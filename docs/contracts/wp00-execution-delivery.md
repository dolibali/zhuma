# WP00 执行与交付契约

状态：成员 B 起草，供 WP03、WP04、WP05 使用。日期：2026-10-22。

成员 A 正在本地 `develop` 开发组织与编排，这些改动尚未提交，也尚未并入本契约。本文只冻结执行与交付需要的领域规则，以及 B 读取编排信息时依赖的最小形状。标注「待 A 对齐」的对象和规则由 A 在 WP01、WP02 中确认；B 不修改 A 的代码，也不在本工作包里实现项目、参与者、计划编辑或工作流布局。

需求来源：铸码团队协作工作台需求 V1.0 第 6–10 章、第 13–15 章、第 19 章，以及表 6、表 9、表 12、表 13、表 17。代码在 `packages/agent-core`，只读投影在 `packages/client`。本包不持久化、不访问网络或文件系统、不调用模型。

## 1. 范围

本次覆盖 WP00 中属于执行与交付的契约，不宣称对应功能需求已经交付。

| 工作包 | 关系                                                                  |
| ------ | --------------------------------------------------------------------- |
| WP00   | 本文与 `@zhuma/agent-core` 中的纯领域规则                             |
| WP03   | 依赖节点状态机、运行观察、命令信封；实现 FR05/07/10/13 的执行与上下文 |
| WP04   | 依赖产物版本、待办派生、提交权限；实现 FR06                           |
| WP05   | 依赖评审轮次、评论和反馈批次；实现 FR08/09                            |

关联验收用例只锁定领域规则，不能代替 AC 的端到端验证：

| 用例 | 本次锁定的规则                                                               | 仍未做               |
| ---- | ---------------------------------------------------------------------------- | -------------------- |
| AC04 | 文字、文件、链接至少一项；未完成上传不能形成版本                             | 预览、存储、草稿恢复 |
| AC06 | 全员通过才交接；任一退回进入需修改；旧轮次、作废轮次和旧版本的结果无效       | 页面、下游调度       |
| AC07 | 反馈批次逐条处置；同键同内容重放不改写；同键不同内容冲突；目标版本变化则冲突 | 方案生成与差异界面   |
| AC08 | 过期运行和任何已结束运行的迟到结果不推进、不触发下游                         | 真实执行器与停止回执 |
| AC11 | 期望版本、幂等键、eventId 与 sequence                                        | 多用户服务、断网恢复 |
| AC12 | 任务授权、提交人、评审人、文件与工作树裁剪的判定                             | 页面和下载接口       |

FR05 的「任务汇总状态、节点状态、运行状态、评审状态分开建模」在类型上分开。骨架里的 `TaskStatus` 仍是任务快照词汇，不是表 6 的节点状态，也不充当任务汇总。`TaskStatus` 里的 `ready` 与节点 `ready` 同名但不同层，见第 3.3 节。任务汇总待 A 对齐。

## 2. 包边界

`agent-core` 只保存可单测的领域规则。`context` 继续管理来源和证据，本工作包不改它。`dsh-adapter` 的 `ExecutionResult.completed` 仍是执行端口结束，不是节点交付；运行观察里进程成功不会改节点状态。`client` 只导出只读 DTO 和中文文案，不保存第二套执行事实，也不导入 Host。

跨包引用使用 `@zhuma/*`。调用方负责持久化、时钟、身份提供方和执行器回执，并把结果作为参数传入。

## 3. 对象与维护者

| 对象            | 维护者                               | 公开形状                                                           | 约束                                                            |
| --------------- | ------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Project         | A                                    | `ProjectDependency`                                                | 待 A 对齐。B 只读 `id` 与 `active` / `archived`                 |
| Task            | A                                    | `TaskDependency`                                                   | 待 A 对齐。父级唯一、根任务可追溯由 A 保证                      |
| WorkflowVersion | A                                    | `WorkflowVersionDependency`                                        | 待 A 对齐。应用版本不可原地覆盖、边无环、布局与依赖分离         |
| Node 编排字段   | A                                    | `NodeHandoff`                                                      | 待 A 对齐。目标、执行者、依赖、评审人、输入与不含凭据的资源引用 |
| Node 执行状态   | B                                    | `NodeStatus`、`transitionNode`                                     | 表 6。同一节点只有一条执行状态                                  |
| Run             | B                                    | `RunRecord`、`transitionRun`、`requestNodeRun`、`observeRunSignal` | 同一节点至多一个有效运行                                        |
| ArtifactVersion | B                                    | `ArtifactVersion`、`createArtifactVersion`                         | 内容不覆盖；新提交生成下一个版本号                              |
| ReviewRound     | B                                    | `ReviewRound`、`submitBallot`、`aggregateReview`                   | 票绑定轮次和产物版本                                            |
| Comment         | B                                    | `Comment`                                                          | 锚点带版本；已解决不是评审通过                                  |
| FeedbackBatch   | B                                    | `FeedbackBatch`、`evaluateFeedbackApplication`                     | 每条意见有处置；应用检查版本和幂等键                            |
| InboxItem       | B                                    | `deriveInbox`                                                      | 由节点、轮次和确认事实派生，不另存一套执行事实                  |
| Command / Event | B 维护信封；A 的编排命令复用同一信封 | `CommandEnvelope`、`DomainEvent`                                   | 见第 8 节                                                       |

