# S1 模块签名

A-INTEGRATE-S1 按 `packages/dsh-adapter/src/s1-integration.ts` 接线。`tsc -b` 会编译这份清单。执行通道和界面组件在本分支上与真实导出双向对齐。身份签名按 `b/id0a-identity`（`f0eac0f`）书写。通道层已经合并这一提交，身份文件属于那条分支。`packages/dsh-adapter/tsconfig.identity.json` 在本分支上就能编译。

## 加载顺序

Cordis 的 `ctx.effect` 会立刻执行。`applyIdentity` 返回前，成员解析器已经装进宿主根上下文。执行插件在每次请求里自己调用 `resolveMember(ctx, { headers })`。

1. `await applyIdentity(ctx, imported?)`
2. `await applyWorkbench(ctx)`
3. `await applyExecution(ctx, { readWorkbench })`
4. 用 `createExecutionApi(rpc)` 挂上 `ExecutionWorkspace`

`readWorkbench` 的类型是 `() => Workbench`。A 在宿主闭包里保住 `WorkbenchService`，传入 `() => service.snapshot()`。`snapshot()` 返回已存储工作台的结构化克隆。`workbench-plugin.ts` 仍把服务留在自己的 `apply` 里，这份清单只声明这个函数类型。

`applyExecution` 只接受 `readWorkbench`。单人还是多人、当前成员是谁，只由 `identityAccessMode` 和 `resolveMember` 决定。单人模式是导入里写明的那一个 `ownerAccountId`。`'unmounted'` 表示解析器还没装上，这时不调用 `applyExecution`。

把三段 `inject` 合成宿主插件的依赖：身份需要 `connection`、`storageDomain`、`credentials`、`webServer`、`remoteAccess`；工作台再加 `llm`、`agentDefaultModel`；执行使用其中的 `connection` 和 `storageDomain`。

```ts
await applyIdentity(ctx, imported);
const mode = identityAccessMode(ctx);
await applyWorkbench(ctx);
if (mode !== 'unmounted') {
  await applyExecution(ctx, { readWorkbench: () => service.snapshot() });
}
```

## A 要接上的部分

- 账户导入的形状是 `{ accounts: [{ id, passwordHash }], ownerAccountId?, notes? }`。`passwordHash` 是 scrypt 校验值。
- 把 `readWorkbench` 传给 `applyExecution`。执行插件自己调用 `resolveMember`。
- 客户端调用 `createExecutionApi(rpc)`。内部是 `rpc.call('/api', 'zhuma-exec/<endpoint>', payload)`。
- 导航挂 `ExecutionWorkspace`。它自己挂 `InboxPanel`，并按待办动作打开 `DeliveryPanel` 或 `ReviewWorkspace`。
- 页面里已经有 `.zhuma > main.zm-page`。

通道注册在 `connection.fetch.register`，路径是 `/api/zhuma-exec/<endpoint>`。端点是 `start-plan`、`inbox`、`submit`、`ballot`、`settle`、`report`。成功和失败都是 `{ ok, value | error }`。`error` 为 `{ code, message, details }`，`code` 在线上是字符串。`ExecutionMessageCode` 是已经写好文案的目录。`conflicting-ballot` 这类纯函数代码会原样穿过，并使用兜底文案。

官方 `rpc.handle` 不携带请求头。精确 Fetch 路由保留 Fetch `Request` 的 `cookie` 和 `host`。Connection 仍只把 owner Peer 送进处理函数；成员只从 `resolveMember` 来。

## 遗留门

多人模式下，`b/id0a-legacy-gate`（`aa9060d`）关闭 `/api/zhuma/*`。A 提供成员进入工作台的入口。执行通道留在 `/api/zhuma-exec/*`。

## 编译检查

`packages/dsh-adapter/tests/types/s1-conformance.ts`、`packages/dsh-adapter/tests/types/s1-identity-conformance.ts` 和 `packages/client/tests/types/s1-conformance.ts` 含在根 `tsc -b` 里。

```sh
tsc -b --force
```
