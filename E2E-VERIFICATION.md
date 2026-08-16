# dsh-chaos E2E 验证记录（真实 Profile 场景）

> 状态：全部场景已完成（截至 2026-08-16）。本文记录在**真实 DSH profile + 真实 Agent loop** 下对 `@why-daydream/dsh-chaos` 的端到端验证结果、方法、以及复现要点。

## 一、背景与目标

插件已通过代码级验证（20/20 单测、`tsc`、`oxlint`、host 全量编译），本阶段的目标是把 `dsh-chaos` 从"monorepo 里的一个 package"提升为**可安装、可加载、故障可真实注入**的独立第三方插件，证明：

```
独立插件能安装 → Profile 能加载 → Agent 能运行 → 真实故障能注入 → DSH 按真实故障语义处理
```

## 二、环境与方法

| 项 | 值 |
|---|---|
| DSH 运行来源 | 本地 checkout（`/mnt/workspace/DSH/deepseek-harness`，`0.1.0-rc.5`），`node --import tsx/esm apps/cli/src/bin.ts` |
| 插件 | `@why-daydream/dsh-chaos`（`/mnt/workspace/DSH/dsh-chaos`，独立仓库） |
| Profile | `chaos-e2e`（`$DSH_HOME/profiles/chaos-e2e`，即 `/root/.dsh/profiles/chaos-e2e`） |
| Profile bundles | `@deepseek-ai/dsh-base` + `@why-daydream/dsh-chaos` + `@deepseek-ai/dsh-headless` |
| LLM 供应 | 仓库自带 `llm-mock-server`（OpenAI 兼容，无真实 API key）；`DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1`、`DEEPSEEK_API_KEY=mock-key` |
| Mock 行为序列 | `tool_call_success, success --repeat-last`（先让模型请求工具调用，再正常收尾） |
| 注入目标工具 | `todo_write`（base bundle 自带、**无需 sandbox**） |
| 规则注入方式 | `dsh --profile chaos-e2e --patch <patch.yml> "task"`，patch 按 id 替换 `chaos` 行 config |
| 结果核验 | 解压 session 日志（`/root/.dsh/sessions/--mnt-workspace-DSH-deepseek-harness--/<id>/session.jsonl.zstd`）中的 `tool/result` 事件 |

## 三、已完成的场景与结果

### 3.1 安装与加载（已完成 ✅）

```sh
dsh plugin --profile chaos-e2e add file:/mnt/workspace/DSH/dsh-chaos
```

- profile 初始化于 `/root/.dsh/profiles/chaos-e2e`（package.json + cordis.patch.yml + pnpm-workspace.yaml）
- `dsh.profile.bundles` 调和后包含 `@why-daydream/dsh-chaos`
- `dsh --profile chaos-e2e --dump-config` 输出末尾出现：

```yaml
# == @why-daydream/dsh-chaos
- id: chaos
  name: '@why-daydream/dsh-chaos'
```

✅ **插件树加载成功。**

### 3.2 Baseline：无规则不改变行为（已完成 ✅）

- 方法：`--patch` 使用 profile 默认空 patch（`[]`），跑 headless 任务
- 结果：Agent 正常完成，stdout `mock response recovered`；session 日志 `tool/result` 为正常结果

✅ **未配置 Chaos ≠ 改变 Agent 原本行为。**

### 3.3 HTTP 429 注入（已完成 ✅）

- 规则：

```yaml
- id: chaos
  config:
    rules:
      - tool: todo_write
        failureRate: 1
        error: { status: 429, probability: 1 }
```

- session 日志 `tool/result` 实测：

```json
"error.code = HTTP_429"
"Error: injected HTTP 429 for tool `todo_write`"
```

✅ **chaos 制造的 429 以真实 HTTP_429 错误码到达 Agent**，可被下游重试/策略按真实 429 处理。

### 3.4 TOOL_TIMEOUT 注入（已完成 ✅）

- 规则：`timeout: { probability: 1, afterMs: 500 }`
- session 日志 `tool/result` 实测：

```json
"error.code = TOOL_TIMEOUT"
"Error: tool call timed out after 500ms (injected by dsh-chaos)"
```

✅ **与 `dsh-tool-call-timeout-policy` 同码（`TOOL_TIMEOUT`），语义一致。**

### 3.5 malformedJson 注入（已完成 ✅）