`NodeHandoff` 是 A 交给 B 的边界：目标、执行者、依赖、评审策略、输入引用，以及与 `inputRefs` 分开的专家、技能和 MCP 引用。人工节点的 `assignee.kind` 是 `human`，可以不带 `expertRef`，也不需要选择引擎。专家节点的 `assignee.kind` 是 `expert`，`expertRef` 必须是 `{ id, version }`。`readNodeHandoff` 把 `inputRefs` 按 `ContextInputRef` 白名单重建，只保留 `sourceNodeId`、`artifactVersionId`、`contextPackId`，可以是空数组。`sourceNodeId` 和 `artifactVersionId` 都必须是非空白字符串，缺一或只有空白则返回 `invalid-handoff`，不再静默收下。`contextPackId` 可以省略；出现时必须是非空白字符串，`null`、数字、对象或空白都返回 `invalid-handoff`。这与 `expertRef`、`skillRefs`、`mcpRefs` 拒绝空白 id 的规则一致。`token` 以及其他多余字段不会留在结果里。引用不是对象，或其中某个字段不是字符串时，返回 `invalid-handoff`，不抛出。`skillRefs`、`mcpRefs` 与 `expertRef` 仍重建为 `{ id, version }`。技能或 MCP 引用缺 `id` 或缺 `version` 时返回 `invalid-handoff`。`inputNote` 与 `expectedOutput` 可以是空字符串。这些字段不含凭据、密钥、令牌或授权材料，也不使用 `skillIds`。`PayloadExcludesCredentials` 递归检查每一层字段。比较前去掉 `_` 和 `-`，并且不区分大小写，覆盖 `credential`、`credentials`、`secret`、`secretKey`、`token`、`apiKey`、`api_key`、`password`、`passwd`、`authorization`、`auth`、`accessToken`、`access_token`、`access-token`、`refreshToken`、`refresh_token`、`privateKey`、`private_key`、`sessionToken`、`session_token`、`session-token`、`client_secret`、`client-secret`、`id_token`、`idToken`、`id-token`、`bearer`、`bearerToken`、`bearer-token`、`sessionId`、`session-id`、`cookie`，并拒绝字符串索引签名。`handoffPayloadExcludesCredentials` 锁定 `NodeHandoff`、`VersionedRef`、`ContextInputRef` 和 `ActorRef`。`readNodeHandoff` 收到 null 输入或 null `assignee` 时返回 `invalid-handoff`，不抛出。`readVersionedSnapshot` 收到 null 引用或 null 目录时返回 `undefined`，不抛出。

`NodeHandoff.revision` 是切出这份交接时的已应用计划修订号。它不是节点命令版本，也不是 A 的草稿并发版本。

`VersionedRef.version` 等于对应的 `AppliedPlan.id`。它是计划内容快照的 id，不是需求第 12 节里的资产版本号，也不是 Skill 的版本号。资产 id 和这份快照 id 一起定位冻结内容。以后若建立独立的资产版本库，按显式迁移处理；本契约不另建版本库。节点的 `inputNote` 与版本化产物引用保持分开。`readVersionedSnapshot` 同时匹配资产 id（`VersionedRef.id`，快照上的 `assetId`）和快照 id（`VersionedRef.version`，快照上的 `id`，即 `AppliedPlan.id`）。只命中其中一个，或没有这条组合时，返回 `undefined`。命中时返回该条目的深拷贝，调用方修改副本上的嵌套对象或数组也不会改目录里的快照。条目含有函数、`Symbol` 或其他不能克隆的值时，返回 `undefined`，不抛出。同一份已应用计划下的专家和技能是不同资产，不能互相读到对方的快照。目录或清单随后改变、或追加了新的快照 id 时，原来的资产 id 加原来的快照 id 仍读到原来的内容。

`NodeExecutionReport` 是 B 交回 A 的边界：节点状态、阻塞原因、已接受产物版本、有效运行、评审结局、上游受影响标记。节点状态以 `NodeExecutionReport.status` 为准。A 只投影这份报告，并计算任务汇总。B 不计算任务汇总，也不渲染编排。

### 3.1 参与者种类

`ParticipantKind` 与 `ActorRef.kind` 只有 `'human' | 'expert'`。标识使用 A 的成员目录 id。B 不建立身份目录。运行实例只记在 `Run` 上。`{ kind: 'agent' }` 不能作为 `ActorRef`。

- `'human'` 是人工执行者。人工节点可以不选专家，也可以不选引擎。
- `'expert'` 是 A 目录里的专家配置，不是一次运行实例。专家配置和运行实例分开。专家节点必须带可解析的 `expertRef`。
- `agent` 不是第三种参与者身份。B 内部若仍把一次执行标成 agent，由 `dsh-adapter` 的 `toHandoffActor` 映射：人工执行保持 `human`；agent 运行带有非空专家 id 时映射为该专家，否则映射为人类负责人。映射结果不是 `agent`。
- `assigneeUsesAgentRuntime` 接受内部运行分类 `'agent'` 和目录身份 `'expert'`，供适配层判断非人工运行。`deriveInbox` 的 `InboxNodeFact.assignee` 类型是 `ActorRef`，只有 `human` 和 `expert`，不把内部 `agent` 当作入参。内部 agent 先由 `toHandoffActor` 映射，再进入待办。映射后的 `expert` 本人不产生交付待办；节点在等待输入或失败时，有写授权的 `ownerId` 收到负责人待办。

### 3.2 三层版本

| 层             | 字段                       | 含义                                                  |
| -------------- | -------------------------- | ----------------------------------------------------- |
| 工作台并发版本 | A 维护                     | A 的草稿和工作台对象的并发版本。B 不读写              |
| 已应用计划版本 | `WorkflowVersion.revision` | 已经应用的计划修订号                                  |
| 节点执行版本   | `NodeCommandState.version` | B 的节点命令版本，从 0 开始，只随已接受的节点命令增加 |

三层互不代替。交接上的 `revision` 只指向已应用计划版本。

### 3.3 `ready` 的分层

表 6 里 B 的节点状态 `ready` 表示依赖已满足、可以处理。A 侧若也使用 `ready` 表示定义已确认，两者不是同一层。骨架 `TaskStatus` 里的 `ready` 仍是任务快照词汇。

提案，待对齐：A 将定义确认态改名为 `plan-confirmed`，或放进独立命名空间。B 不改 A 的代码，本次也不重命名 `NodeStatus.ready` 或 `TaskStatus`。节点状态仍以 `NodeExecutionReport.status` 为准。

### 3.4 已确认的协调结论

下列结论已经确认。本包把它们写入契约，并只实现 B 这一侧能够验证的行为。多层工作流服务、独立资产版本库和复杂取消不在本包实现。

