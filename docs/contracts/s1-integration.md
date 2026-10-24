# S1 模块签名

A-INTEGRATE-S1 按 `packages/dsh-adapter/src/s1-integration.ts` 接线。`tsc -b` 会编译这份清单。执行通道在本分支上与真实 `apply` 双向对齐。带类型的 `startPlan` 和界面组件由 A 在 #32 的 Client 接手；本层不加界面。身份实现是已合并的 `b/id0a-identity`（`c31f062`）。`packages/dsh-adapter/tsconfig.identity.json` 在本分支上就能编译。

## 加载顺序

`configureDeploymentMode(ctx, mode)` 的 `mode` 只能是 `'legacy-single-user'` 或 `'multi-member'`。`applyIdentity` 在打开身份库之前读取 `deploymentMode(ctx)`。模式还没选定时抛 `identity startup refused: deployment mode is not configured`，不会改去另一种模式，所以先选定模式。空间目录在身份之前装配，成员解析从一开始就枚举可信空间；目录消费方每次调用时才读取挂载，后装配也会生效，但未装配时成员没有任何空间。

1. `configureDeploymentMode(ctx, mode)`，`mode` 是 `'legacy-single-user' | 'multi-member'`
2. `await applySpaceDirectory(ctx, spaceImport?)`（#29 交付的可信目录；挂载无返回值，用 `spaceDirectoryFor(ctx)` 取句柄）
3. `await applyIdentity(ctx, imported?)`
4. `memberResolver(ctx)`
5. `await applyWorkbench(ctx)`
6. `await applyExecution(ctx, { readWorkbench, projectSpaces })`
7. `mount` 的签名留在清单里。本层不实现 `ExecutionWorkspace`，打开或刷新也不调用 `start-plan`。

```ts
configureDeploymentMode(ctx, mode);
await applySpaceDirectory(ctx, spaceImport);
await applyIdentity(ctx, imported);
const resolver = memberResolver(ctx);
await applyWorkbench(ctx);
await applyExecution(ctx, {
  readWorkbench: () => service.snapshot(),
  projectSpaces: spaceDirectoryFor(ctx),
});
```

`memberResolver(ctx)` 留在启动顺序里，供其他调用方使用。`resolver` 和 `resolveMember(ctx, request)` 是同一条规则，但不是 `applyExecution` 的字段，上面的例子不把它传给 `apply`。

`readWorkbench` 的类型是 `() => Workbench`。A 在宿主闭包里保住 `WorkbenchService`，传入 `() => service.snapshot()`。`snapshot()` 返回已存储工作台的结构化克隆。`workbench-plugin.ts` 仍把服务留在自己的 `apply` 里，这份清单只声明这个函数类型。

`S1ExecutionOptions` 就是 `ExecutionApplyOptions`：必填 `readWorkbench`，可选 `projectSpaces`。`S1Startup.applyExecution` 使用这一组参数。`packages/dsh-adapter/tests/types/s1-conformance.ts` 用双向约束把它们和真实 `apply` 的参数、`ExecutionPluginConfig` 对齐。键里没有 `memberResolver`。每次请求仍调用 `resolveMember`。`docs/contracts/b-id0a-identity.md` 的旧签名曾把可选 `memberResolver` 写进 `ExecutionApplyOptions`。那份说明不实现执行插件。执行参数以本文件和 `execution-plugin.ts` 的 `apply` 为准。

`projectSpaces` 由 A 在 Host 注入。正式的项目空间目录由 B 在 #29 交付，经 `applySpaceDirectory` 装配，句柄用 `spaceDirectoryFor(ctx)` 取出；A 只做这次注入，本层不另建事实源，也不实现 #29 的 provider。后栈 #66–#71 不是交付 #29 事实源的前提。省略 `projectSpaces` 时，执行入口拒绝所有项目。`spaceForProject(projectId)` 在有目录时返回该项目所属空间，或 `unknown` / `unavailable`。它必须接受任意合法 id（工作台 `WorkTaskSchema` 的 id：1 到 100 个字符，匹配 `/^[\w-]+$/u`）。不认识这个 id 时返回 `unknown`，不能抛错，也不能返回 `unavailable`。单人还是多人只看已经选定的 `deploymentMode`：`legacy-single-user` 或 `multi-member`。`identityAccessMode` 的声明类型仍包含 `unmounted`，以便和身份导出互认。运行时不根据解析器有没有装上推断这个值。模式没选定时它抛未配置错误，不表示可以跳过 `applyExecution`，也不表示旧入口可以放开。

带类型的 `startPlan` 由 A 在 #32 的 Client 接手。打开页面或刷新不调用 `start-plan`，只有明确点击才开始。本层注册 `/api/zhuma-exec/start-plan`，不加按钮，也不在 `apply` 里启动计划。

