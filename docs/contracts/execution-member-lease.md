# 持续成员授权：Host 内部接缝

关联 #30、#113。此接缝复用身份域、空间目录与既定 `ExecutionMemberLease`，不创建授权库、会话库、轮询器或 HTTP 入口。

## 接入与归属

C 维护 `member-session.ts`、`identity-session.ts` 的源签发和 `space-directory.ts` 的原始关闭生命周期。A 维护 Host publication、装配、公开导出；B 继续维护执行业务，D 组合节点／Run／工作区授权。

```ts
interface ExecutionMemberDirectoryBinding {
  readonly directory: SpaceDirectory & { readonly signal: AbortSignal };
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}
interface IdentityExecutionOptions {
  currentDirectoryBinding(): ExecutionMemberDirectoryBinding | undefined;
}
applyIdentity(ctx, imported?, executionOptions?): Promise<void>;
openExecutionMemberLease(ctx, originalMemberRequest): Promise<ExecutionMemberLease>;
```

这些都是同一 Host 进程的内部对象与函数，不跨网络或序列化，也不需要协议协商或幂等键。`applyIdentity` 的可选第三参由 A 的私有 Host 闭包传入；普通登录与 `resolveMember` 保持原语义。未注入执行接缝时仅新 lease 拒绝，不回退 owner。`directory` 必须是 `spaceDirectoryFor(ctx)` 当前注册的同一真实 handle，不能是成员快照、包装副本或请求字段。getter 随同真实身份安装源持有。

A 每个 publication 持有稳定 binding、token 与 signal；`isCurrent` 同步检查 Host 未关闭、token 仍当前、同一 owned handle 且仍注册。替换、unpublish 和 Host beforeClose 必须在首个 await 前先使 token 无效并 abort；旧 disposer 按 token 比对，不能撤销新世代。A 可组合 publication 与原始 handle 的 signal。C 也独立检查原 handle.signal，以覆盖直接 close。

## 操作与生命周期

| 内部操作                 | 输入与结果                                   | 校验、顺序与失败                                                                                                                                                                        | 释放与限额                                                                                                     |
| ------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 签发                     | 原始 `MemberRequest.headers` → Promise lease | 同一真实安装源验证 Host/Origin、HMAC、同一会话行及真实期限、账号存在、当前目录与 publication；订阅后再次同步复核才返回。拒绝统一为 `execution member lease unavailable`，不带请求内容。 | 每安装源最多 256 个存活 lease；满额拒绝，调用者可在释放后重试。没有持久写入。                                  |
| `assertCurrent(spaceId)` | 同步返回 void 或抛出统一错误                 | 每次重查原请求／签名／原会话／账号／期限、安装实例、目录对象与两个生命周期，再查空间存在与实时 membership。记录成功使用的空间；失效永久拒绝，重新登录或重新授权不会复活旧 lease。       | 不返回 Promise，不发网络请求。失败同时释放并 abort。                                                           |
| 失效通知                 | lease.signal abort                           | 身份源替换／卸载、publication 失效、原 handle.close 同步通知；真实 domain/changed 在会话／账号／空间／成员持久变更后重查已经使用的空间。无关会话或未使用空间的撤权不误伤有效授权。      | 每 lease 一个单次期限任务，达到真实 expiresAt 即 abort；每次断言也检查 Date.now，不依赖定时器及时调度。        |
| `release()`              | 无参数、无返回                               | 幂等、永久 abort；先丢弃原请求和来源引用，再移除监听、期限任务并释放容量。清理错误不投影来源错误内容。                                                                                  | 保留 lease 对象不再保留原请求、身份源、目录或观察者。内部状态使用私有字段，不能意外 JSON 输出 Cookie／secret。 |
| 原 handle.close          | Promise，重复调用同一 Promise                | 在异步 drain 前同步 abort 原 handle.signal；关闭成功或失败都不恢复该 handle。                                                                                                           | 只改变来源生命周期，不改变目录数据、授权规则、写入顺序或注册 owner。                                           |

`MemberResolverSource.execution.onChange` 由原 identity closure 订阅真实存储事件；域名仅是触发重查的过滤条件，不作为生产者身份。会话 HMAC／行、当前安装记录和真实目录仍逐次验证。订阅函数必须同步注册、成功返回清理函数或完整拒绝，不能留下调用方不可撤销的半注册。

返回的类型复用 D 的 `ExecutionMemberLease`：`memberId`、真实 `expiresAt`、`signal`、`assertCurrent`、`release`。它不授权节点／Run／工作区／文件，不支持凭调用方 actor、缓存 MemberResolution 或 owner cookie 签发。调用者在第一次使用空间及每个有副作用的边界调用同步断言，并在结束时 release。

## 验证边界

定向测试复用真实 identity 登录／签名／解析和发布的 DomainFacility；KV、凭据介质、HTTP 运输及 Host publication 使用隔离契约夹具。覆盖注销、新旧同账号会话、行变化、账号／成员撤销、期限、源替换和同源 remount、publication 替换、伪目录、原 handle 的 held／失败关闭、订阅期间失效、释放／容量及冷重开。源码与契约测试不认证正式 Host 装配、真实磁盘、原生模型、桌面 GUI 或产品验收；这些由集成 owner 在对应提交上另行证明。

## Host 同步项目归属读取

`OpenedSpaceDirectoryHandle.spaceForProjectNow(projectId): ProjectSpaceLookup` 是同一真实目录 handle 的 Host-only 同步读口，不增加到普通 `SpaceDirectory` 或 Client 显示接口。它直接读取原 domain 的 `project_spaces` 当前行：有行返回 `{ok:true,spaceId}`；无行返回 `{ok:false,reason:'unknown'}`，不把 projectId 当作 spaceId；handle.signal 已失效或域读取失败返回 `{ok:false,reason:'unavailable'}`。close 进入后即拒绝，不等异步 drain，重开应使用新 handle。原异步 `spaceForProject` 仅委托这个函数，响应形状不变；不增加缓存、第二份状态、注册、订阅、轮询、I/O 或持久写入。

A 的同步授权回调必须使用同一个 owned handle 和仍有效的 publication，继续验证请求空间／成员事实；缺少真实同步 producer 时拒绝，不用旧异步结果或资源定义快照代替。此读口本身不授权成员／节点／Run／工作区。定向控制使用真实 DomainFacility 与测试内存介质，验证持久写入落定前后、权威行变化／删除、未知、原 handle held／失败 close、域故障和重开；它不认证正式 Host／真实磁盘或完整运行链路。
