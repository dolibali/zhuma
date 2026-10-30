# CodeArts 接入叶子

`registration.ts` 提供 Host 内部的 `CodeArtsProfileRegistrationProducer`。`prepare` 校验实际 Node／Electron、适配入口和 CLI launcher 的路径与 SHA256，返回完整 ACP profile 和本代不透明对象。注册时调用 `guardForProfile(profileId, actualFullConfig)`，取得本代闭包；注册替换、撤销、卸载、父信号取消、配置或文件变化都会令旧闭包失效。A 的 registry 另外核对当前完整配置，产品接入传动态闭包。普通目录展示无需启动 CLI。

`http.ts` 仅连接本进程拥有的 loopback 服务，使用单独生成的 Basic 凭据。会话创建固定目录和明确 permission 配置；恢复读取原 ID，失败保留错误。历史和 SSE 只返回已绑定会话，流关闭会取消 reader。写请求遇到不确定结果不会自动重发；abort 返回的是确认回执，真实进程排空沿原 Harness Subprocess 能力核对。

`main.ts` 是独立的 Node ACP 入口，A 需将其构建成自包含产物，并由注册生产者校验该实际产物的 SHA256。`initialize` 只协商能力；携带当前工具桥的显式 new／resume／load 才建立自己的 CodeArts serve。每个 ACP connection 只拥有一个任务会话，第二个工作项返回 busy，原会话继续保留；不同连接分别管理 serve、桥和停止范围。普通 DSH 历史仍走原历史系统。

原社区 ACP 模型 probe 通过 `session/new({cwd, mcpServers:[]})` 读取 `configOptions`。此形状只得到 `metadata-only` ACP 逻辑会话，独立 ID 不属于 CodeArts SID，最多保留 8 个，关闭或连接销毁即释放；它不占任务绑定容量，也不能 prompt、load、resume、设置模型或转换成任务。返回的 `provider-default` 是本适配器已定义的路由策略“继承码道当前配置（开始时解析）”，来源是已核对 SHA 的适配器能力声明，不是已发现的供应商模型 ID、认证健康或可用模型事实。探测不启动 CodeArts backend／CLI，不读取全局认证或模型配置。普通被动 options／执行器选择仍由 A 使用已核对的被动元数据，不能因此调用通用 probe 或启动 ACP 适配进程。

路由来源绑定完整固定 profile 与注册生产者代次：Node、适配入口或 launcher 文件变化，完整 profile 改变、替换、撤销、父信号取消均令旧 guard 失效；A 的 registry 保留原完整配置和探测缓存失效规则。实际供应商／模型仍由真正任务的原生用户记录确定；探测成功不认证 CodeArts 登录、工作区信任或模型可用性。需要这些事实时须在明确的资格操作中另作有预算检查。

`routing-metadata.ts` 的 `describeCodeArtsRoutingCapability()` 为零依赖、零 I/O 的纯元数据出口，返回冻结的 `{ id, name, kind: 'adapter-routing-capability', backendVerified: false }`。ACP 的 configOptions、兼容 models 字段与 `_meta` 复用同一描述；A 单写公开 exports 和 Host 被动投影，仅对原 prepared 且仍有效的固定 profile 展示它。原 `CODEARTS_PROFILE_ID` 继续由注册模块唯一提供。该描述不携带模型目录、凭据、会话或授权。

`policy.ts` 只接受当前固定插件生成的单个 DSH HTTP 桥。每进程配置禁用内置工具，开启该桥，并在每次明确 prompt 后置写入 deny-all 加本代桥 namespace 的 allow；恢复不会沿用旧桥权限。CodeArts 内置 user-shell 不作为任务端口。授权、审批、产物和评审继续由原 DSH 工具与 Run／成员门禁处理。原工具交接补丁由 A 按协调冻结的社区源 pin 纳入发行。

当前入口固定核对已验证的 CLI 26.10.13，使用正常 CLI 认证及既有会话模型，不读取全局模型配置。首个请求生成的原生用户记录确定模型；继续时复用该模型元数据。文本和内联文本资源可用；图片、任意本机路径及额外工作目录会被明确拒绝。取消在未发送时不启动请求；请求尚未确认进入 provider loop 时退出自有 backend 并保留不确定结果。abort／主进程退出与官方外层 Subprocess 的托管范围排空分别观察。

文件校验、permission 回显、CLI 退出和会话文本均不认证产物交付。真实 CLI → 本地合成 provider／scoped MCP 的定向资格已观察到仅受控桥声明、一次受控读和一次越界拒绝、native bash 为 invalid；这不替代当前 ACP 产物、真实 DSH Run 与模型的组合验收。

本地契约测试使用合成文件和 HTTP 响应。真实 CLI 会话与恢复的无模型证据分别记录准确 launcher 和编译产物；Windows／Linux、真实模型和完整任务交付另验。
