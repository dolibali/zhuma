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
3. 产品多人模式只认有效成员会话。成员 cookie 缺失、被删除、过期、撤销或伪造都返回 401，不退回 DSH owner。否则登出后浏览器里剩下的 DSH cookie 又会变成绑定成员。
4. 空间是否可读写看账号是否为资源的 owner 或团队成员。`decide` 对 owner principal 的允许不算空间授权。本次测试里，owner principal 对 `south-note` 的 `decide` 是 allow，HTTP 写入仍被拒绝。笔记不存在和没有成员资格都返回 404 `not-found`，响应体相同，不能靠状态码判断笔记在不在。

## 5. 本次探针

`packages/dsh-adapter/src/identity-session.ts` 的 `applyIdentity`，测试在 `packages/dsh-adapter/tests/identity-session.test.mjs`。没有改子模块，也没有新依赖。

生产路径没有默认账号。`applyIdentity(ctx)` 不传导入时不写账号、不写笔记、也不保存任何口令。`seedIfEmpty` 不使用内置口令。调用方只能显式传入已经算好的 `{ id, passwordHash }`。导入先写账号和笔记，最后才把 global 的 `importComplete` 写成 true。标记还没写上时，下一次用同一份导入打开会把缺的行补上。标记已经是 true 的 domain 不会被另一份导入覆盖。

测试在每次运行时自己生成随机口令，算出摘要后再导入。夹具里的账号 id 是 `lin`、`zhao`、`chen`。`north-note` 属于 `team-north`，owner 是 `lin`，成员还有 `zhao`。`south-note` 属于 `team-south`，owner 是 `chen`。没有写死的 `lin` 默认账号。多人导入（两个及以上账号）如果再写 `ownerAccountId`，导入直接拒绝。没有导入，或导入没有把 `ownerAccountId` 设成唯一账号时，DSH cookie 不是产品账号，`/session` 返回 401。只有导入恰好一个账号，并且 `ownerAccountId` 就是这个账号时，隔离的本机单人模式才接受这张 DSH cookie。摘要是 `node:crypto` 的 salted scrypt（N=16384，r=8，p=1），盐和摘要一起放在 `passwordHash` 里。导入不接受口令明文。拼错的键、空的账号列表、重复的 id，以及笔记引用了未导入的账号，都会拒绝并报错。请求体超过 64KiB 时先把完整的 413 写出去，带 `Content-Length`，这个值等于响应正文的字节数，并且不带 `Connection: close`。对端还可能继续上传时不调用 `res.end()`。Node 会在响应结束时收起套接字；分块上传还没写完就被收起时，解析失败，客户端看到 ECONNRESET 或 EPIPE，状态是 0，读不到 413。正文用 `data`/`end` 读取；超限后停止解析，继续把剩余正文读完并丢掉。客户端把请求写完之后才 `res.end()`。丢掉的上限是再读 32MiB，时间上限是 5 秒，用来挡住一直不写完的连接。先碰到上限时，要等这 413 的字节已经写出，再留 500 毫秒给客户端读完，然后才 `destroy`。不能用 `for await` 读请求：循环抛错时异步迭代器会销毁 `IncomingMessage`，套接字在 413 写出之前就被拆掉。声明了超限 `Content-Length` 的请求和分块超限请求都会收到完整的 413，客户端仍在按大块写入并占用事件循环时也一样，之后正常登录仍然成功。登录核对走异步 `scrypt`，次数在计算摘要之前先占名额，所以同一地址的并发登录也不能全部越过限额。同一个来源地址在 60 秒内的登录合计达到 8 次后，该地址再登录返回 429，不再计算摘要；账号 id 是否存在、是否换一个账号，都数进这一窗口，所以 429 出现的时刻不能用来判断账号在不在。同一地址上的单个账号另外还有一份计数，上限同样是 8。登录成功会清掉该地址的计数和这次登录的账号计数，另一个账号在同一地址上已经累计的失败次数还留着，所以这个账号仍会在 8 次后得到 429，而该地址上的其他账号还可以登录。过期的计数会在下一次占名额、清除或读取时删掉。失败计数表由每次 `applyIdentity` 各自创建，同一个进程里的两个宿主不共用一张表。进程里同时进行的口令摘要最多 4 路。再多的登录排队，队列最多 32 个。队列已满时这次登录返回 503 `login-unavailable`，不计算摘要，也不占用上面的 8 次名额。账号是否存在，503 的状态和正文都一样。同一个宿主上，本地部署通常共用一个来源地址，因此这一地址上连续 8 次登录就会把该地址锁 60 秒，锁定期内换账号或使用正确口令也是 429。`hashPassword` 仍是同步的，只给准备导入的调用方使用，请求处理不会调用它。登录成功时删掉 `expiresAt` 已经过去的会话行。没有定时器。只读请求和过期 cookie 的 401 不会删行；没有人登录时，过期行会留到下一次成功登录。成员 cookie 的 `Path` 是 `/`，这样 `/api/zhuma-exec` 也能带上它；`HttpOnly` 和 `SameSite=Strict` 保留。`Secure` 仍是待办：在 0.2.1-rc.2 上 DSH 只在监听协议为 https 时才加 `Secure`，这里同样留到 TLS 监听接上之后。

