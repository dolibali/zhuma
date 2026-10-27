# 原生独立评审运行接缝

关联 #35 / #41。复用原 `NativeWorkSessionService`、`DshNativeWorkRuntime`、`NativeResultOwner`、官方默认 Agent factory、队列、SDK 历史和物理排空。没有第二个聊天库、评审事实库或执行循环。作者九字段 scope、key、记录 v1/v2 及两个 `complete_work` getter/hash 不变。

## 实际入口

- `openNativeWorkSessions(ctx, nativeOptions, reviewPorts?)`：唯一原 bindings 域。首次评审写入前，先持久确认 review writer marker；失败不创建 Agent。未配置 reviewPorts 时评审入口拒绝，不回退作者授权。
- `NativeReviewPorts` 在 `native-work-session-purpose.ts`：`authorize(original, NativeWorkAction)`、`readTarget(original, query, signal)`、`unavailableRequired(original)`。这是 C 的 Host 接缝，不是可反序列化授权 DTO。生产适配器必须在真实 D issuer 中验证原对象身份、当前 controller/轮次/固定产物/专家与冻结配置，并提供撤权 signal。公开 scope、对象自带 assert、作者 grant 或 workflow ticket 都不足以授权评审。
- `service.reviewGrant(original)`：只在上述真实校验后投影原九定位字段，原对象与角色信息保留为 owner 内的临时路由元数据；每个动作重新验证。复制的定位和其他 Service/runtime 的评审能力不能进入作者或评审路径。仍调用原 `send/open/stop/history`，不建立平行会话服务。
- 先按原入口创建一次结果 owner，再调用 `nativeFixedReviewIssuer(service, runtime)` 取得其评审视图。它不创建新 owner。实际方法为 `registerNativeReviewTools`、`prepareFixedReview`、`assertFixedReview`、`readFixedReview`。
- 两个评审工具只在独立评审 Run 的原 Agent scope 注册；作者不提供 `complete_review/read_review_target`，评审不提供作者提交工具 `complete_work`。

评审投影能力要求精确原对象接收 assertion。作者回退前同时拒绝借用已知评审 scope、投影 signal 或 assertion 的未知对象；同步 assertion 调用也保留当前接收对象来源，bound/forwarding 方法不能替另一个对象资格检查。角色观察仍只存 WeakMap/WeakSet，不从 JSON 授予 purpose。投影 signal 独立派生并跟随原撤权，原 Host 共享 signal 不被标为评审，保持旧作者来源兼容。复制拒绝发生在 binding 写入、原 factory 和模型请求之前。

D 的 `ExecutionReviewReadGrant` 只授权固定目标读取。须经过原 Service 的 issuer 鉴别；不能拿它授权 Native 启动/send/落票。真实 Drive/冻结 model、Skills、MCP 资格仍由 D/A/Host 原链路接续，组合不完整时保持拒绝。配置元信息不是资源已实际采用的证据。

## 纯清理与冷进程

热进程的 `retireForCleanup` 保留同一 owner 已路由的 review scope 角色，仍逐次调用原 cleanup 断言，不删除 scope 比较。角色不会随九字段解析或复制丢失；其他 owner 的已路由 scope 拒绝。原共同 `retireScope` 在同一 bindings 域通过 review adapter 严格核对 v3 context 与内层 binding，再等待原元数据/正文 I/O 槽和实际 writer 退役，不按旧作者记录误报 absence。Stop 与 cleanup 并发时，Stop 等待同一实际退役及其 drain，不能以关闭句柄错误充当停止确认。

新进程不从持久 JSON 续签 send。可选同步 `NativeReviewPorts.authorizeCleanup(original): ExecutionReviewScope` 由 Host 先调用 D 原 Service 的 `assertExpertReviewCleanupAuthority(original)` 验证真实 cleanup issuer，之后返回其准确 scope；仅调用对象自报的 `assertCurrent` 不足够。`service.retireReviewForCleanup(original, waitSignal)` 只在该核对后建立本 owner 临时角色关联并复用原共同清理，缺口、异步 producer、复制对象、来源替换、跨 owner、目标变化均拒绝。该入口不获取成员 drive/read、模型 selection 或评审目录，不构建 Agent、不写 ballot。D 仍负责原 admitted/held、准确 round/artifact/native IDs 与新进程清理重资格，不允许凭 scope 数据升级权限。

caller 取消或超时只结束等待；已开始的物理清理仍归原 owner 持有，直到真实源 I/O/关闭完成。返回 drain 在实际元数据、writer 或 Host 生命周期变化后失效。重启用例使用两个不同 OS worker 的原 SDK 和实际 JSON 域/日志，consumer 零模型/Agent且业务 JSON/作者和评审日志字节不变；新 cleanup issuer 身份仍明确是 Host 契约 fixture，不认证 D 真实重资格或正式 Host 接线。

## 读取、声明与固定证明

`read_review_target` 只接受 Host 固定目标目录中的引用及 byte range。先在原队列持久预扣尝试/字节预算，再启动真实字节 I/O；只有真实底层操作和 lease 结束后才释放原读槽，超时、Stop 或撤权不提前宣称排空。每页最多 8192 请求字节，16 次/65536 字节预算不因恢复清零。UTF-8 页面末尾截断时只返回完整字符前缀，保留 BOM 和准确 offset/length/total；不把所读取的尾部半字符计入模型实际收到的范围。

实际读结果与工具 call、native session/Agent、配置和完整 review context 绑定；finalize 再检查当前权限、lease、范围和字节摘要。完整原生 read-call→成功结果才算正文证据；目录、失败、EOF、二进制与模型自述不算。固定目标资源是 required；Host 声明或该受限工具实际报告不支持的材料进入 limitations，不能凭另一处成功读取忽略它。不能判定时只可带限制 comment 或请求干预；comment 不表示批准。

`complete_review` 接受前同时检查原始 JSON/UTF-8/转义与 120000-byte 参数预算，以及原 SDK cut reader 实际累计 `sourceBytes`，在原 8MiB scan 内预留后续 ACK/turnEnd 空间。超量在意图/成功 ACK 前拒绝，不截断。公开投影只按准确新工具名裁剪已知参数载体，原持久日志不变，原 frame/scan 限额不提高。

声明只写 v3 envelope 的 intent 元数据。原 owner 验证准确读范围、完整 manifest、完成 call→ACK→completed turn，等待真实 writer retire/flushed-and-closed，再次读取原持久 cut 并 seal，才签发 WeakMap 里的 process-local fixed ref。复制 ref、跨 owner、另一轮/产物/专家或配置均拒绝；读取 lease 重查权限、来源、digest 与 drain，release 幂等。D 最后仍须在原队列核对真实资格并原子落票，本接缝不写 ballot、不替代全员通过条件。

## 证据边界

Node `.test.mjs` 覆盖预算/投影与合成 SDK 事件损坏契约，不当运行证明。`native-work-session-review-runtime.spec.ts` 配合 `native-work-session-review-runtime-fixture.mjs` 在固定、带已核必要补丁的原 SDK 单一模块图中运行；原默认 factory、实际 Session/Agent/JSON 日志、真实文件读取与退役为实际执行，模型和评审驱动授权/目标选择明确为 fixtures。另有原 Cookie/Run 作者完成兼容场景。

SDK 组件 PoC 不认证生产 review Drive/read 组合、模型推理质量、Skills/MCP 实际生效、D 最终票/恢复确认、正常 UI、安装或跨平台。当前仓库没有通过新公开导出或 Host 装配启用这组能力；A 后续按冻结实际类型接入。GUI 与正式交付验收继续在原工作项记录。