1. 子任务容器。每个 Task 一个根工作流。`TaskDependency.parentNodeId`、`TaskDependency.rootTaskId` 与 `NodeHandoff.childTaskId` 表达同一棵树，工作树视图由这棵树投影。普通并行仍用任务内依赖边。A 的嵌套草案可以保留为中间格式；应用时原子转换，保留节点 id，失败不留下半棵树，重复请求不重复创建子任务。同任务里的嵌套草稿不能当作独立子流程权限已经支持。
2. 子任务责任人。父节点执行者是人时，默认该人。父节点执行者是专家时，默认父任务的人类责任人。创建界面预填，并允许在有权限的人员中修改。没有可用的人类责任人时保留草稿并要求选择，不编造 owner。参与者和评审人单独配置。能读到祖先拓扑，不等于取得祖先材料的权限。
3. 分工。A 维护树结构、应用转换和快照导出。B 维护父节点与子节点的返回、运行取消、节点状态和评审规则。
4. 取消和多层转换留到后续工作包。取消父任务应停止派发其后代的新工作，并对仍在运行的后代发出取消请求。收到实际回执之前，只能表示取消处理中或列出尚未停止的项，不能提前宣称整棵树已经取消。已有产物和历史保留，迟到结果不推进下游。归档不触发取消。首版如果还有未结束的后代，应拦住归档并给出处理入口。这些执行行为不在本次契约里实现。
5. 运行中修改。草稿继续可以编辑。已经应用的计划，以及既有运行绑定的快照，不被覆盖。首轮不把会影响运行中、评审中或子流程中节点结构的修改直接热应用。应提示受影响项，等相关执行停止并确认后再应用新版本。运行中补充指令或插入排队工作，走单独的受控操作，不用改树覆盖现有运行。

B 在本包仍未实现、留给后续包的项：多层工作流转换服务、独立资产版本库、父任务级联取消和归档拦截。本包保留的可测边界是：未确认取消不改变节点，以及快照 id 不因目录改动而改读。

### 3.5 最小验证里本包测不到的部分

| 最小验证                   | 本包已测                                                                                                              | 本包测不到的部分                             | 归属                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------- |
| 重复拆分不重复创建         | 节点已有有效运行时 `requestNodeRun` 返回 `active-run-exists`；同一条 `child-workflow-started` 不重复生效              | 应用转换不创建第二个子任务，失败不留下半棵树 | A，后续多层转换批次               |
| 子任务无权读取祖先材料     | `canReadFile` 不因 `referencedByUpstream` 授权；无权时 `projectWorkTreeNode` 只返回 id                                | 祖先任务的授权如何赋给子任务                 | A                                 |
| 人工节点不必选择专家或引擎 | 人工交接可以省略 `expertRef`，结果里也没有引擎字段                                                                    | 无                                           | B，本包                           |
| 子返回不跳过父提交与评审   | `child-workflow-returned` 的效果只有 `await-parent-submit`                                                            | 无                                           | B，本包                           |
| 旧快照不随目录改动         | `readVersionedSnapshot` 用资产 id 和 `AppliedPlan.id` 一起读到原快照                                                  | 目录持久化和快照导出                         | A。独立资产版本库是以后的显式迁移 |
| 取消回执前不显示已停止     | 命令层收到 `cancel-unconfirmed` 返回 `illegal-transition`，节点和版本都不变；只有 `cancel-confirmed` 进入 `cancelled` | 父任务取消后代、取消处理中的展示、归档拦截   | 后续执行工作包                    |

## 4. 节点状态机

状态与表 6 对应。`failed` 与 `cancelled` 分成两个状态，因为离开条件不同：失败可显式重试，取消后重新开始必须显式操作。

| 状态                | 含义           | 进入                                   | 离开                                               |
| ------------------- | -------------- | -------------------------------------- | -------------------------------------------------- |
| `draft`             | 草稿           | 计划节点尚未启动                       | `plan-started`                                     |
| `blocked`           | 等待前置       | 至少一个上游尚未交接                   | 依赖满足后到 `ready`；或确认取消                   |
| `ready`             | 待处理         | 依赖已满足，等待人工或调度             | 执行回执、直接提交、拆分、依赖再次失效、确认取消   |
| `running`           | 执行中         | 执行器已经接收                         | 提交、等待输入、核实失败、确认取消                 |
| `waiting-for-input` | 等待输入       | 运行中缺少信息或权限                   | 补充后继续、核实失败、确认取消                     |
| `child-workflow`    | 子工作流处理中 | 子流程已关联                           | 子流程返回后回到 `ready`；或确认取消               |
| `in-review`         | 待评审         | 已提交且需要评审                       | 当前轮次全员通过，或任一有效退回                   |
| `needs-revision`    | 需修改         | 评审退回                               | 提交新版本并重新评审、改用 Agent、再拆分、确认取消 |
| `completed`         | 已完成         | 无需评审的有效提交，或当前轮次全员通过 | 只有显式 `reopen-for-rework`                       |
| `failed`            | 失败           | 核实后的执行失败                       | 只有显式 `retry`，并带 `returnTo`                  |
| `cancelled`         | 已取消         | 取消已经确认                           | 只有显式 `restart`，并带 `returnTo`                |

`applyNodeTransitionCommand` 是提交和恢复（`retry`、`restart`）的唯一权威入口。下面这条只在命令层成立：存储层保存和恢复 `NodeCommandState` 时必须带上 `entryStatus`。`blocked`、`ready`、`running`、`waiting-for-input`、`child-workflow`、`in-review`、`failed`、`cancelled` 缺了这份记录时，除 `execution-failed` 和 `cancel-confirmed` 以外的节点命令都返回 `illegal-transition`，不改状态，也不把记录补成 `ready`。这两条例外仍按各自合法来源落库：`execution-failed` 进入 `failed`，`cancel-confirmed` 进入 `cancelled`，并且不补写 `entryStatus`。缺记录到达这两个状态之后，`retry` 和 `restart` 仍然拒绝。丢记录之后，子流程往返和依赖往返都不能再把节点免评审完成。`blocked` 保留进入前的记录；回到 `ready` 时还原它，不新写一个 `ready`。`draft` 上的 `plan-started` 为新节点写下第一条记录。`needs-revision` 这个状态本身就是需修改记录。已经记下 `entryStatus: 'ready'` 的节点仍可以不评审完成。载荷里的 `entryStatus` 不能把丢失的记录补回去。`transitionNode` 和 `transitionForSubmission` 是无状态的底层函数，只根据当次参数计算，不读取也不写入 `entryStatus`。调用方不能用它们直接落库。null 状态、信封或载荷返回 `illegal-transition`，不抛出。

