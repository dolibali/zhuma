# @zhuma/agent-core

工作台的智能体任务与协作核心，不是底层 Agent 引擎。

当前提供任务与计划的初始契约、依赖图校验，以及节点状态机、评审汇总、产物版本和命令幂等的纯领域规则。这些规则不调度、不持久化、不访问文件或网络。项目和计划编排只保留执行侧要读的最小形状，见 `docs/contracts/wp00-execution-delivery.md`。

不得依赖 DSH、Electron、React、文件系统或网络。后续通过端口与适配层连接实际能力。

执行调度规则在 `src/execution.ts`：运行尝试、停止回执、终态迟到信号、下一轮队列和草稿交接。已结束运行上的迟到信号不改变节点状态。这些函数不调度、不读文件。说明见 `docs/contracts/wp03-execution-context.md`。
