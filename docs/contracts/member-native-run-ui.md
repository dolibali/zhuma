# 正常成员 Agent 工作区

关联 #32 / #35；运行权威继续使用 [Host Run](host-native-run.md)。本文件记录客户端和只读 options 接缝，不替代原工作项的实时进度与退出条件。

## 入口与归属

人工 submit/revise 待办打开交付表单后，在表单标题操作区提供“使用 Agent”；文字交付仍保留原表单，不再增加重复节点标题的中间横栏。已确认工作流可对具体叶节点打开同一工作区，包含不出现在人工待办的专家节点。入口使用已确认 AppliedPlan 的完整 task/plan/revision/node 定位，不把未保存草稿或工作流容器当作可运行节点。计划的显式开始仍由原 start-plan 操作负责，打开工作区不自动开始计划或节点。

A 的 `NativeRunWorkspace` 连接 C 的受控 `NativeRunPanel`，经 `/api/zhuma-run/*` 调用同一 Host。Client 不导入 Host 或原生 SDK、不调用旧 owner RPC、不保存第二份会话和执行记录。公共 UI 出口是 `@zhuma/client/workbench/ui`，主题由原插件一次注册。

## 只读 options

`POST /api/zhuma-run/options` 仅接受 spaceId、taskId、planId、revision、nodeId；复用原 MemberRequest、成员 lease、空间目录、当前 controller 和完整节点门禁。该 exact 路由加入原桌面 cookie allowlist，并使用同一 128 KiB Run body 上限；没有放宽 ZIP 或其他路径。

模型来自实际 SDK listProviders/listModels，不调用 generate，不创建原生会话，不启用 writer。最多 16 个供应商、256 个模型，等待 2500ms；SDK 目录接口没有 AbortSignal 参数，因此仅能取消等待，迟到结果与异常不会发布为新响应。异步返回后重新核对成员、空间、controller 和输入，再同步读取当前节点、版本和 Run。注册模型目录不证明凭据或推理可用；每次推理仍由原运行服务核实。输出预算 4096 是本入口的显式应用策略，不是供应商默认值。

专家只投影完整 AppliedPlan 中的可用参与者和精确版本；专家指派只允许该固定专家，人工节点允许真实内置执行定义或固定计划专家，不从当前全局目录补人。已有 Run 的 actor/space 必须与刚授权的调用者一致，不能把旧 owner 快照投影给新 controller。响应仅包含安全选择元数据、当前 Run id、节点/Run 版本和资源可用性，不含提示词、方法正文、grant 或 native handle。

当前 Host 只接 text-only 与已接受正文输入读取。尚未采用的 Skills/MCP 显示不可用，阻止开始；文件上传或工具 PR 存在不代表已采用。基础执行定义不能替代个人专家库。

## 交互与恢复边界

工作区沿现有中性浅深主题和系统字体，以节点目标为唯一可见主标题，状态、停止、刷新和关闭同栏。首次运行默认展开模型与执行者配置，选好后显示“准备就绪”和一个显式开始动作；已有运行默认收为配置摘要，选择器和资源按需展开。显示固定计划参与者时使用已授权 AppliedPlan 的参与者快照，不因当前目录缺条目误标为未分配。已有指派但信息缺失明确显示“执行者信息未提供”。已确认工作流的 Agent 入口置于原工具栏，不额外铺节点标题栏。

“我的工作”将服务实际返回的 `agent-assisted-delivery / continue-handling` 工作项放在“处理中”，提供“打开 Agent 会话”。仅唯一匹配的当前 running 节点及可用成员 Run API 显示可操作入口；状态过期、重复工作项或多计划匹配均拒绝，未知通知不转成人工义务。入口复用同一 NativeRunLauncher，从已授权空间及精确任务/计划/节点读取 options 的 currentRunId，再读取该 Run 和历史，不从节点状态构造 Run 或发送 begin。团队任务工作树入口保留；重新进入、关闭和账号/空间替换继续沿用同一被动读取、取消及脏输入守卫。

消息和输入区共享居中的 740px 可读列，随窗口收缩。用户消息靠右限宽，Agent 正文左对齐，以位置、图标和无障碍名称辨角色，不逐条铺厚重角色标题。消息区独立滚动，输入区占满内容列并保持文字在上、发送方式和动作在下；停止在顶栏独立可达。`workspace` 弹窗复用原 Modal 与取消守卫，仅让会话自身提供标题/关闭；会话底部使用独立块而非匹配公共 `footer` 样式，不改变普通表单弹窗的底栏布局。停止后无可发送能力且无未发送草稿时，展示紧凑状态和显式“开始新一轮”；仍有草稿则保留编辑区与原脏输入守卫，不因能力变化丢文字。

打开、刷新和历史只读。模型和执行者必须显式选择；已有运行显示其保存的配置，held/active 时冻结。begin/send/stop 只由明确动作触发，未知结果重试相同内容沿用请求 id；不会在刷新或重挂载时自动重发。停止使用同一次 read 返回的 Run generation/segment/版本，真实回执保持 pending/stopped 区别。