`transitionNode` 是节点状态的迁移函数。合法迁移返回下一个状态和推进效果；非法迁移返回 `illegal-transition`，不修改调用方状态。`review-resolved` 仍留在迁移联合类型里，使旧载荷失败关闭而不是抛出；这条迁移一律返回 `illegal-transition`。联合类型之外的迁移类型同样返回 `illegal-transition`，不抛出。`in-review` 的通过或退回由 `applyReviewSettlementCommand` 写入：信封带 actor、期望版本和幂等键，内部经 `decideCommand` 调用 `applyReviewToNode`，并从选票重算结局。它必须绑定节点当前轮次。轮次没有 `ballots` 数组时，结算命令返回拒绝，不抛出。

推进效果：

| 效果                                     | 含义                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| `become-actionable`                      | 人工节点进入待办，或 Agent 节点可以按调度创建运行请求  |
| `hold-for-dependencies`                  | 下游继续等待，不创建交付待办                           |
| `open-review`                            | 为当前产物版本打开评审轮次                             |
| `accept-handoff`                         | 本节点交接完成，下游可以重新计算依赖                   |
| `block-downstream`                       | 下游不得因本次结果启动                                 |
| `await-parent-submit`                    | 子流程只回到父节点负责人，不跳过父节点提交和评审       |
| `record-failure` / `record-cancellation` | 保留已有产物和运行记录                                 |
| `mark-upstream-affected`                 | 记录上游变化。状态保持不变，不重新执行、不覆盖当前运行 |
| `resume-execution`                       | 补充输入后继续当前运行                                 |

### 4.1 推进边界

对应需求 6.1 与表 13。

- 需要评审的提交进入 `in-review` 并 `block-downstream`。入口不是 `needs-revision` 的 `ready` 或 `running`，不需要评审的提交进入 `completed` 并 `accept-handoff`。评审开关打开时评审人不能为空，否则返回 `review-requires-reviewers`，节点不动。
- `needs-revision` 的 `submit-artifact` 必须 `reviewRequired: true`，进入 `in-review`，效果是 `open-review` 和 `block-downstream`。同一次提交若 `reviewRequired: false`，返回 `illegal-transition`，节点保持需修改。关闭评审要另有授权命令，不能借这次提交跳过。
- 下面这条只在命令层成立。进入 `running` 或 `child-workflow` 时，`applyNodeTransitionCommand` 把入口写入 `NodeCommandState.entryStatus`，取值是 `ready` 或 `needs-revision`。存储层必须持久化这个字段。等待输入、补充输入、失败和确认取消都保留这份记录。子流程返回后节点状态可以是 `ready`；若入口是 `needs-revision`，`entryStatus` 仍是 `needs-revision`。命令只读领域状态里的记录。载荷里的 `entryStatus`、`returnTo` 和 `reviewRequired: false` 都不能覆盖或清除它。`blocked`、`ready`、`running`、`waiting-for-input`、`child-workflow`、`in-review`、`failed`、`cancelled` 缺了 `entryStatus` 时，`applyNodeTransitionCommand` 拒绝该状态下除 `execution-failed` 和 `cancel-confirmed` 以外的命令，返回 `illegal-transition`，不改状态、不补记录。`execution-failed` 仍进入 `failed`，`cancel-confirmed` 仍进入 `cancelled`，这两条不补写 `entryStatus`。缺记录到达这两个状态之后，`retry` 和 `restart` 仍然拒绝。因此丢记录之后，不能靠子流程往返或依赖往返把入口改写成 `ready` 再免评审完成。`blocked` 保留进入前的 `entryStatus`；从 `blocked` 回到 `ready` 时还原这份记录，不新写一个 `ready`。`draft` 上的 `plan-started` 是新节点写下第一条记录的地方。`needs-revision` 这个状态本身就是需修改记录。已经记下 `ready` 的节点仍可以不评审完成。载荷入口与记录不一致时返回 `illegal-transition`。`entryStatus` 为 `needs-revision` 时必须再评审，`reviewRequired: false` 不能进入 `completed`。`ready` 声称入口是 `needs-revision`，或 `needs-revision` 声称入口是 `ready`，同样返回 `illegal-transition`。`transitionNode` 不保存这份记录；它在 `running` 上缺少当次参数里的入口时返回 `illegal-transition`，不抛出，也不能代替命令落库。
- 只有评审通过会清掉这份需修改记录。`applyReviewToNode` 的结果是 `completed` 时，`applyReviewSettlementCommand` 写入的状态不再带 `entryStatus`。退回会把 `entryStatus` 写成 `needs-revision`。其它命令不能清除它。
- 依赖未满足时停在 `blocked`。全部依赖满足后才进入 `ready`。`ready` 若依赖再次失效，回到 `blocked`。已经开始、评审中或已结束的节点只打 `upstreamAffected`，不静默重跑。
- 人工节点可以从 `ready` 直接提交。`needs-revision` 的提交会打开新一轮评审。Agent 对话结束、进程退出成功、文件上传完成，都不会把节点送去评审或完成。
- 执行器实际接收后，`execution-acknowledged` 才把 `ready` 或 `needs-revision` 变成 `running`。仅创建运行请求时节点仍停留在可执行状态。
- 子流程返回使用 `child-workflow-returned`，节点状态回到 `ready`，效果只有 `await-parent-submit`。返回本身不交付，也不清除已经记下的需修改入口。父节点原有评审仍要走。停止子流程并接回，也回到父节点的可处理入口，不自动交付。
- `completed` 保持完成。返工必须走 `reopen-for-rework`，进入 `needs-revision`，并重新记下需修改入口，不自动调度。
- `failed` 只有 `retry`，`cancelled` 只有 `restart`。类型上 `returnTo` 必填，取值是 `'ready' | 'needs-revision'`。命令层要求它与已记录的 `entryStatus` 相同。记录是 `needs-revision` 时，`returnTo: 'ready'` 被拒绝，节点保持失败或已取消。没有记录时同样拒绝，不用调用方给出的 `returnTo` 补记。两者一致且为 `ready` 时回到 `ready`，效果 `become-actionable`。为 `needs-revision` 时回到 `needs-revision`，效果 `block-downstream`，不把它当成一次新的交接。取值不是这两个状态时，`transitionNode` 返回 `illegal-transition`，不抛出。二者都不能直接再次确认执行。
- 草稿上的删除和取消属于计划编辑，B 不提供 `draft` 的取消迁移。