探针里真实跑到的 DSH 层：

- Connection `apply`、浏览器 cookie、`admit`、共享 `browserPeer`、`createPeer`。成员路由在登录和 cookie 之前调用 `ctx.connection.requestRejection`。它返回 403 时拒绝。这是 Connection 自己的 Host/Origin 检查：`admit` 在不信任的 Host、跨站 `sec-fetch-site` 或不匹配的 Origin 上返回 403。已发布包的入口不导出 `isTrustedApiRequest`，所以没有从内部路径再引一份，也没有另写一份检查。401 只表示还没有 DSH 会话，成员 cookie 仍继续核对。
- `DomainFacility.open`。重开时新的 facility 从同一份内存介质读回记录，所以写入经过了 domain 的 `putRecord`。

没有装进本包、因此用同形替身的部分：

- 多数用例没有监听套接字。`webServer.register` 的替身按 exact、再按最长前缀分发，处理函数是 `applyIdentity` 和 Connection 注册进去的那些。另有一个 `node:http` 用例。Chromium 用例在 `packages/dsh-adapter/tests/browser/identity-session.spec.mjs`，自己监听并挂上 `/zhuma-id`。两个服务都 `listen(0)`，端口由系统分配。`pnpm test:ui` 的 `identity` 项目会跑它。单独重跑：`pnpm exec playwright test --config packages/client/tests/browser/playwright.config.mjs --project=identity`。Playwright 先启动 webServer，再跑 globalSetup。从 `4e6a055` 起，webServer 的命令会先在仓库根目录执行 `pnpm exec tsc -b --pretty false`，成功后再启动页面服务，所以没有 dist 的树也能启动。启动预算是 120 秒。globalSetup 之后还会再用当前 Node 跑一次 `tsc -b`。`pnpm test:ui` 会带上同一个项目。
- `modifyRecord` 是按 key 分开的内存表，不是 `.credentials.yaml`。Connection 的 `client-connection/browser-session` 和本模块的 `zhuma-identity/member-session` 各占一条。
- KV 介质是内存 Map。domain 的校验和写链是真的，json/sqlite 后端不是。
- `decide` 按 `remote-access` 源码里的规则实现：owner 直接允许，其他 kind 走已注册策略的 `bindings` 和 `condition`。策略对象是 `applyIdentity` 注册的。没有加载 `RemoteAccessService` 类。

测试结果：

