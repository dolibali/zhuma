# B-M1 人工节点执行契约（S1）

切片 S1 把一份已经确认的计划跑通：启动、待办、提交、评审、退回、全员通过、下游解锁、报告。本文固定命令、存储形状和身份映射。纯编排在 `packages/agent-core/src/human-node.ts`，组合现有 WP00 导出。`node-status.ts`、`delivery.ts`、`handoff.ts`、`concurrency.ts` 没有改。`packages/agent-core/src/review.ts` 相对 develop `843661c` 仍是 +14/−2。#18 已合入 develop（772b59c）。`BallotRejectionCode` 增加 `empty-comment`；私有 `commentText` 去掉零宽字符和 U+00AD 后再 trim，用来判断评论和退回意见是不是空的。这处待 A 确认。

带存储的服务和 `/api/zhuma-exec` 通道在 `packages/dsh-adapter`。待办、交付和评审界面在 `packages/client/src/execution/`。`createExecutionApi` 调用 `rpc.call('/api', 'zhuma-exec/<endpoint>', payload)`。下文用「契约」指纯函数，用「适配」指服务和 Host 通道。进程内的服务测试是契约模拟。`execution-host.test.mjs` 用真实 Connection 和成员 cookie 跑通一条链路，仍不是已安装的桌面产品。

## 验证层级

| 层级      | 本文件对应的证据                                                                                                                          | 不是什么             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 纯契约    | `packages/agent-core/tests/human-node.test.mjs`，进程内函数，不打开存储、不建立 Peer                                                      | 不是 Host 验收       |
| 契约模拟  | `execution-identity.test.mjs`、`execution-service.test.mjs`、`execution-recovery.test.mjs`。内存存储，actor 是 `resolveMember` 的结果形状 | 不是登录 cookie      |
| 成员会话  | `execution-member.test.mjs`。`applyIdentity` 登录后调用真实的 `resolveMember`，再交给 `ExecutionService`                                  | 不是桌面安装包       |
| Host 通道 | `execution-host.test.mjs` 和 `execution-plugin.test.mjs`。真实 Connection 的精确 Fetch 路由，或签名成员 cookie                            | 不是已安装的官方桌面 |

DSH 浏览器 Peer 仍然是 owner。成员是 `zhuma-member` cookie，由 `resolveMember` 读取。两人退回、重提、再全员通过既在恢复测试里用解析结果覆盖，也在 `execution-member.test.mjs` 里用真实登录 cookie 覆盖。

## 命令

执行通道是 `/api/zhuma-exec/<endpoint>`。调用方不得在正文里提供 actor。

正文里任意嵌套的 `actorId`、`memberId`、`reviewerId` 都拒绝，代码 `actor-from-body`。嵌套超过 32 层返回 `validation`，不再抛出。`submit` 的 `text` 和 `ballot` 的 `comment` 最长 100000 个字符，超出同样是 `validation`。actor 只来自 `resolveMember` 的结果，再调用下面的纯函数。`ownerId` 只从已确认计划复制，是业务负责人，不是这次命令的 actor。

