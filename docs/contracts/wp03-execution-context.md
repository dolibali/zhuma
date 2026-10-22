# WP03 执行与上下文

状态：成员 B 实现。日期：2026-10-22。基线是 `b/wp00-contracts` 的 `80b1ff2bf708b254ebbc79dcaed77cd58677e28a`。

本文说明 FR05、FR07、FR10 的 P0，以及 FR13 在本仓里的落点。FR10 的 P1（安全点暂停、方案重排）不在本期。产物正式提交属于 WP04，评审执行属于 WP05。

## 1. 包边界

| 包            | 本期内容                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------- |
| `agent-core`  | 运行尝试、回执、停止、终态信号、队列、故障、草稿交接、下一步提示。不读文件，不调度。     |
| `context`     | 一次运行的上下文清单、阻塞原因、隔离工作区与单一写入者。文件是否存在由调用方探查后传入。 |
| `dsh-adapter` | 执行器端口、显式模拟执行器、未实现的 DSH / 码道占位、工作区事务与本地演示服务。          |
| `client`      | `createAgentWorkspaceView` 只读投影。不导入 Host，也不保存第二套运行事实。               |

可操作页面在 `examples/agent-workspace`。根工作区仍然只有 `packages/*`。

跨包只用 `@zhuma/*`。演示服务在构建之后从各包的 `dist` 组合，避免让 `client` 依赖 Host。

## 2. 执行器

`ExecutionEngine` 增加 `'simulated'`。模拟执行器只能显式选择。没有注册所选执行器时，`selectAgentExecutor` 直接失败，不会改用模拟。

模拟执行器的能力声明：不支持实时注入，不支持会话恢复，支持取消回执和流式输出，`verified: false`，`mode: 'simulated'`。回复、工具活动和结果都带模拟标识。模拟活动的 `succeeded` 保持 false。

`UnimplementedNativeExecutor` 覆盖 `dsh` 和 `codearts-cli`。`run()` 抛出未实现错误，`cancel()` 返回 `unsupported`。未验证的原生执行器在创建运行前被拒绝，不写入运行记录。

后续真实 DSH 使用同一个 `AgentRunRequest`：任务、节点、计划版本、上下文引用、专家版本、资源授权、取消信号。结果包含运行身份、产物草稿、来源引用和验证说明。当前没有真实回执，不能把这个接口写成已接通。

## 3. 运行生命周期

一次发送创建一个 `ExecutionAttempt`。它有独立的 `id`、`attempt` 和 `generation`。节点要等执行器 `accepted` 之后才经 `execution-acknowledged` 进入 `running`。在此之前运行状态是 `requested`，节点保持进入前的 `ready` 或 `needs-revision`。

同一幂等键、同一内容重放，不创建第二条运行。同一幂等键、不同内容返回 `idempotency-mismatch`。刷新、切换视图和读取快照使用 `view-refresh` / `view-switch` 一类触发，`triggerMayCreateRun` 为 false。关闭页面不取消运行，页面计时器不把运行标成完成。

运行正常结束时，`settleExecutionRun(..., 'completed')` 发出 `execution-finished`，节点回到进入运行前的 `ready` 或 `needs-revision`。效果只有 `await-human-submit`。这不是 `accept-handoff`，不打开评审，不触发下游，也不自动开始下一次调度。多轮对话因此可以再次显式发送。WP00 原来没有「执行结束但继续由人决定是否提交」的出口，所以增加了这条迁移。

已确认完成的节点不能再次 `openRunAttempt`。

## 4. 终态信号、停止与恢复

`admitExecutionSignal` 复用 `observeRunSignal` 的世代和终态分类，再补上执行层自己的两条事实：

- 世代不一致先返回 `stale-generation`，即使这次运行也已经被替换。
- 运行标识不是当前有效运行时返回 `superseded-run`。`observeRunSignal` 不知道有效运行标识。
- 其余分类与观察函数一致。`completed`、`failed`、`cancelled` 上的任何后续信号都是 `terminal-run`：不改节点、不改写终态、不触发下游、不更新该运行记录。只追加 `LateRecord`。
- `requested` 上的核实失败只更新运行记录，不改节点。`requested` 上的进程成功或产物到达只作附属记录，`reason` 留空，不记成 `terminal-run`。
- 已经开始的运行上，核实失败可以随后使用 `execution-failed`。
- `cancel-confirmed` 在观察函数允许改节点时，`requiresStopRequest` 为 true。没有 `requestRunStop` 就收到取消，`settleExecutionRun` 记为 `cancel-unconfirmed`，节点不动。

`requestRunStop` 只把 `stopPhase` 设为 `requested`，节点仍保持 `running`，直到取消回执到达。停止按钮会等待这个回执。模拟执行器在回执之前先交出取消事件和一条迟到输出，上层把迟到输出记成附属记录。

失败后的恢复命令是 `retry`，取消后是 `restart`，其他状态拒绝。二者都回到 `ready`，然后由调用方显式再发送，才会有新的运行标识。改派和人工接回只记录 `RecoveryRequest`：`changesAssignee` 和 `forgesRun` 都是 false。谁真正改派由成员 A 决定。

服务重启时 `ExecutionDesk.restore` 先装回事实，`interactionReady` 为 false，并在执行器不支持会话恢复时留下 `resumeGap`。此阶段拒绝新命令，不推断完成，也不自动续跑。用户继续交互后，才能另行核实为 `executor-disconnected`。这是核实后的失败，不是完成。

模型错误、工具失败、网络中断、执行器断开和专家停用分开呈现。故障 `forgesRun` 为 false，并带对象、原因和下一步。

## 5. Agent 处理

演示页从具体工作项进入，并用「返回任务」回到该任务。任务页只显示返回位置，不发送、不创建运行。