- 三人导入下，只带 DSH owner cookie 时 `/session` 和北队笔记都是 401。principal 不会变成 `lin`。
- `zhao`、`chen` 登录后 principal 是 `{kind:'zhuma-member', memberId}`，peer id 不是 `browserPeer`。账号来自会话记录，不来自请求体。
- `zhao` 能读能写 `north-note`，也能查询 `team-north`。`chen` 写北队笔记得到 404 `not-found`，和笔记不存在是同一个响应，原文保持为 `zhao` 写入的内容。`chen` 能写南队笔记。owner cookie 写南队笔记也被拒绝，同样是 404 `not-found`。策略层的 `decide` 仍可以返回 `not-a-member`，HTTP 不把它露出去。
- 登录体或查询串里的 `actorId` 返回 `actor-from-body`，不发 cookie。`chen` 的 cookie 加上 `actorId: lin` 同样被拒，笔记不变。同时带 owner cookie 和 `chen` cookie 时，账号仍是 `chen`。
- `chen` 登出后，旧 cookie 单独使用是 401；和 owner cookie 放在一起也是 401。登出响应是 `Max-Age=0; Path=/`。浏览器丢掉成员 cookie 后只剩 DSH cookie，`/session` 仍是 401，北队笔记也是 401。
- 关掉 Connection 和 identity，用同一份凭据表和同一份 KV 介质再打开：北队笔记仍是登出前的文本；`zhao` 的 cookie 仍能读；`chen` 的旧 cookie 仍是 401；新的 owner cookie 仍是 401。`chen` 重新登录后仍不能读北队笔记，南队笔记仍在。

## 5.1 给执行入口的成员解析

`/zhuma-id` 和以后的 `/api/zhuma-exec` 用同一份解析。执行插件注入 `MemberResolver`，不要再从 `admit` 的 owner principal 推导成员。

导出在 `packages/dsh-adapter/src/member-session.ts`：

```ts
interface MemberRequest {
  readonly headers: IncomingHttpHeaders;
}
type MemberResolution =
  | { readonly ok: true; readonly memberId: string; readonly spaceIds: readonly string[] }
  | { readonly ok: false; readonly status: 401; readonly code: 'unauthenticated' }
  | { readonly ok: false; readonly status: 403; readonly code: 'untrusted-request' };
interface MemberResolver {
  resolve(request: MemberRequest): Promise<MemberResolution>;
}
function resolveMember(ctx: object, request: MemberRequest): Promise<MemberResolution>;
function memberResolver(ctx: object): MemberResolver;
```

`applyIdentity` 挂上之后，`memberResolver(ctx)` 就是可注入的对象，`resolveMember(ctx, { headers })` 是同一条规则的函数。`ctx` 可以是宿主根上下文，也可以是 Cordis 插件拿到的子上下文，解析登记在宿主根上。`headers` 用 Node 的请求头，至少要有这次请求的 `cookie`，以及 Host/Origin 检查要用的 `host`、`origin`、`sec-fetch-site`。成功时 `memberId` 是账号 id，`spaceIds` 是该账号作为 owner 或团队成员能够触及的空间 id，按字母序。403 表示 Host/Origin 不被 Connection 信任。401 表示没有有效成员会话。未挂载 identity 时也是 401。

多人模式下，没有成员 cookie、cookie 被删、`Max-Age=0` 登出、超过 12 小时、签名不对或会话已撤销，都是 401。同时带成员 cookie 和 DSH cookie 时按成员处理。DSH owner 不会自动等于某个成员。

部署模式由宿主在启动时显式选定，登记在宿主根上，和成员解析器分开存放。解析器在不在，不能推出当前是单人还是多人。

```ts
type DeploymentMode = 'legacy-single-user' | 'multi-member';
function configureDeploymentMode(ctx: object, mode: DeploymentMode): void;
function deploymentMode(ctx: object): DeploymentMode | undefined;

type LegacyOwnerRouteDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401 | 404;
      readonly code: 'deployment-mode-unset' | 'not-found';
    };
function authorizeLegacyOwnerRoutes(ctx: object): LegacyOwnerRouteDecision;

type IdentityAccessMode = 'unmounted' | 'single-user' | 'multi-member';
function identityAccessMode(ctx: object): IdentityAccessMode;
```