`UNVERIFIED_EXTERNAL_SIGNALS` 中的进程成功、文件已上传、子流程结束、未确认取消、未核实评审，一律不能改变节点。`unverifiedSignalChangesNode` 固定返回 `false`。

## 5. 运行

`RunStatus`：`requested`、`running`、`waiting-for-input`、`completed`、`failed`、`cancelled`。

`requested`、`running`、`waiting-for-input` 是有效运行。`requestNodeRun` 在节点不是 `ready` 或 `needs-revision` 时返回 `node-not-executable`；该节点已有有效运行时返回 `active-run-exists`。已结束的运行不占用这个名额。

`transitionRun` 是运行自己的状态机。`requested` 只有 `executor-acknowledged` 之后才到 `running`。`input-required` 从 `running` 到 `waiting-for-input`，`input-supplied` 回到 `running`。`succeeded` 只从 `running` 到 `completed`。`failed` 可以从 `requested`、`running` 或 `waiting-for-input` 到 `failed`。执行器拒绝启动时，运行进入 `failed` 并让出有效名额，节点保持原状。`cancel-confirmed` 可以从 `requested`、`running` 或 `waiting-for-input` 到 `cancelled`。`completed`、`failed`、`cancelled` 没有出口，再迁移返回 `illegal-run-transition`。

`observeRunSignal` 先看世代，再看运行是否已经结束：

| 信号                                         | 节点                             | 下游   |
| -------------------------------------------- | -------------------------------- | ------ |
| 当前世代、运行已开始，进程成功或产物到达     | 不改节点                         | 不触发 |
| 当前世代、运行已开始，核实失败               | 允许随后使用 `execution-failed`  | 不触发 |
| 当前世代、运行仍有效，取消已确认             | 允许随后使用 `cancel-confirmed`  | 不触发 |
| `requested` 上的核实失败                     | 只把运行记为失败，不改节点       | 不触发 |
| `requested` 上的进程成功或产物到达           | 只作附属记录，运行还不能成功     | 不触发 |
| 世代不一致                                   | 只作附属记录，`stale-generation` | 不触发 |
| 运行已完成、已失败或已取消之后的任何迟到信号 | 只作附属记录，`terminal-run`     | 不触发 |

`terminal-run` 时 `mayChangeNodeStatus` 和 `mayTriggerDownstream` 都是 false，调用方不能借迟到的失败或取消确认去改节点。已经开始的运行上，失败和取消的 `mayChangeNodeStatus` 只表示可以再提交对应的已核实迁移。`requested` 的失败与 `transitionRun` 一致，只更新运行记录。观察函数本身不改节点。

## 6. 产物版本

`createArtifactVersion` 生成该节点的下一个版本，并复制文字、文件和链接。调用方之后修改草稿，不会改已生成的版本。版本号只增不改。

提交内容至少包含一项有效内容：非空白文字、字节数大于 0 且已完成上传的文件，或 `http` / `https` 链接。零字节文件可以和其他有效内容一起提交，单独出现时与纯空白文字一样返回 `empty-delivery`。`javascript:`、带用户名或密码的链接，以及其他不能解析成这两种协议的字符串返回 `invalid-link`。任一文件未完成上传时返回 `upload-incomplete`，即使文字已经填写。文件必须有稳定 `id`、媒体类型、非负字节数、校验值和 `accessPolicyId`。同一版本内文件标识不能重复。

预览失败不是交付失败。大小、格式和保留周期是产品配置，不写进领域规则。

## 7. 评审、评论与反馈

### 7.1 汇总

`aggregateReview` 默认全员通过。

- 每位名单内评审人都有一条当前轮次、当前产物版本上的有效 `approve`，结局才是 `approved`。
- 任一有效 `request-changes` 的结局是 `changes-requested`，即使其他人已经通过。节点随后进入 `needs-revision`，效果为 `block-downstream`。
- `comment` 只保留意见，不占通过票。
- 没有投票视为未回复，留在 `outstandingReviewerIds`，轮次保持 `pending`，节点保持 `in-review`。
- `availability` 为 `timed-out` 或 `unavailable` 的 `approve` 直接拒绝，代码 `non-passing-availability`，不能算通过。
- 评审人名单为空是 `invalid-policy`，不能被汇总成通过。名单里出现非字符串 id 也是 `invalid-policy`，原因是 `invalid-reviewer-id`，`aggregateReview` 不抛出。
- 退回必须有意见正文，或引用至少一条未解决评论。引用的每条标识都要出现在调用方给出的评论快照里，且状态为 `open`。快照若带 `versionId` 或 `targetId`，它们必须等于本轮产物版本，否则不算属于这一轮。缺失、已解决或不属于本轮返回 `comment-not-unresolved`，整张票不写入。只写正文、不引用评论，仍然是有效退回。空退回返回 `empty-request-changes`。
- 已解决评论不进入汇总。把评论标成已解决不会产生通过票。
- 投票人必须就是当前 actor。`actorId` 为空，或与 `ballot.reviewerId` 不同，返回 `actor-mismatch`，票不写入。

`applyReviewToNode` 只接受当前轮次。轮次为 `voided` 返回 `voided-round`。轮次标识或产物版本与节点当前值不一致，分别返回 `stale-round`、`stale-version`。推进必须带完整轮次：`reviewerIds` 和 `ballots` 都要在。结局只按选票重算，不信任调用方写入的 `round.status`，也不再按状态核对缺少名单或选票的旧形状。调用方给的结局与重算不一致、名单缺失、选票缺失，或通过票为零，都返回 `unbound-evaluation`，节点不能到 `completed`。因此一份伪造的 `approved` 状态若票里仍有退回，或根本没有通过票，不能把节点完成。名单为空是 `invalid-policy`，节点保持 `in-review`。通过后节点到 `completed`，效果 `accept-handoff`。退回后节点到 `needs-revision`，效果 `block-downstream`。`pending` 和 `invalid-policy` 不推进节点。