每一轮保存用户消息或执行器消息、附件引用、专家版本和配置快照标识。刷新后从同一进程的事实里读回。切换专家不删除已有轮次。使用 Agent 后责任人标识保持不变。

表 8 的配置在数据和页面上都能看到：专家、执行器、模型说明及继承来源、Skills / MCP 的搜索多选和移除、附件、上下文引用摘要、不可用原因。选择 MCP 不会把 `toolsAuthorized` 设为 true，因此也不会自动授权全部工具。

「编辑并提交」调用 `prepareArtifactDraft`。草稿 `autoDeliver` 和 `skipReview` 都是 false，评审模式是 `new-round-required`。这里不调用 `createArtifactVersion`，节点也不进入 `in-review` 或 `completed`。空交付和非法链接仍由 `validateDeliveryContent` 在正式提交时拒绝，草稿层不复制那套检查。

## 6. 补充、队列和使用中的停止

模拟执行器 `liveInjection` 为 false。运行中的补充或排队都变成 `next-turn`，阶段走到 `pending`，并提示执行器不支持实时注入、发送成功不等于已应用。`advanceIntervention(..., 'apply')` 在仍处于 `sent` 时返回 `send-is-not-adoption`。

阶段顺序是已发送、已接收、待生效、已应用。待生效时「已应用」未到达。队列只在当前运行以 `execution-finished` 正常结束后才开始下一轮；取消不消费队列。已应用只发生在下一轮被执行器接收之后。

等待输入时的补充是 `resume-input`。节点迁移 `input-supplied` 成功后才标成已应用。

## 7. 评审轮次与幂等

`ReviewRound.status` 使用 WP00 的 `open`、`approved`、`changes-requested`、`voided`。结算只走 `applyReviewToNode` 和 `applyReviewSettlementCommand`。`review-resolved` 迁移保持非法。同一轮次标识再次 `replaceReviewRound` 返回 `invalid-round`，不会把已退回的轮次重开。

- `prepareArtifactDraft` 遇到已有轮次或 `previousRoundIds` 返回 `old-round-rejected`。
- 状态 `voided` 返回 `voided-round`。
- `acceptRoundResult` 只拒绝作废轮次和不是当前轮次的结果。它不结算评审，也不改变节点。
- 从 `needs-revision` 进入的运行结束后仍回到 `needs-revision`。再次提交必须使用新的轮次标识。

运行消息和队列都走 `acceptUserMessage`。同一幂等键、不同内容返回 mismatch，不改写已有记录。反馈批次的同类规则由 WP00 的 `evaluateFeedbackApplication` 提供，本工作包不复制它。

## 8. 上下文

`assembleRunContext` 读取目标、父级目标摘要、节点输入、已接受的上游产物、项目知识和本轮评审意见。引用形如 `kind:sourceId@version`，带权限和版本。成功清单不包含本机路径。

缺文件、不可读、无权限、路径被拒绝或缺必需项时，整次为 `context-blocked`，不创建运行。`probeRelativeFile` 拒绝绝对路径、`..`、空段和空字节，结果里也不返回绝对路径。

`isolateWorkspaceId(runId)` 为每次运行生成独立工作区。`claimWritableWorkspace` 拒绝第二个有效写入者。

## 9. 下一步提示

工作区的 `executionTodoHint` 对重叠状态调用 `deriveInbox`，再映射成下面的动作。停止回执、取消后的显式重开，以及已完成，待办里没有对应项，仍由工作区自己给出。未传入执行者时，按当前工作区的人类执行者派生，因此只传节点状态的调用保持原提示。

| 状态       | nextAction              |
| ---------- | ----------------------- |
| 已请求停止 | `wait-for-stop-receipt` |
| 执行中     | `continue-agent`        |
| 等待输入   | `supply-input`          |
| 失败       | `retry`                 |
| 已取消     | `restart`               |
| 需修改     | `revise-in-new-round`   |
| 待处理     | `edit-or-send`          |
| 已完成     | `none`                  |

`in-review` 的评审待办要求节点带有非空 `currentRoundId`。轮次上的 `current` 不能代替它。

## 10. 待 A 对齐

1. 项目成员、任务目标和多个节点报告如何折叠成任务汇总。
2. 计划版本、节点和边由谁发布。谁发出 `plan-started`。
3. 谁接受改派和人工接回。本包只记录请求。
4. 子工作流的创建和父子关系。
5. 团队可见范围。
6. 工作流上如何展示本包返回的节点状态、运行和草稿。

本包只消费 `NodeHandoff`，不计算任务汇总，也不实现编排。

## 11. 验证与未验证

领域规则的测试名称以「契约：」开头，只证明纯函数和内存事务。`examples/agent-workspace/browser.test.mjs` 用浏览器操作显式选择的模拟执行器，覆盖打开处理、多选资源、附件、两轮修改、刷新、补充排队、停止、迟到结果和重试。它不是真实执行器测试。

尚未验证：真实 DSH、真实模型、码道、真实多人、真实文件存储和预览、WP04 提交、WP05 评审执行、FR10 P1。服务重启不会自动续跑模拟会话。页面沿用参考工作区的青绿、浅底和组件间距，没有把原型包或设计技能文件提交进仓库。

## 12. 本地演示

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -b
node examples/agent-workspace/server.mjs
```

浏览器打开标准输出里的 `url`。先在配置里选择「模拟执行器」，再发送。未选择时发送按钮禁用。停止会等待回执。编辑并提交只保存草稿。

`ZHUMA_HOLD_RUNS=1` 让运行在接收回执后暂停，`POST /api/release` 才继续。`ZHUMA_SESSION_FILE` 把会话写到调用方指定的临时文件，不要提交该文件。
