# dsh-chaos

English | [中文](README.zh.md)

> Fault injection and chaos engineering plugin for DeepSeek Harness.

`dsh-chaos` is an independent third-party plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It intercepts the `tools/execute` / `tools/post-execute` and `llm/stream` waterfalls and injects latency, timeouts, HTTP-style errors, malformed tool results, dropped tool results, and LLM provider failures — so you can verify that retry, fallback, circuit-breaking, and agent-recovery paths actually work **before** a production incident tests them for you.

Injected failures reuse the same structured codes as real ones (`TOOL_TIMEOUT`, `HTTP_429`, …) so downstream policy routes on them identically; the `error.info.name` field carries a `Chaos*` class so telemetry can tell injected faults from genuine incidents.

## Install

From a `dsh` installation, install from the npm registry into any profile:

```sh
dsh plugin --profile web add @why-daydream/dsh-chaos          # latest
dsh plugin --profile web add @why-daydream/dsh-chaos@0.1.0    # pin a version
dsh --profile web --dump-config   # confirm `dsh-chaos` appears in the tree
```

The published package carries a prebuilt `lib/` (via the `dsh.bundle` manifest declaration), so no source build runs on install.

### Development installation (from source)

To iterate against a local checkout, add it with a `link:`/`file:` spec instead:

```sh
dsh plugin --profile chaos-e2e add /path/to/dsh-chaos
dsh --profile chaos-e2e --dump-config   # confirm `dsh-chaos` appears in the tree
```

The plugin registers no tool and no prompt; it has **zero effect when no rule matches** — every rule is opt-in.

## Config

```yaml
chaos:
  seed: 42              # optional: same config + same seed → same fault sequence
  rules:
    - tool: 'web_search'          # `*`-wildcard tool-name pattern; 10% fail with HTTP 429
      failureRate: 0.1
      error:
        status: 429
        probability: 1
    - tool: 'database_query'      # every call delayed 1–5s
      latency:
        min: 1000
        max: 5000
    - event: 'llm/request'        # 5% of model requests end with an HTTP 429 error finish
      error:
        status: 429
        probability: 0.05
```

Each rule names **exactly one** of `tool` (wildcard pattern) or `event` (`'llm/request'`). Faults:

| Fault | Target | Meaning |
|---|---|---|
| `failureRate` | both | overall gate (0–1, default 1) |
| `latency: { min, max }` | both | uniform delay (ms) before the call |
| `error: { status, probability }` | both | fail with `HTTP_<status>` |
| `timeout: { probability, afterMs }` | tool | wait `afterMs`, then fail as `TOOL_TIMEOUT` (same code as `dsh-tool-call-timeout-policy`) |
| `malformedJson: { probability }` | tool | let the tool run, replace its successful content with malformed JSON |
| `dropResult: { probability }` | tool | let the tool run (side effects happen), report the result as lost (`TOOL_RESULT_LOST`) |
| `providerUnavailable: { probability }` | LLM | end the stream with `PROVIDER_UNAVAILABLE` |

Load-time validation is fail-loud: a rule naming both `tool` and `event` (or neither), a rule configuring no fault, a tool-only fault on an `llm/request` rule, a `providerUnavailable` on a tool rule, or `latency.min > latency.max` throws at plugin load.

## Development

```sh
pnpm install
pnpm run build      # tsc emits lib/
pnpm test           # vitest (no network)
pnpm run lint       # oxlint
```

Dev dependencies resolve to a local DeepSeek Harness checkout via `file:` links (`../deepseek-harness`), so build/test run against the same Harness APIs the plugin was developed against. Published `@deepseek-ai/*` peers are declared in `peerDependencies` with npm ranges.

## Compatibility

| dsh-chaos | DeepSeek Harness |
|---|---|
| 0.1.x | 0.1.0-rc.5 (verified) · 0.1.0-rc.x (expected) |

This plugin depends on the `tools/execute`, `tools/post-execute`, and `llm/stream` Harness waterfalls. DeepSeek Harness is in developer preview and may introduce compatibility-breaking changes; verify the matrix above before upgrading either side.

## Known Limitations and Deferred Work

- **First-match-wins rule selection** — a call is affected by only the first matching rule; overlapping rules do not compose per-fault.
- **LLM latency and error are pre-stream** — the `llm/stream` listener delays before returning the stream and can only end it with a terminal error finish; mid-stream chunk corruption (e.g. an injected `tool-call-delta` with broken JSON) is not yet supported.
- **No chaos dashboard or metrics** — this plugin injects faults but does not record or report them; a telemetry consumer of `tools/result` / `session/event` can attribute them via `error.info.name` (`Chaos*`).

## License

[MIT](LICENSE)
