/**
 * Chaos-engineering fault injection for agent runtime reliability testing.
 * Registers `tools/execute` and `llm/stream` listeners that, per configured
 * rules, inject latency, timeouts, HTTP-style errors, malformed tool results,
 * dropped tool results, and LLM provider failures — so an operator can verify
 * that retry, fallback, circuit-breaking, and agent-recovery paths actually
 * work before production incidents do.
 *
 * Injected failures use the same structured codes as real ones (`TOOL_TIMEOUT`,
 * `HTTP_429`, …) so downstream policy routes on them identically; the
 * `info.name` field carries a `Chaos*` class so telemetry can tell injected
 * faults from genuine incidents.
 *
 * @module @why-daydream/dsh-chaos
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TOOL_TIMEOUT } from '@deepseek-ai/dsh-tool-call-timeout-policy'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export const name = 'chaos'

/**
 * One chaos rule. Exactly one of `tool` (a `*`-wildcard tool-name pattern) or
 * `event` (`'llm/request'`) must be present — the loader rejects rules naming
 * both or neither. `latency` and `error` apply to both targets; `timeout`,
 * `malformedJson`, and `dropResult` are tool-only; `providerUnavailable` is
 * LLM-only.
 */
export interface ChaosRule {
  /** Tool-name `*`-wildcard pattern the rule targets (e.g. `web_search`, `db_*`). */
  tool?: string
  /** Event target; only `'llm/request'` is supported. */
  event?: 'llm/request'
  /** Overall gate: the rule's faults apply with this probability (default 1). */
  failureRate?: number
  /** Inject a uniform delay before the call (ms). */
  latency?: { min?: number; max?: number }
  /** Tool: wait `afterMs`, then fail the call as `TOOL_TIMEOUT`. */
  timeout?: { probability?: number; afterMs?: number }
  /** Fail the call with an HTTP-style error carrying the status code. */
  error?: { status?: number; probability?: number }
  /** Tool: let the call run, then replace its content with malformed JSON. */
  malformedJson?: { probability?: number }
  /** Tool: let the call run, then report the result as lost. */
  dropResult?: { probability?: number }
  /** LLM: end the stream with a provider-unavailable failure. */
  providerUnavailable?: { probability?: number }
}

/** Plugin config: the fault rules plus an optional reproducibility seed. */
export interface Config {
  /** Fault rules, applied in order; the first matching rule wins. */
  rules?: ChaosRule[]
  /** Optional PRNG seed: the same config then injects the same fault sequence. */
  seed?: number
}

const FAULT_PROBABILITY = z.number().min(0).max(1).default(1)

export const Config: z<Config> = z.object({
  rules: z.array(z.object({
    tool: z.string(),
    event: z.union(['llm/request'] as const),
    failureRate: z.number().min(0).max(1).default(1),
    latency: z.object({ min: z.number().min(0).default(0), max: z.number().min(0).default(0) })
      .default(undefined as unknown as { min: number; max: number }),
    timeout: z.object({ probability: FAULT_PROBABILITY, afterMs: z.number().min(1) })
      .default(undefined as unknown as { probability: number; afterMs: number }),
    error: z.object({ status: z.number().min(100).max(599), probability: FAULT_PROBABILITY })
      .default(undefined as unknown as { status: number; probability: number }),
    malformedJson: z.object({ probability: FAULT_PROBABILITY })
      .default(undefined as unknown as { probability: number }),
    dropResult: z.object({ probability: FAULT_PROBABILITY })
      .default(undefined as unknown as { probability: number }),
    providerUnavailable: z.object({ probability: FAULT_PROBABILITY })
      .default(undefined as unknown as { probability: number }),
  })).default([]),
  seed: z.number(),
})

/** The malformed-JSON sample substituted for a real tool result. */
const MALFORMED_JSON = '{"status": "ok", "results": ['

/** Every tool-only fault name, for load-time validation. */
const TOOL_ONLY_FAULTS = ['timeout', 'malformedJson', 'dropResult'] as const

/** Every LLM-only fault name, for load-time validation. */
const LLM_ONLY_FAULTS = ['providerUnavailable'] as const

