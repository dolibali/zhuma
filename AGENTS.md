# Zhuma 开发约定

## 范围与结构

先阅读 `README.md` 和 `docs/architecture.md`。自研代码在 `packages/`；上游仅在 `upstream/deepseek-harness/`，默认保持干净。不得把上游整个 Workspace 合并进根 Workspace。

- `agent-core`：纯工程领域，不依赖 DSH、Electron、React、文件系统和网络。
- `context`：上下文与证据；可以依赖 `agent-core`，不反向调度 Agent。
- `dsh-adapter`：Host/执行适配；可以依赖 `agent-core`、`context`。
- `client`：客户端公开模型和后续 UI；不得导入 `dsh-adapter` 或 Host-only 代码。

跨包使用 `@zhuma/*` 入口，禁止跨包相对路径和直接引用上游源码。包内 ESM 相对引用使用 `.js`，由 TypeScript 编译解析。

## 修改与验证

不要覆盖与当前任务无关的修改，不自动重置用户工作区。只改明确范围，不因为初始化就实现完整框架。

提交前执行 `pnpm check`。变更上游基线时同步 `.gitmodules`、gitlink、`runtime.lock.json` 和说明，并执行 `pnpm upstream:check`。上游内部的开发规则只适用于上游，不替代本仓边界。

所有成功、通过和恢复状态应来自真实执行。模拟测试只标记为契约测试；CLI 退出成功不等于业务验收通过。历史验证不能认证后续修改的代码。

## 执行与隐私

未经用户要求，不启动付费模型、不创建远程仓库、不推送、不发布、不运行生产操作。不要读取或输出真实密钥。模型凭据、会话库、内部资料、个人路径和签名文件不提交。

保持公开工程的中性命名。第三方版权和许可不能因改造或改名删除。用户指定的 Git 身份只设置到当前仓库，不修改全局配置。

桌面复用官方实现，不另写 Electron 壳；品牌与必要补丁在临时构建树中应用。实际接入和安装包未验证前，不把本骨架称为已完成产品。
