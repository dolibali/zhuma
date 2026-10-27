# Host 原生 Run 消费

范围入口：[#32](https://github.com/dolibali/zhuma/issues/32)、[#35](https://github.com/dolibali/zhuma/issues/35)、[#113](https://github.com/dolibali/zhuma/issues/113)。本文记录接缝和证据边界，实时交付状态以原工作项和 PR 为准。

## 原有 owner 的组合

Host 从 `ExecutionPluginConfig.publishRunService` 接收已经打开的唯一 `ExecutionService`。原执行域、节点整行写入和业务队列不变；原生子作用域只打开一个 C 会话映射 owner，并安装同一 D manager 的来源端口。没有备用执行器、第二个 Run 域或另一套聊天记录。

原生服务依赖缺失时，成员人工读写仍可使用原执行入口；原生运输返回不可用。启动、浏览、读历史和配置装配不启用 writer，也不创建或唤醒 Agent。

## 显式开始与消息

Run 入口为 `/api/zhuma-run/{options,begin,send,stop,read,history,inbox,observe}`，沿用 Connection 信封；method 与路径必须一致，observe 使用有界 NDJSON 帧。原始 Cookie/Host/Origin 由同一 Host 中的身份模块核实，运输先认证再读有界正文，业务操作再次取得真正的成员授权。桌面 Cookie 桥仅转发已声明的精确路径。

`begin` 接收任务、精确计划版本、节点、请求 ID、乐观版本、显式模型/执行者/工具模式和新 Run/段标识。客户端不能提供 actor、冻结配置正文、能力对象或工作目录路径。当前 workspace 仅接通 `text-only`；正式本地工具、文件生成及 MCP 仍须单独接入。导入 Skill 的实际采用沿已注册的原隔离资源和冻结 allowlist，不由定义可选推断所有工具可用。

Host 用 `readRunCompositionInputs(originalRequest, locator)` 取得原执行 owner 的新鲜可见输入投影，覆盖人工节点及不在人工待办中的 expert-ready 节点。不扫描私有 store，也不把缺目标/缺数组解释为空输入。配置采用准确 AppliedPlan 中的节点与专家；基础任务执行者有实际定义，指定专家缺失时拒绝替换。模型 provider 注册只表示存在路由，不认证凭据或真实推理成功。

`startRun` 在 D 原队列内完成 marker 前后真实授权/当前输入复核和整行持久化。成功后 Host 立即取得同 manager 的 cleanup 能力，再异步取得驱动授权、迁移或发送。原生 compose 读取该 Run 保存的完整 snapshot，注册实际 C 工具后使用保存的 context/allowlist，不另拼一份输入目录。

未发布的 compose 阶段安装原生观察器，随后仅接受 registry 中同一已发布 Agent 的事件。C 返回的当前 receipt.messageId 与真实 `user/message` 对上后才写 D accepted；绑定创建、received、原生 idle 均不表示完成。原生故障只按实际 Agent 实例关联，不读取或保存原始错误正文。正常 idle 保持持续 Run，不自动提交产物、批准评审或推进下游。

重复开始返回原有 durable Run 事实，不再次调用 native send/resume。后续 send 取得新鲜成员授权，沿用保存的模型/配置及同一活跃会话；发送正文保留原始空白。未核实的首次投递或已 detached 会话拒绝隐式接管。重试/重启的旧绑定迁移使用原 manager 的 migration grant 和 C 的真实 prepare/migrate，不用 drive grant 冒充迁移权限。

若同一 C owner 曾实际返回 retired、无 binding 且 drain 为 absent-unadmitted，Host 可在进程内有界保留这一物理观察。仅旧 Run 已 failed/settled、无 ack/原生 ID、精确原 scope 及 drain 仍有效，并且新 Run 已持久化并取得新真 drive grant 时，才交 C 规范 send 创建首绑定；不制造旧绑定或改写迁移结果。

冷重开丢失旧观察时，正式 dispatch 先打开当前新 Run 的真实 drive grant，以持久 requestId、inputFingerprint、scope、selection 查询同一个 C owner 的 migrationOrigin。只有实际 NativeWorkError/not-started（整个 locator 记录缺失）才向 D 的 unadmittedCleanup 派生旧 scope 限定能力，沿原 retireForCleanup 取得新的物理 drain；pending、旧 binding、非 absent-unadmitted、撤权或失效均拒绝。该观察不持久化为证书，仍须原 assertHostAbsentRetry 和 canonical send 检查后才可首次绑定。已有记录继续原 prepare/migrate；普通 read/history 和同键重放没有 dispatch 效果，不能触发这条清理。D 原型与未修 Host 的两进程失败保留在 #139 的独立证据中，不能认证本次正式接入。

`verify-native-lifecycle --phase host-run-cold` 在同一固定补丁 SDK 检查原 Host 场景，并对未受理、unknown 历史、已有 binding 和重试持久化后登出分别启动独立 writer/reader OS 进程。夹具使用原 emitted Host、成员 Cookie、JSON/JSONL；仅控制真实存储 put 故障/等待，不注入恢复实现、伪造 binding 或 drain。撤权场景在新 Run 持久化后、驱动授权打开前登出；清理 await 中撤权另由明确的契约测试覆盖，不能混称为真实进程时序证明。模型始终为本地 scripted adapter，GUI/安装及真实供应商仍分别验收。

## 读取

read/history 每次取得新鲜只读授权并释放；不连接、恢复、发送或打开 writer。read 投影包括 Run/段、版本、dispatch/resources、acknowledged、stopPhase 和原生会话状态，不返回 grant、配置全文或原始请求头。逐模式可用性另取得并立即释放真 controller 驱动授权作校验，不调用驱动；steer 还要求实际 native.running，queue 仅表示停放下一轮。history 使用有界页和原生 seq 游标，保留原历史来源。

## 专家固定正文交付

新建的专家负责节点将 C 的准确 `complete_work@1` 描述冻结到原 Run 配置，并在未发布的原 Agent scope 中注册真实工具。人工负责节点即使选择计划中的专家来处理，也不获得这条自动提交能力，仍由负责人核对并手动提交。旧 Run 未冻结该描述时继续原语义，不补工具、不换 allowlist。

模型必须显式调用该工具提交最多 100000 字符正文及最多 20 条安全 HTTP(S) 链接。声明、普通回复、idle 或收到事件均不是业务交付。原 C issuer 核对真实日志、完成轮次和来源，实际退休 writer 并排空读取后，才签发进程内真实固定引用。Host 在 SDK 回调栈外接收原 onReady、等待原 accepted 与资源排空，将同一原 manager grant 和原引用交给 D 的 `submitNativeFixedResult`。原 D 队列复核成员、专家、Run 世代、冻结配置、引用与租约，然后同次节点整行持久化 Run 结束、原产物版本、需要时的评审轮次及幂等回执。

成功持久化会正常撤销 drive grant，之后不再向 C 请求 send 权限或重新签引用。若提交回复丢失，Host 只通过 D 的 `confirmNativeResultDelivery`，用新鲜成员和精确历史 Run 来源读取原回执；刷新与冷重开不再次生成产物、启动模型或修复业务记录。`read.resultDelivery` 仅包含已确认的产物／评审／回执引用，或明确的待固定状态；正文保留在原产物中，不复制到 Run 元数据、历史或实时帧。等待固定时仍允许原停止操作，不提供新的消息驱动能力。

`verify-native-lifecycle --phase host-results` 在本次实际 Host bundle、固定补丁 SDK、独立测试成员 Cookie 与 JSON/JSONL 上检查正文、100000 中文字符的历史／NDJSON 帧、人工负责边界、停止、真实原生作用域异常和冷回执。冷 writer 在原真实节点 put 保存后注入一次回复丢失，另一个 OS 进程重新登录只读确认；原业务字节不变且模型与 Agent 创建次数为零。模型输出仍为本地脚本，此范围不认证真实供应商质量、正常 GUI、安装包或 Agent 文件生成／发布。

## 停止与关停

显式 stop 先在 D 原队列记下停止请求，再用原 cleanup 适配 C `retireForCleanup`。撤权后也只允许这条物理清理，不再使用过期成员 grant 去读取历史或驱动。pending 保留资源 claim；仅真实退休及输入来源排空证明后，才写 stopped/cleanup。错误、未见绑定或没有收到回复不能直接变成 settled。

全 Host 关停共享同一个 close Promise：先同步 fence 和取消原固定结果 owner，完成其实际读取／作业关闭后再关闭 C 原生 owner，并等待已接纳操作及晚到事件；原生 close 成功后，原 cleanup 能力在仍打开的 D 队列提交清理，之后才允许执行域及共享 Workbench 关闭。C 关停会使逐 Run drain 失效，因此全 Host 使用实际全 owner close 成功事实，不复用失效 drain。close 失败保留未核实 claim 并传播失败。

## 验证边界

内容、来源、读取和观察器单测是明确的契约检查。`verify-native-lifecycle --phase host-run` 重新生成并复制实际 Host bundle 字节，在固定补丁 SDK、隔离测试目录、真实成员 Cookie、JSON/JSONL 与原执行 owner 中执行组合场景；模型输出来自本地 scripted adapter，不能认证真实模型质量或费用调用。默认 all 同时保留原生 SDK/迁移/跨进程等原有检查，并新增 working-directory 九项。

发行 Web importer 显式声明实际使用的 llm/session/session-persistence SDK 依赖，Session 从 dev 提升到 production，并同步固定上游锁文件；Host 保留这些实际服务的 external 模块身份。未验证安装版、正常产品 UI、本地文件/工具或真实模型前，不把上述接线称为完整产品闭环。