`configureDeploymentMode(ctx, mode)` 只接受 `legacy-single-user` 或 `multi-member`。同一个宿主再设一次相同的模式可以；改成另一种模式会抛 `identity startup refused: deployment mode is already configured`。传入其他值会抛 `identity startup refused: deployment mode is not configured`，并且不写入。`deploymentMode(ctx)` 在还没选定的时候返回 `undefined`。

`applyIdentity` 在打开 domain 之前读取这个模式。没有选定就抛同一句未配置错误，不会打开身份库，也不会改去单人模式。`legacy-single-user` 并且导入恰好一个账号、`ownerAccountId` 指向该账号时，owner cookie 才映射成这个成员。`multi-member` 下即使导入满足这个形状，owner cookie 仍是 401。

`LEGACY_OWNER_ROUTES` 是仍走 DSH owner carrier 的 exact 路由：`snapshot`、`command`、`plan`、`preview-import`、`resource-files`。`LEGACY_OWNER_PACKAGE_COMMANDS` 是 `import-package`。它没有单独的路由，写在 `command` 的载荷里，和这五条路由一起关闭。

`authorizeLegacyOwnerRoutes(ctx)` 是这些入口的门。它只看部署模式，不读 cookie：

- `legacy-single-user` 返回 `{ ok: true }`。这五条路由仍按原来的 owner 入口处理，`import-package` 也一样。
- `multi-member` 返回 `{ ok: false, status: 404, code: 'not-found' }`。身份还没挂上、`applyIdentity` 抛错、正在 dispose、dispose 完成、以及重新挂载的整个过程，都是这个结果。没有 cookie、cookie 无效、或成员 cookie 有效，都一样，不退回 owner。这五条路由不返回工作台快照，也不解析导入包。
- 模式还没选定时返回 `{ ok: false, status: 401, code: 'deployment-mode-unset' }`。启动拒绝继续，路由也不放行。

门必须写在 `request.json()` 和 `handle()` 之前。这样超限或失败时不会解压 ZIP，不会读出文件字节，也不会把包写入 `zhuma_asset_packages`。

`zhuma_asset_packages`（version 1，per-record，`versions` 表）只保存不可变字节，自己不做授权。字段、限额和 Host 形状由 A 的 IF04 维护，见 `docs/asset-import.md` 提交 `e3916fa`（「本地专家与资产包导入：首批接口」）的「Host 与 S1 接缝」。本文不复制那份定义。旧版本在运行时的物化要经过 B 的服务，用 `deploymentMode(ctx)` 和 `resolveMember` / `memberResolver` 做授权，不能直接扫这张表。普通成员不能用这五条路由读全局目录，也不能按任意 versionId 取包；那会另走空间授权入口。`resource-files` 在单人旧入口里也只返回当前定义 origin 允许的文件，不是目录列举。

`identityAccessMode(ctx)` 的声明返回类型仍包含 `unmounted`，以便和既有 S1 签名互认。运行时它只读 `deploymentMode`：`legacy-single-user` 得到 `single-user`，`multi-member` 得到 `multi-member`，未选定则抛未配置错误。授权决定用 `authorizeLegacyOwnerRoutes`。

宿主装配顺序：

1. `configureDeploymentMode(ctx, mode)`，在宿主 setup 选定。
2. `applyIdentity(ctx, imported?)`。
3. `memberResolver(ctx)` 可以注入。它和 `resolveMember(ctx, request)` 是同一条规则。
4. `applyWorkbench`。A 的工作台插件在这里挂上。
5. `applyExecution`。执行插件从 `deploymentMode(ctx)` 和 `resolveMember` / `memberResolver` 读取模式和成员。
6. UI mount。

