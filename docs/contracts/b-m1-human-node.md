# B-M1 人工节点执行契约（S1）

切片 S1 把一份已经确认的计划跑通：启动、待办、提交、评审、退回、全员通过、下游解锁、报告。本文固定命令、存储形状和身份映射。纯编排在 `packages/agent-core/src/human-node.ts`，只组合现有 WP00 导出，不改 `node-status.ts`、`review.ts`、`delivery.ts`、`handoff.ts`、`concurrency.ts`。

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

| 端点         | 正文                                                                                                                              | 结果                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-plan` | `taskId`、`planId`、`revision`、`idempotencyKey`                                                                                  | 只接受这一份已确认修订。修订对不上返回 `plan-not-found`，不改用更新的计划。无依赖节点进入 `ready`，有依赖节点一律进入 `blocked`（上游当时是否已经完成都不改这个入口），两者都写下 `entryStatus: ready`。`plan-started` 不写 `inputRefs` |
| `inbox`      | `{}`                                                                                                                              | 用 `resolveMember` 得到的 actor 调用 `executionInbox`。先按空间和 `planMembership` 过滤记录，再生成待办。被移出参与者后，待办行和节点视图（目标、交付正文、轮次、评论）都不返回。没有成员会话返回 `unauthenticated`                     |
| `submit`     | `taskId`、`planId`、`revision`、`nodeId`、`expectedVersion`、`idempotencyKey`、`text`、`files`、`links`                           | 只有该节点的 human 执行者可以提交。文件只收 `ArtifactFileRef` 元数据                                                                                                                                                                    |
| `ballot`     | 节点定位、`expectedVersion`、`idempotencyKey`、`roundId`、`artifactVersionId`、`action`、可选 `comment` 和 `unresolvedCommentIds` | actor 必须与票面评审人一致，且在该轮 `reviewerIds` 里                                                                                                                                                                                   |
| `settle`     | 节点定位、`expectedVersion`、`idempotencyKey`、`roundId`、`artifactVersionId`                                                     | 只有该节点的 human 执行者或评审人可以结算。按当前轮的票面结算。未齐票为 `ignored`。幂等键使用 `settle:{roundId}`                                                                                                                        |
| `report`     | `taskId`、`planId`、`revision`                                                                                                    | 只有任务负责人或参与者可以读。每个节点一份 `NodeExecutionReport`，含 `acceptedArtifactVersionId` 和 `reviewOutcome`                                                                                                                     |

`submit` 的产物 id 和轮次 id 由幂等键决定：`artifact:{idempotencyKey}`、`round:{idempotencyKey}`。同一执行者、同一键、同一正文重放第一次的结果，即使 `expectedVersion` 已经落后。同一键、不同正文返回 `idempotency-mismatch`。失败的提交不写回执，也不占用产物版本。另一个 actor 重发同一键时先按角色拒绝，不会拿到 `replayed`。若该 actor 同样有权，指纹里的 `actorId` 对不上，则返回 `idempotency-mismatch`。

`submitDelivery` 和 `castBallot` 先检查调用方是不是执行者或本节点评审人，再查回执。不是执行者返回 `not-assignee`，不是评审人返回 `not-assigned-reviewer`，票面评审人与 actor 不一致返回 `actor-mismatch`。这些拒绝的 disposition 是 `rejected`，不会变成 `replayed`。纯函数交还调用方传入的同一条记录引用，不另造一份成功视图。服务把拒绝收成只有 `code` 的错误，响应里不带节点、产物或正文。

节点命令版本从启动后的 1 开始。`expectedVersion` 落后返回 `conflict`，记录保持原样。

## 身份

单人还是多人由 `configureDeploymentMode` 选定，当前成员只来自已合并的 `b/id0a-identity`（`c31f062`）的 `resolveMember`。执行插件没有 `singleUser`，也没有 `bind-owner`。同一来源地址 60 秒内登录满 8 次后返回 429。

1. `configureDeploymentMode(ctx, mode)` 先选定 `legacy-single-user` 或 `multi-member`。然后 `applyIdentity` 装上解析器。`resolveMember(ctx, { headers })` 读这次请求的头。成功是 `{ ok: true, memberId, spaceIds }`。拒绝是 `{ ok: false, status: 401, code: 'unauthenticated' }`，或 `{ ok: false, status: 403, code: 'untrusted-request' }`。模式没选定时 `applyIdentity` 拒绝启动。
2. 没有装上解析器、cookie 无效，或结果不是成功时，返回 `unauthenticated`，不回退到 owner。`untrusted-request` 原样拒绝，`details` 为空。`memberId` 必须是目录里的 human，否则 `not-in-directory`。专家不能当执行 actor。`spaceIds` 用任务的 `projectId` 当作空间 id。
3. `legacy-single-user` 并且导入恰好一个账户、`ownerAccountId` 写明是这个账户时，owner cookie 才解析成那个账户。`multi-member` 即使导入是这个形状，也不把 DSH owner cookie 当成成员。
4. 空间对不上时，`start-plan`、`report`、`submit`、`ballot`、`settle` 返回 `not-found`。待办不列出这些任务。空间通过之后才检查任务成员，然后才检查节点角色。

官方 `rpc.handle` 的 Peer 没有请求头，所以执行通道不用它。`connection.fetch.register` 的 Fetch `Request` 保留 `cookie` 和 `host`。Connection 的精确路由仍然只把 owner Peer 送进处理函数；成员身份只从 `resolveMember` 来。

授权在服务端完成，并且发生在重放之前。拒绝响应只有 `code`、`message` 和 `details`。

| 操作         | 谁可以                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-plan` | 任务 `ownerId`，或 `participantIds` 里的目录成员。其他人返回 `not-participant`                                                                                                   |
| `report`     | 与 `start-plan` 相同。任务不存在返回 `plan-not-found`                                                                                                                            |
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

