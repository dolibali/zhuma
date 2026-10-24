# 实施顺序

以 [产品能力覆盖账本](product-coverage.md) 保留 FR01–17 的范围、证据基线与退出条件；[总索引 #25](https://github.com/dolibali/zhuma/issues/25)及对应 Issue 是实时阶段、依赖和阻塞的唯一入口。原型主要能力是范围基线，UI/UE 可重做；不能以目录 CRUD、领域契约或布局完善代替用户任务闭环。

任务 → 同一 workspace 持续会话 → 固定产物 → 多人评审的补充范围与分期见[联动方案](architecture/task-session-delivery/development-plan.md)（PR #13 范围、[PR #15](https://github.com/dolibali/zhuma/pull/15) S1 接入分工与 [PR #16](https://github.com/dolibali/zhuma/pull/16) LC-11 同页 CLI 交接均已合入；这只是方案基线）。保留六工具逐一验证、本地专家及项目四入口的范围，按原批次接入，先完成首个正式身份／人工交付／评审切片，再接原生会话和一个外部工具；不等待六工具全部完成才联调。

## 已有基础与边界

四包依赖、固定官方 DSH、Host/Client 插件、组织目录、计划编排与模型规划提案已建立。A 的组织数据由 Host 持久化；B 除状态机／并发契约外，已发布 M1 执行服务、草稿、退回意见、待办分组及事件等候选，累计交付与证据见 [#30](https://github.com/dolibali/zhuma/issues/30)。这些模块仍需正式 Host／正常入口组合验收，不将发布误记为集成，也不将待集成写成没有实现。当前不称为完整产品。

执行适配 [PR #10](https://github.com/dolibali/zhuma/pull/10) 与身份 [PR #18](https://github.com/dolibali/zhuma/pull/18) 的交付通过 [#26](https://github.com/dolibali/zhuma/issues/26)／[#27](https://github.com/dolibali/zhuma/issues/27) 跟踪。PR #11／12 已分别合入 `5bcd3f2`／`0d3b70a`；具体候选、累计 head 与正式验证以对应工作项引用为准，独立演示不认证原生会话。

A-UX2a 目录/表单及浏览器 CI 已合入；A-UX2b 导航见 PR #6，已合入并完成三层草稿导航验证，不追加装饰性范围。执行状态只有权威服务确认后才展示。

## 工作项入口

此表只映射范围，阶段、优先级和依赖读取 Issue，不在这里手抄。后续项不是同时开工指令；先按 #25 拉取一个主要切片。

| 范围                                 | 工作项                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份与共享接入                       | [#27](https://github.com/dolibali/zhuma/issues/27) / [#28](https://github.com/dolibali/zhuma/issues/28) / [#29](https://github.com/dolibali/zhuma/issues/29) / [#31](https://github.com/dolibali/zhuma/issues/31) / [#32](https://github.com/dolibali/zhuma/issues/32) |
| 执行适配、人工／文件交付和持续 Agent | [#26](https://github.com/dolibali/zhuma/issues/26) / [#30](https://github.com/dolibali/zhuma/issues/30) / [#33](https://github.com/dolibali/zhuma/issues/33) / [#35](https://github.com/dolibali/zhuma/issues/35)                                                      |
| 权威视图与多层树                     | [#34](https://github.com/dolibali/zhuma/issues/34) / [#40](https://github.com/dolibali/zhuma/issues/40)                                                                                                                                                                |
| 工作流复用、资产与个人专家           | [#36](https://github.com/dolibali/zhuma/issues/36) / [#37](https://github.com/dolibali/zhuma/issues/37)                                                                                                                                                                |
| 编排质量                             | [#38](https://github.com/dolibali/zhuma/issues/38)                                                                                                                                                                                                                     |
| 项目权威成果                         | [#39](https://github.com/dolibali/zhuma/issues/39)                                                                                                                                                                                                                     |
| 专家评审与批量反馈                   | [#41](https://github.com/dolibali/zhuma/issues/41)                                                                                                                                                                                                                     |
| 协作统计与外部集成                   | [#42](https://github.com/dolibali/zhuma/issues/42)                                                                                                                                                                                                                     |
| 多账号样例及部署恢复                 | [#43](https://github.com/dolibali/zhuma/issues/43) / [#44](https://github.com/dolibali/zhuma/issues/44)                                                                                                                                                                |
| 桌面遗留验收                         | [#45](https://github.com/dolibali/zhuma/issues/45)                                                                                                                                                                                                                     |

首批已集成的历史证据：[入口 PR #7](https://github.com/dolibali/zhuma/pull/7)、[规划上下文 PR #14](https://github.com/dolibali/zhuma/pull/14)、[模板 PR #17](https://github.com/dolibali/zhuma/pull/17)、[资产 PR #19](https://github.com/dolibali/zhuma/pull/19)、[专家目录 PR #21](https://github.com/dolibali/zhuma/pull/21)、[项目 PR #22](https://github.com/dolibali/zhuma/pull/22)（`79a4466`）及[局部配置调整 PR #24](https://github.com/dolibali/zhuma/pull/24)（`f90f2d8`）。这些切片不关闭整项产品退出条件。

范围与接入约束：

- **A-UI-controls**：PR #8 已合入统一锚定选择控件及标题避让；实际 macOS 三档缩放、长目录和浅深展开证据已记录。PR #9 已合入中性侧栏；拖窗和真实系统浅色／切换仍属 A-DESKTOP1 未验收项，不通过 CSS 或媒体模拟关闭。
- **A-PLANQ / FR02/04/13**：上下文首批已合入 `5aa75c0`；显式局部配置范围、变更前后值和保护已随 PR #24 合入 `f90f2d8`，见[接口与证据](planning-adjustments.md)。真实模型质量、语义候选效果与结构局部调整由 #38 继续验收。缺少 B 的权威连接／忙闲事实时保持未知，不另建 Agent 循环或向量库。

- **B-ID0 / FR16**：预置账号、真实会话与可信 actor、个人/团队成员授权、空间隔离。先给固定 DSH 的最小适配证据；不把模型平台账号或 browserPeer owner 当产品账号。
- **权威视图 / FR05/06**：A 在 #34 接同源任务列表／阶段看板和待办深链，消费 B 的权威任务阶段及业务投影；#32 仅挂接 B 的具体待办／交付／评审业务页。不从 draft/ready 猜执行，禁止拖卡绕过评审。
- **身份与空间 UI / FR16**：B 在 #27／#29 提供可信会话和空间授权接口，A 在 #31 实现登录、个人／团队切换与成员入口。树深链与刷新偏好按账号／空间／任务隔离，失效位置回退。
- **B-ID0 + A 集成 / FR17**：本地单实例可启动和重启恢复先行，K8s 为后续指定测试环境目标。演示至少 3 账号/2 团队并有人跨团队；双账号退回重提与第三账号越权拒绝必须真实验证。

下一可用版本必须包含人与 Agent 协作链。A/B 不互相造服务：A 实现组织、规划和共享入口，B 实现可信运行、产物、评审与状态；联合验收从普通任务入口走完整路径。

## 后续与发布门槛

- P1 外部研发平台单独排期；先一个明确需求源/代码平台往返及幂等回写。高级运行调整、复杂锚点和大规模树优化按实际需要拆批。
- P2 再考虑更多平台、外部 MCP 与企业组织治理；不得静默删除已有 P0。
- 桌面继续复用官方实现。独立数据目录、退出/重开、打包/安装验证单列，Web Host 成功不能代替安装版验证。
- 不建设独立 Rules、独立讨论、冗余验收面板和单独多层演示区。保留必要业务审计与版本，但不堆叠解释文案。

## 近期待交付的具体边界

- **A-DESKTOP1**：图标外观入口与标题避让已进入 UI-controls；中性侧栏材质、系统浅深解析、聚焦/失焦、窗口拖动、全屏/还原与重开另作桌面批次。系统模式沿用官方主题服务；不得用第三套主题状态或更改用户系统设置完成测试。用户正在使用的窗口不再用于自动化缩放。
- **A-TEMPLATE / FR02/12**：首批 PR #17 已合入 `759270d`，见[协议与边界](workflow-templates.md)及[实际截图／分层证据](review/templates/README.md)，不关闭整个 FR 或完整资产生命周期。创建统一为“AI 规划 / 使用工作流 / 从空白开始”；只显示所选摘要，在当前空间目录内搜索；团队／我的筛选依赖 B 的真实可见性投影，仍未完成。预览节点、依赖、层级、所需角色/资源及缺项；优先任务参与者映射，范围外人选显式加入。缺项可保存草稿，执行确认沿用校验，不能静默删除多人评审。
- 模板复用现有 Workflow/WorkNode 定义和校验，在原子幂等创建中重建任务/流程/节点 ID、整体重映射依赖与父级，保留并行/嵌套/交付与评审，记录源版本快照。结构实例化不发模型请求，之后“按目标调整”显式调用同一规划器、预览差异。旧文本模板需显式转换保存；源资产不变。提供“保存为工作流”，仅保存定义/角色/允许的资产绑定，排除实际产物、评论、运行状态、私人材料与凭据。跨空间权限由 B-ID0 单一维护，未联调前不能声称团队/个人隔离完成。
- **A-ASSET-IMPORT / FR12**：资产分类可见为全部/工作流/Agent 专家/Skills/MCP，分类有计数、搜索、新建、导入及空态；专家复用同一稳定定义，真人仍属成员管理。首批 PR #19 已合入 `fddf6b8`：目录／ZIP 静态识别、内容／缺项预览、新建或明确更新、来源版本与文件保存；官方隔离桌面 ZIP／冷重开通过，[证据](review/asset-import/README.md)。当前归属仅现有工作台，空间授权、发布和历史运行包物化仍待接，不另建资源平台。[兼容边界](asset-import-compatibility.md)。

## 专家定义与个人入口的既定队列

- A 先逐项核对已确认的既有研发专家清单、依赖与来源许可，再选择可迁入内容默认内置；稳定 ID／版本、复制修改与升级保护共同验收。没有实际迁入不能把原创示例或手工导入标为默认内置完成。
- A 实现团队工作台下方的个人专家入口及搜索／分类／收藏／导入／详情；个人无需团队任务的直接使用和团队发布由 A 入口与 B 会话／授权共同接通，不能另造执行器或把 unknown 标成功。
- PR #20 已合入 `e081b86`：四个原创 [起步包](../resources/experts/starter-pack/README.md)是小型定义与导入样例，不改变以上两项退出条件。各包有来源与许可、单独导入所需的全部文件和待验场景，模型效果、原生运行和默认预装仍未验收。

- **A-EXPERT-BROWSE**：PR #21 已合入 `8ac6cb4`（首批 `863deb3`、恢复修复 `8f1e1aa`），先交独立浏览／定义维护入口，搜索和配置复用同一目录；[界面对照与分层验证](review/expert-library/README.md)。收藏与个人直接使用、真实既有专家迁入及默认内置／升级继续按原退出条件，不追加无效运行按钮。

## A-INTEGRATE-S1 与后续会话交接

Host 身份装配及执行装配分别由 #28／#32 跟踪，依赖与集成顺序以 #25 为准。S1a 的显式模式、身份子作用域与父门禁已随 PR #23／#48 集成至 main `843661c`；项目 ID 不能替代空间身份，#29 的可信归属事实仍由 B-ID0 提供，A 只作 Host 注入，不新建授权库。后续 S1b 须核对实际模块／DTO、DI／加载顺序／导出及 Inbox／提交／评审 props，复用已打开 WorkbenchService 的 Host-only readWorkbench 快照闭包，再组合执行服务和注册已审业务组件。各 domain 只打开一次，浏览器不获全量读取接缝；B 提供成员 cookie、空间过滤和业务事实，A 单写共享整合。成员模式缺 cookie、身份加载失败或卸载都不回落 owner；模式必须显式配置。已集成门禁覆盖 snapshot／command／plan／preview-import／resource-files 五个 exact 入口及 import-package，在解压、读取或写包前拒绝无权请求。身份测试的公共预构建与 120 秒启动配置沿已合入版本维护，不能只复制项目注册或据此认证后续业务。

S1a 的身份组合基线为 develop `772b59c41f1812051931348289f576aeadc5ae8f`，保留旧五接口流式门禁、显式单人兼容与 Host-only 快照闭包，见[范围](host-identity-integration.md)和[分层验证](review/s1a-host/README.md)。原实现 `6a0fd6f` 与同步组合 `a4ea4d1983ac6553fefc4ffd73fa3fa3e5758fe1` 的证据各自绑定来源版本、发行字节和环境，不能认证后续新增组合。S1b 等 B 提供真实项目→产品空间绑定及业务 DI 后接执行／待办／提交／评审，不提前用虚构映射挂载页面。

S2 的 [LC-11／LC-T11](architecture/task-session-delivery/test-plan.md) 先做 Zhuma 加一种外部 CLI 的同工作会话交接：真实停止／写权释放、目标实际受理后切换当前执行段，原责任、历史、提交版本及评审义务保持。其余工具逐项补齐；不另建聊天库或默认 Host factory。此项只有方案，尚未实现验收。

A-PROJECT 首批已随 PR #22 合入 `79a4466`；`83ab303` 的[交互／兼容边界](project-hub.md)与[分层证据](review/project-hub/README.md)单列。项目 ID 与产品空间保持独立；项目默认参与者仅初始化新草稿，显式关联资产进入现有规划预算，链接正文不自动抓取。当前不实现归档或运行中职责变更，不能据草稿／已确认推断真实阶段与已接受产物。