- 规则：`malformedJson: { probability: 1 }`
- session 日志 `tool/result` 实测：成功结果的内容被替换为畸形 JSON 文本：

```json
"content: {\"status\": \"ok\", \"results\": ["
```

✅ **工具真实执行、模型看到的是被替换后的 malformed 内容**——证明 `tools/post-execute` 注入点（规避 `normalizeDispatchResult` 重投影）在真实管线中生效。

### 3.6 latency 注入（已完成 ✅）

- 规则：

```yaml
- id: chaos
  config:
    rules:
      - tool: todo_write
        latency: { min: 2000, max: 2000 }
```

- session 日志 `tool/call` → `tool/result` 时间戳实测间隔：**2005 ms**（`min=max=2000`）

✅ **工具真实延时 ≥ 配置下界，Agent 正常等待并继续。**

### 3.7 LLM providerUnavailable 注入（已完成 ✅）

- 规则：`event: llm/request` + `providerUnavailable: { probability: 1 }`
- 进程行为：headless 任务以 `exit=1` 结束，stderr：

```text
dsh: PROVIDER_UNAVAILABLE: injected provider unavailable (dsh-chaos)
```

- session 日志事件流完整：`turn/start` → `step/end` → `turn/end`，session 正常落盘

✅ **注入的 `PROVIDER_UNAVAILABLE` 以真实错误码到达 LLM 层，Turn 正确收尾、Session 完整。**

### 3.8 seed 42 进程级复现（已完成 ✅）

- 规则：`seed: 42` + `failureRate: 0.5` + `error: { status: 429, probability: 1 }`
- 独立启动 mock server（重置 FIFO 序列），两次独立进程运行，从 session 日志 `tool/result` 提取故障序列：

| Run | 故障序列（按工具调用次序） |
|---|---|
| Run A | `OK, OK, HTTP_429` |
| Run B | `OK, OK, HTTP_429` |

✅ **相同 config + 相同 seed → 两次独立进程产生完全相同的故障序列**，单测中的 seed 可复现在真实 Plugin lifecycle 下成立。

## 四、复现脚本与要点

复现脚本：`/tmp/e2e.sh <scenario>`（scenario: baseline | latency | http429 | timeout | malformed | llm | seed）。

每个场景的标准流程：

```sh
# 1. （必要时）重启 mock server，重置 FIFO 行为序列 —— 关键！
#    否则 --repeat-last 会重复最后一个行为（如纯文本 success），模型不再发起工具调用，chaos 无从注入
node --import tsx packages/test-support/llm-mock-server/src/bin.ts \
  --port 8000 --api-key mock-key \
  --tool-name todo_write \
  --tool-arguments '{"todos":[{"content":"write a test todo","status":"pending"}]}' \
  --sequence tool_call_success,success --repeat-last

# 2. 跑 headless 任务（baseline 用空 patch：printf '[]\n' > /tmp/chaos-baseline.patch.yml）
DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1 DEEPSEEK_API_KEY=mock-key \
  node --import tsx/esm apps/cli/src/bin.ts --profile chaos-e2e \
  --patch /tmp/chaos-<scenario>.patch.yml "please write a todo item"

# 3. 核验 session 日志（zstd 压缩 JSONL）
unzstd -c "$(ls -t /root/.dsh/sessions/--mnt-workspace-DSH-deepseek-harness--/*/ | head -1)session.jsonl.zstd" \
  | grep '"type":"tool/result"'
```

| 场景 | 核验点 |
|---|---|
| baseline | `tool/result` 为正常结果（无 `error` 字段）、Agent 正常完成 |
| latency | `tool/call` → `tool/result` 时间差 ≥ `min` |
| http429 | `tool/result` 的 `error.code = HTTP_429` |
| timeout | `tool/result` 的 `error.code = TOOL_TIMEOUT` |
| malformed | `tool/result` 成功结果内容被替换为畸形 JSON 文本 |
| llm | 进程 `PROVIDER_UNAVAILABLE` 错误码 + session `turn/start→step/end→turn/end` 完整 |
| seed | 两次独立进程（mock server 各自重置）故障序列完全一致 |

## 五、过程中发现的问题与修复（重要经验）

