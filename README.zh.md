# dsh-chaos

English | [中文](README.zh.md)

> 面向 DeepSeek Harness 的故障注入与混沌工程插件。

`dsh-chaos` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的独立第三方插件。它拦截 `tools/execute` / `tools/post-execute` 与 `llm/stream` 瀑布，注入延迟、超时、HTTP 风格错误、畸形 JSON 工具结果、工具结果丢失与 LLM 供应商故障——从而在**生产事故替你测试之前**，验证重试、降级、熔断与 Agent 恢复路径是否真的有效。

注入的故障复用与真实故障相同的结构化错误码（`TOOL_TIMEOUT`、`HTTP_429` 等），下游策略对其路由方式完全一致；`error.info.name` 携带 `Chaos*` 类别，遥测据此区分注入故障与真实事故。

## 安装

在 `dsh` 安装中，从 npm registry 安装到任意 profile：

```sh
dsh plugin --profile web add @why-daydream/dsh-chaos          # latest
dsh plugin --profile web add @why-daydream/dsh-chaos@0.1.0    # 锁定版本
dsh --profile web --dump-config   # 确认树中出现 `dsh-chaos`
```

发布的包自带预构建的 `lib/`（通过 manifest 中的 `dsh.bundle` 声明），安装时无需源码构建。

### 源码安装（开发）

如需基于本地 checkout 迭代，改用 `link:`/`file:` 规格：

```sh
dsh plugin --profile chaos-e2e add /path/to/dsh-chaos
dsh --profile chaos-e2e --dump-config   # 确认树中出现 `dsh-chaos`
```

插件不注册任何工具或提示词；**无规则匹配时零影响**——每条规则都是显式启用的。

## 配置

```yaml
chaos:
  seed: 42              # 可选：相同配置 + 相同种子 → 相同故障序列
  rules:
    - tool: 'web_search'          # `*` 通配的工具名模式；10% 以 HTTP 429 失败
      failureRate: 0.1
      error:
        status: 429
        probability: 1
    - tool: 'database_query'      # 每次调用延迟 1–5 秒
      latency:
        min: 1000
        max: 5000
    - event: 'llm/request'        # 5% 的模型请求以 HTTP 429 error finish 结束
      error:
        status: 429
        probability: 0.05
```

每条规则**恰好**指定 `tool`（通配模式）或 `event`（`'llm/request'`）之一。故障类型：

| 故障 | 目标 | 含义 |
|---|---|---|
| `failureRate` | 两者 | 总闸门（0–1，默认 1） |
| `latency: { min, max }` | 两者 | 调用前注入均匀延迟（毫秒） |
| `error: { status, probability }` | 两者 | 以 `HTTP_<status>` 失败 |
| `timeout: { probability, afterMs }` | 工具 | 等待 `afterMs` 后以 `TOOL_TIMEOUT` 失败（与 `dsh-tool-call-timeout-policy` 同码） |
| `malformedJson: { probability }` | 工具 | 让工具真实执行，把其成功结果内容替换为畸形 JSON |
| `dropResult: { probability }` | 工具 | 让工具真实执行（副作用发生），把结果报告为丢失（`TOOL_RESULT_LOST`） |
| `providerUnavailable: { probability }` | LLM | 以 `PROVIDER_UNAVAILABLE` 结束流 |

加载期校验是 fail-loud 的：同时指定 `tool` 与 `event`（或两者皆无）、未配置任何故障、LLM 规则上出现工具专属故障、工具规则上出现 `providerUnavailable`、或 `latency.min > latency.max` 都会在插件加载时抛错。

## 开发

```sh
pnpm install
pnpm run build      # tsc 输出 lib/
pnpm test           # vitest（无网络）
pnpm run lint       # oxlint
```

devDependencies 通过 `file:` 链接（`../deepseek-harness`）解析到本地 DeepSeek Harness checkout，因此构建/测试针对插件开发时所用的同一套 Harness API。已发布的 `@deepseek-ai/*` peer 依赖以 npm 范围声明在 `peerDependencies`。

## 兼容性

| dsh-chaos | DeepSeek Harness |
|---|---|
| 0.1.x | 0.1.0-rc.5（已实测）· 0.1.0-rc.x（预期兼容） |

本插件依赖 Harness 的 `tools/execute`、`tools/post-execute`、`llm/stream` 瀑布。DeepSeek Harness 仍处于 developer preview，可能引入破坏性变更；升级任一侧前请核对上表。

## 已知限制与待办（Known Limitations and Deferred Work）

- **先匹配者胜出的规则选择**——一次调用只受第一条匹配规则影响；重叠规则不会按故障组合生效。
- **LLM 延迟与错误均为流前行为**——`llm/stream` 监听器在返回流之前延迟，且只能以终结性错误 finish 结束流；流中 chunk 损坏（例如注入带畸形 JSON 的 `tool-call-delta`）尚不支持。
- **无混沌仪表盘或指标**——本插件只注入故障，不记录或上报；遥测消费者可通过 `error.info.name`（`Chaos*`）从 `tools/result` / `session/event` 归因。

## 许可证

[MIT](LICENSE)
