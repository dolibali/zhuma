# B-ID0a 身份与空间

状态：成员 B 的第一份证据。日期：2026-10-23。基线是 `upstream/develop` `180fffc35a173b698fd9ed71ebb2132a665ec700`。DSH 子模块仍是 `687f282e8625c6b8d11ff58211a90524be2e4317`，已发布包 `@deepseek-ai/dsh-client-connection@0.2.1-rc.2`。本文不把这一步写成 ID0 退出。

## 1. 预置账号方案写在哪里

公开仓库没有 `req.txt` 或 `tables.txt`。`docs/product-coverage.md` 第 3 行写明公开文档不收录私人需求文件。已收敛的预置账号方案在这三处：

- [产品能力覆盖账本](../product-coverage.md) FR16（第 24 行）：3 个账号、各自个人空间、2 个团队；B-ID0 负责会话、可信 actor、成员授权和空间持久化；A-SPACE 接登录和空间入口。同文件第 35 行：身份契约由 B 维护，不用浏览器 actor 参数伪造登录。依据是 [PR #5 评论 6340839080](https://github.com/dolibali/zhuma/pull/5#issuecomment-6340839080)。
- [实施顺序](../roadmap.md) 第 31–34 行：B-ID0 先给固定 DSH 的最小适配证据；不把模型平台账号或 `browserPeer` owner 当产品账号。退出条件仍是 3 账号 / 2 团队，其中一人跨团队，双会话走完退回重提，第三账号被拒。
- 上述评论的原文：没有 SSO；预置测试账号；一个账号有个人空间和所属团队；空间内有项目、人员、专家、资产、任务和产物；真实登录会话和服务端成员校验。模拟的是种子数据，不是浏览器里的 member/actor 切换。DeepSeek account 是模型平台账号。不要把整个 owner API 对外共享。

`docs/architecture.md` 第 50 行仍写明当前是本地 Host owner 模式，不能据此宣称多人权限已经完成。

## 2. 固定 DSH 上的复核

以下行号相对 `upstream/deepseek-harness/`，提交 `687f282`。这些是在 0.2.1-rc.2 / `687f282` 上读到的源码，证据就在本节，不另指仓库里不存在的调研分节。

在 0.2.1-rc.2 / `687f282` 上，官方 Host 只有一个 owner 身份：

- 一个进程一个启动令牌。`packages/client/connection/src/browser-auth.ts:22` 的 `PROCESS_LAUNCH_TOKENS`，`:61-67` 生成令牌，`:244-248` 把它放进 `?token=`。
- 浏览器 cookie 的载荷是 `{version, authority, issuedAt, expiresAt}`（`browser-auth.ts:29-34`）。`authorizeIndex`（`:263-305`）用启动令牌换这张 cookie。签名密钥是 owner 范围的 `client-connection/browser-session`（`:14`，`:182-199`）。载荷里没有用户 id。
- API cookie 是 version 2，多一个 `id: PeerId`（`:36-39`，`:314-348`）。`publishPeer` 创建的 Peer 仍是 `{ kind: 'owner' }`（`packages/client/connection/src/rpc-host.ts:169-173`）。
- 所有通过认证的浏览器共用一个 Peer。`rpc-host.ts:71-72` 的注释和 `:94` 的 `browserPeer`，`admit`（`:128-137`）对浏览器 cookie 一律返回它。包说明 `packages/client/connection/README.md:49` 写的是同一句话。
- `PrincipalMap` 只有 `owner`（`packages/typert/protocol/src/types.ts:455-461`）。源码里的其他 kind 只出现在测试的声明合并里，例如 `packages/typert/protocol/tests/built-runtime.e2e.ts:28` 的 `guest` 和 `packages/client/connection/tests/fetch-routes.host.spec.ts:22` 的 `test-guest`。
- Host/Origin 检查不确立身份（`packages/client/connection/src/api-request-trust.ts:1-13`，第 12 行写明 never establishes identity）。
- 没有登出。`packages/client/connection/README.md:83`：清掉浏览器 cookie 只结束这一次浏览器会话；删掉 owner 凭据并重启 `dsh` 才会作废全部会话。`packages/identity/README.md:12` 的 anonymous id 不标识用户。

授权缝隙：

- exact Fetch 只放行 owner，而且 `route.fetch(request)` 不传 Peer（`rpc-host.ts:218-222`）。现有 `/api/zhuma/*` 就是这种路由。
- `ctx.connection.rpc.handle` 的 handler 能拿到 Peer（`packages/client/connection/src/rpc.ts:136-141`，调用点 `rpc-host.ts:342`）。注册前先 `admit`（`rpc-host.ts:253-277`），所以浏览器请求在进 handler 之前已经是 owner。
- `createPeer`（`rpc-host.ts:139-142`）可以在进程内造别的 principal。运行时只保存传入的对象，不核对 `PrincipalMap`。
- `remoteAccess.registerPolicy`（`packages/api/remote-access/src/index.ts:153-166`）给非 owner kind 登记策略。`decide`（`:199-222`）对 owner 直接允许（`:202`）。`allows` 在 `:235-244`。Gateway 对非 owner 另有限制（`packages/api/gateway/src/index.ts:484-486`、`:566`）。
- `connection/request`（`packages/client/connection/src/index.ts:61-72`，调用在 `:157`）只作用在已经认证的请求上，不能把请求换成另一个身份。
- 前缀路由的注册点是 `ctx.webServer.register`（`packages/host/webserver/src/index.ts:47`、`:366`；匹配在 `:543-551`）。
- `storageDomain.open` 同名第二次打开抛 `already-open`（`packages/storage/storage-domain/src/index.ts:105`）。写先落盘再改内存（`packages/storage/storage-domain/src/domain.ts:307-311`）。没有跨记录事务（`packages/storage/storage-domain/README.md:147`）。

因此，在 0.2.1-rc.2 / `687f282` 上观察到：插件不能让官方 `/api` 认证出非 owner 的浏览器会话，除非改 DSH，或在 `admit` 之外另挂一条路由。

## 3. 最小复现

`packages/dsh-adapter/tests/owner-identity-limit.test.mjs` 调用已发布的 `apply`。真实的是 BrowserAuth、`authorizeIndex`、`authorizeConnect`、`admit`、`browserPeer`、`createPeer` 和 exact Fetch 分发，以及它们签出的 cookie。模拟的是凭据介质：内存里的 `modifyRecord`，不是 `$DSH_HOME/.credentials.yaml`。没有监听端口；请求是这些方法本来就接受的对象。

结果：

- 两次启动令牌交换得到两张不同的 v1 cookie。载荷键只有 `authority`、`expiresAt`、`issuedAt`、`version`。
- 两次 `admit` 返回同一个对象，就是 `connection.browserPeer`，principal 都是 `{ kind: 'owner' }`。
- 在请求头上另放 actor 不会改变这次 admission。exact 路由处理函数只收到 `Request`，拿不到 Peer。请求体里的 `actorId` 对 Peer 没有影响。
- `createPeer({ kind: 'zhuma-member', memberId: 'chen' })` 能造出另一个 Peer，但 exact 路由对它返回 403，处理函数不会被调用。
- 两次 `/connect` 得到两张 v2 cookie，Peer id 不同，principal 仍都是 owner。cookie 里的 id 是 PeerId，不是用户 id。
- 没有 cookie 时 `admit` 返回 401。

在 0.2.1-rc.2 / `687f282` 上观察到：两个浏览器会话无法区分。这是可运行证据，不是契约模拟：认证和 Peer 来自已发布的 Connection 包。

## 4. 方案

| 方案 | 做法                                                                                                                                                                                                                                                          | 取舍                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M    | owner Peer 绑定一个目录成员。命令从 `peer.principal` 计算 actor，拒绝请求体里的 actor。多人只在进程内 Peer 的测试里出现。                                                                                                                                     | 不改 DSH，也不签发第二套 cookie。真实的两个浏览器仍是同一个人，到不了 FR16 的双会话。                                                                                                    |
| M+   | 在 `ctx.webServer` 上挂前缀路由。成员口令核对显式导入的账号后，用 `ctx.credentials` 里的密钥签发 `zhuma-member` cookie，再用 `createPeer({ kind: 'zhuma-member', memberId })`。`registerPolicy('zhuma-member', …)` 限制该方法。空间成员关系在路由里再查一次。 | 复用 webServer、credentials、Peer 和 storage-domain，不改子模块。B 要维护会话签发。官方 `admit` 仍把每张浏览器 cookie 当成 owner。`decide` 对 owner 一律放行，空间隔离不能只放在策略里。 |
| U    | 上游让 `admit` 按用户签发 principal。zhuma 不改子模块，等 pin 升级。                                                                                                                                                                                          | 浏览器会话本身就能区分人。周期不由本仓库决定。                                                                                                                                           |
| P    | 反向代理把身份放进请求头。                                                                                                                                                                                                                                    | `api-request-trust.ts:12` 不把请求头当身份。不采用。                                                                                                                                     |

建议走 M+，范围限在 `/zhuma-id` 前缀，不把 owner 的 `/api` 暴露成产品登录。M 留作“只有宿主操作者一个人”时的映射，不能代替第二个会话。U 仍是让官方浏览器认证本身支持多人的路，值得另提，但不阻塞这一层。

M+ 必须守住四条，否则两个会话会再次合成一个人：

1. 产品读写走前缀路由，不走 exact `/api/zhuma/*`。
2. 只拒绝 JSON 对象或查询串上的顶层 `actor`、`actorId`、`memberId`，不把它当成登录或覆盖。请求头（例如 `x-actor-id`）、嵌套字段（例如 `{ data: { actorId } }`）和大小写变体（`ActorId`、`actor_id`）不走这条拒绝，也不会因此升权。
3. 已经带了 `zhuma-member` cookie 时，无效会话返回 401，不退回 owner。否则登出后浏览器里剩下的 DSH cookie 又会变成绑定成员。
4. 空间是否可读写看账号是否为资源的 owner 或团队成员。`decide` 对 owner principal 的允许不算空间授权。本次测试里，owner principal 对 `south-note` 的 `decide` 是 allow，HTTP 写入仍被拒绝。笔记不存在和没有成员资格都返回 404 `not-found`，响应体相同，不能靠状态码判断笔记在不在。

## 5. 本次探针

`packages/dsh-adapter/src/identity-session.ts` 的 `applyIdentity`，测试在 `packages/dsh-adapter/tests/identity-session.test.mjs`。没有改子模块，也没有新依赖。

生产路径没有默认账号。`applyIdentity(ctx)` 不传导入时不写账号、不写笔记、也不保存任何口令。`seedIfEmpty` 不使用内置口令。调用方只能显式传入已经算好的 `{ id, passwordHash }`。已有账号的 domain 不会被这次导入覆盖。

测试在每次运行时自己生成随机口令，算出摘要后再导入。夹具里的账号 id 是 `lin`、`zhao`、`chen`。`north-note` 属于 `team-north`，owner 是 `lin`，成员还有 `zhao`。`south-note` 属于 `team-south`，owner 是 `chen`。`lin` 作为 host owner cookie 的映射，只在这次导入写了 `ownerAccountId` 时成立。没有导入，或导入没有 `ownerAccountId` 时，domain 的 global 是空字符串，DSH cookie 不会变成任何账号，`/session` 返回 401。摘要是 `node:crypto` 的 salted scrypt（N=16384，r=8，p=1），盐和摘要一起放在 `passwordHash` 里。导入不接受口令明文。拼错的键、空的账号列表、重复的 id，以及笔记引用了未导入的账号，都会拒绝并报错。请求体超过 64KiB 时先返回 413，带 `Connection: close`，响应结束后再停止读取并关闭连接。真实的 `node:http` 客户端能收到这个 413。登录核对走异步 `scrypt`。同一个来源地址和账号在 60 秒内失败 8 次后，再登录返回 429，不再计算摘要。`hashPassword` 仍是同步的，只给准备导入的调用方使用，请求处理不会调用它。登录成功时删掉 `expiresAt` 已经过去的会话行。没有定时器。只读请求和过期 cookie 的 401 不会删行；没有人登录时，过期行会留到下一次成功登录。

探针里真实跑到的 DSH 层：

- Connection `apply`、浏览器 cookie、`admit`、共享 `browserPeer`、`createPeer`。成员路由在登录和 cookie 之前调用 `ctx.connection.requestRejection`。它返回 403 时拒绝。这是 Connection 自己的 Host/Origin 检查：`admit` 在不信任的 Host、跨站 `sec-fetch-site` 或不匹配的 Origin 上返回 403。已发布包的入口不导出 `isTrustedApiRequest`，所以没有从内部路径再引一份，也没有另写一份检查。401 只表示还没有 DSH 会话，成员 cookie 仍继续核对。
- `DomainFacility.open`。重开时新的 facility 从同一份内存介质读回记录，所以写入经过了 domain 的 `putRecord`。

没有装进本包、因此用同形替身的部分：

- 没有监听套接字。`webServer.register` 的替身按 exact、再按最长前缀分发，处理函数是 `applyIdentity` 和 Connection 注册进去的那些。
- `modifyRecord` 是按 key 分开的内存表，不是 `.credentials.yaml`。Connection 的 `client-connection/browser-session` 和本模块的 `zhuma-identity/member-session` 各占一条。
- KV 介质是内存 Map。domain 的校验和写链是真的，json/sqlite 后端不是。
- `decide` 按 `remote-access` 源码里的规则实现：owner 直接允许，其他 kind 走已注册策略的 `bindings` 和 `condition`。策略对象是 `applyIdentity` 注册的。没有加载 `RemoteAccessService` 类。

测试结果：

- owner cookie 的当前账号是 `lin`，principal 是 `{kind:'owner'}`，peer id 等于 `browserPeer.id`。两次读取是同一个 peer。
- `zhao`、`chen` 登录后 principal 是 `{kind:'zhuma-member', memberId}`，peer id 不是 `browserPeer`。账号来自会话记录，不来自请求体。
- `zhao` 能读能写 `north-note`，也能查询 `team-north`。`chen` 写北队笔记得到 404 `not-found`，和笔记不存在是同一个响应，原文保持为 `zhao` 写入的内容。`chen` 能写南队笔记。owner cookie 写南队笔记也被拒绝，同样是 404 `not-found`。策略层的 `decide` 仍可以返回 `not-a-member`，HTTP 不把它露出去。
- 登录体或查询串里的 `actorId` 返回 `actor-from-body`，不发 cookie。`chen` 的 cookie 加上 `actorId: lin` 同样被拒，笔记不变。同时带 owner cookie 和 `chen` cookie 时，账号仍是 `chen`。
- `chen` 登出后，旧 cookie 单独使用是 401；和 owner cookie 放在一起也是 401，不会退回 `lin`。只有 owner cookie 时登出返回 `member-session-required`，DSH 会话还在，账号仍是 `lin`。
- 关掉 Connection 和 identity，用同一份凭据表和同一份 KV 介质再打开：北队笔记仍是登出前的文本；`zhao` 的 cookie 仍能读；`chen` 的旧 cookie 仍是 401；新的 owner cookie 认证仍映射到 `lin`，但是新的 `browserPeer`。`chen` 重新登录后仍不能读北队笔记，南队笔记仍在。

## 6. A 需要提供的挂载

本切片没有改 `workbench-plugin.ts`，也没有改 `scripts/workbench/build.mjs`。宿主构建的 Host 入口仍只有工作台插件，所以桌面和 Web 包里还没有 `/zhuma-id`。

A 在官方 Host 上已经具备 `connection`、`storageDomain`、`credentials`、`webServer` 时，需要：

1. 在现有 `apply` 里调用一次 `applyIdentity`。不要再打开名为 `zhuma_identity` 的 domain，也不要为了读工作台再打开 `zhuma_workbench`。
2. 构建入口要能带到 `packages/dsh-adapter/src/identity-session.ts`。现在的 esbuild 入口只有 `workbench-plugin.ts`。
3. 登录页、空间切换和成员入口仍由 A-SPACE 做。cookie 由 `Set-Cookie` 写入，页面不提交 actor。
4. 若要把 `registerPolicy` 写成对真实 `RemoteAccessService` 的类型检查，需要在宿主编译里合并 `PrincipalMap` 的 `zhuma-member`。运行时 `createPeer` 不依赖这次合并；本包用了断言，因为 `@deepseek-ai/dsh-typert-protocol` 不是直接依赖。

## 7. 到 ID0 退出还缺什么

FR16 的退出是：3 个账号、2 个团队、其中一人跨团队；两个独立会话走完提交、退回、重提、通过和下游待办；第三账号访问无权限的空间和文件被拒；刷新和后端重启后状态还在；切空间不串缓存、不搬私人内容、不触发模型。

这次已经有的是：3 个预置账号、2 个团队空间、各一条笔记、服务端 actor、读写拒绝、成员登出，以及在同一份介质上重开 domain 和 Connection。没有个人空间，没有跨团队成员，没有任务、文件字节、待办或评审，也没有真实 `dsh` 进程的重启。KV 重开不能代替进程重启。

剩下的工作是这些块，而不是再换一套身份模型：

- 把 `applyIdentity` 接到宿主构建，并用真实 webServer、credentials 和 RemoteAccessService 跑一遍前缀路由。成员 cookie 的 `Path` 是 `/zhuma-id`。`Secure` 仍是待办：在 0.2.1-rc.2 上 DSH 只在监听协议为 https 时才加 `Secure`，这里同样留到 TLS 监听接上之后。
- 空间记录独立出来：每人一个个人空间，两个团队，其中一人同时属于两个团队。种子只在空库写入。
- 资源授权继续用“owner 或团队成员”，从一条笔记扩到任务和文件元数据。文件字节仍没有带访问控制的 DSH 存储，那是另一项。
- B-M1 的提交、退回、重提和下游待办改用这里的 `accountId`，不再接受请求体 actor。
- A-SPACE 的登录和空间切换，以及按账号/空间分开的客户端缓存。
- 一次真实 Host 进程的退出和再启动。DSH owner cookie 仍然没有产品级登出；产品登出只作废 `zhuma-member` 会话。

## 8. 给 dolibali 的问题

1. M+ 这种由 B 签发的成员 cookie，是否接受为 FR16 的登录，还是必须等 U，在 `admit` 里区分用户？
2. `decide` 对 owner 一律允许。空间隔离放在路由里、不单放在 `registerPolicy`，是否符合预期？
3. 带了无效成员 cookie 时不退回 owner。后果（N1）：导入把 `ownerAccountId` 设成 `lin` 时，浏览器只留 DSH cookie、删掉成员 cookie，会被当成 `lin`，因此 chen 能读到北队笔记。没有这份导入时，DSH cookie 不是产品账号。演示时是否要求两个浏览器都走成员登录，从而都不再落回 owner？
4. 生产路径已经不放默认账号。导入是调用方传入的 `{ id, passwordHash }`，且不覆盖已有账号。宿主是否就用这个导入作为种子入口？
5. `applyIdentity` 的挂载和构建入口是否由 A 加进 `workbench-plugin.ts`？B 这次没有改那个文件，也没有改 `scripts/workbench/build.mjs`。
