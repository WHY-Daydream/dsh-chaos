# PCA-02 — 候选 peer range 草稿 + semver regression（audit-only 草稿）

**Date**: 2026-09-05 · **Branch**: audit/latest-dsh-compat
**铁律**: 仅草稿。每个 tuple union member 只有在 PCA-07/PCA-09 证明该 DSH 线
runtime/API 兼容后才允许进入正式 peer range（用户规则：no member without evidence）。

## 候选 range（dsh-chaos 的 peerDependencies）

| peer | 已发布地板 | PCA-02 候选（per-line union） |
|---|---|---|
| @deepseek-ai/dsh-invariants | `>=0.0.1-rc.1` | `>=0.0.1-rc.1 <0.1.0-0 \|\| >=0.1.0-0 <0.2.0-0 \|\| >=0.1.1-0 <0.2.0-0 \|\| >=0.1.2-0 <0.2.0-0 \|\| >=0.1.3-0 <0.2.0-0` |
| @deepseek-ai/dsh-llm | `>=0.0.1-rc.1` | 同上 |
| @deepseek-ai/dsh-tools | `>=0.0.1-rc.1` | 同上 |
| @deepseek-ai/dsh-tool-call-timeout-policy | `>=0.0.1-rc.3` | `>=0.0.1-rc.3 <0.1.0-0 \|\| >=0.1.0-0 <0.2.0-0 \|\| >=0.1.1-0 <0.2.0-0 \|\| >=0.1.2-0 <0.2.0-0 \|\| >=0.1.3-0 <0.2.0-0`（**独立 floor，不继承其他 peer 结论**） |
| @deepseek-ai/cordis | `>=4.0.1` | 不变（stable 4.0.x 线，无 prerelease-tuple 问题；无上界为既有语义） |

设计要点：
- 保留旧地板成员 `>=0.0.1-rc.X <0.1.0-0` → 0.0.1 线宿主（插件首发时的 npm `latest`）继续可装（PCA-03 兼容）
- 每条已发布/源码内 0.1.x prerelease 行一个显式成员：0.1.0（rc.x）、0.1.1（rc.x）、0.1.2（alpha/rc）、0.1.3（源码 alpha.1）
- `0.2.x` 一律被 `<0.2.0-0` 排除；稳定版 0.1.x 由 `>=0.1.0-0` 成员自然覆盖
- npm semver prerelease 元组规则：候选 prerelease 须与同 set 内某比较器共享 major.minor.patch tuple

## Semver regression（脚本暂存 /tmp/pca02-semver.mjs，未入 production）

矩阵覆盖每个 peer 的**全部 npm 已发布版本** + 源码 `0.1.3-alpha.1`（expect true）+
`0.2.0-alpha.1` / `0.2.0` / 低于地板版本（expect false）→ **ALL PASS**。

结果（4 个 dsh-* peer × 15~16 已发布版本 + guards + cordis）：
- 每行已发布 prerelease：true ✅（含 0.0.1-rc.1..rc.5、0.1.0-rc.2..rc.8、0.1.1-rc.1/rc.2、0.1.2-alpha.2..5、0.1.2-rc.1）
- `0.1.3-alpha.1`：true ✅
- `0.2.0-alpha.1` / `0.2.0`：false ✅
- timeout-policy floor：`0.0.1-rc.1`/`rc.2` < rc.3 → false ✅（独立 range 生效）
- cordis `>=4.0.1`：4.0.1 / 4.0.2 / 4.1.0 → true ✅

> 注：首版矩阵的 8 个 FAIL 均为脚本守卫期望错误（把旧地板语义内的版本误标为应排除），
> 修正期望后 ALL PASS——候选 range 本身无误。