`applyReviewSettlementCommand` 把同一次结算放进命令信封。载荷是 `{ roundId, artifactVersionId }`。期望版本不符返回 `conflict` 且不保存。同一键、同一 actor、同一载荷重放第一次的结果。键相同但轮次、版本或 actor 不同返回 `idempotency-mismatch`。尚未全员表态时命令为 `ignored`，不占版本。陈旧轮次、作废轮次和非法节点状态为 `rejected`，也不占版本。

### 7.2 表 9 的并发规则

- 轮次状态是 `open`、`approved`、`changes-requested` 或 `voided`。新版本必须 `openReviewRound`。新轮次的投票列表为空，旧通过票不继承。
- 取消已确认或重新开始，并且节点迁移成功时，`reviewRoundAfterNodeTransition` 把仍开放的轮次标成 `voided`。再次 `submit-artifact` 时，只有传入的 `currentRoundId` 指向另一轮，才会把这一轮标成 `voided`。不传当前轮次，或传入的就是这一轮，轮次保持开放，避免刚打开的新轮次被误作废。`replaceReviewRound` 打开下一轮，并且只在上一轮仍开放且标识不同时作废它。已关闭的轮次保持原状态。迁移被拒绝时轮次不动。`voided` 轮次上的后续票返回 `voided-round`。调整作废轮次的名单也返回 `voided-round`。
- `submitBallot` 在写入前核对轮次、产物版本和 actor。轮次不一致返回 `stale-round`，版本不一致返回 `stale-version`，actor 不是投票人返回 `actor-mismatch`。这些票都不写入。
- 轮次已经通过或退回后，后续裁决返回 `round-closed`。因此同一轮里先退回、后到达的通过不会把节点改成完成。已经作废的轮次也不能再被拿来结算。
- 同一评审人的第一次终态票有效。相同动作再次提交不追加；改成另一种终态返回 `conflicting-ballot`。通过之后不能在同一开放轮次里改成退回。是否允许改票见第 11.1 节。
- 不在名单中的人返回 `not-assigned-reviewer`，不能替他人投票。
- `openReviewRound` 和 `changeReviewers` 先去掉评审人 id 里的零宽字符（U+200B、U+200C、U+200D、U+FEFF、U+2060、U+180E），再去掉两端空白，然后保存。评审人 id 区分大小写，`A` 与 `a` 是两个席位。空白，或规范化后重复，返回 `duplicate-reviewer`，不把两个席位合成一个。非字符串 id 返回 `invalid-round`，不抛出。结算命令遇到非字符串 id，或选票的 `reviewerId` 不是字符串，同样返回 `invalid-round`，不抛出。`submitBallot` 收到 null 轮次、null 票，或 `reviewerId` 不是字符串时返回 `invalid-ballot`，不抛出。`aggregateReview` 收到 null 轮次返回 `invalid-policy`。选票为 null 或选票 `reviewerId` 不是字符串时，原因是 `invalid-reviewer-id`。`applyReviewToNode` 与结算命令收到 null 输入返回 `unbound-evaluation`，不抛出。
- `changeReviewers` 需要 `{ actorId, authorized }`。未授权、空 actor 返回 `unauthorized`。不能拿掉已经退回的评审人来让当前轮次通过，返回 `cannot-drop-rejection`。已经关闭的轮次也不能靠调整名单重开。只从开放轮次里移除评审人返回 `requires-new-round`，轮次保持开放，未回复和超时不会因此变成通过。显式改派是同时移除并加入评审人，新加入的人没有旧票，轮次不会因此自动通过。换人继续也可以 `replaceReviewRound` 新建轮次，旧票不继承。
- 专家输出走 `interpretAgentReview`。缺少结论、理由，或在通过/退回时缺少定位与证据，返回 `abnormal-output`，不能当成批准。

### 7.3 评论与反馈批次

`Comment` 的目标可以是工作流版本、节点或产物版本。锚点保存种类、原文或位置，并带 `versionId`。无法可靠重定位时使用 `original-version`，不得把意见自动贴到无关文字。计划目标上的版本号与 `WorkflowVersion.revision` 如何对应，待 A 对齐。

`evaluateFeedbackApplication`：

- 未授权返回 `unauthorized`。授权检查先于幂等比对。
- 同一幂等键且内容指纹相同，返回 `replayed`，即使当前目标版本后来变了，也不再写一版。指纹覆盖批次 `id`、评论标识、目标版本、每条处置，以及可选的 `proposal`。`commentIds` 和 `dispositions` 的数组顺序也是内容的一部分，重排后再用同一键会得到 `idempotency-mismatch`，领域层不把它们排序成重放。
- 同一幂等键但指纹不同，返回 `idempotency-mismatch`。新批次不写入，也不当成重放丢掉。
- 新键遇到目标版本不一致，返回 `version-conflict`。`commentIds` 为空返回 `invalid-batch`。
- 每条评论恰好一条处置，且回复非空。冲突处置使用 `conflict-pending`，批次仍可记录，但不能把冲突意见悄悄覆盖掉。
- 应用成功只表示可以写入新版本及处置关联。原始评论保留。`proposal` 由调用方放入，本函数不生成方案，也不修改产物。

## 8. 命令、事件与幂等

`CommandEnvelope` 包含 `idempotencyKey`、`actorId`、`objectId`、`expectedVersion` 和 `payload`。`actorId`，以及调用方用来放行写操作的授权，必须来自 Host 的可信上下文，或由服务端根据该上下文计算。不得信任调用方自行声明的 actor 或授权位。本层函数只消费已经判定过的值。`canChangeReviewers` 不在本纯契约中提供；写授权且 actor 非空由后续执行适配在服务端计算，不复制客户端传来的 `authorized`。

`decideCommand` 的结果：

| 状态                   | 条件                                         | 版本与存储                                                             |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `applied`              | 键首次出现，期望版本等于当前版本，领域接受   | 版本加一，并保存结果                                                   |
| `replayed`             | 同一对象、同一 actor、同一键、同一规范化载荷 | 返回第一次的结果，不再调用应用                                         |
| `conflict`             | 键是新的，但期望版本不等于当前版本           | 返回 `currentVersion`、`expectedVersion` 和 `version-mismatch`；不保存 |
| `idempotency-mismatch` | 键已存在，但对象、actor 或载荷不同           | 不应用                                                                 |
| `rejected`             | 领域拒绝，例如非法迁移                       | 不占版本，不保存                                                       |
| `ignored`              | 领域判定没有新事实，例如依赖状态没有变化     | 不占版本，不保存                                                       |

