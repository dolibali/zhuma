# 开发指南

第一次运行先读[源码运行与本地部署](getting-started.md)：其中给出完整检出、工具安装、Windows/macOS 桌面启动、可选共享后端、Linux 包运行及数据保留。这里维护开发边界和日常命令；[架构](architecture.md)解释当前模块和事实归属。

## 仓库与工具

根仓库使用 Node.js `24.15.0`、pnpm `12.4.2`；固定 DSH SDK 使用自己的 `pnpm@11.28.5`。以 `.node-version`、`.nvmrc`、`package.json` 和 `runtime.lock.json` 为准，不自动修改全局工具。根 Workspace 只有 `packages/*`，不能纳入上游整套 Workspace。

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm upstream:check
```

从克隆开始的完整命令及 Corepack 安装见[运行指南](getting-started.md)。仅安装根依赖或通过 `pnpm build`，不会生成可运行桌面。Windows/macOS 使用对应本机依赖；Linux 服务原生构建不复制另一系统的二进制。Node 的 TypeScript 支持不得被 `--no-experimental-strip-types` 禁用。

## 目录与依赖

| 目录/包                     | 作用                                  |
| --------------------------- | ------------------------------------- |
| `packages/agent-core`       | 纯领域契约与任务/计划/交付模型        |
| `packages/context`          | 有来源/版本的上下文和证据             |
| `packages/dsh-adapter`      | Host、运行、身份/空间、存储与运输适配 |
| `packages/client`           | 工作台、成员处理、会话与评审 UI       |
| `resources`                 | 工作流、Skills、专家等资源            |
| `scripts`、`distribution`   | 准备、构建、核验及桌面/服务发行材料   |
| `docs`、`tests`、`examples` | 技术文档、验证约定和独立示例          |
| `upstream/deepseek-harness` | 由子模块锁定的官方依赖源码            |

包边界与通用工程约定见 [AGENTS.md](../AGENTS.md)；跨包走 `@zhuma/*` 公开入口。公共 DTO、装配及持久化协议的变更，应明确影响范围、兼容方式和验证方法；身份、聊天与工作台数据继续沿各自的权威来源维护。

## 常用命令

以下在根目录运行；环境检查写作 `pnpm run doctor`，避免命中 pnpm 自带的同名命令。

| 命令                                        | 作用与边界                                              |
| ------------------------------------------- | ------------------------------------------------------- |
| `pnpm build`                                | 构建四个产品包的 TypeScript 引用                        |
| `pnpm typecheck`                            | 先构建引用声明，再检查各包类型                          |
| `pnpm test`                                 | 构建后运行 Node 测试，模型/特定环境项目保留原显式条件   |
| `pnpm check`                                | 仓库、图标、格式、类型和上述测试；提交前必须执行        |
| `pnpm check:repo`                           | 检查 Workspace、命名和导入边界                          |
| `pnpm format:check` / `pnpm format`         | 检查/整理自有文件，排除生成与上游目录                   |
| `pnpm upstream:check`                       | 核子模块 URL、gitlink、HEAD、版本及干净状态             |
| `pnpm workbench:build`                      | 生成 `.build/workbench` 的产品插件文件，不启动应用      |
| `pnpm desktop:prepare` / `pnpm desktop:dev` | 准备隔离桌面源码/编译并启动；不同于普通包构建           |
| `pnpm test:host`                            | 构建工作台并核组合 Host，使用独立测试数据；不是安装验收 |
| `pnpm test:ui`                              | 构建工作台并运行浏览器契约；不是产品实机/模型证明       |
| `pnpm clean`                                | 删除四个产品包的 dist，不是用户数据迁移工具             |

`examples/` 与 `workspace:demo`、`test:browser` 中的早期模拟演示保留原语义，不是当前产品共享服务入口。正式源码启动和部署使用[运行指南](getting-started.md)中的真实脚本，不把临时演示或夹具当作真实成员业务。

## 模型、状态与本机数据

人工编排/提交不要求模型。后端 AI 规划与桌面本机执行各用自己的模型设置和凭据，入口、隔离目录和开发网关开关见[运行指南](getting-started.md)。不提交密钥、个人路径、会话库、用户材料或操作者能力文件，不复制其他安装的 profile。

新建桌面 profile 进入明确的本机成员设置；旧 profile 保持原模式和数据，不自动迁移。根发行 overlay 的 legacy 兼容值不能用来推断新安装默认模式。任务/计划与执行/交付状态分开，浏览器选择不能替代服务授权，CLI 完成不等于节点已交付。

## 验证和交付

变更通过独立 topic 分支和 Pull Request 集成，遵守仓库有效保护规则；Issue/PR 可使用 GitHub 插件或 `gh` 管理。通用约定见 [AGENTS.md](../AGENTS.md)，长期范围与历史证据见[产品范围](product-coverage.md)。

提交变更时说明解决的问题、行为变化、影响范围及验证结果。检查记录绑定准确源码版本，区分契约、真实 Host、界面、模型和安装等层次；详细证据保留在对应 PR，工作项引用结论。产品与使用文档维护稳定入口和行为说明，阶段进展集中在[总索引 #25](https://github.com/dolibali/zhuma/issues/25)与对应工作项。

当前已经提供成员创建/规划、原生会话处理、固定文字/文件交付、评审与下游等实现；完整 FR/LC、工程案例和延期范围仍读[产品范围](product-coverage.md)。`pnpm check` 只证明其实际运行的检查，不能认证模型、平台、安装或全业务通过。新增代码后的验证必须绑定新源码；未变部分按准确版本继承历史证据，不因文档整理重复 GUI/SDK/模型。

接口参考：[退回修改](contracts/client-revision.md)、[上游输入](contracts/client-upstream-inputs.md)、[草稿](contracts/client-delivery-drafts.md)、[待办](contracts/client-inbox-groups.md)。历史正式 Host/桌面记录见[验证记录](workbench-validation.md)及 `docs/review/`，只在对应 SHA/环境范围内使用。

## 固定依赖与发行

固定源码的工具链独立安装、编译；先读其开发/桌面说明，再通过本仓准备脚本在隔离树应用产品补丁，不直接修改子模块。升级需专门分支，同步 `.gitmodules`、gitlink、`runtime.lock.json` 和必要接口/平台证据；不自动追踪最新版本。

版本、签名、打包和发布操作见[桌面发行指南](../distribution/desktop/README.md)、[服务指南](../distribution/server/README.md)。发布与当前分支的代码检查分开，不能把文档准备、版本号或一次构建成功当作新包已发布。