会话/空间 controller 实例替换、账号 epoch、空间 epoch、页面 epoch、API 或完整 target 变化会使表单重新挂载。旧 controller 主动中止等待读取；迟到读取不能发布或接续读，旧动作不能经新 API 发送。客户端提示不作为权限。

Stop 使用独立于 pending send 的命令通道，不等待发送回执或重启 Agent。每种命令保留自己的幂等键；Stop 优先显示忙碌状态并隔离旧 send 的迟到成功/失败。未确认停止的同一 Run 保持发送禁用，只有重新读取的真实 settled/confirmed 或不同 Run 才解除界面停止栅栏，不伪造业务停止事实。

只有当前 epoch 的命令票据参与互斥和 busy。刷新已读取真实 Run 后，旧 epoch 的 begin/send 等待不再挡住该 Run 的停止或新操作；旧 finally 必须匹配原票据，不能删除新的同类票据或幂等键。没有读取到当前完整 Run 时仍拒绝停止，不从旧 begin 请求猜运行标识。

未发送输入只在面板本地；仅把 dirty 布尔值接入既有空间/导航守卫。关闭或 ESC 使用现有紧凑离开确认，取消保留原输入并恢复焦点，确认放弃才卸载本 scope。离开不停止 Run、不撤销已发送操作；真实账号/controller 撤销仍即时卸载，不将输入带给新账号。

工作会话关闭时先关闭原生 dialog，再在卸载提交后回焦实际打开它的按钮；触发器已经随账号/空间/节点替换而断开时不回焦旧 scope。选择器里的 Esc 先关闭选择菜单并回焦选择器，后续 workspace cancel 才执行上述关闭与回焦；普通长表单弹窗行为不变。

会话可见且资源 held 时每 2500ms 只读进度和历史，不重新发现模型、不连接或驱动 Agent。历史沿 SDK 正向 seq 游标读取并保留已加载消息；不把未知 payload JSON、system/developer 内容、工具参数或 reasoning 展开到消息区，也不把正向分页称为较早消息。原生正文流仅用于展示进度；任意旧页回看和自动采用输出为交付仍未接入。

固定 SDK 将运行上下文也记录成 `user/message`，因此历史展示以其实际 `message.role` 与 `message.source.kind` 一起判别来源：只显示 `user/user` 和 `assistant/model` 的文字块，工具仅显示 `tool/call` 名称。`runtime-context`（含 snapshot sections 与清空快照）、指令、目录注入、来源缺失或未知的消息及原始工具结果均不作为聊天正文展示；不把来源对象、replayState 或内部配置复制到 UI。判断不依赖正文关键词，真实用户或 Agent 谈到运行上下文时仍正常显示。

## 原生 inbox 与正文流

`POST /api/zhuma-run/inbox` 返回同一 cut 的 pending 用户文字及 receipt 状态；`received` 显示“已收到 · 待处理”。原生 `claimed` 仅表示进入会话记录，不表示模型已采用。已保存用户消息与 pending 使用真实 message id 合并，避免显示两次。

`POST /api/zhuma-run/observe` 沿同一个原始 MemberRequest 打开真正只读 grant，并在整个观察期保有。原生观察先建立，再发送只读 ready 帧，让空闲会话也能及时返回响应头；该帧不表示模型采用或执行成功。每帧核对准确 scope/nativeSessionId，公开投影只保留 message、assistant-stream、status 和 gap 的白名单字段。运输为带 rpcId 的 NDJSON，每次按消费者需求写一帧，上限 512 KiB；读取取消、成员撤权与 Host 关闭中止读流并排空，不停止模型或补发消息。原有桌面 cookie 桥只增加这两个准确路径。

Client 每次建立读流仍核对真实成员账号/空间，逐帧验证 Run、generation、segment、session 和 messageKey。推理及工具参数被原生投影过滤，因此可见 index 允许跳号，只要求单调增加。临时正文只留在内存，终态按原生 seq/messageKey 合并为一个持久消息；abandoned/assistant-attempt 不捏造为已提交回复。断流保留已保存记录，gap 使用本界面已经扫描的持久游标重新读历史，不跳到 gap.after。关闭、切换账号/空间或节点卸载观察，迟到帧不能写回新视图。

正式 `desktop:verify:native-lifecycle --phase native-stream` 注册 C 的完整 73 项原生会话场景及独立 inbox write/read 两个进程模式，并运行 emitted Host 的正常成员运输场景；`host-run-cold` 保留原冷恢复场景。临时 SDK checkout 在 finally 中移除，报告仍保留。原始 SDK loader 466 项资格化属于独立 phase，不因本批再次执行。

## 验证口径

Node 契约覆盖被动读取、未知结果幂等、固定选择、模式能力、账号/空间变化、迟到响应和已知历史字段投影。Host 组合验证使用真正成员 cookie、HTTP、JSON/JSONL、官方 SDK 与本地 scripted 模型，单列其证据；不冒充真实供应商质量、正常 GUI、安装版、文件提交/评审或跨冷进程完整恢复。正常桌面操作由协调安排，仍以精确构建和原工作项结论为准。
