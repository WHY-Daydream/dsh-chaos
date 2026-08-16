/**
 * Behavior suite for the dsh-chaos fault-injection plugin: per-rule fault
 * semantics (latency, timeout, HTTP errors, malformed JSON, dropped results,
 * provider failures), wildcard tool matching, failureRate gating, the
 * reproducibility seed, and fail-loud config validation — all driven through
 * the real tool registry and LLM runtime (no network).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { TOOL_TIMEOUT } from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as Chaos from '@why-daydream/dsh-chaos'
import type { Config } from '@why-daydream/dsh-chaos'

/** A provider adapter that replays one scripted chunk stream. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: StreamChunk[]) {
    super()
  }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield * this.script
  }
}

const STOP_STREAM: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]

const testToolSignal = new AbortController().signal

/** Boot the tool registry + the chaos plugin; the caller registers fixtures. */
async function toolHarness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Chaos, config)
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'p',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return ctx
}

/** Boot the LLM runtime + the chaos plugin with one scripted adapter. */
async function llmHarness(config: Config = {}, script: StreamChunk[] = STOP_STREAM): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Chaos, config)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(script))
  return ctx
}

function executeTool(ctx: Context, name = 'probe'): Promise<unknown> {
  return ctx.tools.execute({ callId: CallId('c1'), name, arguments: {}, signal: testToolSignal })
}

async function collectLlm(ctx: Context): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: 'mock', model: 'mock', messages: [] })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('delegation without a matching rule', () => {
  it('delegates unchanged when no rule matches', async () => {
    const ctx = await toolHarness()
    const result = await executeTool(ctx)
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'ok' }] })
  })

  it('leaves unmatched tools alone when another tool is targeted', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'other_*', error: { status: 429, probability: 1 } }] })
    const result = await executeTool(ctx, 'probe')
    expect(result).toMatchObject({ isError: false })
  })

  it('a failureRate of 0 never injects', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', failureRate: 0, error: { status: 500, probability: 1 } }] })
    const result = await executeTool(ctx)
    expect(result).toMatchObject({ isError: false })
  })
})

describe('tool faults', () => {
  it('injects latency before dispatch', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', latency: { min: 60, max: 60 } }] })
    const started = Date.now()
    await executeTool(ctx)
    expect(Date.now() - started).toBeGreaterThanOrEqual(55)
  })

  it('timeout waits afterMs then fails with TOOL_TIMEOUT', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', timeout: { probability: 1, afterMs: 20 } }] })
    const started = Date.now()
    const result = await executeTool(ctx)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
    expect(result).toMatchObject({
      isError: true,
      error: { info: { code: TOOL_TIMEOUT } },
    })
  })

  it('error status 429 fails with HTTP_429', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', error: { status: 429, probability: 1 } }] })
    const result = await executeTool(ctx)
    expect(result).toMatchObject({
      isError: true,
      error: { info: { code: 'HTTP_429', name: 'ChaosHttpError' } },
    })
  })

  it('error status 500 fails with HTTP_500', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', error: { status: 500, probability: 1 } }] })
    const result = await executeTool(ctx)
    expect(result).toMatchObject({ isError: true, error: { info: { code: 'HTTP_500' } } })
  })

  it('malformedJson replaces a successful result content with malformed JSON', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', malformedJson: { probability: 1 } }] })
    const result = await executeTool(ctx)
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '{"status": "ok", "results": [' }],
    })
  })

  it('malformedJson leaves an already-failed result untouched', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', malformedJson: { probability: 1 } }] })
    ctx.tools.register(defineContentToolFixture({
      name: 'boom',
      description: 'b',
      parameters: {},
      async execute() { throw new Error('native failure') },
    }))
    const result = await executeTool(ctx, 'boom')
    expect(result).toMatchObject({ isError: true })
  })

  it('dropResult lets the tool run but reports the result as lost', async () => {
    const ctx = await toolHarness({ rules: [{ tool: 'probe', dropResult: { probability: 1 } }] })
    const result = await executeTool(ctx)
    expect(result).toMatchObject({
      isError: true,
      error: { info: { code: 'TOOL_RESULT_LOST' } },
    })
  })
})

describe('llm faults', () => {
  it('ends the stream with an HTTP_429 error finish', async () => {
    const ctx = await llmHarness({ rules: [{ event: 'llm/request', error: { status: 429, probability: 1 } }] })
    const chunks = await collectLlm(ctx)
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'injected HTTP 429 for model request (dsh-chaos)', code: 'HTTP_429', status: 429 } } },
    ])
  })

  it('ends the stream with a provider-unavailable error finish', async () => {
    const ctx = await llmHarness({ rules: [{ event: 'llm/request', providerUnavailable: { probability: 1 } }] })
    const chunks = await collectLlm(ctx)
    expect(chunks).toEqual([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'injected provider unavailable (dsh-chaos)', code: 'PROVIDER_UNAVAILABLE' } } },
    ])
  })

  it('delegates when the llm rule does not fire', async () => {
    const ctx = await llmHarness({ rules: [{ event: 'llm/request', failureRate: 0, error: { status: 500, probability: 1 } }] })
    const chunks = await collectLlm(ctx)
    expect(chunks).toEqual(STOP_STREAM)
  })

  it('a tool rule never touches the llm stream', async () => {
    const ctx = await llmHarness({ rules: [{ tool: 'probe', error: { status: 500, probability: 1 } }] })
    const chunks = await collectLlm(ctx)
    expect(chunks).toEqual(STOP_STREAM)
  })
})

describe('reproducibility seed', () => {
  it('the same seed and config produce the same fault sequence', async () => {
    const config: Config = {
      seed: 42,
      rules: [{ tool: 'probe', error: { status: 500, probability: 0.5 } }],
    }
    const outcomes: boolean[] = []
    for (let i = 0; i < 8; i++) {
      const ctx = await toolHarness(config)
      const result = await executeTool(ctx)
      outcomes.push((result as { isError: boolean }).isError)
    }
    // A fixed seed is deterministic: every run reproduces the same sequence.
    const again: boolean[] = []
    for (let i = 0; i < 8; i++) {
      const ctx = await toolHarness(config)
      const result = await executeTool(ctx)
      again.push((result as { isError: boolean }).isError)
    }
    expect(again).toEqual(outcomes)
  })
})

describe('fail-loud config validation', () => {
  it('rejects a rule naming neither tool nor event', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Chaos, { rules: [{ error: { status: 500, probability: 1 } }] })).rejects
      .toThrow(/exactly one of `tool` or `event`/)
  })

  it('rejects a rule naming both tool and event', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Chaos, {
      rules: [{ tool: 'probe', event: 'llm/request', error: { status: 500, probability: 1 } }],
    })).rejects.toThrow(/exactly one of `tool` or `event`/)
  })

  it('rejects a rule configuring no fault', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Chaos, { rules: [{ tool: 'probe' }] })).rejects
      .toThrow(/configures no fault/)
  })

  it('rejects a tool-only fault on an llm rule', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Chaos, { rules: [{ event: 'llm/request', dropResult: { probability: 1 } }] })).rejects
      .toThrow(/tool-only/)
  })

  it('rejects a providerUnavailable fault on a tool rule', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Chaos, { rules: [{ tool: 'probe', providerUnavailable: { probability: 1 } }] })).rejects
      .toThrow(/LLM-only/)
  })
})
