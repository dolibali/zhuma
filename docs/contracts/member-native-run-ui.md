# 正常成员 Agent 工作区

关联 #32 / #35；运行权威继续使用 [Host Run](host-native-run.md)。本文件记录客户端和只读 options 接缝，不替代原工作项的实时进度与退出条件。

## 入口与归属

人工 submit/revise 待办旁提供“使用 Agent”；文字交付仍保留原表单。已确认工作流可对具体叶节点打开同一工作区，包含不出现在人工待办的专家节点。入口使用已确认 AppliedPlan 的完整 task/plan/revision/node 定位，不把未保存草稿或工作流容器当作可运行节点。计划的显式开始仍由原 start-plan 操作负责，打开工作区不自动开始计划或节点。

A 的 `NativeRunWorkspace` 连接 C 的受控 `NativeRunPanel`，经 `/api/zhuma-run/*` 调用同一 Host。Client 不导入 Host 或原生 SDK、不调用旧 owner RPC、不保存第二份会话和执行记录。公共 UI 出口是 `@zhuma/client/workbench/ui`，主题由原插件一次注册。

## 只读 options

`POST /api/zhuma-run/options` 仅接受 spaceId、taskId、planId、revision、nodeId；复用原 MemberRequest、成员 lease、空间目录、当前 controller 和完整节点门禁。该 exact 路由加入原桌面 cookie allowlist，并使用同一 128 KiB Run body 上限；没有放宽 ZIP 或其他路径。

模型来自实际 SDK listProviders/listModels，不调用 generate，不创建原生会话，不启用 writer。最多 16 个供应商、256 个模型，等待 2500ms；SDK 目录接口没有 AbortSignal 参数，因此仅能取消等待，迟到结果与异常不会发布为新响应。异步返回后重新核对成员、空间、controller 和输入，再同步读取当前节点、版本和 Run。注册模型目录不证明凭据或推理可用；每次推理仍由原运行服务核实。输出预算 4096 是本入口的显式应用策略，不是供应商默认值。

专家只投影完整 AppliedPlan 中的可用参与者和精确版本；专家指派只允许该固定专家，人工节点允许真实内置执行定义或固定计划专家，不从当前全局目录补人。已有 Run 的 actor/space 必须与刚授权的调用者一致，不能把旧 owner 快照投影给新 controller。响应仅包含安全选择元数据、当前 Run id、节点/Run 版本和资源可用性，不含提示词、方法正文、grant 或 native handle。

当前 Host 只接 text-only 与已接受正文输入读取。尚未采用的 Skills/MCP 显示不可用，阻止开始；文件上传或工具 PR 存在不代表已采用。基础执行定义不能替代个人专家库。

## 交互与恢复边界

打开、刷新和历史只读。模型和执行者必须显式选择；已有运行显示其保存的配置，held/active 时冻结。begin/send/stop 只由明确动作触发，未知结果重试相同内容沿用请求 id；不会在刷新或重挂载时自动重发。停止使用同一次 read 返回的 Run generation/segment/版本，真实回执保持 pending/stopped 区别。

会话/空间 controller 实例替换、账号 epoch、空间 epoch、页面 epoch、API 或完整 target 变化会使表单重新挂载。旧 controller 主动中止等待读取；迟到读取不能发布或接续读，旧动作不能经新 API 发送。客户端提示不作为权限。

Stop 使用独立于 pending send 的命令通道，不等待发送回执或重启 Agent。每种命令保留自己的幂等键；Stop 优先显示忙碌状态并隔离旧 send 的迟到成功/失败。未确认停止的同一 Run 保持发送禁用，只有重新读取的真实 settled/confirmed 或不同 Run 才解除界面停止栅栏，不伪造业务停止事实。

未发送输入只在面板本地；仅把 dirty 布尔值接入既有空间/导航守卫。关闭或 ESC 使用现有紧凑离开确认，取消保留原输入并恢复焦点，确认放弃才卸载本 scope。离开不停止 Run、不撤销已发送操作；真实账号/controller 撤销仍即时卸载，不将输入带给新账号。

会话可见且资源 held 时每 2500ms 只读进度和历史，不重新发现模型、不连接或驱动 Agent。历史沿 SDK 正向 seq 游标读取并保留已加载消息；不把未知 payload JSON、system/developer 内容、工具参数或 reasoning 展开到消息区，也不把正向分页称为较早消息。现批没有流中 token 推送、任意旧页回看或自动采用输出为交付；这些边界继续保留。

## 验证口径

Node 契约覆盖被动读取、未知结果幂等、固定选择、模式能力、账号/空间变化、迟到响应和已知历史字段投影。Host 组合验证使用真正成员 cookie、HTTP、JSON/JSONL、官方 SDK 与本地 scripted 模型，单列其证据；不冒充真实供应商质量、正常 GUI、安装版、文件提交/评审或跨冷进程完整恢复。正常桌面操作由协调安排，仍以精确构建和原工作项结论为准。
