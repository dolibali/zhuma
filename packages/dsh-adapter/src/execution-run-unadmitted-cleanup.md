# 首次未受理尝试的限定清理能力

关联 #113 / #35。此模块只补 D 的授权接缝；A 的正式 dispatch 接入和对应界面验收独立交付。

## 问题与能力

首次 begin 已持久化、原生执行尚未受理时登出，正常清理可留下 failed / settled、无原生 binding 的 Run。同一 Host 曾保留真实 absence 观察，因此显式重试可继续；换进程后该观察消失，原 migration 查询会因没有 binding 返回 not-started。持久化的 settled 不能代替新 Host 的物理观察，也不能重新授权终态 Run 驱动。

```ts
authorities.unadmittedCleanup(currentDriveGrant): ExecutionUnadmittedCleanupAuthority

interface ExecutionUnadmittedCleanupAuthority {
  readonly scope: NativeWorkScope; // 紧邻的旧尝试，完整原始 scope
  readonly signal: AbortSignal; // 当前真正 drive grant 的同一个 signal
  assertCurrent(): undefined;
}
```

同步签发，无第二个成员租约、计时器或 dispose。生命周期由原 opened authority 的 dispose、成员租约和 Host 管理。能力只给同一个 C owner 的 `retireForCleanup` 使用，不加入业务事件 cleanup、drive 或 migration 的身份集合；既有 `cleanupAfterCommit` 和终态驱动规则保持不变。

签发及每次断言都核对：

- 本 manager 实际签发的当前 drive grant，包括原可信成员租约、到期、节点职责、写者协议、工作区和配置；read、复制、序列化及其他 manager 的 grant 均拒绝。
- 当前新 Run 是 requested / held / reserved，无确认、session、executor、discarded、模型标签或 stop 证据。
- 严格验证完整 Run 历史。所有旧尝试都是同一 actor / space 的 failed / settled / reserved，且没有任何曾受理、unknown、确认或原生身份记录；每次原 begin 的 request receipt 唯一且关联本人和准确 Run。
- 旧尝试是紧邻前代，世代相邻、执行段不同；原始完整节点快照、scope、原 Host signal 及源端口在能力存续期间不变。

异步或未知的同步源断言拒绝，并消化返回的 rejected Promise；不能把 Promise 当作检查成功。接口既不读写业务记录，也不产生 C binding、absence 或 native drain 证明。

## A 接入顺序

保留原 begin 的耐久顺序，仅在新 Run 已实际持久化、decision 要求 dispatch、存在 previousScope 而当前 owner 没有旧 absence 观察时进入限定分支。普通 read、历史和同键重放不得进入。

1. 从原成员请求打开当前新 Run 的真正 drive grant。`open` 接收严格的 taskId / planId / revision / nodeId / runId 五字段 locator，不能直接传带额外字段的 NativeWorkScope。
2. 用同一个 C owner 的 `migrationOrigin` 查询当前持久化 requestId、inputFingerprint、scope 和 selection。只有真正 `NativeWorkError('not-started')`（整个 locator 记录缺失）才具备进入新分支的资格；该错误本身不是 absence 证明。已有记录、binding、活动、未知或解析失败继续原迁移或拒绝，不能改成记录缺失。
3. 用本方法派生旧 scope 的能力，核对等于 previousScope，传给原 `C.retireForCleanup(capability, capability.signal)`。pending、撤权或异常不允许发送。
4. 只接受同一 C owner 实际返回的 retired、binding 缺失及 `absent-unadmitted` drain；再次核当前能力和真实 drain，继续原 `assertHostAbsentRetry` 与当前 manager 的 send 检查。
5. 复用该 opened drive grant，调用原 canonical send、received / accepted 写回。不能另外造旧 binding、绕过 C.send、手写确认事件或再开恢复租约。结束和失败仍由 A 原生命周期释放。

真正受理后本清理能力即失效；它不是长期的恢复证书。旧尝试没有原生会话，不能为了让旧会话历史可读而给它伪造 binding；已有旧 Run 事实保持不变。

## 已执行验证

定向契约由 `execution-run-unadmitted-cleanup.test.mjs` 与既有 authority 测试执行，共 46 项通过。它们使用提供的 source / lease，不能冒充真实成员签发证明。完整 `pnpm check` 为 1377 项，1373 通过、4 项模型条件跳过、0 失败；未调用远程模型。

在独立编译副本中分别移除旧尝试的无受理检查和完整节点快照检查，对应 unknown / 节点变更负例各因缺少预期拒绝而失败；生产源码与 dist 未为反向验证改写。

另在固定官方 SDK `687f282e8625c6b8d11ff58211a90524be2e4317` 加实际发行补丁的隔离环境执行两进程试验：真实 Host、HTTP 成员登录、JSON / JSONL 与原 C 服务；模型为本地 ScriptedAdapter。未改 A/C 仓库源文件，正例只在私有 emitted Host 副本的两处 dispatch 接缝接入本能力，因此不是正式产品或 GUI 已修复证明。

| 场景                                         | 真实观察                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原未修 Host，进程 55099 → 55152              | 首次持久化后登出，旧 Run failed / settled / reserved 且无 binding；新 cookie 普通读取不写业务，显式重试仍 unknown，无模型请求，原失败保留                                          |
| 新能力隔离原型，进程 68265 → 68317           | 同一失败条件；新 owner 实际 not-started 后取得真实 absent-unadmitted drain，第二代 Run received / acknowledged，只有一个 schema-1 首次 binding 和一次脚本模型调用；旧 Run 完全不变 |
| 实际存储故障造成 unknown，进程 72727 → 76052 | 首次 binding put 在持久化前故障，真实 Run 留 unknown 证据；即使新 owner 观察记录缺失，本能力仍拒绝，无 C 恢复清理、binding 或模型调用                                              |
| 已实际受理且有 binding，进程 76105 → 76157   | 不取得新清理能力；原 migration 正常产生 schema-2 lineage，原生接续受理；旧 Run 不变                                                                                                |
| 清理前真实登出，进程 76207 → 76278           | 新 cookie 签发能力后登出，C 的原 verify 拒绝清理确认；无新 binding、无模型调用；旧 Run 不变                                                                                        |

上述四组原型的普通读取和重放均未触发第二次 dispatch；每组 reader 与 writer 是不同 OS 进程，reader 使用新成员 cookie，同一持久目录没有改造成另一份事实库。故障注入只用于指定存储 put 失败，不伪造 binding、缺失读取或 drain。真实 C 的原 getter 被原样调用，仅记录其观察次数。

原型、原未修失败和各次报告分别保存在本次隔离构建证据中，签发源码与 emitted Host 副本各自有摘要。A 必须在正式接入后另跑同样场景、持久记录及普通界面验收；这些原型结果不认证后续代码。没有跨设备锁、外部工具、真实模型质量或安装包验收结论。
