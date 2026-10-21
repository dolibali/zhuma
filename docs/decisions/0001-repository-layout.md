# ADR-0001：独立产品仓库与固定 DSH 上游

状态：采用。日期：2026-10-20。

## 决策

产品主仓使用中性名称 `zhuma`，自研包为 `agent-core`、`context`、`dsh-adapter`、`client`。DSH 完整源码放在 `upstream/deepseek-harness/`，用 Git Submodule 固定到 `dsh-v0.2.1-rc.2` 的精确提交。

这是初始化基线，不声称该候选发布版本已经通过本产品完整验收。升级需显式修改 gitlink 和 `runtime.lock.json`。

## 原因

复用官方桌面、Host 与 Web Client，避免另建桌面框架；保留独立插件边界，避免自研代码散布到上游。上游拥有独立 Workspace 和工具链，不能混用根 pnpm 锁文件。

## 发行修改

品牌与发行参数在 `branding/` 和 `distribution/`，必要代码变化记录为 `patches/` 中的补丁。构建在 `.build/` 工作树进行。补丁增多时再评估辅助 Fork，不复制整个上游到普通业务目录。

## 代价

开发者需要初始化子模块；真实桌面集成还需准备上游工具链。CI 首先验证本仓骨架与上游 pin，不把它等同于发布验收。