执行侧使用的导出是 `DeploymentMode`、`configureDeploymentMode`、`deploymentMode`、`resolveMember`、`memberResolver`、`MemberResolver`、`MemberRequest`、`MemberResolution`。`applyIdentity` 的签名仍是 `(ctx: Context, imported?: IdentityImport) => Promise<void>`。

执行插件不再接受 `singleUser`，也不再提供 `bind-owner`。模式和成员只从上面的 `deploymentMode`、`resolveMember` 和 `memberResolver` 读取。对应的模块签名：

```ts
interface ExecutionApplyOptions {
  readWorkbench(): Workbench;
  memberResolver?: MemberResolver;
}
type ApplyExecution = (ctx: Context, options: ExecutionApplyOptions) => Promise<void>;
type ExecutionEndpoints = readonly ['start-plan', 'inbox', 'submit', 'ballot', 'settle', 'report'];
interface ExecutionApi {
  inbox(signal?: AbortSignal): Promise<ExecutionInboxValue>;
  submit(draft: DeliveryDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
  ballot(draft: ReviewDraft, signal?: AbortSignal): Promise<ExecutionNodeWire>;
}
type CreateExecutionApi = (rpc: ClientConnectionRpc) => ExecutionApi;
interface ExecutionWorkspaceProps {
  api: ExecutionApi;
}
```

请求体仍是 `StartPlanRequest`、`InboxRequest`、`SubmitRequest`、`BallotRequest`、`SettleRequest`、`ReportRequest`。没有 `BindOwnerRequest`。通道结果仍是 `{ ok: true, value } | { ok: false, error: { code, message, details } }`。`readWorkbench` 由 A 包住 `WorkbenchService.snapshot()`。界面挂 `ExecutionWorkspace`，它使用 `createExecutionApi(rpc)`。这些类型的字段以本累计 head 的 `packages/dsh-adapter/src/s1-integration.ts` 为准。执行插件已在 `packages/dsh-adapter` 实现。不要用旧的 `b/s1-signatures@5d6eafa` 推断它尚未实现。身份模块 #18 的 head 是 `eb25d30`。#18 已合入 develop（772b59c）。本 head 的身份代码经 `b/m1-align-identity` `20314eb` 带入，与 `eb25d30` 内容等价；另多 `packages/dsh-adapter/tsconfig.identity.json` 与 `packages/dsh-adapter/tests/identity-session.test.mjs` 的小增量。

「不改包的公开 exports」只描述身份模块 #18：该分支不改 `workbench-plugin.ts`、宿主构建和当时的包入口。B 在累计 Draft 里自己的提交仍不改 `workbench-plugin.ts`。develop `843661c` 合入的 #23 改了这个文件，在注册五条路由时先调用 `authorizeLegacyOwnerRoutes`。相对当时的 develop `f90f2d8`，三个包的 `index.ts` 另有新增导出，待 A 确认。`packages/agent-core/src/index.ts`：`ExecutionNodeRecord`、`ExecutionReceipt`、`NodeCommandResult`、`PlanStartResult`、`nodeRecordKey`、`unlockKey`、`completionSource`、`downstreamRecords`、`startAppliedPlan`、`submitDelivery`、`castBallot`、`settleReview`、`unlockDownstream`、`toNodeExecutionReport`、`executionInbox`。`packages/client/src/index.ts`：`DeliveryDraft`、`ExecutionApi`、`ExecutionInboxValue`、`ExecutionNodeWire`、`ReviewDraft`、`createExecutionApi`、`readExecutionNode`、`DeliveryPanel`、`ExecutionWorkspace`、`InboxPanel`、`ReviewWorkspace`。`packages/dsh-adapter/src/index.ts`：`ACTOR_FIELD_DEPTH_LIMIT`、`containsActorField`、`resolveActor`、`scanActorField`、`ActorFieldScan`、`ActorResolution`、`MemberRequest`、`MemberResolution`、`MemberResolver`、`ExecutionService`、`toNodeView`、`ExecutionFailure`、`ExecutionNodeView`、`ExecutionCommandResult`、`ExecutionStorage`、`PlanReceipt`、`applyExecution`、`executionEndpoints`、`executionInject`、`ExecutionPluginConfig`，以及 `export type * from './s1-integration.js'`。下面仍是 #18 的记录：该分支相对当时的 develop 新增 `packages/client/tests/browser/global-setup.mjs`，并在 `playwright.config.mjs` 里加上 `globalSetup` 和 `identity` project，也改了 webServer 的命令和 timeout。这些都是 B 加的或改的。`identity` project 是 B 在 `7668a2c` 加上的。`global-setup.mjs` 和 `globalSetup` 是 B 在 `f0eac0f` 加上的。A 的 `52d0ac0` 只把 global-setup 改成用当前 Node 跑 `tsc`；A 的 `5d356fb` 只改了 webServer 的命令和 timeout。这两个提交不是本 PR 的祖先，也没有进入 develop。B 在 `9767529` 和 `4e6a055` 里重做了同样的改动，之后没有再改这两处，所以现在的内容与 A 的 `52d0ac0`、`5d356fb` 对齐。在 `b/id0a-legacy-gate` `69c7366` 上，A 也曾用 `LEGACY_OWNER_ROUTES` 注册五条路由，并在读取正文之前调用门禁。本 head 的可运行注册来自 #23，不是 `69c7366`；该提交仍不是本 head 的祖先。`command` 被关掉时，`import-package` 不会进入 `previewResourcePackage` 或包存储的 `put`：