| 端点         | 正文                                                                                                                              | 结果                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-plan` | `taskId`、`planId`、`revision`、`idempotencyKey`                                                                                  | 只接受这一份已确认修订。修订对不上返回 `plan-not-found`，不改用更新的计划。无依赖节点进入 `ready`，有依赖节点一律进入 `blocked`（上游当时是否已经完成都不改这个入口），两者都写下 `entryStatus: ready`。`plan-started` 不写 `inputRefs`                                                                                                                                                                                |
| `inbox`      | `{}`                                                                                                                              | 用 `resolveMember` 得到的 actor 调用 `executionInbox`。先按空间和 `planMembership` 过滤记录，再生成待办。被移出参与者后，待办行和节点视图（目标、交付正文、轮次、评论）都不返回。没有成员会话返回 `unauthenticated`                                                                                                                                                                                                    |
| `submit`     | `taskId`、`planId`、`revision`、`nodeId`、`expectedVersion`、`idempotencyKey`、`text`、`files`、`links`                           | 只有该节点的 human 执行者可以提交。文件只收 `ArtifactFileRef` 元数据                                                                                                                                                                                                                                                                                                                                                   |
| `ballot`     | 节点定位、`expectedVersion`、`idempotencyKey`、`roundId`、`artifactVersionId`、`action`、可选 `comment` 和 `unresolvedCommentIds` | actor 必须与票面评审人一致，且在该轮 `reviewerIds` 里。`comment` 只留下评论，不改变轮次状态，也不改变已经投下的票。评论去掉空白、零宽字符和 U+00AD 后为空时返回 `empty-comment`，不写。退回必须有意见，或引用至少一条这条产物上未解决的评论；两样都没有是 `empty-request-changes`，引用对不上是 `comment-not-unresolved`。这三种拒绝都不写                                                                             |
| `settle`     | 节点定位、`expectedVersion`、`idempotencyKey`、`roundId`、`artifactVersionId`                                                     | 只有该节点的 human 执行者或评审人可以结算。按当前轮的票面结算。未齐票为 `ignored`。幂等键使用 `settle:{roundId}`                                                                                                                                                                                                                                                                                                       |
| `report`     | `taskId`、`planId`、`revision`                                                                                                    | 只有任务负责人或参与者可以读。每个节点一份 `NodeExecutionReport`，含 `acceptedArtifactVersionId` 和 `reviewOutcome`                                                                                                                                                                                                                                                                                                    |
| `revision`   | `taskId`、`planId`、`revision`、`nodeId`                                                                                          | 不修改这份退回记录。权限通过之后可以补上本任务还没写完的解锁；拒绝、找不到和目录不可用都不写。human 执行者，或同时仍在最近一次退回轮次和当前评审名单里的评审人，可以看到被评审版本、上一版，以及每一次退回的意见。意见写评审人姓名，不写标识。文件只返回标识、类型和字节数。空间不符是 `not-found`，被移出任务是 `not-participant`。被移出评审名单的人，以及本来就不是评审人的参与者，与节点不存在是同一份 `not-found` |

`submit` 的产物 id 和轮次 id 由幂等键决定：`artifact:{idempotencyKey}`、`round:{idempotencyKey}`。同一执行者、同一键、同一正文重放第一次的结果，即使 `expectedVersion` 已经落后。同一键、不同正文返回 `idempotency-mismatch`。失败的提交不写回执，也不占用产物版本。另一个 actor 重发同一键时先按角色拒绝，不会拿到 `replayed`。若该 actor 同样有权，指纹里的 `actorId` 对不上，则返回 `idempotency-mismatch`。

`submitDelivery` 和 `castBallot` 先检查调用方是不是执行者或本节点评审人，再查回执。不是执行者返回 `not-assignee`，不是评审人返回 `not-assigned-reviewer`，票面评审人与 actor 不一致返回 `actor-mismatch`。这些拒绝的 disposition 是 `rejected`，不会变成 `replayed`。纯函数交还调用方传入的同一条记录引用，不另造一份成功视图。服务把拒绝收成只有 `code` 的错误，响应里不带节点、产物或正文。

节点命令版本从启动后的 1 开始。`expectedVersion` 落后返回 `conflict`，记录保持原样。

## 身份

单人还是多人由 `configureDeploymentMode` 选定。成员来自身份模块的 `resolveMember`。身份模块 #18 的 head 是 `b/id0a-identity` `eb25d30`。#18 已合入 develop（772b59c）。本 head 的身份代码经 `b/m1-align-identity` `20314eb` 带入，与 `eb25d30` 的身份实现内容等价；另多 `packages/dsh-adapter/tsconfig.identity.json` 与 `packages/dsh-adapter/tests/identity-session.test.mjs` 的小增量。`c31f062` 是更早的身份提交，不是这个 head。不要用旧的 `b/s1-signatures@5d6eafa` 推断执行插件尚未实现。执行插件没有 `singleUser`，也没有 `bind-owner`。同一来源地址 60 秒内登录满 8 次后返回 429。

1. `configureDeploymentMode(ctx, mode)` 先选定 `legacy-single-user` 或 `multi-member`。然后 `applyIdentity` 装上解析器。`resolveMember(ctx, { headers })` 读这次请求的头。成功是 `{ ok: true, memberId, spaceIds }`。拒绝是 `{ ok: false, status: 401, code: 'unauthenticated' }`，或 `{ ok: false, status: 403, code: 'untrusted-request' }`。模式没选定时 `applyIdentity` 拒绝启动。
2. 没有装上解析器、cookie 无效，或结果不是成功时，返回 `unauthenticated`，不回退到 owner。`untrusted-request` 原样拒绝，`details` 为空。`memberId` 必须是目录里的 human，否则 `not-in-directory`。专家不能当执行 actor。项目属于哪个空间，只问调用方注入的 `ProjectSpaceDirectory`。执行服务把 `spaceForProject(projectId)` 返回的空间 id 和这次成员的 `spaceIds` 做精确比较。没有注入这份目录时，不把 `projectId` 当作空间 id，启动、提交、投票、结算、报告和待办全部拒绝，也不写入。
3. `legacy-single-user` 并且导入恰好一个账户、`ownerAccountId` 写明是这个账户时，owner cookie 才解析成那个账户。`multi-member` 即使导入是这个形状，也不把 DSH owner cookie 当成成员。
4. 没有注入目录时，`start-plan`、`report`、`submit`、`ballot`、`settle` 和待办都返回 `not-found`，待办不是空列表，也不写入。目录正常应答时，任务不存在、目录没有这个项目，或空间对不上，前五个命令返回同一份 `not-found`（`code`、`message`、`details` 都相同），待办不列出这些任务，也不能靠响应区分任务不存在和任务在别的空间。目录抛错、返回 `unavailable`，或返回 `ok` 但空间 id 缺失、为空、不是字符串时，不论任务是否存在，这五个命令都返回同一份 `unavailable`，文案是「执行记录暂时不可用，请稍后用同一个请求再试一次。」，待办也返回这份 `unavailable`，并且不写入。`revision` 和 `draft` 同样先返回这份 `unavailable`，任务在不在字节相同，拒绝前不写。任务不在工作台里时，不把空字符串传给 `spaceForProject`。请求里的 `taskId` 必须符合工作台 `WorkTaskSchema` 的 id，和 `save-task`、已有存储是同一条规则：1 到 100 个字符，匹配 `/^[\w-]+$/u`。不符合的五个入口都返回和任务不存在一样的 `not-found`，不调用目录，也不写入。符合时才用这个 `taskId` 判断目录能不能应答；目录正常应答时仍返回 `not-found`，不采用返回的空间。目录整体故障时，符合这条规则的 id 无论任务是否还在工作台，都返回同一份 `unavailable`。待办遇到已经不在工作台、且 id 符合这条规则的任务时也这样询问。A 的 `spaceForProject` 必须接受任意这种合法 id，对不认识的返回 `unknown`，不能抛错，也不能返回 `unavailable`。写盘失败仍是「执行记录暂时写不进去，请用同一个请求再试一次。」计划交接抛出预期之外的错误时用「执行记录暂时不可用，请稍后用同一个请求再试一次。」，因为这不是写盘失败。目录核对在 `submit`、`ballot`、`settle` 的任何写入之前完成。空间通过之后才检查任务成员，然后才检查节点角色。已经通过空间核对的任务，修订对不上时 `start-plan` 仍返回 `plan-not-found`。

官方 `rpc.handle` 的 Peer 没有请求头，所以执行通道不用它。`connection.fetch.register` 的 Fetch `Request` 保留 `cookie` 和 `host`。Connection 的精确路由仍然只把 owner Peer 送进处理函数；成员身份只从 `resolveMember` 来。

授权在服务端完成，并且发生在重放之前。拒绝响应只有 `code`、`message` 和 `details`。

| 操作         | 谁可以                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-plan` | 任务 `ownerId`，或 `participantIds` 里的目录成员。其他人返回 `not-participant`                                                                                                   |
| `report`     | 与 `start-plan` 相同。任务不存在与其他空间返回同一份 `not-found`                                                                                                                 |
| `inbox`      | 已解析的目录 human，并且仍是该任务的负责人或参与者。待办只列出该 actor 自己的项，节点视图只附带这些项。移出参与者后该项消失，响应不带交付正文。非目录成员返回 `not-in-directory` |
| `submit`     | 先是任务成员，然后是该节点的 human 执行者。不是参与者返回 `not-participant`。不是执行者返回 `not-assignee`。计划回执缺失时返回 `plan-incomplete`                                 |
| `ballot`     | 先是任务成员，然后必须在该节点 `reviewerIds` 里，且票面评审人就是这个 actor。从参与者里移除后再投票返回 `not-participant`。计划回执缺失时返回 `plan-incomplete`                  |
| `settle`     | 先是任务成员，然后是该节点的 human 执行者或评审人。其他人返回 `not-assigned-reviewer`。票面未齐时仍是 `ignored`。计划回执缺失时返回 `plan-incomplete`                            |

