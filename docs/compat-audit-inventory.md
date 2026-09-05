# dsh-chaos — Latest-DSH Compatibility Audit（audit-only）

**Date**: 2026-09-05
**Branch**: `audit/latest-dsh-compat`（基线 main = `01130b5`，v0.1.0 已发布）
**Audit 目标**: PCA-01 ~ PCA-10 逐项验收；本文件 = PCA-07 的 consumer-symbol 输入清单。
**铁律**: 本审计不修改 production 行为；发现 breaking change 先报告，不用 peer range 掩盖。

## 开发基线（devDeps link → 本地 deepseek-harness 工作树）

| package | link 版本 | 说明 |
|---|---|---|
| @deepseek-ai/cordis | 4.0.1 | vendor/cordis |
| @deepseek-ai/dsh-agent-loop | 0.1.0-rc.5 | dev/test 用 |
| @deepseek-ai/dsh-invariants | 0.1.0-rc.5 | invariant companion |
| @deepseek-ai/dsh-llm | 0.1.0-rc.5 | llm/stream 契约 |
| @deepseek-ai/dsh-session | 0.1.0-rc.5 | dev/test 用 |
| @deepseek-ai/dsh-system-prompt | 0.1.0-rc.5 | dev/test 用 |
| @deepseek-ai/dsh-tool-call-timeout-policy | 0.1.0-rc.5 | TOOL_TIMEOUT 常量 |
| @deepseek-ai/dsh-tools | 0.1.0-rc.5 | tools/execute 契约 |

npm 已发布 peer floors（v0.1.0）：cordis `>=4.0.1`、dsh-invariants `>=0.0.1-rc.1`、
dsh-llm `>=0.0.1-rc.1`、dsh-tool-call-timeout-policy `>=0.0.1-rc.3`、dsh-tools `>=0.0.1-rc.1`
→ 裸 prerelease 地板，tuple `(0,0,1)`，已知对 0.1.x 全部 prerelease 行不匹配（PCA-01 复现）。

## Consumer-symbol 清单（production：src/）

### src/index.ts — apply(ctx, config) 主插件
| package | symbol | kind | 使用方式 |
|---|---|---|---|
| @deepseek-ai/cordis | `Context` | type | apply(ctx) 参数；事件注册面 |
| @deepseek-ai/dsh-tool-call-timeout-policy | `TOOL_TIMEOUT` | value | 注入 timeout 错误的 code（结构化错误码，须与真实 timeout 同码） |
| @deepseek-ai/dsh-llm | `StreamChunk` | type | llm/stream waterfall 返回 chunk 形状；构造 finish/error reason（kind:'finish', reason:{kind:'error', failure:{message,code,status?}}） |
| @deepseek-ai/dsh-tools | `ToolExecutionResult` | type | tools/execute 返回 + 错误结果契约（message/code + info.name 携带 `Chaos*` 类名，供遥测区分注入） |

**消费的 Cordis 事件契约（waterfall 形状，PCA-07 重点）**：
- `ctx.on('tools/execute', (exec, next) => Promise<ToolExecutionResult>)` — exec.name / exec.signal；next() 透传
- `ctx.on('tools/post-execute', (exec, result, next) => Promise<...>)` — result.isError；返回 `{kind:'accept', content:[...]}` 替换 materialize 内容
- `ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>)` — options.signal；须同步返回 AsyncIterable（瀑布委托语义）

**错误语义**：注入失败与真实失败同构——TOOL_TIMEOUT（tools）、HTTP_<status>（tools+llm）、
PROVIDER_UNAVAILABLE（llm）、TOOL_RESULT_LOST（tools）；errorName `Chaos*` 进 info.name。

### src/invariant.ts — chaos-invariant companion
| package | symbol | kind | 使用方式 |
|---|---|---|---|
| @deepseek-ai/cordis | `Context` | type | apply(ctx) 参数 |
| @deepseek-ai/dsh-invariants | `InvariantInstaller` | type | install 常量类型；`ctx.invariants.register(PACKAGE_NAME, install)` |

**Service key / lifecycle**：`inject: ['invariants']`；ctx.invariants.register 返回 disposer；apply 返回 Promise<disposer>。

## dev/test-only imports（PCA-03/08/09 用，非 production 面）
- tests/chaos.spec.ts: `Context`（cordis, 运行时）、`CallId / LlmAdapter / GenerateOptions / StreamChunk`（dsh-llm）、
  `SystemPrompt` default（dsh-system-prompt）、`LlmRuntime` default（dsh-llm）、`ToolRuntime` default +
  `defineContentToolFixture`（dsh-tools）、`TOOL_TIMEOUT`（timeout-policy）

## PCA-07 比对基线（harness git tags）
- 开发基线: harness 工作树 HEAD（app-boot 0.1.0-rc.5 era，2026-08-13）
- 已发布最新: tag `dsh-v0.1.2-rc.1`（= npm next 0.1.2-rc.1 家族）
- 最新源码: tag `dsh-v0.1.3-alpha.1`（2026-09-04）
