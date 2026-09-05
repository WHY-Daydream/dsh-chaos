# Changelog

本项目的版本历史。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-09-05

**Latest DSH compatibility fix** — 纯兼容性 patch release，无 production 行为变更
（peer 声明 + 测试导入修复 + regression；未改 chaos 故障注入逻辑）。

### Fixed

- **peerDependencies 对 DSH prerelease 版本的 npm semver 匹配**（F1）：`dsh-invariants` /
  `dsh-llm` / `dsh-tools` 的裸地板 `>=0.0.1-rc.1` 与 `dsh-tool-call-timeout-policy` 的
  `>=0.0.1-rc.3` 只能匹配 `(0,0,1)` 元组的 prerelease；npm semver 规则下 DSH 0.1.x 全行
  （0.1.0-rc.x / 0.1.1-rc.x / 0.1.2-rc.1 / 0.1.3-alpha.1）均被挡在门外（npm strict install
  报 ERESOLVE）。改为**按已通过 PCA-07/PCA-09 验收的 prerelease 行显式列出的 per-line union**：
  `>=0.0.1-rc.1 <0.1.0-0 || >=0.1.0-0 <0.2.0-0 || >=0.1.1-0 <0.2.0-0 || >=0.1.2-0 <0.2.0-0 || >=0.1.3-0 <0.2.0-0`
  （timeout-policy 使用自己的独立地板 `>=0.0.1-rc.3` 起点的同构 union，不继承其他 peer 的结论）。
  语义：保留 0.0.1 线旧宿主兼容；覆盖 0.1.0 / 0.1.1 / 0.1.2 / 0.1.3 已测行；`0.2.x` 一律
  `<0.2.0-0` 排除。**不承诺**"所有未来 0.1.x prerelease"——新的 0.1.x tuple（如 0.1.4-alpha.x）
  必须先重跑 compatibility acceptance（PCA-07/PCA-09）再加对应成员。
- **测试导入修复**（F2）：`@deepseek-ai/dsh-llm` 在 0.1.0-rc.5 → 0.1.2-rc.1 之间将 call-id
  brand `CallId` 改名为 `ToolCallId`；`tests/chaos.spec.ts` 两处导入/调用随之更新。production
  src 不消费该符号，零影响。

### Compatibility Acceptance（PCA-01 ~ PCA-10 ALL PASS）

- PCA-01 旧 peer range ERESOLVE 复现 ✅；PCA-02 新 range semver regression ✅
- 真实 npm strict install：DSH `0.1.1-rc.2` / `0.1.2-rc.1` 干净 PASS；
  0.1.0 prerelease tuple 使用**可构造的 host 组合（rc.8）**验证 PASS —— `rc.6-only`
  组合因对应上游 package family（dsh-brand / dsh-scope 等在 0.1.0 线内漂移到 rc.7/rc.8）
  本身不可严格构造，属**上游组合约束，非本插件不兼容**（纯 host 对照亦 ERESOLVE，已实证）
- 0.1.2-rc.1 clean-room runtime：typecheck + vitest 20/20 + chaos/timeout-policy golden
  5/5 + invariant companion registration ✅；consumer-symbol 三 ref audit 无破坏 ✅

### Docs

- `docs/audit/pca-complete-report.md`：完整 PCA 报告与最小 patch 依据（audit 分支）
- `docs/audit/pca02-candidate-ranges.md`、`docs/audit/pca07-consumer-symbol-audit.md`