计划表 `plans`。键：`{taskId}:{planId}:{revision}`。值：`{ idempotencyKey, fingerprint, nodeIds }`。指纹只覆盖 `taskId`、`planId`、`revision`。节点已经启动后，再用来启动同一修订会重放；同一幂等键配上另一个修订返回 `idempotency-mismatch`。

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
- `applyExecution` 把 `/api/zhuma-exec/<endpoint>` 注册到 `connection.fetch.register`，并调用 `resolveMember`

未实现（后续切片）：

- 产物字节、预览和访问控制。这一层只校验文件元数据
- 专家评审和 `interpretAgentReview`
- 已安装桌面里的验收。面板已经在 client 里，还没有装进成员 A 的导航。Host 测试使用真实 Connection，但不是安装包

## 需要成员 A 接入

B 不改 `workbench-plugin.ts` 的业务，也不把工作台域再 `open` 一次。A 自己保住已打开的工作台，把 `readWorkbench` 传进来。加载顺序是先选定部署模式，再 `applyIdentity`，然后工作台，然后执行：

```ts
configureDeploymentMode(ctx, mode);
await applyIdentity(ctx, imported);
await applyWorkbench(ctx);
await applyExecution(ctx, { readWorkbench: () => service.snapshot() });
```

`applyExecution` 只接受 `readWorkbench`。不要传 `memberResolver` 或 `singleUser`。单人还是多人是上一步选定的 `deploymentMode`，不从解析器是否存在来推断。

`inbox` 先按空间和 `planMembership` 留下仍是任务负责人或参与者的记录，再调用 `executionInbox`。移出参与者后，待办行和节点视图都不返回。`report` 在返回投影之前做同样的成员核对。

客户端调用：

```ts
await rpc.call('/api', 'zhuma-exec/inbox', {});
await rpc.call('/api', 'zhuma-exec/submit', payload);
```

多人模式下，`b/id0a-legacy-gate`（`aa9060d`）关闭 `/api/zhuma/*`。A 提供成员进入工作台的入口。执行通道留在 `/api/zhuma-exec/*`，因为它已经按 `resolveMember` 认成员。

客户端「需要我处理」由 A 注册。B 的面板从 `@zhuma/client` 已有入口导出，不新增 package export。A 在自己的 `plugin.tsx` 里挂 `ExecutionWorkspace`。它自己读取待办并打开交付或评审，不要改挂只接受 `items` 的 `InboxPanel`。页面里已经有 `.zhuma > main.zm-page`，这个组件不再包一层 `main`：

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

`packages/client/src/execution/` 提供 `createExecutionApi`、`InboxPanel`、`DeliveryPanel`、`ReviewWorkspace` 和把它们串起来的 `ExecutionWorkspace`。客户端调用 `rpc.call('/api', 'zhuma-exec/<endpoint>', payload)`。提交和投票只抄写允许的字段；嵌套的 `actorId`、`memberId`、`reviewerId` 在发出前拒绝。

面板使用工作台已经导出的 `Button` 和 `Field`，以及 `.zhuma`、`.zm-page`、`.zm-directory`、`.zm-status`、`.zm-error`、`.zm-review` 这些现有类。不另写颜色。包内引用这些控件用相对路径，因为仓库边界不允许 `@zhuma/client` 导入自己。

`docs/contracts/evidence/b-m1-execution-light.png` 和 `b-m1-execution-dark.png` 是同一份样例数据在浅色和 `body[data-ds-dark-theme]` 下的整页截图。样例 RPC 固定返回失败，页面不会写存储，也不是官方桌面里的真人会话。截图同时画出交付和评审，真实的 `ExecutionWorkspace` 一次只打开其中一项。

## 已知限制

这些行为在本切片里保持原样：

- 退回之后再提交，执行者的页面不显示评审意见，也不显示上一版产物。下游的交付页不显示已经接受的上游产物。
- 同一轮已经投下的票不能撤回。先通过再改成退回会得到 `conflicting-ballot`，原先的通过仍然有效。
- 交付的幂等键不随文件的 `mediaType`、`byteSize`、`checksum`、`accessPolicyId`、`uploadComplete` 变化。评审页在通过和退回之间、评论尚未改动时共用一个键。被拒绝的请求不写回执，所以换这些字段再提交通常仍会执行；若上一次其实已经成功、只是响应丢失，再改这些字段会得到 `idempotency-mismatch`。
- 解锁那一次写入失败之后，如果客户端没有用同一个键重试，下游要等到插件再次打开时的对账才会补上。运行期间没有周期性对账。
