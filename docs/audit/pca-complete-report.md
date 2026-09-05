# dsh-chaos — Latest-DSH Compatibility Audit 报告（PCA-01 ~ PCA-10）

**Date**: 2026-09-05
**Branch**: `audit/latest-dsh-compat`（基线 main = `01130b5`，published v0.1.0）
**状态**: **audit-first 完成，未改 production、未发版**。全部 gate 有结论，两项发现见下。
**铁律遵守**: 无 `--force` / `--legacy-peer-deps`；不先假设 peer range 即运行时兼容；发现 breaking 先报告。

## PCA 汇总

| Gate | 内容 | 结果 | 证据 |
|---|---|---|---|
| PCA-01 | 当前已发布 peer range 的 ERESOLVE 复现 | ✅ 复现 | npm strict exit 1，2× ERESOLVE（`/tmp/pca01/install.log`；首个冲突 `dsh-invariants@0.1.2-rc.1`） |
| PCA-02 | 候选 peer range semver regression | ✅ ALL PASS | `/tmp/pca02-semver.mjs`（全部已发布版本 + 0.1.3-alpha.1 in-window；0.2.x out） |
| PCA-03 | 旧开发基线 typecheck + vitest | ✅ | dsh-chaos repo（0.1.0-rc.5-era links）：tsc exit 0、20/20 |
| PCA-04 | DSH 0.1.0-rc.6 线 | ✅（含上游限制说明） | 见下 Finding F1；0.1.0 线今日可构造端点 rc.8（同 tuple）全闭包 + fixture INSTALL OK（`/tmp/pca45/host-0.1.0-line`） |
| PCA-05 | DSH 0.1.1-rc.2 strict install | ✅ | `/tmp/pca45/host-0.1.1-rc.2` INSTALL OK（resolved 0.1.1-rc.2 ×4） |
| PCA-06 | DSH 0.1.2-rc.1 strict install | ✅ | `/tmp/pca45/host-0.1.2-rc.1` INSTALL OK（resolved 0.1.2-rc.1 ×4） |
| PCA-07 | 0.1.3-alpha.1 source consumer-symbol audit | ✅ 无破坏 | 见 `docs/audit/pca07-consumer-symbol-audit.md`（三 ref 逐 symbol/签名/字段一致；唯一差异 llm finish replayState，chaos 不触碰） |
| PCA-08 | 真实 0.1.2-rc.1 运行时 plugin load / apply / 注册 | ✅ | `/tmp/pca08`：真实 npm 家族（cordis 4.0.2 + dsh-llm/tools/system-prompt/timeout-policy/invariants@0.1.2-rc.1）；typecheck exit 0（修一处测试导入后）、vitest 20/20、invariant companion 注册 PASS |
| PCA-09 | chaos+timeout-policy golden 三态 | ✅ 5/5 | `/tmp/pca08/pca09-golden.mjs`：A 基线 PASS、B chaos timeout→TOOL_TIMEOUT、C 真实 policy 超时→TOOL_TIMEOUT、D 无假阳性、E disabled→基线 |
| PCA-10 | full typecheck + vitest + clean-room | ✅ | 双环境全绿（基线 repo + 0.1.2-rc.1 clean-room harness）；audit 无 production 变更故无新 tgz 需审计 |

## Finding F1 — peer floors 挡新版（已知，复现并定位上游限制）

- 已发布 peer floors（cordis `>=4.0.1` 之外）均为裸 prerelease 地板（tuple `(0,0,1)`）：
  `dsh-invariants/dsh-llm/dsh-tools >=0.0.1-rc.1`、`dsh-tool-call-timeout-policy >=0.0.1-rc.3`。
- npm semver 元组规则 → 只匹配 0.0.1 线 prerelease；0.1.x 全行（0.1.0-rc.x / 0.1.1-rc.x / 0.1.2-rc.1 / 0.1.3-alpha.1）不匹配 → strict npm ERESOLVE（PCA-01 实证）。
- **上游限制（非 chaos 缺陷）**：字面"全 0.1.0-rc.6 钉死"的宿主今日在 npm strict 下不可构造——家族内部漂移
  （`dsh-brand@rc.8` / `dsh-scope@rc.8` 等的 `dsh-invariants ^0.1.0-rc.8` 地板与 rc.6 冲突）；
  **纯 host 对照（无 chaos fixture）同样 ERESOLVE**（`/tmp/pca45-control/c1.log`）；`dsh@0.1.0-rc.6` 锚点安装超时。
  0.1.0 线今日可构造端点为同 tuple 的 rc.7/rc.8——候选 range 已覆盖（tuple 0.1.0，`>=0.1.0-0` 成员），实证 INSTALL OK。
  结论：候选 range 对 0.1.0 线的承诺成立且以可构造现实为界；字面 rc.6-only 宿主属上游不可复现，不阻塞修复。

## Finding F2（本次新发现，测试面 drift）— dsh-llm brand 改名 `CallId` → `ToolCallId`

- 基线（0.1.0-rc.5 era）：`packages/llm/llm/src/brand.ts` `export type/function CallId`
- `dsh-v0.1.2-rc.1` 与 `dsh-v0.1.3-alpha.1`：改名 `ToolCallId`
- 影响：**仅测试面**——`tests/chaos.spec.ts` 的 `import { CallId }` + `CallId('c1')` 对 0.1.2-rc.1 类型不再编译
  （TS2614）。chaos **production src 不 import CallId，零影响**（PCA-07 覆盖的 src 消费面全部无破坏）。
- 最小修复：测试导入改 `ToolCallId`（2 行）。

## 候选 peer range（PCA-02 草稿；批准后才落入 package.json）

| peer | 候选 union |
|---|---|
| dsh-invariants / dsh-llm / dsh-tools | `>=0.0.1-rc.1 <0.1.0-0 \|\| >=0.1.0-0 <0.2.0-0 \|\| >=0.1.1-0 <0.2.0-0 \|\| >=0.1.2-0 <0.2.0-0 \|\| >=0.1.3-0 <0.2.0-0` |
| dsh-tool-call-timeout-policy | 同构，地板 `>=0.0.1-rc.3`（**独立评估，不继承**） |
| cordis | `>=4.0.1` 不变（stable 线） |

语义：保留 0.0.1 线旧宿主兼容（PCA-03）；每条已发布/源码内 0.1.x prerelease 行一个显式成员
（0.1.0/0.1.1/0.1.2/0.1.3）；`0.2.x` 一律 `<0.2.0-0` 排除。**未来新行（0.1.4-alpha 等）须过 PCA-07/09 后再加成员。**

## 最小 patch 方案（未实施；待用户批准）

1. `package.json`：5 个 peer 按上表替换（仅声明，无 production 行为变更）
2. `tests/chaos.spec.ts`：`CallId` → `ToolCallId`（import + 调用点，2 行）
3. （建议）新增 `tests/peer-range.spec.ts` 式 semver regression，锁死已发布 tuple 矩阵，防未来被"简化"
4. 版本 bump + CHANGELOG（如 v0.2.0 兼容性补丁，按仓库约定定版号）
5. 发版前复跑：基线 typecheck/vitest + 0.1.2-rc.1 clean-room（复用 `/tmp/pca08` 流程）+ npm strict 安装矩阵 + exact tgz 审计

## 后续复制路径（dsh-chaos 全绿后）
- `dsh-tool-bulkhead` / `dsh-tool-idempotency`（依赖面接近：tools/invariants）：共用 `/tmp/pca08` 式 harness 模板
- `dsh-tool-transaction` 最后单独做（事务 commit/rollback golden path，重点验 session/agent-loop/tool-execution 语义）