投票人不是本节点评审人时返回 `not-assigned-reviewer`。票面评审人与 actor 不一致时返回 `actor-mismatch`。这两项也在重放之前检查。交付回执和投票回执的指纹都包含 `actorId`。

## 存储形状

DSH storage-domain 没有跨记录事务。一次用户命令只写一条记录。结算之后的下游解锁另写下游记录。

域：`zhuma_execution`，`version: 1`。

全局：

```json
{ "schemaVersion": 1 }
```

成员会话不写进这个域。

节点表 `nodes`。键：`{taskId}:{planId}:{revision}:{nodeId}`。值是 `ExecutionNodeRecord`：

- `ownerId`：计划上的业务负责人，可以为已确认计划里的那个 id，不从 actor 填
- `handoff`：`readNodeHandoff` 之后的快照。启动时 `inputRefs` 为空
- `command`：`NodeCommandState`，含 `status`、`version`、`entryStatus`、`upstreamAffected`、`stored`
- `rounds`、`currentRoundId`
- `artifactVersions`、`acceptedArtifactVersionId`
- `comments`：被引用的未解决评论
- `receipts`：业务幂等回执，指纹覆盖 actor、交付正文或票面，不覆盖 `expectedVersion`

计划表 `plans`。键：`{taskId}:{planId}:{revision}`。值：`{ idempotencyKey, fingerprint, nodeIds }`。指纹只覆盖 `taskId`、`planId`、`revision`。同一个键、同一个修订先重放，别的项目的目录故障不会改变这次重试。别的键先查重：本空间另一个计划用过的键返回 `idempotency-mismatch`，查重时目录不可用返回 `unavailable`；没有冲突的键也重放。幂等键只在本空间内判重：同一个键配上本空间的另一个修订，以及另一个计划的键配上已经启动的修订，都返回 `idempotency-mismatch`。别的空间里的同一个键，在那个空间的目录正常应答时，不影响本空间，响应里也看不出那个键。计时上看得出。例如目录慢 2ms 时，中位数大约是 5057µs 对 2866µs。查本空间里另一个项目时，目录抛错、返回 `unavailable` 或 `unknown`、结果是 null 或字符串、reason 无法识别，或空间 id 无法使用，启动都返回 `unavailable`。目录恢复前，这个键不能再拿去启动。只有目录明确给出另一个空间 id 时才忽略。

