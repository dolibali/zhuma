# 执行客户端接手切片

范围归属见 [#32](https://github.com/dolibali/zhuma/issues/32)，进度只更新原 Issue。

## 来源与边界

本切片从 [PR #60](https://github.com/dolibali/zhuma/pull/60) 的客户端层
`9a9f6f9c6679c56a111151c19ad860e6268b4433` 独立接手，基于 develop
`ad9131df0293069b299678fc36c06c616856ab83`；没有吸收累计业务层。
沿用其 API、待办、提交、评审、公开导出和类型契约，统一到现有浏览器契约入口。
原 PR 的独立截图脚本及旧图片保留在原分支，没有作为本切片的新界面证据。

评审隔离依据 [PR #70](https://github.com/dolibali/zhuma/pull/70) 已确认修复
`ff3f04127d892698445b222add7dc178ecb239e7` 的任务／计划／修订／节点／轮次边界改编，
同时加入同步重复点击门禁、请求取消、会话与卸载隔离、父选择回执保护。
没有合入该 PR 的领域、持久化或后续修订接口。

客户端只消费现有执行服务，不推算下一节点状态或授权身份。
`ExecutionApi.startPlan` 显式携带已确认计划的精确引用与请求标识；只有点击“开始执行”才调用。
挂载、刷新待办、切换选择都只读。`ExecutionError` 保留实际服务的 code、message、details，
不把业务失败包装成成功。网络未知结果重试复用同一请求标识；改变动作或正文重新生成。

当前可提交文字和 http/https 链接；评审绑定精确产物版本，提供通过、退回修改和仅评论。
文件字节传输、文件预览与行内批注尚未接入，不提供手填校验和冒充上传的表单。
表单仅有当前挂载生命周期的输入，没有暴露服务端草稿读写，因此不声称支持草稿恢复。
多版本待办缺少唯一定位时禁用操作，不用 taskId/nodeId 的首个匹配项猜测计划版本。

## 公开组合接口

`@zhuma/client` 导出 `createExecutionApi`、`ExecutionWorkspace`、`StartPlanPanel`、
`InboxPanel`、`DeliveryPanel`、`ReviewWorkspace`、`ExecutionError` 及相关 DTO。
包内复用 Button、Field 和官方主题令牌。

```tsx
<ExecutionWorkspace api={createExecutionApi(rpc)} plan={{ taskId, planId, revision, title }} />
```

调用方必须传稳定的 API 实例；`plan` 由已确认计划提供，选填，不从表单构造可信身份。
这仍是可组合客户端，并未安装正式 Host／导航入口或可信成员目录。
`packages/dsh-adapter/src/s1-integration.ts` 仅同步 A 负责的客户端类型快照；
服务 DTO、授权、存储与状态机没有更改。

## 可运行的界面契约入口

协调者可从仓库根目录运行：

```sh
node packages/client/tests/browser/server.mjs
```

打开 `http://127.0.0.1:8796/?execution-client=1`。
浅色和深色使用同一数据、1440×900 视口及系统配色，页面只消费官方主题属性。
也应检查 1280×800、1024px、200% 缩放、Tab 键导航、长正文和错误状态。
这是测试用 RPC 重放，不启动 Host、登录服务或模型，不写入真实任务。

- 默认：已确认计划、待交付工作、待评审工作、待修改工作；刷新不得开始执行。
- `&execution-form=review&strict=1`：查看本轮正文和链接，填写意见，切换任务／计划／修订／节点／轮次，验证意见不串项。
- `&execution-form=delivery&strict=1`：文字和链接提交，空内容与链接校验，切换计划后隔离旧回执。
- “卸载执行页／重新打开执行页”和“更换 API 会话”检查旧响应不能改动当前界面。

自动交互契约在 `packages/client/tests/browser/execution-client.spec.mjs`。
可按既有 CI 配置运行，或由协调者执行：

```sh
pnpm exec playwright test --config packages/client/tests/browser/playwright.config.mjs execution-client.spec.mjs
```

测试故意让旧 RPC 忽略 AbortSignal 再返回，覆盖迟到成功、业务失败、异常与 finally，
从而验证客户端自身的隔离，而非只依赖传输取消。
A 提供源代码、类型／Node 契约和打包结果；浏览器运行结果与本切片浅深截图另由协调者补充。
旧图片、静态渲染与 RPC 重放均不能认证真实成员的文字人工闭环或产品验收。
