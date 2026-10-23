# 架构与代码边界

## 产品方向

复用 DSH 官方 Electron 桌面与基础 Harness，自研功能以 Host／Client 插件组合交付。通用任务从需求、计划、实现进入验证与人审，最终交付准确版本。这里定义方向，不代表骨架已具备完整功能。

```text
官方 Electron 桌面 + 公开品牌/发行适配
                     |
        DSH Web Client + packages/client
                     |
     DSH Host + packages/dsh-adapter
          |                    |
 packages/agent-core      packages/context
          |
  后续受控编码与独立验证环境
```

## 依赖规则

| 包          | 允许依赖                                    | 不负责                                 |
| ----------- | ------------------------------------------- | -------------------------------------- |
| agent-core  | 独立领域代码                                | 模型调用、DSH 会话、文件系统、Electron |
| context     | agent-core                                  | Agent 生命周期、任务批准               |
| dsh-adapter | agent-core、context、经验证的 DSH Host 接口 | 平行 Agent Loop 或另一套任务数据库     |
| client      | agent-core 的公开 DTO、后续 DSH Client 接口 | Host 代码、文件系统、验证裁决          |

`agent-core` 可以未来拆分任务、计划、产物和验证子模块，但不用为目录数量而预先创建空服务。`dsh-adapter` 是 Host 适配边界；Client 侧只能使用公开客户端扩展 API。

## 事实归属

会话和工具历史由 DSH 管理；任务与计划由我们的工程服务管理；代码内容来自真实工作区和快照；验证结果由独立 Runner 管理；批准来自用户动作。UI 仅投影状态，切换视图不能再次执行任务。

当前 `ExecutionResult.completed` 是执行端口的结束状态，不是任务交付状态。图校验也不等于权限、预算或业务验收。

节点执行、产物、评审和并发契约由成员 B 起草，见 [WP00 执行与交付契约](contracts/wp00-execution-delivery.md)。骨架里的 `TaskStatus` 仍是任务快照，不是该契约的节点状态机。项目、任务、计划版本和节点编排字段待成员 A 对齐。

## 插件与发行

四个代码包不要求与插件数量相同。Host 插件可以组合核心服务；Client 插件显示相应模型；Rules、Skills、专家与模板是资源。实际插件声明、Peer dependencies、Bundle 配置以固定上游接口的集成测试为准。

根 Workspace 不包含上游。上游源码仅作为固定构建输入，使用其自己的 pnpm 锁文件。桌面源码不复制到自有 `apps/desktop/`；品牌和必要补丁在临时构建树应用，不污染上游检出。

详细决策见 [ADR-0001](decisions/0001-repository-layout.md)。

## 组织与编排首批实现

`agent-core/workbench` 与 `planning` 保存可序列化目录、草稿、确认快照和规划协议。`dsh-adapter/workbench-service` 串行处理带版本/幂等键的持久化命令；`workbench-plugin` 通过 DSH Connection、storageDomain 和 llm 接入真实 Host。`client/workbench` 仅调用公共 RPC 并渲染工作流，不导入 Host。

当前是本地 Host owner 模式；已确认计划独立版本化，不能据此宣称多人权限或执行调度已完成。子任务容器方向及 A/B 分工见 [交接方案](ab-handoff-proposal.md)；当前同任务嵌套只用于编辑草稿，不冻结为执行树模型。

## 任务、持续会话与产物评审

补充范围见 [联动方案](architecture/task-session-delivery/design.md)、[A/B 分期](architecture/task-session-delivery/development-plan.md)及[验收清单](architecture/task-session-delivery/test-plan.md)，[PR #13](https://github.com/dolibali/zhuma/pull/13) 已合入 main `b8c5d18`。任务和 workspace 两处打开同一个持续会话，产物固定版本经评审接受后才交下游；方案合入不代表该链路已实现。

B 维护可信身份、会话绑定、上下文物化、执行及产物评审的前后端和 DTO 映射；A 消费已集成版本，维护组织定义、共享 UI／导航／注册／导出及项目和专家入口。[B PR #10](https://github.com/dolibali/zhuma/pull/10) 已提供待审执行实现，独立演示与正式 Host 集成、流式和评审接续的边界分别验证，不按演示回执宣称正式链路完成。
