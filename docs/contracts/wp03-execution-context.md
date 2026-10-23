# WP03 执行与上下文

状态：成员 B 实现。日期：2026-10-22。基线是 `e67708a90ef2d675bfd852b6c5b2e564539ac4bd`。

本文说明 FR05、FR07、FR10 的 P0，以及 FR13 在本仓里的落点。FR10 的 P1（安全点暂停、方案重排）不在本期。产物正式提交属于 WP04，评审执行属于 WP05。

## 1. 包边界

| 包            | 本期内容                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------- |
| `agent-core`  | 运行尝试、回执、停止、终态信号、队列、故障、草稿交接、下一步提示。不读文件，不调度。     |
| `context`     | 一次运行的上下文清单、阻塞原因、隔离工作区与单一写入者。文件是否存在由调用方探查后传入。 |
| `dsh-adapter` | 执行器端口、显式模拟执行器、DSH 子进程、码道占位、工作区事务与本地演示服务。             |
| `client`      | `createAgentWorkspaceView` 只读投影。不导入 Host，也不保存第二套运行事实。               |

可操作页面在 `examples/agent-workspace`。根工作区仍然只有 `packages/*`。

跨包只用 `@zhuma/*`。演示服务在构建之后从各包的 `dist` 组合，避免让 `client` 依赖 Host。

## 2. 执行器

`ExecutionEngine` 增加 `'simulated'`。模拟执行器只能显式选择。没有注册所选执行器时，`selectAgentExecutor` 直接失败，不会改用模拟。

模拟执行器的能力声明：不支持实时注入，不支持会话恢复，支持取消回执和流式输出，`verified: false`，`mode: 'simulated'`。回复、工具活动和结果都带模拟标识。模拟活动的 `succeeded` 保持 false。

`DshChatExecutor` 在显式选择后启动 `dsh --profile sdk`，经 stdio 上的 JSON-RPC 对话。它读取 `ZHUMA_MODEL_BASE_URL`、`ZHUMA_MODEL_API_KEY` 和 `ZHUMA_MODEL_ID`。缺地址、密钥或模型时，`run()` 直接失败，原因里点名缺少的变量，不写出地址或密钥，也不改用模拟执行器。密钥只放进子进程环境变量 `ZHUMA_MODEL_API_KEY`。模型由 `ZHUMA_MODEL_ID` 提供，未设置时直接失败并点名该变量。运行时取 `ZHUMA_DSH_BIN`，否则取上游构建出的 CLI。`verified` 表示这条路由已经配好，并且运行时文件存在。找不到运行时时，原因里点名 `pnpm upstream:build-dsh` 和 `ZHUMA_DSH_BIN`。二进制不可执行时立即失败，不等初始化超时。进程在接收前退出时，stdin 上的 EPIPE 只让这次运行失败，脱敏后的 stderr 留在失败原因里。子进程环境设置 `DSH_TELEMETRY_DISABLED=1` 和 `DSH_TELEMETRY_MODE=DISABLED`。

生成的 `cordis.patch.yml` 是加载器补丁条目的顶层 YAML 数组，使用 `- id:` 和 `- insert:`。它不是映射。`llm-pi-ai` 写入模型路由、`apiKeyEnv: ZHUMA_MODEL_API_KEY`，以及 `input` 的 `text` 和 `image`。密钥不写进文件。

模型可见的技能是专家实际授权、并且这次勾选的技能。内容写到会话目录下的 `granted-skills/<id>/SKILL.md`，包含 `name`、`description` 和正文。`description` 用 JSON 字符串写入，说明里的 `:`、`#`、`[`、`"` 不会让上游把这份技能丢掉。`skill-filesystem` 设置 `includeDefaultRoots: false`，只扫描这个目录。`skill-office` 保持 `disabled: true`，并且不写入占位 `SKILL.md`。当前源码构建没有 `office/SKILL.md`。界面把这项标成不可用，原因是当前构建没有 Office 技能文件，授权不会加载文档技能。只有环境里已经有 `DSH_BUNDLED_OFFICE_SKILLS`，或运行时旁的 `office-skills/office/SKILL.md` 时，授权才会打开这个插件。不会下载技能文件，也不改上游子模块。