/** Deterministic PRNG (mulberry32) for reproducible chaos runs. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Resolve early on abort so a cancelled turn is not held hostage by an injected delay. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Compile one `*`-wildcard tool pattern to an anchored RegExp (every other regex metacharacter is matched literally). */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/** Build one structured `isError` tool result. */
function chaosErrorResult(message: string, code: string, errorName: string): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
    error: { message, info: { name: errorName, code } },
  }
}

/** A tool rule compiled for matching. */
interface CompiledToolRule {
  regex: RegExp
  failureRate: number
  latency?: { min: number; max: number }
  timeout?: { probability: number; afterMs: number }
  error?: { status: number; probability: number }
  malformedJson?: { probability: number }
  dropResult?: { probability: number }
}

/** An `llm/request` rule compiled for matching. */
interface CompiledLlmRule {
  failureRate: number
  latency?: { min: number; max: number }
  error?: { status: number; probability: number }
  providerUnavailable?: { probability: number }
}

/** Normalize one rule's optional fault fields into their compiled, resolved shapes. */
function compileFaults(rule: ChaosRule): Pick<CompiledToolRule, 'latency' | 'timeout' | 'error' | 'malformedJson' | 'dropResult'> {
  return {
    ...(rule.latency === undefined ? {} : { latency: { min: rule.latency.min ?? 0, max: rule.latency.max ?? 0 } }),
    ...(rule.timeout === undefined ? {} : { timeout: { probability: rule.timeout.probability ?? 1, afterMs: rule.timeout.afterMs ?? 0 } }),
    ...(rule.error === undefined ? {} : { error: { status: rule.error.status ?? 0, probability: rule.error.probability ?? 1 } }),
    ...(rule.malformedJson === undefined ? {} : { malformedJson: { probability: rule.malformedJson.probability ?? 1 } }),
    ...(rule.dropResult === undefined ? {} : { dropResult: { probability: rule.dropResult.probability ?? 1 } }),
  }
}

/** Fail-loud load validation shared by both apply paths. */
function validateRule(rule: ChaosRule, index: number): void {
  const hasTool = rule.tool !== undefined
  const hasEvent = rule.event !== undefined
  if (hasTool === hasEvent) {
    throw new Error(`dsh-chaos: rule ${index} must name exactly one of \`tool\` or \`event\``)
  }
  const target = hasTool ? `tool \`${rule.tool}\`` : `event \`${rule.event}\``
  const faults = [rule.latency, rule.timeout, rule.error, rule.malformedJson, rule.dropResult, rule.providerUnavailable]
  if (faults.every(fault => fault === undefined)) {
    throw new Error(`dsh-chaos: rule ${index} for ${target} configures no fault`)
  }
  if (rule.latency !== undefined && (rule.latency.min ?? 0) > (rule.latency.max ?? 0)) {
    throw new Error(`dsh-chaos: rule ${index} for ${target} has latency.min > latency.max`)
  }
  if (rule.timeout !== undefined && rule.timeout.afterMs === undefined) {
    throw new Error(`dsh-chaos: rule ${index} for ${target} configures \`timeout\` without \`afterMs\``)
  }
  if (rule.error !== undefined && rule.error.status === undefined) {
    throw new Error(`dsh-chaos: rule ${index} for ${target} configures \`error\` without \`status\``)
  }
  for (const fault of TOOL_ONLY_FAULTS) {
    if (hasEvent && rule[fault] !== undefined) {
      throw new Error(`dsh-chaos: rule ${index} for ${target} configures \`${fault}\`, which is tool-only`)
    }
  }
  for (const fault of LLM_ONLY_FAULTS) {
    if (hasTool && rule[fault] !== undefined) {
      throw new Error(`dsh-chaos: rule ${index} for ${target} configures \`${fault}\`, which is LLM-only`)
    }
  }
}

