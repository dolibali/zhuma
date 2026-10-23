# S1 模块签名

A-INTEGRATE-S1 按 `packages/dsh-adapter/src/s1-integration.ts` 接线。`tsc -b` 会编译这份清单。执行通道和界面组件在本分支上与真实导出双向对齐。身份签名按 `b/id0a-identity`（`f0eac0f`）书写，在合并工作区里用 `packages/dsh-adapter/tsconfig.identity.json` 再查一次。那条分支留在原处。

## 加载顺序

Cordis 的 `ctx.effect` 会立刻执行。`applyIdentity` 返回前，成员解析器已经装进宿主根上下文。`memberResolver(ctx)` 只记住这个上下文；每次 `/zhuma-exec` 调用 `resolve()` 时再读取已安装的来源。

1. `await applyIdentity(ctx, imported?)`
2. `const resolver = memberResolver(ctx)`，并用 `identityAccessMode(ctx)` 看模式
3. `await applyWorkbench(ctx)`
4. `await applyExecution(ctx, { memberResolver: resolver, readWorkbench, singleUser? })`
5. 用 `createExecutionApi(rpc)` 挂上 `ExecutionWorkspace`

`readWorkbench` 的类型是 `() => Workbench`。A 在宿主闭包里保住 `WorkbenchService`，传入 `() => service.snapshot()`。`snapshot()` 返回已存储工作台的结构化克隆。`workbench-plugin.ts` 仍把服务留在自己的 `apply` 里，这份清单只声明这个函数类型。

执行选项里的解析器字段是 `memberResolver`。`identityAccessMode(ctx) === 'single-user'` 时再传 `singleUser: true`。`'multi-member'` 省略 `singleUser`，执行服务默认就是多人。`'unmounted'` 表示解析器还没装上，这时不调用 `applyExecution`。

把三段 `inject` 合成宿主插件的依赖：身份需要 `connection`、`storageDomain`、`credentials`、`webServer`、`remoteAccess`；工作台再加 `llm`、`agentDefaultModel`；执行使用其中的 `connection` 和 `storageDomain`。

```ts
await applyIdentity(ctx, imported);
const resolver = memberResolver(ctx);
const mode = identityAccessMode(ctx);
await applyWorkbench(ctx);
if (mode !== 'unmounted') {
  await applyExecution(ctx, {
    memberResolver: resolver,
    readWorkbench: () => service.snapshot(),
    ...(mode === 'single-user' ? { singleUser: true } : {}),
  });
}
```

## A 要接上的部分

- 账户导入的形状是 `{ accounts: [{ id, passwordHash }], ownerAccountId?, notes? }`。`passwordHash` 是 scrypt 校验值。
- 把 `memberResolver(ctx)` 和 `readWorkbench` 传给 `applyExecution`。
- 客户端调用 `createExecutionApi(rpc)`。内部是 `rpc.call('/zhuma-exec', endpoint, payload)`。
- 导航挂 `ExecutionWorkspace`。它自己挂 `InboxPanel`，并按待办动作打开 `DeliveryPanel` 或 `ReviewWorkspace`。
- 页面里已经有 `.zhuma > main.zm-page`。

通道端点是 `bind-owner`、`start-plan`、`inbox`、`submit`、`ballot`、`settle`、`report`。成功和失败都是 `{ ok, value | error }`。`error` 为 `{ code, message, details }`，`code` 在线上是字符串。`ExecutionMessageCode` 是已经写好文案的目录。`conflicting-ballot` 这类纯函数代码会原样穿过，并使用兜底文案。

官方 `ConnectionRpcHandler` 的 Peer 没有请求头。没有 `peer.request.headers` 时，通道返回 `unauthenticated`，不回退到 owner。头从 Fetch `Request` 到这次调用的传法见 `docs/contracts/b-m1-human-node.md`。

## 遗留门

T3 的多人遗留门在 `b/id0a-legacy-gate`（`aa9060d`，关闭多人模式下的旧工作台路由）。A 审查那条分支后接入。

## 编译检查

`packages/dsh-adapter/tests/types/s1-conformance.ts` 和 `packages/client/tests/types/s1-conformance.ts` 含在根 `tsc -b` 里。身份检查文件是 `packages/dsh-adapter/tests/types/s1-identity-conformance.ts`。它引用的 `member-session.ts` 在 `b/id0a-identity` 上，所以 `tsconfig.identity.json` 不进根项目引用。把那条分支合并进临时工作区后执行：

```sh
tsc -b packages/dsh-adapter/tsconfig.identity.json --force
```