下游解锁的幂等键是 `unlock:{sourceId}:{downstreamNodeId}`。`sourceId` 在有评审轮次时是 `currentRoundId`，没有轮次时是 `artifact:{acceptedArtifactVersionId}`。依赖没有全部接受时，解锁结果是 `ignored`，不写回执。全部接受后把 `{ sourceNodeId, artifactVersionId }` 经 `readNodeHandoff` 写入该下游的 `inputRefs`，并把还处在 `blocked` 的下游推进到 `ready` 一次。下游若已经是 `ready` 但 `inputRefs` 仍空，同一次解锁补上这些引用，不再改状态。同一键再请求则重放。

启动对账：节点已经 `completed`，但下游还没有对应解锁回执时，用上面的确定性键补一次。已经写过的键只重放，不第二次推进。重试 `start-plan` 时，也会对这份计划里当时已经完成的节点做同样的解锁。

一条读不出来的节点记录会被跳过：对账、待办和报告继续处理其余记录，通道仍然打开。写失败时不更新这次没有写成功的记录。`start-plan` 要写每个节点再写计划回执，存储没有跨记录事务，所以中途失败会留下还没有计划回执的节点。这种半写计划不出现在 `inbox` 里。`report`、`submit`、`ballot`、`settle` 都返回 `plan-incomplete`，响应不带节点正文。探针里「半启动期间先把上游交付完，再重试」这条路径按设计被拒绝：半写窗口里的写入不会把上游完成，因此重试启动时下游还拿不到 `inputRefs`。唯一继续方式是用同一个幂等键重试 `start-plan`（或在插件再次打开时对账）。回执写上之后，正常的提交、评审和结算才接受；那时若上游已经完成，重试启动和对账会补上 `inputRefs`，否则要等回执之后的正常完成再解锁。

