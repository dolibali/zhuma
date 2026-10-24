# S1 模块签名

A-INTEGRATE-S1 按 `packages/dsh-adapter/src/s1-integration.ts` 接线。`tsc -b` 会编译这份清单。执行通道和界面组件在本分支上与真实导出双向对齐。身份实现是已合并的 `b/id0a-identity`（`c31f062`）。`packages/dsh-adapter/tsconfig.identity.json` 在本分支上就能编译。

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

插件参数 `ExecutionApplyOptions` 是 `readWorkbench`，以及可选的 `projectSpaces`。上面的 `executionOptions` 还带上 `memberResolver`，这个对象可以传给现在的 `apply`。每次请求仍调用 `resolveMember`，它和 `memberResolver(ctx).resolve` 是同一条规则。`projectSpaces` 的正式内容由 A 的 Host／空间模块注入。省略它时，执行入口拒绝所有项目。`spaceForProject(projectId)` 在有目录时返回该项目所属空间，或 `unknown` / `unavailable`。它必须接受任意合法 id（工作台 `WorkTaskSchema` 的 id：1 到 100 个字符，匹配 `/^[\w-]+$/u`）。不认识这个 id 时返回 `unknown`，不能抛错，也不能返回 `unavailable`。单人还是多人只看已经选定的 `deploymentMode`：`legacy-single-user` 或 `multi-member`。`identityAccessMode` 的声明类型仍包含 `unmounted`，以便和身份导出互认。运行时不根据解析器有没有装上推断这个值。模式没选定时它抛未配置错误，不表示可以跳过 `applyExecution`，也不表示旧入口可以放开。

执行插件的 `inject` 是 `['connection', 'storageDomain']`。宿主把身份的 `connection`、`storageDomain`、`credentials`、`webServer`、`remoteAccess` 和工作台的 `llm`、`agentDefaultModel` 放在同一个插件上时，执行只用前两项。

## 通道 DTO

路径是 `/api/zhuma-exec/<endpoint>`，端点是 `start-plan`、`inbox`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`。先 `resolveMember`，再读正文。未登录是 HTTP 401，不可信请求是 HTTP 403，这两种都不解析 JSON。正文不是 JSON 时 HTTP 415。信封无法解析时 HTTP 400。声明长度或实际读数超过 2MiB 是 HTTP 413，5 秒内没有读完是 HTTP 408。业务成功和失败都是 HTTP 200，`result` 为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

`code` 在线上是字符串。`ExecutionMessageCode` 是服务写了文案的目录。`ExecutionPassthroughCode` 是纯函数原样穿过、使用兜底文案的代码，例如 `conflicting-ballot`。`ExecutionService` 的方法是 `startPlan`、`inbox`、`submit`、`ballot`、`settle`、`report`、`reconcile`。`inbox` 先按空间和 `planMembership` 留下仍是任务负责人或参与者的记录，再生成待办；节点视图只附在这些待办上。

导出的 M1 组件是 `ExecutionWorkspace`、`InboxPanel`、`DeliveryPanel`、`ReviewWorkspace`。它们的 props 在清单里，并和组件双向对齐。没有别的 M1 组件导出。

## A 要接上的部分

- 账户导入的形状是 `{ accounts: [{ id, passwordHash }], ownerAccountId?, notes? }`。`passwordHash` 是 scrypt 校验值。
- 先 `configureDeploymentMode`，再 `applyIdentity`，然后 `memberResolver(ctx)`，再把 `{ memberResolver, readWorkbench, projectSpaces }` 传给 `applyExecution`。执行插件自己调用 `resolveMember`。省略 `projectSpaces` 时，执行入口拒绝所有项目。
- 客户端调用 `createExecutionApi(rpc)`。内部是 `rpc.call('/api', 'zhuma-exec/<endpoint>', payload)`。
- 导航挂 `ExecutionWorkspace`。它自己挂 `InboxPanel`，并按待办动作打开 `DeliveryPanel` 或 `ReviewWorkspace`。
- 页面里已经有 `.zhuma > main.zm-page`。

通道注册在 `connection.fetch.register`，路径是 `/api/zhuma-exec/<endpoint>`。端点是 `start-plan`、`inbox`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`。成功和失败都是 `{ ok, value | error }`。`error` 为 `{ code, message, details }`，`code` 在线上是字符串。`ExecutionMessageCode` 是已经写好文案的目录。`conflicting-ballot` 这类纯函数代码会原样穿过，并使用兜底文案。

官方 `rpc.handle` 不携带请求头。精确 Fetch 路由保留 Fetch `Request` 的 `cookie` 和 `host`。Connection 仍只把 owner Peer 送进处理函数；成员只从 `resolveMember` 来。

## 遗留门

多人模式下，`b/id0a-legacy-gate`（`aa9060d`）关闭 `/api/zhuma/*`。A 提供成员进入工作台的入口。执行通道留在 `/api/zhuma-exec/*`。

## 编译检查

`packages/dsh-adapter/tests/types/s1-conformance.ts`、`packages/dsh-adapter/tests/types/s1-identity-conformance.ts` 和 `packages/client/tests/types/s1-conformance.ts` 含在根 `tsc -b` 里。

```sh
tsc -b --force
```
