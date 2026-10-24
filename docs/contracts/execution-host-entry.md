# 成员执行入口装配

工作项与实时进度见 [#32](https://github.com/dolibali/zhuma/issues/32)。
本切片接在 #73 的客户端之后，消费已合入的执行服务；正式成员／空间事实仍由 #29 提供。

## Host

正式发行入口仍为 `host-plugin.ts`，明确配置 `deploymentMode`。
先调用一次 `openWorkbench`，把同一个克隆读取闭包传给执行子作用域，不另开工作台领域。
`multi-member` 在身份子作用域之后装配执行服务及 `/api/zhuma-exec/*` 路由。
身份未就绪、失败或撤回时不能回落到 owner；缺少项目空间归属时执行服务保持拒绝。
旧工作台 owner 路由继续遵守原有早期门禁。默认发行补丁仍是 `legacy-single-user`，没有自动升级为多人部署。
服务已有的恢复逻辑照常运行；装配或打开界面不会派发新计划，也不调用模型。

可信目录生产者可以复用同一个正式装配：

```ts
import { createWorkbenchHost } from '@zhuma/dsh-adapter';
const host = createWorkbenchHost({ projectSpaces: trustedProvider });
await ctx.plugin(host, { deploymentMode: 'multi-member', identityBootstrapKey });
```

`trustedProvider` 必须实现现有 `ProjectSpaceDirectory.spaceForProject(projectId)`。
它是 Host 内的可信依赖，不从 JSON 配置、客户端参数、项目 ID 或预置映射推导。
默认 `apply` 没有该实例，因此项目相关执行请求关闭；不以 fixture 或内存 helper 填补正式目录。
Host 依赖属于子作用域，统一处理撤销和关闭，不增加第二套成员库、凭据库或授权机制。

## 客户端

官方 Client 插件注册“我的工作”导航，先经过既有 `MemberSessionBoundary`，验证成员后再读取执行待办。
该入口不读取旧 owner 工作台 API，不自动开始计划；登出、会话失效时卸载工作内容和当前输入。
原团队工作台及专家入口保持原有行为。

DSH SDK RPC 当前把 HTTP 失败变成没有结构状态的通用异常。
成员执行入口因此使用同源 Fetch，发送同一 RPC 信封、核对 rpcId，并保留 401／403 状态。
浏览器正常携带 DSH 连接凭据和 HttpOnly 成员 Cookie：前者是连接准入，后者才是成员身份。
401 使当前成员会话失效；403、目录拒绝和其他失败不能伪装成空成功结果。
取消或卸载后的旧 401 不得影响新会话。错误页不回显原始传输诊断。

## 仍缺少的正式依赖

B 的可信持久化目录生产者、成员空间授权事实及其受控生命周期尚未在本切片中提供。
这里只有现有 `spaceForProject` 消费端和正式 Host 的注入位置，不采纳未审的目录启动接口。
授权空间列表／空空间、成员／空间切换仍归 #29／#31；不推导替代事实。
本次导航接通成员待办，不把旧 owner 的已确认计划列表移交给成员端。
完整任务入口“选择已确认计划 → 显式开始”仍需成员授权后的任务／计划查询接缝；不通过放开旧 CRUD 实现。

因此本切片不是完整成员工作台或真实多人交付的完成声明，#32 的产品退出条件仍需后续接线和验收。

## 验证入口与证据边界

`pnpm check` 覆盖源码、类型、Node 契约；`pnpm test:host` 使用正式发出的 Host 产物、已发布的真实 DSH 服务、
临时私有凭据和存储，模型端口明确拒绝调用。
新增过程经过真实 owner API 保存定义，重启多人 Host；owner 单独访问执行路由被拒绝，缺目录时拒绝派发，
再显式注入私有测试目录验证文字链及三个领域各开一次。
私有测试目录只证明消费与装配契约，不认证生产目录、撤销事实或安装版桌面。

协调者的浏览器契约入口为 `node packages/client/tests/browser/server.mjs`，
打开 `http://127.0.0.1:8796/?member-execution&strict`；测试需要重放身份及执行 HTTP 响应。
定向交互见 `member-execution.spec.mjs`，验证登录前不读取执行、无旧 owner 回退、401 后移除输入及重新登录隔离。
A 只提供代码、类型、Node／真实服务和静态打包证据；额外浏览器操作、导航及同数据浅深截图由协调安排。