/**
 * Install the chaos listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; rules are re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const rules = config.rules as ChaosRule[]
  rules.forEach(validateRule)

  const random = config.seed !== undefined ? mulberry32(config.seed) : Math.random
  const roll = (probability: number): boolean => random() < probability

  const toolRules: CompiledToolRule[] = rules
    .filter((rule): rule is ChaosRule & { tool: string } => rule.tool !== undefined)
    .map(rule => ({
      regex: wildcardToRegExp(rule.tool),
      failureRate: rule.failureRate ?? 1,
      ...compileFaults(rule),
    }))
  const llmRules: CompiledLlmRule[] = rules
    .filter((rule): rule is ChaosRule & { event: 'llm/request' } => rule.event !== undefined)
    .map(rule => ({
      failureRate: rule.failureRate ?? 1,
      ...(rule.latency === undefined ? {} : { latency: { min: rule.latency.min ?? 0, max: rule.latency.max ?? 0 } }),
      ...(rule.error === undefined ? {} : { error: { status: rule.error.status ?? 0, probability: rule.error.probability ?? 1 } }),
      ...(rule.providerUnavailable === undefined
        ? {}
        : { providerUnavailable: { probability: rule.providerUnavailable.probability ?? 1 } }),
    }))
  if (llmRules.length > 1) {
    throw new Error('dsh-chaos: at most one rule may target `event: llm/request`')
  }

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const rule = toolRules.find(candidate => candidate.regex.test(exec.name))
    if (rule === undefined) return next()
    if (!roll(rule.failureRate)) return next()

    if (rule.latency !== undefined) {
      await delay(rule.latency.min + random() * (rule.latency.max - rule.latency.min), exec.signal)
    }
    if (rule.timeout !== undefined && roll(rule.timeout.probability)) {
      await delay(rule.timeout.afterMs, exec.signal)
      if (exec.signal.aborted) return next()
      return chaosErrorResult(
        `tool call timed out after ${rule.timeout.afterMs}ms (injected by dsh-chaos)`,
        TOOL_TIMEOUT,
        'ChaosToolTimeout',
      )
    }
    if (rule.error !== undefined && roll(rule.error.probability)) {
      return chaosErrorResult(
        `injected HTTP ${rule.error.status} for tool \`${exec.name}\``,
        `HTTP_${rule.error.status}`,
        'ChaosHttpError',
      )
    }
    if (rule.dropResult !== undefined && roll(rule.dropResult.probability)) {
      await next() // the tool really ran; only the result is lost
      return chaosErrorResult(
        'tool result lost after execution (injected by dsh-chaos)',
        'TOOL_RESULT_LOST',
        'ChaosResultLost',
      )
    }
    return next()
  })

  // Malformed JSON must replace the content AFTER the registry has normalized
  // the dispatch result — a success result swapped inside `tools/execute` is
  // re-projected from its value by `normalizeDispatchResult`, so the injected
  // content would be lost. `tools/post-execute`'s `accept` decision replaces
  // the content that reaches materialization and the session log.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const rule = toolRules.find(candidate => candidate.regex.test(exec.name))
    if (rule === undefined) return next()
    if (!roll(rule.failureRate)) return next()
    if (rule.malformedJson !== undefined && !result.isError && roll(rule.malformedJson.probability)) {
      return { kind: 'accept', content: [{ type: 'text', text: MALFORMED_JSON }] }
    }
    return next()
  })

  ctx.on('llm/stream', (options, next): AsyncIterable<StreamChunk> => {
    const rule = llmRules[0]
    if (rule === undefined) return next()
    if (!roll(rule.failureRate)) return next()
    // The waterfall expects a synchronous AsyncIterable return, so the delay
    // and any injected finish live inside an async generator; `next()` is
    // delegated lazily so a real request is only issued on the pass-through path.
    return (async function* () {
      if (rule.latency !== undefined) {
        await delay(rule.latency.min + random() * (rule.latency.max - rule.latency.min), options.signal)
      }
      if (rule.error !== undefined && roll(rule.error.probability)) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: {
            message: `injected HTTP ${rule.error.status} for model request (dsh-chaos)`,
            code: `HTTP_${rule.error.status}`,
            status: rule.error.status,
          } },
        }
        return
      }
      if (rule.providerUnavailable !== undefined && roll(rule.providerUnavailable.probability)) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: {
            message: 'injected provider unavailable (dsh-chaos)',
            code: 'PROVIDER_UNAVAILABLE',
          } },
        }
        return
      }
      yield * next()
    })()
  })
}
