# 成员登录客户端切片

范围与验收入口：[A-SPACE #31](https://github.com/dolibali/zhuma/issues/31)，交付规则见 [#25](https://github.com/dolibali/zhuma/issues/25)。本文描述客户端契约和接线边界，实时进度由 Issue 维护。

## 范围

在 develop `b6fe7c4add9af1e8bdd783ba9fe9cf63fa3704ed` 上增加可组合的成员登录客户端，不合入待审 Host 代码，不改变现有 owner 入口。UI 复用工作台的 Button、Field、系统字体和共享浅深主题；紧凑单列表单包含账号、密码、显示密码和登录，当前账号栏提供退出。

登录、登出、会话恢复及错误响应依据 #18 的 `eb25d30eae5d7758588c409b5c166808d9bb3068`：

| 请求                    | 请求体                    | 本片读取的成功响应                                                               |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `POST /zhuma-id/login`  | `{ accountId, password }` | `{ ok: true, accountId }`                                                        |
| `GET /zhuma-id/session` | 无                        | `{ ok: true, accountId, principal: { kind: 'zhuma-member', memberId }, peerId }` |
| `POST /zhuma-id/logout` | `{}`                      | `{ ok: true, accountId }`                                                        |

M1 累计候选 `e4d5dc94a3356cfc0e02bc0e78ca852660835170` 的身份模块与该 #18 版本无差异。这里是源码契约依据，不代表 M1 累计候选已进入 develop。#18 已合入 develop（772b59c）。这也不是成员会话的运行证明。

传输只使用固定的同源成员路由、同源 cookie 和 `no-store`；不调用 owner RPC、不把账号当 actor、不读取或存储 cookie/token。密码在输入阶段使用 LoginForm 的 React 局部状态，提交时清空，不进入会话控制器、持久存储或日志。请求限定 10 秒，支持调用者取消。错误只向界面显示固定文案，不回显响应正文或网络细节；401、429、403、服务不可用与损坏响应分别处理，没有自行推断重试倒计时。

## 组件接线

公开入口为 `@zhuma/client` 的 `createIdentityApi`、`MemberSessionBoundary`、`MemberSessionView` 和相应类型。组件样式由现有工作台插件安装一次；组件本身不安装样式、不切换主题。独立宿主必须加载同一份 `workbench.css`，不能复制一套主题。

```tsx
import { createIdentityApi, MemberSessionBoundary } from '@zhuma/client';

// 在组件外创建稳定实例；不要每次 render 创建新的 api。
const identityApi = createIdentityApi();

<MemberSessionBoundary api={identityApi}>
  {(session, onUnauthenticated) => (
    // 此处仅示意组合位置；正式空间/工作台入口另按 #29/#32 接入。
    <div>当前账号：{session.accountId}</div>
  )}
</MemberSessionBoundary>;
```

- Host 的成员模式、路由与失败关闭门禁就绪后才挂此组件；本片不改 `workbench-plugin`、client 插件注册或发行配置，也不绕过 #27→#28 的身份装配顺序。
- 挂载只恢复会话，不触发模型、规划、节点执行或工作台读取。只有通过服务端会话校验后才渲染 children；owner principal 不作为成员登录。
- 登录回执不足以打开内容：随后读取 session，并要求提交账号、登录回执和会话账号一致，principal 的 memberId 也须匹配。无权响应不能用本地成员选择器修复。
- 正式受保护的客户端请求收到成员 401 时调用 `onUnauthenticated`。回调绑定当前账号代次，旧账号请求的迟到 401 不会清除新账号。下游请求也须在自身卸载时取消，不能跨账号复用数据缓存。
- 退出开始时移除当前账号内容；网络失败显示“尚未完成退出”，只能重试退出，不能按成功继续使用内容。退出返回 401 表示服务端已无有效成员会话，可返回登录表单。
- 卸载/API 实例替换会取消请求并丢弃迟到结果。下一次挂载重新查服务端会话；兼容 React StrictMode 的效果清理与重启。Abort 不能承诺回滚已由服务端处理的登录/退出，重开时以真实会话为准。

## 界面契约入口与验证

在仓库根目录执行 `pnpm build` 后运行：

```sh
node packages/client/tests/browser/server.mjs
```

由协调者打开 `http://127.0.0.1:8796/?member-login&strict`，使用既有测试框架拦截成员 HTTP 响应；可执行用例为 `packages/client/tests/browser/member-login.spec.mjs`。入口复用原有 harness 的主题和 StrictMode，不提供账号导入、会话签发或空间目录。未拦截时该静态服务器返回 404，界面进入服务不可用状态。该入口不进入产品 Bundle。

本片的 Node 契约测试覆盖同源传输、响应窄化、错误映射、取消/超时、重复提交、账号变化、退出失败重试、卸载/重启的迟到响应、旧代次 401 及组件静态输出。新增界面用例覆盖键盘提交、密码显示/清空、429、退出失败、切账号后的内容重置、会话失效和 owner 拒绝。实现 `bb08789b65cb2d5dd61d6b2ec2f8284b344218d4` 的协调独立检查与浅深截图已收录到[界面证据索引](review/member-login/README.md)，CI 的 Node 214/214、界面契约 104/104 通过；不把测试定义或静态输出写成运行或视觉验收。

这些是客户端契约证据。尚需正式 Host 上验证真实 cookie、过期/撤销、重启恢复、同数据浅深外观、键盘焦点和布局；不得据此宣称 #31 的三账号/两团队验收完成。

## 后续依赖

- #27/#28：已审身份模块与正式 Host 装配。不得为预览提前吸收未审候选。
- #29：B 提供当前成员的可信空间目录（含空个人/团队空间）、项目归属和撤销/重启规则；A 消费接口实现空间选择，不从便笺或 projectId 推断空间。
- #32：显式节点启动、正式受保护工作台/执行业务导航。普通打开、恢复和刷新不启动工作。

空间选择、成员管理、授权工作台数据以及上述产品退出条件均不在本片实现中。它们仍保留在原工作项，PR 使用 `Refs #31`。
