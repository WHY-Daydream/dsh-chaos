# PCA-07 — consumer-symbol audit（三 ref 比对结论）

**Date**: 2026-09-05 · **Branch**: audit/latest-dsh-compat
**比对基线**: HEAD（开发基线，0.1.0-rc.5 era）→ `dsh-v0.1.2-rc.1`（npm next）→ `dsh-v0.1.3-alpha.1`（最新源码）

## 结论：PCA-07 PASS — 消费面无破坏性变更

| 消费 symbol | 包 | 三 ref 比对 | 结论 |
|---|---|---|---|
| `TOOL_TIMEOUT = 'TOOL_TIMEOUT'` | timeout-policy | 逐字一致（含值） | ✅ |
| `tools/execute` 事件 | dsh-tools | `(exec: ToolDispatchExecution, next) => Promise<ToolExecutionResult>` 一致 | ✅ |
| `tools/post-execute` 事件 | dsh-tools | `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next) => Promise<PostToolDecision>` 一致 | ✅ |
| `ToolExecutionResult = Success \| Failure` | dsh-tools | 接口字段逐字一致 | ✅ |
| `ToolExecutionFailure` | dsh-tools | `{isError: true, error: ToolFailure, content, ...}` 一致（chaos 构造面全兼容） | ✅ |
| `ToolFailure` | dsh-tools | `{message: string, info?: ToolErrorInfo}` 一致（chaos 写 `info:{name,code}`；timeout-policy 同款构造在三 ref 均编译 = ToolErrorInfo 兼容的间接证据） | ✅ |
| `PostToolDecision` | dsh-tools | `{kind:'accept', content?} | {kind:'accept', value} | {kind:'block'}` 一致（chaos 返回 accept+content 命中第一成员） | ✅ |
| exec 字段 `name` / `signal` | dsh-tools | 三 ref 均存在、字段一致（仅行号漂移） | ✅ |
| `llm/stream` 事件 | dsh-llm | `(options: GenerateOptions, next) => AsyncIterable<StreamChunk>` 一致 | ✅ |
| `FinishReasonMap['error'/'aborted']` | dsh-llm | `{kind, failure: LlmFailure}` 一致 | ✅ |
| `LlmFailure` | dsh-llm | `{message, code, status?, ...}` 一致（chaos 构造 `{message, code, status}` 命中） | ✅ |
| `GenerateOptions.signal` | dsh-llm | `signal?: AbortSignal` 三 ref 均存在 | ✅ |
| `StreamChunk` finish 分支 | dsh-llm | `{type:'finish', reason: FinishReason}` 一致 | ✅ |
| `InvariantInstaller` + `ctx.invariants` + `register` | dsh-invariants | 类型与 `register(packageName, installer): () => void` 三 ref 逐字一致 | ✅ |
| cordis `Context` / `ctx.on` waterfall | cordis | 事件面由各包 augmentation 声明，签名一致 | ✅ |

## 观察到的唯一差异（无影响）
- dsh-llm finish chunk `replayState?: unknown`（HEAD）→ `replayState?: ReplayEnvelope`（两个 tag）——chaos 不读写 replayState，不影响兼容。
- 事件声明行号漂移（tools 163→155、llm 64→67→71 等）——纯文件增长，无语义变化。

## 含义
peer range 修复（候选 union）所声明的 0.1.x 兼容线，在 **API/类型层** 有证据支撑：
0.1.0-rc.5 era 基线 → 0.1.2-rc.1 → 0.1.3-alpha.1 的消费面签名/字段/error 语义全部未变。
「API 名字还在」之外，签名/可选性/返回类型/Context key/lifecycle(register disposer)/error 语义
（info.name=Chaos* 类名 + code=TOOL_TIMEOUT 等结构化码）均已核对一致。