执行插件的 `inject` 是 `['connection', 'storageDomain']`。宿主把身份的 `connection`、`storageDomain`、`credentials`、`webServer`、`remoteAccess` 和工作台的 `llm`、`agentDefaultModel` 放在同一个插件上时，执行只用前两项。

## 通道 DTO

路径是 `/api/zhuma-exec/<endpoint>`，端点是 `start-plan`、`inbox`、`startable`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`、`inbox-counts`、`events`。先认成员，再读正文。没有成员会话是 HTTP 401，Host/Origin 不被信任是 HTTP 403。正文超过传输上限是 HTTP 413，5 秒内没有读完是 HTTP 408。传输上限是 2MiB：提交或投票说明最长 100000 个字符，草稿的说明、链接和文件字符串合计最长 262144 个字符；JSON 里一个字符最多写成 6 字节，262144 × 6 再加 RPC 信封仍放得进 2MiB。正文不是 JSON 时 HTTP 415。信封无法解析时 HTTP 400。业务成功和失败都是 HTTP 200，`result` 为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

`code` 在线上是字符串。`ExecutionMessageCode` 是服务写了文案的目录。`ExecutionPassthroughCode` 是纯函数原样穿过、使用兜底文案的代码，例如 `conflicting-ballot`。`ExecutionService` 的方法是 `startPlan`、`inbox`、`startable`、`inboxCounts`、`events`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`、`reconcile`。`inbox` 先按空间和 `planMembership` 留下仍是任务负责人或参与者的记录，再生成待办；节点视图只附在这些待办上。

清单里的 M1 组件类型是 `ExecutionWorkspace`、`InboxPanel`、`DeliveryPanel`、`ReviewWorkspace`。本层不实现、不导出这些组件，因此没有和组件实现做双向对齐。没有别的 M1 组件类型。带类型的 `startPlan` 不在这份适配层形状里，由 A 在 #32 的 Client 接手；打开或刷新不启动，只有明确点击才调用 `start-plan`。

## A 要接上的部分

- 账户导入的形状是 `{ accounts: [{ id, passwordHash }], ownerAccountId?, notes? }`。`passwordHash` 是 scrypt 校验值。
- 先 `configureDeploymentMode`，再 `applySpaceDirectory`，再 `applyIdentity`。`memberResolver(ctx)` 留给其他调用方，不传给 `applyExecution`。`applyExecution` 只接收 `{ readWorkbench, projectSpaces }`，`projectSpaces` 用同一次 `spaceDirectoryFor(ctx)` 句柄。省略 `projectSpaces` 时，执行入口拒绝所有项目。
- 客户端调用 `createExecutionApi(rpc)`。内部是 `rpc.call('/api', 'zhuma-exec/<endpoint>', payload)`。快捷入口调用 `inboxCounts({})` 或 `inboxCounts({ spaceId })`。成功值带可信 `actorId`、`deliver` / `review` / `confirm`；请求里有 `spaceId` 时一并回显，没有则不含该字段。空成功和回显不是授权证明。增量事件调用 `events({ taskId, planId, revision, nodeId, after, seenEventIds?, spaceId? })`。成功值带 `actorId`、节点定位和 `{ events }`；请求里有 `spaceId` 时一并回显。不带 `spaceId` 时只核对调用者是否持有该任务的空间，成功值不含 `spaceId`。
- 导航挂 `ExecutionWorkspace`。它自己挂 `InboxPanel`，并按待办动作打开 `DeliveryPanel` 或 `ReviewWorkspace`。
- 页面里已经有 `.zhuma > main.zm-page`。

通道注册在 `connection.fetch.register`，路径是 `/api/zhuma-exec/<endpoint>`。端点是 `start-plan`、`inbox`、`startable`、`submit`、`ballot`、`settle`、`report`、`revision`、`draft`、`inbox-counts`、`events`。成功和失败都是 `{ ok, value | error }`。`error` 为 `{ code, message, details }`，`code` 在线上是字符串。`ExecutionMessageCode` 是已经写好文案的目录。`conflicting-ballot` 这类纯函数代码会原样穿过，并使用兜底文案。

官方 `rpc.handle` 不携带请求头。精确 Fetch 路由保留 Fetch `Request` 的 `cookie` 和 `host`。Connection 仍只把 owner Peer 送进处理函数；成员只从 `resolveMember` 来。

## 遗留门

多人模式下，`b/id0a-legacy-gate`（`aa9060d`）关闭 `/api/zhuma/*`。A 提供成员进入工作台的入口。执行通道留在 `/api/zhuma-exec/*`。

## 编译检查

`packages/dsh-adapter/tests/types/s1-conformance.ts` 和 `packages/dsh-adapter/tests/types/s1-identity-conformance.ts` 含在根 `tsc -b` 里。本层没有 Client 一致性文件，也不加界面。

```sh
tsc -b --force
```