## 纯函数

| 函数                    | 作用                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `startAppliedPlan`      | 精确修订。每个节点 `plan-started`，并保存 `entryStatus`。有依赖的节点保持 `blocked` |
| `submitDelivery`        | 先 `canSubmitNode`，再重放；然后内容校验、产物版本、需要时开新轮                    |
| `castBallot`            | 先核对评审人，再重放；然后用可信 actor 调 `submitBallot`                            |
| `settleReview`          | `applyReviewSettlementCommand`。全员通过才 `completed`；退回则 `needs-revision`     |
| `unlockDownstream`      | 对一个下游执行 `dependencies-changed`，并写入已接受的 `inputRefs`                   |
| `executionInbox`        | `deriveInbox`。负责人只在专家节点等待输入或失败时出现                               |
| `toNodeExecutionReport` | 给报告用的只读投影                                                                  |

退回后的旧轮次不再是当前轮。用旧 `roundId` 投票返回 `stale-round`。当前轮配旧 `artifactVersionId` 返回 `stale-version`。轮次状态已经是 `voided` 时返回 `voided-round`。新提交打开新轮，旧票留在旧轮上，不继承。

`uploadComplete: false` 返回 `upload-incomplete`。没有文字、完成的文件或链接时返回 `empty-delivery`。这两种都不增加 `command.version`，不增加产物版本，不写 `receipts`。

缺负责人或计划不能交接时，`startAppliedPlan` 返回 `createNodeHandoffs` 的代码（例如 `invalid-handoff`、`child-task-required`），不写节点。

正文里任意嵌套的 `actorId`、`memberId`、`reviewerId`，`containsActorField` 为真。嵌套超过 32 层时 `scanActorField` 返回 `too-deep`，不再抛出。

## 已实现和未实现

已实现：