冲突不写入幂等记录，调用方重新加载后可以用同一键带上新的期望版本再试。非法迁移也不占用键。已经接受的键即使之后携带另一个期望版本，也只重放，不会第二次生效。`canonicalPayload` 保留载荷里每一个自有 JSON 键，包括顶层和嵌套的 `__proto__`。同键不同内容返回 `idempotency-mismatch`，不会因为键名被丢掉而重放。访问器属性会抛出 `Accessor properties cannot be command payloads.`，不跳过。JSON 载荷没有访问器，这条规则不改变它们的指纹。数组里的反馈指纹仍按原顺序保留。

节点命令版本从 0 开始。`applyNodeTransitionCommand` 是提交和恢复的唯一权威入口，负责除评审结算以外的节点迁移。`applyReviewSettlementCommand` 负责 `in-review` 的通过和退回，使用同一套期望版本、actor 和幂等键。两条命令的重放都不改变状态、版本、`upstreamAffected` 和 `entryStatus`。存储层必须把 `entryStatus` 和其余命令状态一起保存。`transitionNode` 与 `transitionForSubmission` 无状态，不能直接用来持久化。原始 `review-resolved` 不能代替结算命令。评审轮次缺少 `ballots` 时，结算返回 `unbound-evaluation`，不抛出。

`DomainEvent` 包含 `eventId`、`sequence`、`occurredAt`、`actorId`、对象引用、类型、载荷，以及可选的 `runId`。`occurredAt` 由调用方传入，领域层不读时钟。它必须是带日历校验的 ISO-8601 时间：`YYYY-MM-DDTHH:mm:ss`，可选小数秒，时区为 `Z` 或 `±HH:MM`。`2026-99-99T99:99:99` 这类值返回 `invalid-event`。`appendDomainEvent` 同时拒绝重复 `eventId`、空字段和非递增 `sequence`。`recordCommandEvent` 只在命令状态为 `applied` 时追加事件；重放、冲突和拒绝不产生新事件。`eventsAfter` 按序号返回游标之后且调用方尚未见过的事件。

任务推进、评审汇总和下游待办的持久化事务不在本层。调用方必须把一次已接受命令、它的事件，以及由此派生的待办放进同一个可恢复边界。

## 9. 待办

`deriveInbox` 为当前 actor 派生三类事项，每条都带 `action`。同一任务的两个待交付节点是两条。

| 种类      | 条件                                                              | `action`             |
| --------- | ----------------------------------------------------------------- | -------------------- |
| `deliver` | 有写授权的人类执行者，节点为 `ready`                              | `submit`             |
| `deliver` | 同上，节点为 `needs-revision`                                     | `revise`             |
| `deliver` | 同上，节点为 `running`                                            | `continue-handling`  |
| `deliver` | 同上，节点为 `waiting-for-input`                                  | `provide-input`      |
| `deliver` | 同上，节点为 `failed`                                             | `retry-or-take-back` |
| `deliver` | 执行者是目录 `expert`，actor 是有写授权的 `ownerId`，节点等待输入 | `provide-input`      |
| `deliver` | 同上，节点为 `failed`                                             | `retry-or-take-back` |
| `review`  | 节点为 `in-review`，当前轮次为 `open`，actor 在名单中且尚未终态   | `review`             |
| `confirm` | `ready` 且 `awaitingParentConfirmation`                           | `confirm`            |
| `confirm` | 调用方给出的未确认事项，节点不是 `completed` 或 `cancelled`       | `confirm`            |

父节点确认的原因是 `parent-confirmation`。调用方显式确认的原因是 `explicit-confirmation`，`detail` 保存调用方原文。评审待办只认节点的 `currentRoundId`；节点没有该字段时，只认 `current: true` 的轮次。没有标记的开放轮次不按数组顺序猜测。同一节点至多一条评审待办。`voided` 轮次不产生待办。`blocked` 和 `child-workflow` 不产生交付待办。只读授权和已完成节点不产生交付待办。目录 `expert` 执行者自己不产生交付待办；节点在等待输入或失败时，任务负责人收到原因分别为 `owner-input-required` 和 `owner-take-back` 的待办。`expert` 是目录中的专家配置，不是运行实例。`deriveInbox` 的执行者类型是 `ActorRef`，没有内部 `agent` 这一种类；内部 agent 在进入待办前由 `toHandoffActor` 映射。`assigneeUsesAgentRuntime` 可以识别内部 `agent`，那是适配层的分类，不是 `deriveInbox` 的入参。只评论还没有终态票的评审人仍保留当前轮次的评审待办。

## 10. 权限与可见性

判定的输入是 Host 可信上下文里已经算好的授权，不是参与者名单本身，也不是调用方自行声明的授权位。

- `taskAccess` 按 actor 和 task 匹配。参与任务 A 不会得到任务 B 的访问。
- `canSubmitNode` 要求写授权，且 actor 就是当前执行者。任务负责人不能代替执行者提交。使用 Agent 不改变执行者。
- `canCastBallot` 只允许名单内的评审人。评审不是发布或部署授权。
- `canReadFile` 只看文件所属任务的授权。`referencedByUpstream: true` 不会补授权。
- `projectWorkTreeNode` 在无权时只返回 `{ access: 'redacted', id }`，不包含标题、文件名和评论。

观察者可以拥有读授权，但读授权不能提交，也不能投票。团队可见范围如何独立于参与者名单配置，待 A 对齐。

## 11. 待 A 对齐

本节每一条都是提案，待对齐。成员 A 正在本地 `develop` 开发组织与编排，相关改动尚未提交，也尚未并入本仓库。B 不修改 A 的代码。

