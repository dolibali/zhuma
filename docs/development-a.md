# A：组织与编排的第一条开发链路

分支：`develop`。以现有 DSH 官方桌面和 Host/Client 插件为承载，原型只提供场景参考。

## 本轮交付

项目、成员/专家目录、团队资产定义、任务参与者、可编辑工作流（列表与工作流画布）、嵌套工作流定位；AI 基于同一份人员和资产快照生成草案，用户确认后写入工作流。数据保存在 DSH storage domain，不以浏览器 localStorage 作为业务事实源。

第一版是单个本地 Host 的组织工作台。目录中的人员用于分工，不代表已登录的远程成员；多用户身份认证、执行调度、产物、评审投票及运行状态回写由 B 接入。发布计划只生成待执行交接数据，不调用执行器。

## 自动规划

1. 收集目标、项目背景、限定参与者（职责、能力、当前已分配节点）、可用专家、Skills/MCP 和工作流模板；只发送定义，不发送凭据。
2. 经 DSH 已配置模型生成结构化草案。无法合理分配时提出问题；说明各节点的分工理由、输入、输出和依赖。模型不执行工具，也不启动节点。
3. 验证 JSON、成员与资产引用、依赖无环、评审人、嵌套关系和规模。校验失败最多一次定向修复，仍失败保留原计划并报告问题。
4. 展示草案和问题，允许补充要求重新规划、查看分工依据和自由编辑。确认应用时核对创建草案时的版本，防止覆盖同期修改。
5. 记录实际模型路由、精确规划输入和结果；未配置模型时明确不可用，禁止用模板冒充 AI 生成。

## A/B 交接

A 维护 Project / Participant / Asset / Task / Workflow / WorkNode 定义。节点包含目标、执行者、Skills/MCP 引用、输入/输出说明、依赖和多位评审人。B 消费已确认的节点快照；后续执行事实另由 B 的服务产生，A 不直接修改运行状态。人节点不要求模型或引擎；专家身份与执行后端分开。

本轮 RPC 复用 DSH 的认证 Connection；仅允许 Host owner。`snapshot` 返回 schemaVersion 和 revision；`command` 接收 requestId、expectedRevision 和命令，持久化成功才响应。串行写入、版本冲突拒绝、重复 requestId 不重复执行。`plan` 只生成提案，取消、超时和失败都不改变工作流。读取时不隐式生成样例。不会新增第二个 Electron 壳、模型协议或 Agent Loop。

## 交互参考与取舍

- [Linear 子任务](https://linear.app/docs/parent-and-sub-issues)：沿任务上下文继续拆分，保留父级定位。
- [Linear Agents](https://linear.app/docs/agents-in-linear)：人与 Agent 同处参与者选择，明确各自职责。
- [n8n AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder.md)：自然语言生成后继续审阅和修改；模型输入包含节点定义与连接，不包含凭据。
- [LangGraph workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents)：结构化规划、编排者分解和显式交接；只借鉴模式，不另引运行时。
- [Dify LLM](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)：结构化输出与可复用的模型配置。
- [React Flow](https://reactflow.dev/learn)：采用成熟画布支持拖动、连线、缩放和键盘操作。

验证分为领域与规划契约测试、真实 DSH 插件加载/持久化、浏览器交互。没有真实模型调用时只报告规划契约结果，不宣称规划质量验收通过。