内置工具默认关闭。专家的 `toolAllowlist` 点名插件 id 或下面的名字时，打开对应的一组。`tool-skill` 保持开启，以便加载已授权技能。`agent-loop`、`llm` 和 `session` 不关闭。没有白名单时，模型仍然能看到六个会话工具：`create_goal`、`get_goal`、`update_goal`、`todo_write`、`exit_plan_mode`、`working_directory`，以及技能工具 `skill`。它们属于会话和技能，不在下面的关闭组里。`working_directory` 可以把当前目录改到一个已经存在的目录。

| 白名单名字                       | 打开的插件                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`、`shell`                  | `tool-bash`、`tool-pwsh`、`tool-jobs`                                                                                                                            |
| `write`、`edit`、`read`、`fs`    | `tool-fs`、`tool-fs-search`                                                                                                                                      |
| `web`、`web_fetch`、`web_search` | `web`、`web-search-deepseek`、`web-deepseek-api`、`web-fetch-http`、`tool-web`                                                                                   |
| `subagent`                       | `subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process`、`tool-subagent`、`tool-subagent-fork`、`tool-subagent-control`、`tool-subagent-list-agents` |
| `workflow`                       | `tool-workflow`、`workflow-ptc`                                                                                                                                  |

sdk 配置里没有现成的 MCP 客户端行。授权只有在带上传输时才插入 `@deepseek-ai/dsh-mcp-client`：`stdio` 要有 `command`，`streamable-http` 要有 `url`。只有 id、版本和标签的授权写进提示，不连接外部服务。没有配传输、或传输不完整时，界面在该 MCP 上标出「未连接」和原因「没有配置传输，不会连接外部服务」。运行记录里每次运行都追加一条未成功的 MCP 活动。界面上同一条说明只显示一次。不会把它从可选列表里去掉。

会话事件是 `{type, seq, time, data}`。助手正文在 `data.message.content`，随整段 `assistant/message` 一次到达。`data.stream` 是这条事件上的事后记录，不是可以订阅的增量。当前 SDK 接入方式不支持逐字通知，所以 DSH 的 `capabilities.streaming` 为 false。等待期间界面显示「生成中」。模拟执行器仍按片段交出正文，`streaming` 保持 true。一轮结束看 `data.reason.kind`，取值是 `completed`、`aborted` 或 `error`。

图片以 `contentBlocks` 的 `image` 交给模型，媒体类型只接受 png、jpeg、webp、gif。文本和 JSON 仍是文本。PDF 和其他文件在上传时拒绝：当前 SDK 接入方式不支持没有附件引用的 file 块，客户端发不出这个引用。内联 file 块会在到达模型前失败，并留在会话里让之后的纯文本也失败。拒绝发生在写入会话之前。文件选择器也不提供 PDF。执行器若仍收到这种附件，故障种类是 `attachment-rejected`，不是 `model-error`。发出的上下文、运行记录里的引用和界面上的引用是同一组：已勾选且匹配 `inputRefs` 的条目。未勾选的不发。`inputRefs` 为空时不发上下文，界面也不引用。勾选了缺失文件仍然整次阻塞。

`DSH_HOME` 在工作台数据目录下。数据目录依次取 `ZHUMA_DATA_DIR`、`ZHUMA_SESSION_FILE` 所在目录、`~/.zhuma/workbench`。每次会话用 `mkdtemp` 建在 `dsh-sessions/` 里。会话标识是 `zhuma-`、工作台实例随机段、再加一段随机，不从 `runId` 推导。工作台重启后从运行记录读取实际的 `sessionId`，再用 `session/resume` 接回。目录权限 `0700`，文件权限 `0600`。密钥不写入其中。接收前失败会删掉新建的目录。运行被核实为断开并且这次核实已经写入日志时删除会话目录。节点进入 `completed` 并且这次完成已经写入日志之后才删除。日志没写上时目录保持原样，下游启动次数也退回。历史运行仍保留原来的 `sessionId`，并标成已丢弃，不再用于 `session/resume`。目录已经不在时，下一次显式运行新建会话。新会话还没有自己的结果时，界面说明没有带上之前的历史；这一轮成功，或工作台重启之后，这条说明消失。`session/resume` 失败时删掉这次目录，历史记录标成已丢弃，原因写「恢复会话失败，已改用新会话。」，节点可以再运行。成功的一轮和停止之后保留，下一次显式运行用 `session/resume` 接回。工作台启动时清掉索引里没有的孤儿目录。同一数据目录里还有别的活进程的写锁时不清。写锁记录是随机令牌、pid、主机名和启动时间。记录先写进同目录临时文件并同步，再硬链接到锁路径。只有 EEXIST 表示路径已经存在，不会覆盖；ENOENT 不提示删除一条已经不在的路径。确认互斥还在和读到内容之间文件消失时，继续抢锁，不要求删除已经消失的路径。EPERM、ENOTSUP、EXDEV 不把进程打崩，这次改为只读，拒绝理由带上目标路径。崩溃留下的 .tmp 不自动清理，也不挡住别的写入者。别的主机、pid 被复用，或锁内容读不出来时，只读打开，理由里不写路径。锁路径要么还不存在，要么一次出现完整记录，不会是空文件或半截内容。过期回收不挪动锁文件。回收方用同样的方式把互斥记录挂到锁文件加 `.reclaim`。目标已存在则创建失败，不会覆盖。只有拿到互斥的进程可以再读锁。锁仍是刚才那个已死持有者的令牌时，才删除锁文件，并用同样的方式挂上新锁，然后删除互斥文件。死进程留下的互斥文件不做第二层自动回收，也没有超时。进程被 SIGKILL 留下的 .reclaim 一直只读，直到人工删除，错误信息写出要删除的那个文件的完整路径。进程退出或收到 SIGTERM、SIGINT 时只读锁文件，令牌仍是自己的才删除，不改名。每次保存前再读锁。令牌不是自己的，或锁文件已经不在，都返回 `ELOCKED`，并把这份日志标成只读，不再写入。活锁不会被挪走，所以文件缺失就是写权已经丢了。核对令牌和写入会话文件之间还有一段空隙，只有持有者已经死亡之后别的进程才可能补上新锁，死亡的进程不会把这次保存写完。只有同一台机器上该 pid 已不存在（`ESRCH`）才视为过期。没有令牌的旧锁用 pid、主机名和启动时间辨认。拿不到锁时只读打开；没有可恢复的日志则拒绝启动。拿不到锁时不会把对方仍在运行的执行核实成放弃。

`capabilities.sessionResume` 为 true，因为实现了 `session/resume`。工作台重启后子进程已经不在，仍然留下 `resumeGap`，不把未结束的运行当成还在执行。模拟执行器的 `sessionResume` 保持 false，`streaming` 保持 true。自测使用本仓的 JSON-RPC 桩和从真实 DSH 录制的事件。桩的模式只经 `ZHUMA_DSH_STUB_MODE` 传入，不写进会话目录，也不传给真实子进程。没有附件引用的 file 块，桩先返回 `messageId`，再以 `turn/end` 的 `error` 结束，消息含 `attachmentId`，并把这块留在会话里，使之后的文本也失败。这和录制的 `dsh-pdf-rejected.json` 一致。产品路径仍然在写入会话之前拒绝这种文件。上游包已经构建时，用它自己的 `loadOverlayPatches` 检查生成的补丁。没有构建出 app-boot，或库已经构建但依赖没有安装时，检查打印 `skip`，并说明要先运行 `pnpm upstream:build-dsh`，不因此失败。

`UnimplementedNativeExecutor` 仍覆盖 `codearts-cli`。`run()` 抛出未实现错误，`cancel()` 返回 `unsupported`。未验证或未配置的原生执行器在创建运行前被拒绝，不写入运行记录。

真实 DSH 和模拟执行器使用同一个 `AgentRunRequest`：任务、节点、计划版本、上下文引用、专家版本、资源授权、取消信号。结果包含运行身份、产物草稿、来源引用和验证说明。每次运行只加载交接引用与当前选择的交集；版本用交接引用上的版本。上下文包按 `ContextInputRef` 已填写的来源和版本取，空引用不放入提示。每条 `inputRefs` 都必须带非空白的 `sourceNodeId` 和 `artifactVersionId`。`contextPackId` 可以省略；出现时必须是非空白字符串。新建时缺任一项直接拒绝，不补写。交接的 `inputNote` 和 `expectedOutput` 非空时写进提示，分别标成输入说明和交付说明。`session/prompt` 返回 `messageId` 之后才发出 `accepted`。在此之前崩溃、握手失败、超时或停止，都不会把节点标成执行中，队列记为未应用。

## 3. 运行生命周期

一次发送创建一个 `ExecutionAttempt`。它有独立的 `id`、`attempt` 和 `generation`。节点要等执行器 `accepted` 之后才经 `execution-acknowledged` 进入 `running`。在此之前运行状态是 `requested`，节点保持进入前的 `ready` 或 `needs-revision`。

同一幂等键、同一内容重放，不创建第二条运行。同一幂等键、不同内容返回 `idempotency-mismatch`。刷新、切换视图和读取快照使用 `view-refresh` / `view-switch` 一类触发，`triggerMayCreateRun` 为 false。关闭页面不取消运行，页面计时器不把运行标成完成。

受理一次发送时，运行、写权和幂等键与这次日志写入是同一边界。`journal.save` 失败则回滚这次对 claims、runs 和 turns 的修改，返回 `persist-failed`，不启动执行器。排队受理也是同一边界：保存失败则回滚这条队列记录，前一轮结束后不会把它自动执行。存储恢复后的同键再试是一次新的受理，不能当成已经启动的重放。执行器事件写日志失败时不抛出未处理拒绝：内存保留这次事件，并标出持久化故障。故障还在时，界面上的状态不是已经落盘的成功回执。界面只写错误码和下一步，不写绝对路径，同一条故障只出现一次。下一次成功的保存会清掉持久化故障。`rewritePersistence` 成功重写当前内存时同样清掉，并不是只有它能清。用户命令先提交；延后队列恢复失败只记故障，不回滚刚提交的草稿和配置。配置、上下文勾选、附件、恢复请求、草稿、核实断开、确认完成、退回、等待输入、重试和排队受理在保存失败时整段退回，内存与调用前一致，也不记持久化故障。附件字节只在删除已经写入日志之后才丢掉。前一轮结束后如果下一轮没写上日志，排队消息保持可消费，存储恢复后的下一次成功保存会继续它，不会把它标成未应用。只有执行器异步事件写日志失败才留下持久化故障。下一次成功保存会清掉它。不另建存储。

运行正常结束时，`settleExecutionRun(..., 'completed')` 发出 `execution-finished`，节点回到进入运行前的 `ready` 或 `needs-revision`。`waiting-for-input` 上的正常结束也走这条迁移。效果只有 `await-human-submit`。这不是 `accept-handoff`，不打开评审，不触发下游，也不自动开始下一次调度。多轮对话因此可以再次显式发送。WP00 原来没有「执行结束但继续由人决定是否提交」的出口，所以增加了这条迁移。

已确认完成的节点不能再次 `openRunAttempt`。交接 `reviewRequired` 为 true 时，`confirmCompleted()` 拒绝，节点不进入 `completed`，会话目录也不删除。不要求评审时，它才用 `submit-artifact` 且 `reviewRequired: false` 进入 `completed`。

## 4. 终态信号、停止与恢复

`admitExecutionSignal` 复用 `observeRunSignal` 的世代和终态分类，再补上执行层自己的两条事实：

- 世代不一致先返回 `stale-generation`，即使这次运行也已经被替换。
- 运行标识不是当前有效运行时返回 `superseded-run`。`observeRunSignal` 不知道有效运行标识。
- 其余分类与观察函数一致。`completed`、`failed`、`cancelled` 上的任何后续信号都是 `terminal-run`：不改节点、不改写终态、不触发下游、不更新该运行记录。只追加 `LateRecord`。
- `requested` 上的核实失败只更新运行记录，不改节点。`requested` 上的进程成功或产物到达只作附属记录，`reason` 留空，不记成 `terminal-run`。
- 已经开始的运行上，核实失败可以随后使用 `execution-failed`。
- `cancel-confirmed` 在观察函数允许改节点时，`requiresStopRequest` 为 true。没有 `requestRunStop` 就收到取消，`settleExecutionRun` 记为 `cancel-unconfirmed`，节点不动。

`requestRunStop` 只把 `stopPhase` 设为 `requested`，节点仍保持 `running`，直到取消回执到达。停止会等这个回执，最多 4 秒。未知运行的取消立即返回拒绝，不挂起。超时或回执被拒绝时记为 `stop-receipt-missing`，`stopPhase` 回到 `receipt-rejected`，节点不标成已取消。模拟执行器在回执之前先交出取消事件和一条迟到输出，上层把迟到输出记成附属记录。执行器尚未回执接收就取消时，运行可以结束，但节点迁移是 `none`，不发 `cancel-confirmed`。

上游协议没有取消一轮的请求，通知里也没有。`upstream/deepseek-harness/packages/sdk/protocol/README.md` 写明客户端放弃一轮只能关掉运行时进程。`upstream/deepseek-harness/packages/sdk/server/README.md` 写明协议 `shutdown` 会结束整个进程，不是取消一轮。`session/resume` 从持久化会话恢复，历史留在日志里，不会作为新通知重放。因此 DSH 的停止是结束子进程。回执只认进程退出，或 `turn/end` 且 `data.reason.kind` 为 `aborted`。停止后保留这次 `DSH_HOME`，下一轮用 `session/resume` 接回。接收回执之前失败会删掉这次新建的目录，并把脱敏后的 stderr 留在失败原因里。页面在 `requested` 时显示「启动中」，`accepted` 之后才显示「执行中」。初始化超时走未应用。启动期间入口丢失、`execution-acknowledged` 被拒绝时，停掉执行器，这次运行失败，界面显示节点记录异常。

失败后的恢复命令是 `retry`，取消后是 `restart`。二者的 `returnTo` 必填，并且必须等于 `NodeCommandState.entryStatus`。记录是 `needs-revision` 时，`returnTo: 'ready'` 会被拒绝。新建时，`ready` 或 `needs-revision` 的节点命令带上同名的 `entryStatus`。读回或恢复时，入口必须和节点状态一致：`needs-revision` 不能配 `ready`，进行中、失败和已取消必须有入口，已完成、草稿和阻塞不能留下入口。`ready` 可以保留 `needs-revision`。对不上时记 `entry-inconsistent`，不改写记录。没有可验证入口时，`execution-failed` 仍进入 `failed`，已确认的 `cancel-confirmed` 仍进入 `cancelled`，并且不补写 `entryStatus`，也不把入口写成 `ready`。运行可以是失败或已取消，界面和下一次恢复都显示「节点记录异常」。下一步是核对 `entryStatus`，不是重试或重新开始。`retry` 和 `restart` 保持关闭。这种节点不能免评审完成，也不会 `accept-handoff` 推进下游。停止、执行失败和核实断开都走这条规则。正常结束的 `execution-finished.returnTo` 也等于这份入口，不用运行上抄下的 `entryNodeStatus`。然后由调用方显式再发送，才会有新的运行标识。需修改义务一直留到 `applyReviewSettlementCommand` 通过；子流程返回、失败重试和取消后重新开始都不能靠 `reviewRequired: false` 完成。改派和人工接回只记录 `RecoveryRequest`：`changesAssignee` 和 `forgesRun` 都是 false。谁真正改派由成员 A 决定。演示交接的责任人种类是 `human`，可以不带 `expertRef`。内部 agent 运行由 `toHandoffActor` 映射成 `human` 或 `expert`。

服务重启时 `ExecutionDesk.restore` 先装回事实，`interactionReady` 为 false，并留下 `resumeGap`。DSH 虽然实现了 `session/resume`，重启后子进程已经不在，所以这次中断仍然要核实为断开，不会自动续跑。继续交互之后，这条中断运行不再当作当前可补充的运行：发送和停止都要求先核实为执行器已断开，并且不会把 `stopPhase` 写成 `requested`。核实结果是失败，不是完成。入口已经丢失时，节点可以随之进入 `failed`，记录异常标记仍在，不补写 `ready`。恢复时读到非法交接不会让服务起不来：该节点标成记录异常，其他节点照常装入。新建时畸形交接仍然拒绝。缺少 `sourceNodeId` 或 `artifactVersionId`、字段为空白，或只带 `contextPackId` 的 `inputRefs`，新建时返回 `invalid-handoff`。从日志恢复时不抛错，标 `handoffInvalid`，下一步写明请重新建立交接，不要补写来源节点或产物版本。目前没有生产数据，所以不做迁移，也不在恢复时填上缺失字段。快照里的交接引用是副本。

模型错误、工具失败、网络中断、执行器断开和专家停用分开呈现。故障 `forgesRun` 为 false，并带对象、原因和下一步。

## 5. Agent 处理

演示页从具体工作项进入，并用「返回任务」回到该任务。任务页只显示返回位置，不发送、不创建运行。

每一轮保存用户消息或执行器消息、附件引用、专家版本和配置快照标识。刷新后从同一进程的事实里读回。切换专家不删除已有轮次。使用 Agent 后责任人标识保持不变。

表 8 的配置在数据和页面上都能看到：专家、执行器、模型说明及继承来源、Skills / MCP 的搜索多选和移除、附件、上下文引用摘要、不可用原因。选择 MCP 不会把 `toolsAuthorized` 设为 true，因此也不会自动授权全部工具。

「保存草稿」调用 `prepareArtifactDraft`。记录异常时这个按钮仍然可用，只保存草稿，不清除异常标记。草稿 `autoDeliver` 和 `skipReview` 都是 false，评审模式是 `new-round-required`。这里不调用 `createArtifactVersion`，节点也不进入 `in-review` 或 `completed`。空交付和非法链接仍由 `validateDeliveryContent` 在正式提交时拒绝，草稿层不复制那套检查。

## 6. 补充、队列和使用中的停止

模拟执行器 `liveInjection` 为 false。运行中的补充或排队都变成 `next-turn`，阶段走到 `pending`，并提示执行器不支持实时注入、发送成功不等于已应用。`advanceIntervention(..., 'apply')` 在仍处于 `sent` 时返回 `send-is-not-adoption`。

阶段顺序是已发送、已接收、待生效、已应用。取消或失败时，仍待生效的条目改成未应用，并写明未应用。待生效时「已应用」未到达。队列在当前运行以 `execution-finished` 正常结束后按先后消费每一条：第一条启动为新运行，其余仍待生效的条目改挂到这次新运行上，等它结束后再继续。已应用只发生在下一轮被执行器接收之后。队列记录冻结当时的附件引用和校验和，幂等指纹包含这些附件。同一键换了附件返回 `idempotency-mismatch`。消费时把这些附件交给执行器。附件字节只留在当前进程，不另建文件存储。重新打开或移除之后字节不在，发送和消费都返回 `attachment-reupload`，不启动执行器。快照把这种附件标成需重新上传。

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

缺文件、不可读、无权限、路径被拒绝或缺必需项时，整次为 `context-blocked`，不创建运行。`probeRelativeFile` 拒绝绝对路径、`..`、空段和空字节。符号链接会先解析，解析后的路径若离开工作区也拒绝。缺文件仍是不存在，结果里不返回绝对路径。

`isolateWorkspaceId(nodeId)` 按节点生成工作区。同一节点上第二个有效写入者得到 `workspace-busy`，直到前一个释放。

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

`in-review` 的评审待办要求节点带有非空 `currentRoundId`。轮次上的 `current` 不能代替它。记录异常时（`entry-inconsistent` 或 `invalid-handoff`，且没有进行中的运行）界面下一步改成核对记录或重新建立交接，不用上表的 `retry` / `restart`。重试和重新开始保持不可用。

## 10. 待 A 对齐

1. 项目成员、任务目标和多个节点报告如何折叠成任务汇总。
2. 计划版本、节点和边由谁发布。谁发出 `plan-started`。
3. 谁接受改派和人工接回。本包只记录请求。
4. 子工作流的创建和父子关系。
5. 团队可见范围。
6. 工作流上如何展示本包返回的节点状态、运行和草稿。

本包只消费 `NodeHandoff`，不计算任务汇总，也不实现编排。

## 11. 验证与未验证

领域规则的测试名称以「契约：」开头，只证明纯函数和内存事务。`examples/agent-workspace/browser.test.mjs` 用浏览器操作显式选择的模拟执行器，覆盖打开处理、多选资源、附件、两轮修改、刷新、补充排队、停止、迟到结果和重试。发送后先看到「启动中」，放开后才是「执行中」。截图目录来自 `ZHUMA_BROWSER_ARTIFACTS`，未设置时用系统临时目录。200% 缩放下不允许出现横向溢出。它不是真实执行器测试。`dsh-executor.e2e.test.mjs` 只在缺少 `ZHUMA_MODEL_BASE_URL` 或 `ZHUMA_MODEL_API_KEY` 时跳过。环境已经配好但找不到运行时，测试失败。密钥错误或网关失败时，运行记为失败，不改用模拟。对本地假网关跑真实 DSH 是单独的检查，不访问真实模型网关。

尚未验证：真实模型网关、码道、真实多人、真实文件存储和预览、WP04 提交、WP05 评审执行、FR10 P1。服务重启不会自动续跑未结束的运行。页面沿用参考工作区的青绿、浅底和组件间距，没有把原型包或设计技能文件提交进仓库。

已知限制：不含 NUL 的二进制会被当成 UTF-8 文本送出，可能变成乱码，读取行为保持不变。标准错误里长度达到 4 的密钥前缀，在流中间确认接不下去时，以及收尾时还剩下的那段，都会换成 [redacted]。不足 4 的前缀原样留下。

## 12. 本地演示

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -b
node examples/agent-workspace/server.mjs
```

浏览器打开标准输出里的 `url`。先在配置里选择「模拟执行器」，再发送。未选择时发送按钮禁用。停止会等待回执。「保存草稿」只保存草稿。

`ZHUMA_HOLD_RUNS=1` 让运行在接收回执前后各停一次。第一次页面显示启动中，`POST /api/release` 之后显示执行中，再释放才结束。`ZHUMA_SESSION_FILE` 把会话写到调用方指定的文件，不要提交该文件。未设置时，会话放在 `~/.zhuma/workbench`。构建上游 CLI 用 `pnpm upstream:build-dsh`。上游依赖缺失时，该脚本用 pnpm 11.28.5 和 `CI=true` 安装后再构建。模型路由使用 `ZHUMA_MODEL_BASE_URL`、`ZHUMA_MODEL_API_KEY` 和 `ZHUMA_MODEL_ID`。未设置模型时直接失败并点名该变量。运行时文件使用 `ZHUMA_DSH_BIN`。
