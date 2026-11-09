# 架构与代码边界

## 当前组成

铸码复用固定 DSH 官方 Electron/Web 运行时，通过自有 Host/Client 插件管理团队工作。任务与计划、成员与权限、执行会话、固定产物与评审各有事实来源，不另建 Agent Loop、模型协议或聊天历史库。

```text
官方 Electron 桌面 + 产品品牌/发行补丁
               |
     官方 Web Client + packages/client
               |
     本机 Host + packages/dsh-adapter
               |                    |
     原生会话/模型/文件工具    产品任务/交付适配
                                    |
                     packages/agent-core + packages/context

可选共享后端：原 Web CLI + 产品成员入口/业务服务
   ↕ 成员授权 HTTP、固定产物及进度
成员桌面：在明确授权后执行本机节点
```

源码准备、各系统启动与本地部署见[运行指南](getting-started.md)；实际支持与平台资格见[发行说明](release-v1.5.1.md)及对应工作项。图中的模块是职责边界，不表示每项都是独立进程。

## 包与依赖

| 包                   | 职责                                             | 允许依赖                                | 禁止承担                                         |
| -------------------- | ------------------------------------------------ | --------------------------------------- | ------------------------------------------------ |
| `@zhuma/agent-core`  | 任务、计划、编排与交付的纯领域契约               | 不依赖其他产品包                        | DSH/Electron/React、文件系统、网络               |
| `@zhuma/context`     | 有来源和版本的工程上下文、证据                   | agent-core                              | 反向调度 Agent 或管理生命周期                    |
| `@zhuma/dsh-adapter` | 真实 Host、身份/空间、业务存储、执行与 HTTP 适配 | agent-core、context、固定运行时公开接口 | 复制执行循环或替换默认 Agent factory             |
| `@zhuma/client`      | 工作台、成员待办、会话与产物评审界面             | agent-core 的公开 DTO、官方 Client API  | 导入 dsh-adapter 或 Host-only 实现、自己裁决授权 |

跨包通过 `@zhuma/*` 公开入口，包内 ESM 相对引用使用 `.js`。根 Workspace 只有 `packages/*`；`upstream/deepseek-harness` 是固定构建输入，沿自己的 pnpm 锁安装，不合并进根 Workspace。版本和来源见 `runtime.lock.json`，目录决策见 [ADR-0001](decisions/0001-repository-layout.md)。

## 运行模式与身份

全新桌面 profile 在首次创建时明确写入 `multi-member`、`localSetup: true`，然后进入本机账号、团队和基础专家设置。已有 profile 保留原显式配置；发行 Bundle 中的 `legacy-single-user` 继承值用于兼容旧模式，不代表新安装默认进入旧单人数据。升级不自动迁移个人库，也不把读取失败当作 owner 模式回退。

成员身份、团队/空间事实和权限沿原身份服务。个人资料姓名附着于稳定成员 ID，显示名不改变会话、权限或固定计划。Client 只显示当前有权投影，空间选择或可见按钮不授予额外权限。

共享后端显式启用成员 Web、共享执行事实与本地设置。Linux 运行包通过成员网关仅开放登记路由，原操作者平面留在内部回环；源码本地服务和 macOS App 启动器是另一种同口开发入口，不能将其参数或暴露方式混用。真实 CLI、数据目录、端口与 Origin 见[运行指南](getting-started.md)。

## 事实与数据归属

| 内容                          | 权威来源与处理方式                                                     |
| ----------------------------- | ---------------------------------------------------------------------- |
| 成员、空间、目录与权限        | 原身份/目录服务，按当前身份和空间授权；UI 不保存另一份权限事实         |
| 任务、草稿及确认计划          | 产品 Workbench 服务；保存带版本/幂等，确认计划为固定快照               |
| Run、交付、评审与下游状态     | 原执行/交付业务服务；人工与 Agent 共用固定提交、评审和依赖语义         |
| 会话、消息/工具记录和模型凭据 | 固定运行时的原生会话、存储及设置服务；不另造会话库或复制凭据           |
| 正文与文件                    | 固定提交版本、文件表及授权读取；清单、链接或文件名不等于已读字节       |
| 项目工程与本机工具            | 成员明确选择和授权的工作区、读写与交付范围；共享服务不获得整个本机目录 |

