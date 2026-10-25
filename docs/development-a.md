# A：组织与编排的第一条开发链路

本文记录组织与编排首批的范围和契约。以现有 DSH 官方桌面和 Host/Client 插件为承载，原型只提供场景参考。分支、当前阶段和累计 head 以[总索引 #25](https://github.com/dolibali/zhuma/issues/25)及工作项更新为准，不由本文维护实时状态。

A 的交付入口：[Host 身份装配 #28](https://github.com/dolibali/zhuma/issues/28)、[登录／空间 UI #31](https://github.com/dolibali/zhuma/issues/31)、[Host 执行／显式开始／导航 #32](https://github.com/dolibali/zhuma/issues/32)、[权威视图 #34](https://github.com/dolibali/zhuma/issues/34)、[工作流复用 #36](https://github.com/dolibali/zhuma/issues/36)、[资产／专家 #37](https://github.com/dolibali/zhuma/issues/37)、[编排质量 #38](https://github.com/dolibali/zhuma/issues/38)、[项目成果 #39](https://github.com/dolibali/zhuma/issues/39)及[桌面剩余验收 #45](https://github.com/dolibali/zhuma/issues/45)。这些入口保留范围，不表示并行开工。

## 首批交付范围

项目、成员/专家目录、团队资产定义、任务参与者、可编辑工作流（列表与工作流画布）、嵌套工作流定位；AI 基于同一份人员和资产快照生成草案，用户确认后写入工作流。数据保存在 DSH storage domain，不以浏览器 localStorage 作为业务事实源。

第一版是单个本地 Host 的组织工作台。目录中的人员用于分工，不代表已登录的远程成员；多用户身份认证、执行调度、产物、评审投票及运行状态回写由 B 接入。发布计划只生成待执行交接数据，不调用执行器。

## 自动规划

成员工作台的 Host 接线消费 [#104](https://github.com/dolibali/zhuma/issues/104) 已交付的三条独立 `/api/zhuma-member/{snapshot,command,plan}`；复用已打开的 WorkbenchService，关闭旧 owner 路由。Client 按当前账号／空间及页面代次绑定，每次业务请求先重新确认会话，Host 仍独立授权。创建和更新意图在首次发送时固定，原内容重试保留原请求 ID／版本／意图；确认仅发送已保存草稿的任务 ID。模型缺失不阻塞手工读写，规划失败保留原草稿。资源目录未接入时不借用 legacy 的专家／资产。

Host 唯一打开成员操作意图域；关停先封 HTTP 并等待已接纳操作稳定，再关闭意图域，最后关闭工作台／资产域。取消不是持久写回滚。`s1a-host.test.mjs` 的正常成员案例使用真实发布版 DSH、Cookie、独立 Node 进程和 JSON 域，覆盖无模型创建／保存／确认、规划缺失原稿不变、同 ID 重试、计划发现及 held write 卸载／同盘恢复；`test:host` 对构建产物运行同一组八项案例。Client 的新 HTTP／适配器测试是契约测试，新增 `member-workbench.spec.mjs` 只描述响应重放交互，由协调执行浏览器验证。真实模型质量、正式原生 Run、工作区与安装版桌面仍需各自证据；本切片不认证这些链路。个人专家和码道按原范围后置。

1. 收集目标、项目背景、限定参与者的职责与能力、可用专家、Skills/MCP 和工作流模板；只发送定义，不发送凭据。不以计划中的分配推断当前运行负载，运行可用性和授权由权威接口另行提供。
2. 经 DSH 已配置模型生成结构化草案。无法合理分配时提出问题；说明各节点的分工理由、输入、输出和依赖。模型不执行工具，也不启动节点。
3. 验证 JSON、成员与资产引用、依赖无环、评审人、嵌套关系和规模。校验失败最多一次定向修复，仍失败保留原计划并报告问题。
4. 展示草案和问题，允许补充要求重新规划、查看分工依据和自由编辑。调整未应用草案时，客户端发送 `baseProposalId`，Host 核对已完成提案所属任务及工作台版本，以其完整工作流、问题和推断作为本轮基线；不会先应用旧草案，也不会将其拼入有限长度的补充要求。确认应用时核对创建草案时的版本，防止覆盖同期修改。
5. 记录实际模型路由、精确规划输入和结果；未配置模型时明确不可用，禁止用模板冒充 AI 生成。

[PR #24](https://github.com/dolibali/zhuma/pull/24) 已随 `f90f2d8` 合入 develop，补充[显式局部范围与变更预览](planning-adjustments.md)；其模型质量等剩余退出条件继续在 #38 跟踪。项目四入口首批 [PR #22](https://github.com/dolibali/zhuma/pull/22) 已随 `79a4466` 合入，项目权威成果与归档仍由 #39 保留。

## A/B 交接

A 维护 Project / Participant / Asset / Task / Workflow / WorkNode 定义。节点包含目标、执行者、Skills/MCP 引用、输入/输出说明、依赖和多位评审人。B 消费已确认的节点快照；后续执行事实另由 B 的服务产生，A 不直接修改运行状态。人节点不要求模型或引擎；专家身份与执行后端分开。

登录／空间切换 UI、显式开始和共享导航由 A 负责；可信会话／空间授权事实和 ExecutionWorkspace 内部业务由 B 提供。工作项 #29 的可信 provider 不能由项目 ID、浏览器 actor 或临时样例推导代替。已发布 M1 模块、累计 head 和运行证据通过 #30 跟踪，未集成不等于没有实现。

本轮 RPC 复用 DSH 的认证 Connection；仅允许 Host owner。`snapshot` 返回 schemaVersion 和 revision；`command` 接收 requestId、expectedRevision 和命令，持久化成功才响应。串行写入、版本冲突拒绝、重复 requestId 不重复执行。`plan` 只生成提案，取消、超时和失败都不改变工作流。读取时不隐式生成样例。不会新增第二个 Electron 壳、模型协议或 Agent Loop。

`plan.baseProposalId` 是可选的已完成规划请求 ID；省略时从已保存工作流开始，有值时仅从 Host 的规划审计读取，不接受客户端上传的替代草案。未知或被审计保留策略清理的提案返回 `proposal-unavailable`，跨任务引用返回 `proposal-mismatch`，任务或目录版本变更返回 `conflict`。同一个请求 ID 更换提案引用会被幂等检查拒绝。原草案在失败或取消后仍可审阅；已知版本冲突时禁止继续调整或应用，用户可显式读取最新版本。

## 交互参考与取舍

- [Linear 子任务](https://linear.app/docs/parent-and-sub-issues)：沿任务上下文继续拆分，保留父级定位。
- [Linear Agents](https://linear.app/docs/agents-in-linear)：人与 Agent 同处参与者选择，明确各自职责。
- [n8n AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder.md)：自然语言生成后继续审阅和修改；模型输入包含节点定义与连接，不包含凭据。
- [LangGraph workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents)：结构化规划、编排者分解和显式交接；只借鉴模式，不另引运行时。
- [Dify LLM](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)：结构化输出与可复用的模型配置。
- [React Flow](https://reactflow.dev/learn)：采用成熟画布支持拖动、连线、缩放和键盘操作。

验证分为领域与规划契约测试、真实 DSH 插件加载/持久化、浏览器交互。没有真实模型调用时只报告规划契约结果，不宣称规划质量验收通过。
