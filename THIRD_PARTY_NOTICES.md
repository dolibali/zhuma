# 第三方来源与许可

## DeepSeek Harness

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 位置：`upstream/deepseek-harness/`（Git 子模块）
- 基线：`dsh-v0.2.1-rc.4`
- 提交：`504a01a9578abc2c6f1fb896b1dc322c9fe24f66`
- 上游许可：保留 [LICENSE](upstream/deepseek-harness/LICENSE) 及其第三方声明。
- 本次未复制、改写或重新署名上游实现；仅锁定子模块提交。

DSH 的 MIT 许可与本仓自有代码许可分别处理。其依赖、图标、品牌和其他内容应按各自声明处理。

## DSH ACP Adapter

- 社区仓库：<https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter>
- 发布包：`@zaimokuza/dsh-acp-adapter@0.2.1-rc.4.1`
- 源码提交：`28ccc6745ec82139c684c3642637e93e00d800f2`
- 许可：MIT；保留包内 `LICENSE`、原作者版权与实际依赖许可。
- 通过官方 SDK 临时构建树的独立锁文件固定包完整性，记录于 `runtime.lock.json`；本仓不将它加入根 Workspace。它作为附加执行器注册，不替换默认原生 Agent。
- 实际使用范围与修改边界见 [来源登记](third_party/acp-adapter.md)。

## 其他参考与依赖

本骨架未复制 ZCode、AOCI、社区工作流或第三方桌面产品的源码。后续实际抽取模块时，在 `third_party/` 登记仓库、提交、原路径、许可、修改及验证。

TypeScript、Prettier 与 Node 类型仅作为本仓开发工具，具体版本锁定在 `package.json` 和 `pnpm-lock.yaml`，保留各包的许可。正式分发前另生成实际依赖清单。

## 工作台客户端与校验依赖

工作流画布使用 React Flow / @xyflow（MIT），数据结构使用 Zod（MIT）；React 由 DSH 提供。版本锁定于 pnpm-lock.yaml。自有插件构建时按实际打包输入收集包括传递依赖在内的完整许可文本，生成随插件分发的 `THIRD_PARTY_LICENSES.txt`，不删除第三方声明。esbuild 只用于构建。