1. **`file:` 协议无法用于依赖本地 checkout 包**——被链接包的 `workspace:^` 依赖在独立 pnpm 环境下无法解析（`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`）。改用 **`link:` 协议**：不解析链接目标依赖，运行时沿真实路径回退到 checkout 的 `node_modules`，独立仓库可正常 `pnpm install`。
2. **独立仓库构建必须同时产出 JS 与类型**——monorepo 里 tsc 只产出 `lib/types`（JS 由 tsdown 打包）；独立包 `build` 用 `tsc -b tsconfig.build.json`（`rootDir: src`、`outDir: lib`）同时产出 `lib/index.js` + `lib/index.d.ts`，`exports` 相应指向 `lib/`。
3. **独立 tsconfig 需显式 `"types": ["node"]`**——否则 `AbortSignal`/`setTimeout` 等全局类型缺失（monorepo 的 base tsconfig 已配好，独立包要自己加）。
4. **测试包名引用要跟随改名**——`tests/chaos.spec.ts` 中 `@deepseek-ai/dsh-chaos` → `@why-daydream/dsh-chaos`，否则 vitest 报 "Cannot find package"。
5. **bash 工具需要 sandbox 后端**——本机无 bwrap/landlock 可用时工具调用报 `SANDBOX_UNAVAILABLE`，与 chaos 无关。E2E 改用无需 sandbox 的 `todo_write` 作为注入目标。
6. **mock LLM 工具参数必须符合目标工具 schema**——bash 要求必填 `description`，缺它报 `INVALID_ARGS`，工具从未执行、chaos 无从注入。
7. **patch YAML 缩进必须正确**——`rules` 列表项需缩进在 `config.rules` 之下，否则规则不生效（dump-config 可核对）。
8. **headless bundle 无需安装**——`@deepseek-ai/dsh-headless` 是 in-box bundle，直接加入 `dsh.profile.bundles` 即可，`dsh plugin add` 反而会因 workspace 依赖失败。
9. **session 日志是 zstd 压缩 JSONL**——用 `unzstd -c <session.jsonl.zstd>` 解压后 grep `"type":"tool/result"` 核验。
10. **mock server 的 FIFO 行为序列会被消耗，且 `--repeat-last` 永远重复最后一个行为**——跑完一次任务后序列耗尽，后续任务模型只收到纯文本 `success`、不再发起工具调用，chaos 规则（按工具名匹配）无从注入、session 里没有 `tool/result`。**每个场景必须重启 mock server 重置序列**，否则结果无效（本次 latency 首跑即踩中：总耗时 10.3s 但无 tool 事件）。
11. **mock 默认工具名 `mock_tool` 不存在**——不指定 `--tool-name` 时模型发起对 `mock_tool` 的调用，报 `UNKNOWN_TOOL`。E2E 必须用 `--tool-name todo_write --tool-arguments '{"todos":[...]}'` 对齐 base bundle 真实工具的 schema。
12. **`--patch /dev/null` 不合法**——overlay 必须是顶层 YAML 数组，baseline 空 patch 用 `printf '[]\n' > /tmp/chaos-baseline.patch.yml`。
13. **`dsh plugin` 依赖 PATH 上的 pnpm**——环境里只有 corepack 时先 `corepack enable`（shim 位于 `/root/.nvm/versions/node/v22.22.0/bin/pnpm`），并把该目录加入 PATH，否则报 "pnpm not found"。
14. **seed 进程级复现要让 mock 序列包含多轮工具调用**——`tool_call_success,success` 只有 1 次工具调用点；用 `tool_call_success × 4 + success` 才能观察到 `OK/OK/HTTP_429` 式的多步故障序列。

## 六、相关文件

| 路径 | 说明 |
|---|---|
| `/mnt/workspace/DSH/dsh-chaos/` | 独立插件仓库（src/tests/package.json/tsconfig/cordis.patch.yml/README 双语/LICENSE） |
| `/root/.dsh/profiles/chaos-e2e/` | E2E profile（package.json + cordis.patch.yml + pnpm-workspace.yaml） |
| `/tmp/e2e.sh` | E2E 场景复现脚本 |
| `/tmp/chaos-<scenario>.patch.yml` | 各场景规则 patch（baseline 为 `[]` 空数组） |
| `/tmp/mock-<scenario>.log` | mock LLM server 日志 |
| `/tmp/e2e-<scenario>.out` | headless 任务 stdout |
| `/root/.dsh/sessions/--mnt-workspace-DSH-deepseek-harness--/<id>/session.jsonl.zstd` | session 日志（zstd JSONL，含 `tool/call`/`tool/result`/`turn/end`） |
