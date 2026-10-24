# S1 模块签名

A-INTEGRATE-S1 按 `packages/dsh-adapter/src/s1-integration.ts` 接线。`tsc -b` 会编译这份清单。执行通道和界面组件在本累计 head 上与真实导出双向对齐。身份模块 #18 的 head 是 `b/id0a-identity` `eb25d30`。#18 已合入 develop（772b59c）。本 head 的身份代码经 `b/m1-align-identity` `20314eb` 带入，与 `eb25d30` 内容等价；另多 `packages/dsh-adapter/tsconfig.identity.json` 与 `packages/dsh-adapter/tests/identity-session.test.mjs` 的小增量。`c31f062` 是更早的身份提交。不要用旧的 `b/s1-signatures@5d6eafa` 推断执行插件尚未实现。`packages/dsh-adapter/tsconfig.identity.json` 在本 head 上就能编译。

## 加载顺序

`configureDeploymentMode(ctx, mode)` 的 `mode` 只能是 `'legacy-single-user'` 或 `'multi-member'`。`applyIdentity` 在打开身份库之前读取 `deploymentMode(ctx)`。模式还没选定时抛 `identity startup refused: deployment mode is not configured`，不会改去另一种模式，所以先选定模式。

1. `configureDeploymentMode(ctx, mode)`，`mode` 是 `'legacy-single-user' | 'multi-member'`
2. `await applyIdentity(ctx, imported?)`
3. `memberResolver(ctx)`
4. `await applyWorkbench(ctx)`
5. `await applyExecution(ctx, { memberResolver, readWorkbench, projectSpaces })`
6. `mount({ api: createExecutionApi(rpc) })`，把 `ExecutionWorkspace` 挂进页面

```ts
configureDeploymentMode(ctx, mode);
await applyIdentity(ctx, imported);
const resolver = memberResolver(ctx);
await applyWorkbench(ctx);
const executionOptions = {
  memberResolver: resolver,
  readWorkbench: () => service.snapshot(),
  projectSpaces,
};
await applyExecution(ctx, executionOptions);
mount({ api: createExecutionApi(rpc) });
```

`readWorkbench` 的类型是 `() => Workbench`。A 在宿主闭包里保住 `WorkbenchService`，传入 `() => service.snapshot()`。`snapshot()` 返回已存储工作台的结构化克隆。`workbench-plugin.ts` 仍把服务留在自己的 `apply` 里，这份清单只声明这个函数类型。

插件参数 `ExecutionApplyOptions` 是 `readWorkbench`，以及可选的 `projectSpaces`。上面的 `executionOptions` 还带上 `memberResolver`，这个对象可以传给现在的 `apply`。每次请求仍调用 `resolveMember`，它和 `memberResolver(ctx).resolve` 是同一条规则。`projectSpaces` 由 A 在 Host 装配时注入。这是 Host 的注入、导航、导出和公共配置，不是把 B-ID0 的身份或空间授权事实交给 A 重建。B 提供可信身份、空间授权事实，以及执行服务消费该目录的接口。省略它时，执行入口拒绝所有项目。`spaceForProject(projectId)` 在有目录时返回该项目所属空间，或 `unknown` / `unavailable`。它必须接受任意合法 id（工作台 `WorkTaskSchema` 的 id：1 到 100 个字符，匹配 `/^[\w-]+$/u`）。不认识这个 id 时返回 `unknown`，不能抛错，也不能返回 `unavailable`。单人还是多人只看已经选定的 `deploymentMode`：`legacy-single-user` 或 `multi-member`。`identityAccessMode` 的声明类型仍包含 `unmounted`，以便和身份导出互认。运行时不根据解析器有没有装上推断这个值。模式没选定时它抛未配置错误，不表示可以跳过 `applyExecution`，也不表示旧入口可以放开。

执行插件的 `inject` 是 `['connection', 'storageDomain']`。宿主把身份的 `connection`、`storageDomain`、`credentials`、`webServer`、`remoteAccess` 和工作台的 `llm`、`agentDefaultModel` 放在同一个插件上时，执行只用前两项。

## 通道 DTO

