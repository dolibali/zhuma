# B-M1 人工节点执行契约（S1）

切片 S1 把一份已经确认的计划跑通：启动、提交、评审、退回、全员通过、下游解锁、待办和报告。这一支只固定纯函数。纯编排在 `packages/agent-core/src/human-node.ts`，只组合现有 WP00 导出，不改 `node-status.ts`、`review.ts`、`delivery.ts`、`handoff.ts`、`concurrency.ts`。

带存储的服务、`/zhuma-exec` 通道和执行界面在后面的切片。下文用「契约」指这些纯函数。

## 验证层级

| 层级   | 本文件对应的证据                                                                     | 不是什么       |
| ------ | ------------------------------------------------------------------------------------ | -------------- |
| 纯契约 | `packages/agent-core/tests/human-node.test.mjs`，进程内函数，不打开存储、不建立 Peer | 不是 Host 验收 |

契约模拟和官方 Host 验收还不在这一支。

## 记录

`ExecutionNodeRecord` 是一条节点：

- `ownerId`：计划上的业务负责人，从已确认计划复制，不从 actor 填
- `handoff`：`readNodeHandoff` 之后的快照。启动时 `inputRefs` 为空
- `command`：`NodeCommandState`，含 `status`、`version`、`entryStatus`、`upstreamAffected`、`stored`
- `rounds`、`currentRoundId`
- `artifactVersions`、`acceptedArtifactVersionId`
- `comments`：被引用的未解决评论
- `receipts`：业务幂等回执，指纹覆盖 actor、交付正文或票面，不覆盖 `expectedVersion`

节点命令版本从启动后的 1 开始。`expectedVersion` 落后返回 `conflict`，记录保持原样。

## 启动和解锁

`startAppliedPlan` 只接受请求里的那一份已确认修订。修订对不上返回 `plan-not-found`，不改用更新的计划。任务、计划或修订号不合法返回 `plan-reference-required`。缺负责人或计划不能交接时，返回 `createNodeHandoffs` 的代码（例如 `invalid-handoff`、`child-task-required`），不写节点。

无依赖节点进入 `ready`，有依赖节点一律进入 `blocked`（上游当时是否已经完成都不改这个入口），两者都写下 `entryStatus: ready`。`plan-started` 不写 `inputRefs`。同一启动键再请求则重放，即使节点后来已经不再是 `draft`。

下游解锁的幂等键是 `unlock:{sourceId}:{downstreamNodeId}`。`sourceId` 在有评审轮次时是 `currentRoundId`，没有轮次时是 `artifact:{acceptedArtifactVersionId}`。依赖没有全部接受时，解锁结果是 `ignored`，不写回执。全部接受后把 `{ sourceNodeId, artifactVersionId }` 经 `readNodeHandoff` 写入该下游的 `inputRefs`，并把还处在 `blocked` 的下游推进到 `ready` 一次。下游若已经是 `ready` 但 `inputRefs` 仍空，同一次解锁补上这些引用，不再改状态。同一键再请求则重放。

## 提交、投票和结算

`submitDelivery` 先 `canSubmitNode`，再查回执。不是该节点的 human 执行者返回 `not-assignee`。`castBallot` 先核对评审人，再查回执。不是评审人返回 `not-assigned-reviewer`，票面评审人与 actor 不一致返回 `actor-mismatch`。这些拒绝的 disposition 是 `rejected`，不会变成 `replayed`。纯函数交还调用方传入的同一条记录引用。

`submit` 的产物 id 和轮次 id 由调用方传入。同一执行者、同一键、同一正文重放第一次的结果，即使 `expectedVersion` 已经落后。同一键、不同正文返回 `idempotency-mismatch`。失败的提交不写回执，也不占用产物版本。另一个 actor 重发同一键时先按角色拒绝。若该 actor 同样有权，指纹里的 `actorId` 对不上，则返回 `idempotency-mismatch`。

`uploadComplete: false` 返回 `upload-incomplete`。没有文字、完成的文件或链接时返回 `empty-delivery`。这两种都不增加 `command.version`，不增加产物版本，不写 `receipts`。

`settleReview` 调用 `applyReviewSettlementCommand`。全员通过才 `completed`；退回则 `needs-revision`。未齐票为 `ignored`。退回后的旧轮次不再是当前轮。用旧 `roundId` 投票返回 `stale-round`。当前轮配旧 `artifactVersionId` 返回 `stale-version`。轮次状态已经是 `voided` 时返回 `voided-round`。新提交打开新轮，旧票留在旧轮上，不继承。

同一轮已经投下的票不能撤回。先通过再改成退回会得到 `conflicting-ballot`，原先的通过仍然有效。这是 WP00 的 `submitBallot`，本切片不改。

`executionInbox` 调用 `deriveInbox`。负责人只在专家节点等待输入或失败时出现，不把业务负责人当成执行者。`toNodeExecutionReport` 是给报告用的只读投影，含 `acceptedArtifactVersionId` 和 `reviewOutcome`。被挡住的节点带 `blockReason`：等待前置节点完成。

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

## 身份

默认是多人模式。`resolveActor` 只接受 `{ ok: true, memberId, spaceIds }`。没有解析结果，或结果不是成功时，返回 `unauthenticated`。`{ ok: false, status: 403, code: 'untrusted-request' }` 保持 `untrusted-request`。`memberId` 必须是目录里的 human，否则 `not-in-directory`。专家不能当执行 actor。owner principal 不会在这里映射成已绑定的成员。

`MemberResolver` 与 B-ID0a 相同，本仓不从那一支导入。`MemberRequest` 是 `{ headers: IncomingHttpHeaders }`。`resolve(request)` 返回 `Promise<MemberResolution>`。成功是 `{ ok: true, memberId, spaceIds }`。拒绝是 `{ ok: false, status: 401, code: 'unauthenticated' }` 或 `{ ok: false, status: 403, code: 'untrusted-request' }`。A 稍后把 `memberResolver(ctx)` 注入执行入口。本模块不读取 cookie。B-ID0a 已把成员 cookie 的 `Path` 改成 `/`。

正文里任意嵌套的 `actorId`、`memberId`、`reviewerId`，`containsActorField` 为真。嵌套超过 32 层时 `scanActorField` 返回 `too-deep`，不再抛出。

## 已实现和未实现

已实现：

- 上面列出的纯函数，以及 `packages/agent-core/tests/human-node.test.mjs`
- 精确修订、入口状态、提交门禁、退回重提、全员通过后只解锁一次
- `resolveActor` 只接受 `{ ok: true, memberId, spaceIds }`。`untrusted-request` 保持原代码。`containsActorField` 拒绝正文里的 actor 字段

未实现（后续切片）：

- 带存储的执行服务、计划回执和 `/zhuma-exec`
- 执行界面
- 产物字节、预览和访问控制。这一层只校验文件元数据
- 专家评审和 `interpretAgentReview`
- 官方 Host 上的真实多人会话