后端保存团队任务、计划、依赖、固定交付和评审。成员本机模型与会话仍在各自桌面。规划在任务所属的 Host/服务执行：本机团队使用该桌面 Host 的模型配置，共享团队使用共享后端配置；节点 Agent 使用成员本机执行模型。网页成员页面不取得原生工作区控制权，后端不会因成员离线而冒名代跑。

## 正常业务链

成员创建项目和任务，选择人/专家，使用 AI 规划、模板或空白计划，编辑工作节点、依赖、资源与评审配置，再保存确认。列表、工作流与工作树投影同源计划；默认执行顺序和“全部依赖”的切换只改变显示，不删除实际依赖。预览和已确认计划的布局整理不覆盖固定历史。

成员明确开始计划或节点后，可人工提交文字/文件，也可使用本机原生 Agent 工作会话。执行、补充、停止和恢复复用官方原生接口及记录；只打开任务、刷新或重开应用不自动开始执行。原 `ExecutionResult.completed` 仅说明执行端结束，不代表业务产物已提交或已接受。

提交绑定固定正文/文件版本，指定真人或独立 Agent 评审同一提交。退回后负责人查看意见、修改并重提；全部指定评审通过且相关运行收口后才可接续。下游获得必要说明和有权已接受产物清单，再按需读取准确版本；不默认复制所有历史或把单一退出码当作通用质量门禁。

已有节点/子流程定位与工作树视图不等于完整工作树执行、无限层级调度或全部工程案例均已验收。完整范围保留在[产品范围账本](product-coverage.md)，验收按准确来源、平台与场景记录。

## 插件、源码准备与发行

四个产品包与插件/进程不要求一一对应。Host 插件组合领域服务，Client 插件装配公开界面；Skills、专家和工作流是可维护的资源。插件入口和 peer dependencies 以固定接口及生成工作台清单为准。

`desktop:prepare` 和服务 prepare 在 `.build/desktop/`、`.build/server/` 下创建独立 SDK worktree，应用可核验补丁和品牌资源，不复制一套 Electron 壳，不修改固定子模块。桌面首次 profile 的选择与已存在状态分开；业务目录、签名或模型凭据不能作为构建输入。

根产品版本、品牌构建号与固定 SDK 版本各有用途。工作台 Bundle、桌面原生包和 Linux 运行包通过准确源码/版本/摘要关联，正式来源清单和安装/运行资格沿各自流程核对。公开第三方来源、版权和许可证保留，详见[第三方说明](../THIRD_PARTY_NOTICES.md)。

## 契约与验证入口

- 正常运行：[源码与本地部署](getting-started.md)、[工作台操作](../distribution/workbench/README.md#正常操作)。
- 身份/成员接入：[Host 身份组合](host-identity-integration.md)、[成员执行入口](contracts/execution-host-entry.md)、[本机首次设置](contracts/local-member-setup.md)。
- 交付与读取：[草稿](contracts/client-delivery-drafts.md)、[上游输入](contracts/client-upstream-inputs.md)、[退回修改](contracts/client-revision.md)、[待办](contracts/client-inbox-groups.md)。
- 联动方案与范围：[任务/会话/交付设计](architecture/task-session-delivery/design.md)、[验收清单](architecture/task-session-delivery/test-plan.md)。早期 WP00/WP03 和 A/B 交接文档保留各自历史语义，不替代当前实现或实时派工。

仓库/类型/契约检查、组合 Host、浏览器响应重放、真实模型与工程结果、正常桌面和正式安装分别留证。历史记录只认证对应 SHA 和环境；当前发布不表示完整工程案例 6/6、所有 CLI/MCP 或新的 Windows 实机复测通过。实时交付与验证见 [#25](https://github.com/dolibali/zhuma/issues/25) 和具体工作项，不在架构文档复制阶段表。