- 上面列出的纯函数，以及 `packages/agent-core/tests/human-node.test.mjs`
- 精确修订、入口状态、提交门禁、退回重提、全员通过后只解锁一次
- `resolveActor` 只接受 `{ ok: true, memberId, spaceIds }`。`untrusted-request` 保持原代码。`containsActorField` 拒绝正文里的 actor 字段
- `ExecutionService` 串行写。一次用户命令写一条节点；`start-plan` 再另写计划回执。每条写入先核对空间和任务成员，再核对节点角色。从参与者里移除的评审人再投票得到 `not-participant`
- `applyExecution` 把 `/api/zhuma-exec/<endpoint>` 注册到 `connection.fetch.register`。先 `resolveMember`，再读正文；正文超过 2MiB 或 5 秒没读完就拒绝，无效会话不读正文
- `revision` 读取退回时的被评审版本、上一版和每一次退回的意见。意见显示评审人姓名，不显示标识。第二次退回保留第一次的意见。不读取文件字节。已投票的评审人仍可读，内容不超出评审范围。被移出当前名单的评审人与节点不存在是同一份 `not-found`。目录不可用或结果不合法时先查目录，不论任务或节点是否存在都返回同一份 `unavailable`：「执行记录暂时不可用，请稍后用同一个请求再试一次。」拒绝前不写。目录正常时，任务不存在、节点不存在和在别的空间返回同一份 `not-found`
- 交付页读取节点目标。同一任务、同一计划和同一版本里，已接受的上游列出来源节点、版本和产物名；产物名写成「第 2 版」，不带提交者的幂等键。还没有已接受版本，或引用已被新的已接受版本取代时，只提示来源节点，不阻止提交。其余来源只计个数，不带来源、任务或空间标识，并在写盘前拒绝
- 评审人可以只评论。评论不改变轮次状态，也不改变已经投下的票。评论去掉空白、零宽字符和 U+00AD 后为空时返回 `empty-comment`，不写。退回的意见同样去掉这些字符后为空、也没有引用未解决评论时返回 `empty-request-changes`，引用对不上返回 `comment-not-unresolved`，三种都不写
- 提交、投票和结算共用的命令也先查目录，再读节点。八种目录故障下，节点在不在、记录损坏与否，都是同一份 `unavailable`，拒绝前不写
- 人工执行者把交付草稿写在节点记录上。关闭后再打开，包括退回后，仍能读到自己的草稿。只有这位执行者能读写。空间不对和任务不存在，在写之前返回同一份 `not-found`。目录不可用或结果不合法时，任务和节点在不在都返回同一份稍后重试的 `unavailable`，拒绝前不写。不是参与者要等空间通过之后才拒绝。节点不是 `ready` 或 `needs-revision` 时不写。草稿版本不符时不覆盖，并在 `details` 里返回当前版本。同一个幂等键被拿去写另一份内容时也不覆盖。幂等键不超过 200 个字符。超限在空间检查通过之后、写之前拒绝，响应不包含这段键。目录不可用或任务不存在时，超长键和合法键返回同一份响应。单条链接不超过 2048 个字符，全部链接合计不超过 8192 个字符。文件的 id、mediaType、checksum、accessPolicyId 每一项不超过 2048 个字符。正文、链接和这些字段合计不超过 262144 个字符。超出都在写之前拒绝。提交成功后清掉草稿
- 解锁那一次写入失败后，不必等插件再次打开。只有这次请求已经通过权限检查，才补调用者自己空间里、这次请求涉及的任务：写入 `inputRefs`，并把仍是 `blocked` 的下游推进到 `ready`。同一把解锁键不会重复应用。拒绝、找不到和目录不可用都不补写。补写失败不改变这次请求的结果，也不写别的空间，留到下一次再补。插件打开时的对账仍然保留；其中一次写失败不会挡住其他任务
- 待办分成交付、评审、确认三组。专家节点派给负责人的事项归在交付。每一项带上层路径（项目、任务、父节点标题）和负责人姓名，不写负责人标识。`POST /api/zhuma-exec/inbox-counts`，正文 `{}`，返回 `{ deliver, review, confirm }`。状态变了以后，下一次读取就是新的个数。先查目录：没有目录是 `not-found`，目录不可用是和待办同一份 `unavailable`，两种都不返回个数。看不见的节点不改变个数，也不出现在分组里
- 执行事件写在节点记录的 `events` 上，不另建存储。每条有 `eventId` 和该节点上单调递增的 `sequence`。只有已接受的启动、提交、投票、结算和解锁才追加；重放不追加。`POST /api/zhuma-exec/events`，正文是节点定位、`after` 和可选的 `seenEventIds`。返回游标之后、且 `eventId` 还没见过的事件。事件只带状态和版本，不带路径、密钥或校验值。先查目录：目录不可用是和待办同一份 `unavailable`。节点不存在或没有权限是同一份 `not-found`。两种都不带事件个数或 `sequence`，节点在不在字节相同。`after` 为负数、非整数或超出安全整数范围时直接拒绝，不读也不写。权限通过之后可以补上本任务还没写完的解锁，再读事件；拒绝、找不到和目录不可用都不写。补写失败不改变这次查询的结果

未实现（后续切片）：

- 需求 7.1「阅读上游产物」留给后续分支。交付页不读取上游正文和文件
- 产物字节、预览和访问控制。可信上传（#33）接入前，文件元数据不能把节点标成完成
- `RevisionView` 不从包入口导出
- 专家评审和 `interpretAgentReview`
- 已安装桌面里的验收。面板已经在 client 里，还没有装进成员 A 的导航。Host 测试使用真实 Connection，但不是安装包

## 需要成员 A 接入

B 不改 `workbench-plugin.ts` 的业务，也不把工作台域再 `open` 一次。A 自己保住已打开的工作台，把 `readWorkbench` 传进来。加载顺序是先选定部署模式，再 `applyIdentity`，然后工作台，然后执行：

```ts
configureDeploymentMode(ctx, mode);
await applyIdentity(ctx, imported);
await applyWorkbench(ctx);
await applyExecution(ctx, {
  readWorkbench: () => service.snapshot(),
  projectSpaces,
});
```

`applyExecution` 接受 `readWorkbench`，并可选接受 `projectSpaces`。不要传 `memberResolver` 或 `singleUser`。单人还是多人是上一步选定的 `deploymentMode`，不从解析器是否存在来推断。把 `projectSpaces` 装进 Host 是装配职责：A 单写 Host 的注入、导航、导出和公共配置。B 提供可信身份和空间授权事实，以及执行服务消费这份目录的接口。A 不重建 B-ID0 的身份或空间授权。B 不打开空间库，也不保存这份归属，只消费调用方注入的目录。没有记录、空间不匹配，以及根本没有注入目录，都拒绝。