```ts
import { authorizeLegacyOwnerRoutes, LEGACY_OWNER_ROUTES } from './member-session.js';

for (const endpoint of LEGACY_OWNER_ROUTES) {
  ctx.connection.fetch.register({
    path: `/api/zhuma/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const gate = authorizeLegacyOwnerRoutes(ctx);
      if (!gate.ok) {
        return Response.json(
          { ok: false, error: { code: gate.code } },
          { status: gate.status, headers: { 'cache-control': 'no-store' } },
        );
      }
      // JSON、ZIP、文件字节和 packages.put 都在这之后。
    },
  });
}
```

上面代码块是 `69c7366` 的记录，正文模式是 `buffered`。本 head 可运行的注册在 `packages/dsh-adapter/src/workbench-plugin.ts`：`requestBody: 'streaming'`，读正文前调用 `authorizeLegacyOwnerRoutes`，拒绝时返回空正文和对应状态码。它来自 #23（develop `843661c`），不是 `69c7366`；该提交仍不是本 head 的祖先。单独 cherry-pick `69c7366` 到还没有 `member-session.ts` 的树上，类型检查会找不到这个模块。

## 6. A 需要提供的挂载

本切片（#18）没有改 `workbench-plugin.ts`，也没有改 `scripts/workbench/build.mjs`。develop `843661c` 合入 #23 之后，宿主构建入口是 `packages/dsh-adapter/src/host-plugin.ts`。发行补丁是 `legacy-single-user`，没有 `identityBootstrapKey`，所以默认桌面和 Web 包仍不挂身份，也没有 `/zhuma-id`。`multi-member` 或配置了 `identityBootstrapKey` 时才会调用 `applyIdentity`。

A 在官方 Host 上已经具备 `connection`、`storageDomain`、`credentials`、`webServer` 时，需要：

1. `host-plugin.ts` 已经做了 `configureDeploymentMode`，再 `openWorkbench`（`LEGACY_OWNER_ROUTES` 和 `import-package` 在解析正文之前调用 `authorizeLegacyOwnerRoutes`），`multi-member` 或有 `identityBootstrapKey` 时再挂身份子插件并调用 `applyIdentity`。仍未装进这个入口的是 `applyExecution`（不传 `singleUser`，不注册 `bind-owner`）、`projectSpaces` 和成员界面。不要再打开名为 `zhuma_identity` 的 domain，也不要为了读工作台再打开 `zhuma_workbench`。
2. 宿主 esbuild 入口已经是 `packages/dsh-adapter/src/host-plugin.ts`，`multi-member` 或 `identityBootstrapKey` 会进到 `packages/dsh-adapter/src/identity-session.ts`。登录页、空间切换和成员入口仍见下一条。
3. 登录页、空间切换和成员入口仍由 A-SPACE 做。cookie 由 `Set-Cookie` 写入，页面不提交 actor。
4. 若要把 `registerPolicy` 写成对真实 `RemoteAccessService` 的类型检查，需要在宿主编译里合并 `PrincipalMap` 的 `zhuma-member`。运行时 `createPeer` 不依赖这次合并；本包用了断言，因为 `@deepseek-ai/dsh-typert-protocol` 不是直接依赖。

## 7. 到 ID0 退出还缺什么

FR16 的退出是：3 个账号、2 个团队、其中一人跨团队；两个独立会话走完提交、退回、重提、通过和下游待办；第三账号访问无权限的空间和文件被拒；刷新和后端重启后状态还在；切空间不串缓存、不搬私人内容、不触发模型。

这次已经有的是：3 个预置账号、2 个团队空间、各一条笔记、服务端 actor、读写拒绝、成员登出，以及在同一份介质上重开 domain 和 Connection。没有个人空间，没有跨团队成员，没有任务、文件字节、待办或评审，也没有真实 `dsh` 进程的重启。KV 重开不能代替进程重启。

剩下的工作是这些块，而不是再换一套身份模型：

- `applyIdentity` 已由 develop `843661c` 的 #23 接到 `host-plugin.ts`（`multi-member` 或 `identityBootstrapKey` 才挂）。真实服务上的前缀路由验证在 S1a 证据里，不关闭 FR16。成员 cookie 的 `Path` 已经是 `/`，执行入口可以收到它。`Secure` 仍是待办，留到 TLS 监听接上之后。
- 空间记录独立出来：每人一个个人空间，两个团队，其中一人同时属于两个团队。种子只在空库写入。
- 资源授权继续用“owner 或团队成员”，从一条笔记扩到任务和文件元数据。文件字节仍没有带访问控制的 DSH 存储，那是另一项。
- B-M1 的提交、退回、重提和下游待办改用这里的 `accountId`，不再接受请求体 actor。
- A-SPACE 的登录和空间切换，以及按账号/空间分开的客户端缓存。
- 一次真实 Host 进程的退出和再启动。DSH owner cookie 仍然没有产品级登出；产品登出只作废 `zhuma-member` 会话。

## 8. 给 dolibali 的问题

1. M+ 这种由 B 签发的成员 cookie，是否接受为 FR16 的登录，还是必须等 U，在 `admit` 里区分用户？
2. `decide` 对 owner 一律允许。空间隔离放在路由里、不单放在 `registerPolicy`，是否符合预期？
3. 无成员 cookie 即未登录。这已按 main `656bb61`（PR #15）实现，不再请 dolibali 决定：缺失、删除、过期、撤销或伪造的成员 cookie 都返回 401，不退回 DSH owner。多人导入不能再靠 `ownerAccountId` 把 owner 映射成 `lin`。宿主显式选定 `legacy-single-user`，并且恰好一个账号、`ownerAccountId` 指向该账号时，隔离的本机单人模式才做这层映射。
4. 生产路径已经不放默认账号。导入是调用方传入的 `{ id, passwordHash }`，且不覆盖已有账号。宿主是否就用这个导入作为种子入口？
5. `applyIdentity` 没有加进 `workbench-plugin.ts`。develop `843661c` 的 #23 把宿主构建入口改成 `host-plugin.ts`，由它在 `multi-member` 或 `identityBootstrapKey` 时调用 `applyIdentity`。B 的身份切片没有改 `workbench-plugin.ts`，也没有改 `scripts/workbench/build.mjs`。
