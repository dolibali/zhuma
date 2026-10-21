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

## 插件与发行

四个代码包不要求与插件数量相同。Host 插件可以组合核心服务；Client 插件显示相应模型；Rules、Skills、专家与模板是资源。实际插件声明、Peer dependencies、Bundle 配置以固定上游接口的集成测试为准。

根 Workspace 不包含上游。上游源码仅作为固定构建输入，使用其自己的 pnpm 锁文件。桌面源码不复制到自有 `apps/desktop/`；品牌和必要补丁在临时构建树应用，不污染上游检出。

详细决策见 [ADR-0001](decisions/0001-repository-layout.md)。