```ts
interface ProjectSpaceDirectory {
  spaceForProject(
    projectId: string,
  ): Promise<
    | { readonly ok: true; readonly spaceId: string }
    | { readonly ok: false; readonly reason: 'unknown' | 'unavailable' }
  >;
}
```

`boundedProjectSpaces` 只是把一份已经给出的目录装进有界内存：最多 100 条，一个项目只属于一个空间。它不是正式数据源，也不从包入口 `packages/dsh-adapter/src/index.ts` 导出。A 在 Host 里实现 `ProjectSpaceDirectory` 的 `spaceForProject`，把这个对象作为 `projectSpaces` 注入 `applyExecution`。这个对象只把 B 已经给出的空间授权事实接到执行服务。这个函数必须接受任意合法 id（工作台 `WorkTaskSchema` 的 id：1 到 100 个字符，匹配 `/^[\w-]+$/u`），对不认识的返回 `{ ok: false, reason: 'unknown' }`，不能抛错，也不能返回 `unavailable`。`ProjectSpaceDirectory` 和 `ProjectSpaceLookup` 已由 `s1-integration.ts` 再导出，包入口的 `export type * from './s1-integration.js'` 因此带上这两个类型。

`inbox` 先按空间和 `planMembership` 留下仍是任务负责人或参与者的记录，再调用 `executionInbox`。移出参与者后，待办行和节点视图都不返回。`report` 在返回投影之前做同样的成员核对。

客户端调用：

```ts
await rpc.call('/api', 'zhuma-exec/inbox', {});
await rpc.call('/api', 'zhuma-exec/submit', payload);
```

本 head 的 `packages/dsh-adapter/src/workbench-plugin.ts` 注册 `/api/zhuma/*` 时，在读取正文之前调用 `authorizeLegacyOwnerRoutes`。这段接线来自已合入 develop `843661c` 的 #23，不是 `b/id0a-legacy-gate` `69c7366`；该提交仍不是本 head 的祖先。宿主构建入口是 `packages/dsh-adapter/src/host-plugin.ts`。发行补丁是 `legacy-single-user`。`multi-member` 在读正文前关闭这些路由，并挂上身份子插件；默认桌面补丁不挂多人模式，也没有成员进入工作台的入口。`applyExecution` 和 `projectSpaces` 仍没有装进这个入口。执行通道留在 `/api/zhuma-exec/*`，因为它已经按 `resolveMember` 认成员。

客户端「需要我处理」由 A 注册。B 的面板从 `@zhuma/client` 的包入口导出；累计 Draft 新增的导出名见身份契约，待 A 确认。A 在自己的 `plugin.tsx` 里挂 `ExecutionWorkspace`。它自己读取待办并打开交付或评审，不要改挂只接受 `items` 的 `InboxPanel`。页面里已经有 `.zhuma > main.zm-page`，这个组件不再包一层 `main`：

```tsx
ctx.slots.inject('main', () =>
  ctx.slots.register(
    {
      name: 'main',
      key: 'zhuma-inbox' as MainPanelId,
      inject: () => ({ api }),
    },
    ({ api: executionApi }) => <ExecutionWorkspace api={executionApi} />,
  ),
);
```

A 负责把它放进现有导航，并复用 `@zhuma/client/workbench/ui` 与已经加载的工作台样式。B 不改这个注册。

## 界面

`packages/client/src/execution/` 提供 `createExecutionApi`、`InboxPanel`、`DeliveryPanel`、`ReviewWorkspace` 和把它们串起来的 `ExecutionWorkspace`。客户端调用 `rpc.call('/api', 'zhuma-exec/<endpoint>', payload)`。提交和投票只抄写允许的字段；嵌套的 `actorId`、`memberId`、`reviewerId` 在发出前拒绝。退回待办会先打开修订视图，再打开原来的交付表单。退回意见的标题是评审人姓名。第二次退回仍列出第一次的意见。评审页可以只评论，不把评论当成通过或退回。修订视图不从包入口另导出。交付表单显示节点目标。同一任务、同一计划和同一版本的已接受上游列出来源节点、版本和产物名，产物名写成「第 2 版」，不带幂等键。尚无已接受版本或引用已被取代时只提示来源节点，提交仍然可用。无权或缺失的来源只显示个数，提交按钮停用。交付表单会读回节点上的草稿，也可以保存草稿；提交成功后草稿被清掉。

