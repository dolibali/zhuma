# 完成意图工具的固定 Run 配置槽

关联 #35 / #113。只保存 C 的 `complete_work` 声明候选，不注册工具、不推断任务完成、不提交产物，也不保存结果正文或新状态库。原生调用、停止排空、固定结果引用与真实提交权限仍由 C / 原执行 owner 提供，Host 装配及公开导出由 A 接入。

## 接口与候选版本

`ExecutionRunCompositionInput.resultIntentTool?: ResultIntentToolDefinition` 位于顶层，与 tools / acceptedFileReader / resourceCatalog 独立。接口继承 AcceptedInputToolDefinition 的只读 description / parameters / outputSchema，固定 `name: 'complete_work'`、`sourceVersion: 'zhuma-native-result-intent@1'`。仅新 Run 在真实端口就绪后显式选择；浏览器字段、同名工具、描述或摘要都不产生提交权限。

C 提供的源 JSON SHA256 为 `241bae9b4e21db3acbf9f4a4743d10e0934e1abc473ef1c259304f6518215931`，canonical 字段 SHA256 为 `fe37b46ba16dc45e7dc24060a69d339e856efd982522df1efb1420e91798b386`。完整描述、参数和返回都严格校验；null / false、额外字段、其他 sourceVersion 或仅同名的描述均拒绝，不静默当作省略。既有 toolsSchema 不接纳此新工具。

当前 @1 仅有固定 SDK 声明实际注册资格，完整默认 factory 的真实调用与固定 cut 正例仍待 C 交付，因此不是最终产品接受结论。版本或描述变更必须显式重新资格化，不能更改旧 Run 保存值。

C 的声明参数为可选 text 与必填 links，返回区分错误和 declared；100000 字符、20 个无 userinfo 的 HTTP(S) 链接、非空结果、无文件 / 路径等业务限制由 C 同一严格调用 parser 校验。本模块不解析结果正文，不以描述中的限制替代实际校验，也不把 declared / idle / 模型文案视为交付。

## 固定快照和原预算

新 Run 显式选中时采用 schema 2，将准确描述保存到 payload.resultIntentTool，加入原 toolAllowlist 并计入原 composition 配置摘要。schema 2 至少有 resources / acceptedFileReader / resultIntentTool 一项，三者可以组合；无 resources 时仍沿原资源桥的空 Skill 域路径，不因新增工具继承个人或全局 Skill。

原快照 65536 UTF-8 字节、schema 2 工具数量最多 40 及各资源预算不变，超过即拒绝，不截断、不拆新配置库。配置只保存工具描述，允许的结果正文长度不用于扩大快照预算。beginRunNow 只从已经严格解码的 payload 可选透传该槽，再通过原配置重算；不信任 raw DTO 或新资源来源自签。

旧 schema 1、资源 schema 2 和文件 reader schema 2 的 JSON / configurationId 原样恢复，不根据当前 Host 新能力补工具。新槽会产生新配置 ID，同一旧请求键不能覆盖旧 Run；恢复仍采用原固定配置。

## 证据边界

纯配置测试固定准确声明及新增前的旧快照，验证独立 / 组合槽、完整描述篡改、旧字节与 ID、原 40 工具和字节预算，并调用官方 SDK JSON validators。真实 Cordis / DSH JSON Service 契约验证有 / 无 resources 的原队列透传、幂等与旧 Run 不回填；身份与资源来源仍是 doubles。未认证实际 complete_work 调用、原生 cut、结果 issuer、提交、评审、下游、真实 Host 或 GUI；声明合法不等于实际完成链路通过。
