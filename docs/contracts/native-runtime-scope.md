# Native 目录、工具定义与逐 Run 清理

本合同仅覆盖 Native 叶子接缝。A 负责真实 Host／公开导出／运输和工作区授权，D 负责 Run 与冻结执行配置，C 不另建权限库。路径和目录不加入客户端请求或 Native binding 元数据。

## 运行目录

`NativeDshOptions.workingDirectory(binding, grant)` 是必需的 Host 回调，返回 `NativeDshWorkingDirectory`：

- `text-only`：明确不提供本地目录能力。
- `local`：同一完整 `NativeWorkScope`、Host 已验证的绝对规范 `cwd`、活 `signal` 和同步 `assertCurrent(): undefined`。Host 每次断言须验证原始目录授权；目录索引行、路径或 D 的配置快照均不授予权限。

创建用公开 SDK `meta.cwd`；恢复保留原 header，要求原 header 与 `workingDirectory.get/ensure` 均匹配选定目录。异步检查前后、未发布 setup commit、再次驱动、pre-step 和工具执行门禁重核来源与目录服务身份。拒绝缺回调、缺服务、异步断言、换 scope、撤权与目录漂移。目录信号取消会取消并断开相应 Agent，不能唤醒停放输入。不调用 `process.chdir`，也不把全局 cwd 当作授权目录。

`cwd` 仅确定执行目录，**不是文件系统沙箱或写权**。真实文件／shell／MCP handler 的权限、隔离与正式 profile 同一模块图由 Host 分别验证。

C 在 Agent 子作用域声明 `tools.presentAs('native')`；composition 不重复声明 presentation。继承工具由 `restrict` 屏蔽，仍通过 guard 和真实 `tools.schemas(agent)` 精确核对 allowlist，拒绝同作用域额外工具。不能仅凭模型请求中的工具数组宣称限制生效。

## 同源输入工具描述

`describeAcceptedInputTool(): NativeAcceptedInputToolDefinition` 返回 `name / description / parameters / outputSchema / sourceVersion` 的深复制、递归冻结 JSON。getter 和真实 `read_accepted_input` 注册共用一个声明；模型可见定义变更必须提升版本，当前为 `1`。getter 不执行注册、读取、成员解析、模型调用或能力授予。D 可据此冻结实际描述与摘要；摘要本身不授权。原读取协议、固定引用、授权、最终输出校验及预算保持原规则。

## 逐 Run 清理

`service.retireForCleanup(authority, waitSignal)` 仅由 Host 调用：

- `NativeScopeCleanupAuthority` 为同一原 cleanup 的完整 `scope` 和同步 `assertCurrent(): undefined`。A 闭包每次调用 D 真实 manager 的原 cleanup 身份校验；C 不接收浏览器会话 ID，不自造权限 registry。该接口不授予历史、驱动、迁移或产物提交能力。
- 先 fence 原完整 scope，再等其在途 metadata／connect／send 收口，通过同 owner binding 或 lineage 定位原 Native session。复用真实 runtime retirement，并等待该 Native session 的实际输入源 Promise；不以工具等待超时、send 抛错或没拿到 binding 判断资源已释放。
- 返回 `pending`，或 `retired` 与原 `binding`（可不存在）和物理 `NativeMigrationDrain`。这里复用 drain 证据形状，不复用迁移授权。调用者必须在消费前检查 drain，不能据此宣布业务完成。
- 取消等待和五秒超时只停止本次等待；独立 owned Promise 持续收尾并观察晚到失败。重试不会重复清理同一在途 scope。失败保持未知；不能把失败转成 absence。
- 无 binding 只在本 owner 原 scope 活动已排空且从未观察到 Native admission 时产生 `absent-unadmitted`。曾调用 connect 后丢失 metadata、存储错误或 owner 不匹配均拒绝。该事实不是跨 Host 的权限证明。
- owner admission／retired scope 观察上限 4096，新增清理并发上限 256；超限拒绝。观察仅为进程内物理收口事实，不持久化为权限或业务状态。
- 全 Host close 先 seal，等待全部 owned retirement、真实 runtime close 与实际输入源，再关 metadata。close 使进程内 drain 失效；Host 全 close 成功与逐 Run drain 是两条独立证据，不为 close 后重查证据重新打开 metadata。

## 验证边界

`native-work-session-cleanup.test.mjs` 是故障注入端口契约，覆盖等待取消／五秒 pending、在途首次落盘、实际 reservation drain、失败、断言重核与旧新世代隔离。`native-work-session-working-directory.spec.ts` 用固定补丁 SDK、真实目录服务和 JSONL writer 验证创建／恢复／撤权／工具集合与物理清理；模型解析、请求、业务工具执行必须为零。SDK spec 需在隔离上游构建树运行，不将未打补丁 npm SDK 当作正例。它不认证正式 Host 模块图、真实成员目录授权、模型或 GUI 产品验收。