面板使用工作台已经导出的 `Button` 和 `Field`，以及 `.zhuma`、`.zm-page`、`.zm-directory`、`.zm-status`、`.zm-error`、`.zm-review` 这些现有类。不另写颜色。包内引用这些控件用相对路径，因为仓库边界不允许 `@zhuma/client` 导入自己。

`docs/contracts/evidence/b-m1-execution-light.png` 和 `b-m1-execution-dark.png` 是同一份样例数据在浅色和 `body[data-ds-dark-theme]` 下的整页截图。样例 RPC 固定返回失败，页面不会写存储，也不是官方桌面里的真人会话。截图同时画出交付和评审，真实的 `ExecutionWorkspace` 一次只打开其中一项。

## 当前累计组合

本文件随累计 Draft `b/m1-draft`。具体提交以 PR #47 head 为准。退回意见查询 `b/m1-revision-view` 的顶支已经合进这条叠加。叠加 tip 仍是 `b/m1-exec-events` `019b280`，其上又合入了当时的 develop。当前组合是：

- 空间目录：`b/m1-space-mapping` `49d7984`
- 身份对齐：`b/m1-align-identity` `20314eb`
- 叠加从下到上：delivery-draft `39367a6`，review-comment `f494d12`，unlock-reconcile `49be963`，inbox-groups `951fc76`，exec-events `019b280`
- 身份模块 #18：`b/id0a-identity` `eb25d30`。#18 已合入 develop（772b59c）。身份代码经 `20314eb` 带入，内容等价，另多上面说的两处小增量
- 子模块钉在 `687f282`

`f494d12` 改了 `packages/agent-core/src/review.ts` 的空评论判断（私有 `commentText`），需要 A 确认。接缝不变：B 提供可信身份、空间授权事实和执行服务消费接口；A 单写 Host 的注入、导航、导出和公共配置。

## 已知限制

在 Host 装配把 `projectSpaces` 注入执行入口之前，`legacy-single-user` 和 `multi-member` 一样：没有注入目录时，该入口对所有项目全部拒绝。这是还没装上目录，不是把空间授权事实交给 A 重建。

别的空间里的同一个幂等键，响应里看不出来，计时上看得出。例如目录慢 2ms 时，中位数大约是 5057µs 对 2866µs。

计划回执不保存启动当时的空间 id。查重仍然询问目录。这一轮不把空间写进回执。

这些行为在本切片里保持原样：

- 可信上传（#33）接入前，带非空 files 的提交返回 `files-not-accepted`，不写。文字和链接仍可提交。草稿里的文件记成未完成。
- 提交接口的链接没有长度上限。这是 WP03 留下的问题，草稿上限不改变提交。
- 现在没有接口能产生「未解决评论」。需求 9.1「引用已有未解决评论」通过接口满足不了。
- 补写失败不再让这次请求返回「执行记录暂时写不进去」。请求照常返回，没补上的解锁留到下一次已经通过权限的请求。这次补写只碰调用者自己空间里、这次请求涉及的任务，不写别的空间。
- 「确认」组恒为 0。
- inboxCounts() 还没有调用方。
- 父节点路径在 M1 里实际出现不了。
- 任何一个空间目录出问题时所有人的待办都不可用。
- 事件没有上限、没有分页（400 条评论约 69KB）。
- 事件里没有运行引用。
- 客户端只在单次响应内去重。

- 同一轮已经投下的票不能撤回。先通过再改成退回会得到 `conflicting-ballot`，原先的通过仍然有效。
- 交付表单改正文、链接、文件标识，或文件的 `mediaType`、`byteSize`、`checksum`、`accessPolicyId` 时更换幂等键。`uploadComplete` 没有单独的编辑控件，草稿里仍记成未完成。同一键配上不同内容仍返回 `idempotency-mismatch`，不覆盖已保存内容。评审页在通过和退回之间、评论尚未改动时共用一个键。被拒绝的请求不写回执。