路径是 `/api/zhuma-exec/<endpoint>`，端点是 `start-plan`、`inbox`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`、`inbox-counts`、`events`。先认成员，再读正文。没有成员会话是 HTTP 401，Host/Origin 不被信任是 HTTP 403。正文超过传输上限是 HTTP 413，5 秒内没有读完是 HTTP 408。传输上限是 2MiB：提交或投票说明最长 100000 个字符，草稿的说明、链接和文件字符串合计最长 262144 个字符；JSON 里一个字符最多写成 6 字节，262144 × 6 再加 RPC 信封仍放得进 2MiB。正文不是 JSON 时 HTTP 415。信封无法解析时 HTTP 400。业务成功和失败都是 HTTP 200，`result` 为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

`code` 在线上是字符串。`ExecutionMessageCode` 是服务写了文案的目录。`ExecutionPassthroughCode` 是纯函数原样穿过、使用兜底文案的代码，例如 `conflicting-ballot`。`ExecutionService` 的方法是 `startPlan`、`inbox`、`inboxCounts`、`events`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`、`reconcile`。`inbox` 先按空间和 `planMembership` 留下仍是任务负责人或参与者的记录，再生成待办；节点视图只附在这些待办上。

导出的 M1 组件是 `ExecutionWorkspace`、`InboxPanel`、`DeliveryPanel`、`ReviewWorkspace`。它们的 props 在清单里，并和组件双向对齐。没有别的 M1 组件导出。

## A 要接上的部分

- 账户导入的形状是 `{ accounts: [{ id, passwordHash }], ownerAccountId?, notes? }`。`passwordHash` 是 scrypt 校验值。
- 宿主入口已经做了 `configureDeploymentMode` 和 `openWorkbench`，并在 `multi-member` 或 `identityBootstrapKey` 时调用 `applyIdentity`。仍要接上的是 `memberResolver(ctx)`，再把 `{ memberResolver, readWorkbench, projectSpaces }` 传给 `applyExecution`。执行插件自己调用 `resolveMember`。省略 `projectSpaces` 时，执行入口拒绝所有项目。
- 客户端调用 `createExecutionApi(rpc)`。内部是 `rpc.call('/api', 'zhuma-exec/<endpoint>', payload)`。快捷入口调用 `inboxCounts()`，正文 `{}`，成功值是 `{ deliver, review, confirm }`。增量事件调用 `events({ taskId, planId, revision, nodeId, after, seenEventIds? })`，成功值是 `{ events }`。
- 导航挂 `ExecutionWorkspace`。它自己挂 `InboxPanel`，并按待办动作打开 `DeliveryPanel` 或 `ReviewWorkspace`。
- 页面里已经有 `.zhuma > main.zm-page`。

通道注册在 `connection.fetch.register`，路径是 `/api/zhuma-exec/<endpoint>`。端点是 `start-plan`、`inbox`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`、`inbox-counts`、`events`。成功和失败都是 `{ ok, value | error }`。`error` 为 `{ code, message, details }`，`code` 在线上是字符串。`ExecutionMessageCode` 是已经写好文案的目录。`conflicting-ballot` 这类纯函数代码会原样穿过，并使用兜底文案。

官方 `rpc.handle` 不携带请求头。精确 Fetch 路由保留 Fetch `Request` 的 `cookie` 和 `host`。Connection 仍只把 owner Peer 送进处理函数；成员只从 `resolveMember` 来。

## 遗留门

本 head 注册 `/api/zhuma/*` 时，在读取正文之前调用 `authorizeLegacyOwnerRoutes`。接线来自已合入 develop `843661c` 的 #23，不是 `b/id0a-legacy-gate` `69c7366`（该提交仍不是本 head 的祖先）。宿主构建入口是 `host-plugin.ts`。发行补丁是 `legacy-single-user`。`multi-member` 在读正文前关闭这些路由并挂身份子插件；默认桌面不挂多人模式，也没有成员进入工作台的入口。`applyExecution` 和 `projectSpaces` 仍未装进这个入口。执行通道留在 `/api/zhuma-exec/*`。

## 编译检查

`packages/dsh-adapter/tests/types/s1-conformance.ts`、`packages/dsh-adapter/tests/types/s1-identity-conformance.ts` 和 `packages/client/tests/types/s1-conformance.ts` 含在根 `tsc -b` 里。

```sh
tsc -b --force
```
