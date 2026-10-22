# 第三方来源与许可

## DeepSeek Harness

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 位置：`upstream/deepseek-harness/`（Git 子模块）
- 基线：`dsh-v0.2.1-rc.2`
- 提交：`687f282e8625c6b8d11ff58211a90524be2e4317`
- 上游许可：保留 [LICENSE](upstream/deepseek-harness/LICENSE) 及其第三方声明。
- 本次未复制、改写或重新署名上游实现；仅锁定子模块提交。

DSH 的 MIT 许可与本仓自有代码许可分别处理。其依赖、图标、品牌和其他内容应按各自声明处理。

## 其他参考与依赖

本骨架未复制 ZCode、AOCI、社区工作流或第三方桌面产品的源码。后续实际抽取模块时，在 `third_party/` 登记仓库、提交、原路径、许可、修改及验证。

TypeScript、Prettier 与 Node 类型仅作为本仓开发工具，具体版本锁定在 `package.json` 和 `pnpm-lock.yaml`，保留各包的许可。正式分发前另生成实际依赖清单。

## 工作台客户端与校验依赖

工作流画布使用 React Flow / @xyflow（MIT），数据结构使用 Zod（MIT）；React 由 DSH 提供。版本锁定于 pnpm-lock.yaml。自有插件构建时按实际打包输入收集包括传递依赖在内的完整许可文本，生成随插件分发的 `THIRD_PARTY_LICENSES.txt`，不删除第三方声明。esbuild 只用于构建。