1. 提案，待对齐。`Project` 的成员目录、资源引用，以及归档对未完成任务的影响。
2. 提案，待对齐。`Task` 的目标正文、参与者类型明细，以及多个 `NodeExecutionReport` 如何折叠成任务汇总状态。
3. 提案，待对齐。哪些节点算必需节点，父任务完成规则由谁计算。
4. 提案，待对齐。`WorkflowVersion` 的节点、边、布局和草稿应用流程。现有 `validatePlan` 仍只做依赖图不变量，B 不把它扩展成编排器。
5. 提案，待对齐。谁可以改派、改依赖、开关评审和调整评审人，以及这些修改如何生成 `NodeHandoff`。
6. 提案，待对齐。谁在计划启动时发出 `plan-started`，以及「上游完成交接」的判定。
7. 提案，待对齐。上游结果变化如何通知下游。B 只接收 `dependencies-changed` 并记录 `upstreamAffected`。
8. 提案，待对齐。子工作流的创建、父子环检测和 `childTaskId` 的写入仍由 A 实现。树、默认责任人和分工见第 3.4 节。B 只接收 `child-workflow-started` 与 `child-workflow-returned`，不在本包实现多层转换服务。
9. 提案，待对齐。团队可见范围和参与者名单的配置模型、身份源与专家配置的对应关系。对外身份只有 `human` 和 `expert`，身份目录仍由 A 维护。
10. 提案，待对齐。计划评论的 `versionId` 与 `WorkflowVersion.revision` 的对应。评论版本不是节点命令版本，也不是工作台草稿并发版本。
11. 提案，待对齐。工作流上如何展示 B 返回的状态、接受版本和评审结局。展示以 `NodeExecutionReport.status` 为准。
12. 提案，待对齐。骨架 `TaskStatus` / `TaskSnapshot` 是保留、映射，还是被任务汇总状态替换。A 的定义确认态若仍叫 `ready`，建议改名为 `plan-confirmed` 或独立命名空间，避免与表 6 的节点 `ready` 混用。
13. 提案，待对齐。「待我确认」里哪些计划确认属于 A。B 目前只派生交付、评审、父节点确认，以及调用方显式给出的确认事实。

### 11.1 仍待对齐、本次保持现状

下列事项都是提案，待对齐。留到后续工作包。先改本文再改规则。

1. 提案，待对齐。同一开放轮次里，通过之后不能改成退回，返回 `conflicting-ballot`。改票规则在 WP05 前与产品确认。
2. 提案，待对齐。子流程返回后等待父节点确认，仍是 `ready` 加上 `awaitingParentConfirmation`。WP06 前把该标记放进节点状态。
3. 提案，待对齐。表 6 的「手动开始」和「保留阻塞原因」延到 WP04。届时 `blocked`、`waiting-for-input`、`failed` 的阻塞原因改为必填。
4. 提案，待对齐。需修改之后关闭评审，不通过 `submit-artifact` 且 `reviewRequired: false` 表达。那次提交固定返回 `illegal-transition`。单独的授权命令仍待后续决定。

在上述项对齐前，WP03–WP05 应依赖本文的类型和函数，不要在适配层或客户端复制一套节点状态、评审结局或版本号。

## 12. 已知限制

- 没有数据库、接口、文件存储、执行器或界面流程。契约测试只证明纯函数，不证明 AC 的端到端场景。
- `blocked`、`ready`、`running`、`waiting-for-input`、`child-workflow`、`in-review`、`failed` 和 `cancelled` 必须带已持久化的 `entryStatus`。缺了就拒绝该状态下除 `execution-failed` 和 `cancel-confirmed` 以外的节点命令，返回 `illegal-transition`，命令层不会把丢失的记录改写成 `ready`。这两条例外仍进入 `failed` 或 `cancelled`，并且不补写记录；之后的 `retry` 和 `restart` 仍然拒绝。所以子流程往返或依赖往返都不能在丢记录之后免评审完成。`blocked` 保留原入口，回到 `ready` 时还原，不新造一个 `ready`。`needs-revision` 状态本身就是需修改记录。`draft` 的 `plan-started` 为新节点写下第一条 `ready` 记录。已经记下 `ready` 的节点可以不评审提交。载荷不能把丢失的记录填回去。
- 幂等记录和事件日志都由调用方保存。本层不提供跨进程去重。
- 领域层不读取时钟，因此超时投票必须由调用方先变成 `timed-out` 再传入。
- 反馈批次只检查能否应用。方案由调用方放进可选的 `proposal`，领域层不生成方案，也不创建新产物。
- 待办确认事项里，除父节点返回外，其余确认事实要由后续工作包放入输入。
- 文件大小、预览器和真实权限服务都还没有。`accessPolicyId` 只是引用。
- 模拟执行与真实执行的区分属于后续运行适配，不在本次结果类型里伪造成功。

## 13. WP03 正在使用的增补

WP03 的执行与上下文见 [wp03-execution-context.md](wp03-execution-context.md)。它复用 `observeRunSignal`、`deriveInbox`、`validateDeliveryContent` 和 `ReviewRound`，不另写一套终态、待办或空交付规则。执行侧保留的增补是：

- `ExecutionEngine` 增加显式的 `simulated`。它只表示操作者选中的演示执行器，不是 `dsh` 或 `codearts-cli` 未配置、未验证或调用失败时的回退。运行时不得因为缺少真实执行器而改用它。
- `execution-finished` 从 `running` 或 `waiting-for-input` 回到记下的入口，效果是 `await-human-submit`，不触发下游。命令层拒绝与 `NodeCommandState.entryStatus` 不一致的 `returnTo`。`review-resolved` 仍然一律非法，结算只走 `applyReviewToNode` / `applyReviewSettlementCommand`。执行台的 `retry` 与 `restart` 读取同一份入口。新建时写入它，读回不一致时记 `entry-inconsistent`，不改写。
- `admitExecutionSignal` 在世代和终态上调用 `observeRunSignal`。已结束运行上的迟到信号不改变节点。`requested` 上的失败只更新运行记录。`requested` 上的成功或产物到达只作附属记录，并且不带 `terminal-run`。执行层另外拦住 `superseded-run`；`cancel-confirmed` 在信号可以生效时仍要求已经请求停止。
- WP03 不设置 `activeRoundId`。当前轮次留给后续评审工作包。执行台只在校验结果时读取它；校验通过只表示这不是旧轮次或作废轮次，不结算节点，也不让节点离开 `in-review`。
