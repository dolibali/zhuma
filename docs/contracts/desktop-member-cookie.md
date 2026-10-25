# 桌面成员会话运输接缝（#31）

基线为 `runtime.lock.json` 的 DSH `687f282e8625c6b8d11ff58211a90524be2e4317`。固定 `apps/desktop/src/web-document.ts` 使用 Node fetch，删除来路 Cookie、加入壳私有 owner 凭据，并过滤所有 Set-Cookie；成员登录因而无法接续读取。协调已以原函数和实际 Host 对照定位，原生 GUI 仍需另验。本契约只扩展该运输接缝，不改 B 的身份、空间、业务存储或授权。

## 选择与拥有权

采用 `packages/dsh-adapter/src/desktop-member-cookie.ts` 的单槽、壳内内存载体。现有 desktop prepare 将独立文件复制到临时构建树，现有发行补丁仅在原 `web-document.ts` 接入；固定子模块不修改，无新进程、IPC、身份库或登录 UI。Host 仍逐次校验签名、会话行、成员及空间；载体保存不透明凭据，不保存身份或授权结果。

另一可行方向是 Electron Session Cookie jar。[Cookies API](https://www.electronjs.org/docs/latest/api/cookies) 支持 Session 级查询／修改，[protocol API](https://www.electronjs.org/docs/latest/api/protocol) 说明协议注册也属于 Session。当前转发器并未使用该 jar；引入它还需解决自定义源与回环 Host 的存储映射、端口变更和持久清理。本切片没有 remember-me 需求，因此接受整进程重启重新登录，选择不落盘的载体；不声称标准 jar 不可实现或已有跨平台实测。

运输状态只有 owned Host origin、壳私有 owner 标识、一个最多4096字符的成员值／截止时间，以及递增代次。没有队列、定时器、文件写入、自动重试、第二套凭据签发或请求体缓存。owner 是执行接口 Connection 的运输准入，成员 Cookie 是业务身份；两者同时需要。没有成员载体时，除 POST 登录外的精确产品路由本地返回401，绝不以 owner 单独派发产品操作，即使 Host 被配置成 legacy 模式。非产品转发保持原 owner 行为。

## 请求与响应合同

沿用原 `forwardWebRequest(Request, host, ownerCookie): Promise<Response>`；不增加 renderer API。原 Request 的 method、路径／query、headers、body stream、signal 输入，原 Response 的 status、statusText、headers、body stream 输出。Cookie 以外的业务 DTO、授权、错误和幂等键保持原身份／Execution 契约，运输层不解释业务 JSON。身份请求体仍受 Host 64KiB 限制，执行请求仍受2MiB／5秒读取限制；Client 原10秒 deadline及取消信号继续传给原 fetch，无额外重放。已到 Host 的命令可能完成，取消或丢弃响应不等于取消业务提交。

所有操作先校验 source 为 `dsh-app://app`，Origin 只能缺省或精确该源；拒绝 `null`、跨源和 `sec-fetch-site: cross-site`，在任何绑定／清理前返回403。owned target 只允许无用户信息的回环 HTTP(S)。来路全部 Cookie 忽略；仅使用主进程持有的 owner，加上载体中、且路径精确匹配的指定成员 Cookie。所有 Set-Cookie 始终剥离；产品响应强制 no-store。以下17个网络操作是本接缝的完整产品集合：

| 操作       | method／路径及原业务输入                                                | 运输响应／状态变更                                             |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| 登录       | POST `/zhuma-id/login`，accountId、password                             | 先清旧载体；只在200且指定 Set-Cookie 合规时保存；格式不合规502 |
| 退出       | POST `/zhuma-id/logout`，原空JSON                                       | 捕获旧令牌用于 Host 撤销，然后立即清本地；失败也不恢复         |
| 会话读取   | GET `/zhuma-id/session`，无新增输入                                     | 仅附带当前成员；Host401清载体，403不清                         |
| 空间读取   | GET `/zhuma-id/spaces/{id}`                                             | id须为1–64位小写字母／数字／短横线；同上                       |
| 产物读取   | GET `/zhuma-id/notes/{id}`                                              | 同一id规则；同上                                               |
| 产物更新   | PUT `/zhuma-id/notes/{id}`，原text                                      | 同一id规则；原业务权限／提交不变                               |
| 开始计划   | POST `/api/zhuma-exec/start-plan`，原channel envelope／StartPlanRequest | 原返回／幂等语义；401清载体                                    |
| 待办       | POST `/api/zhuma-exec/inbox`，原channel envelope／scope                 | 原返回／scope回显；401清载体                                   |
| 可开始计划 | POST `/api/zhuma-exec/startable`，原channel envelope／scope             | 原返回／scope回显；401清载体                                   |
| 提交       | POST `/api/zhuma-exec/submit`，原channel envelope／SubmitRequest        | 原节点版本／幂等语义；401清载体                                |
| 评审       | POST `/api/zhuma-exec/ballot`，原channel envelope／BallotRequest        | 原评审轮次／幂等语义；401清载体                                |
| 结算       | POST `/api/zhuma-exec/settle`，原channel envelope／节点请求             | 原业务语义；401清载体                                          |
| 报告       | POST `/api/zhuma-exec/report`，原channel envelope／计划引用             | 原只读返回；401清载体                                          |
| 修订读取   | POST `/api/zhuma-exec/revision`，原channel envelope／计划引用           | 原只读返回；401清载体                                          |
| 交付草稿   | POST `/api/zhuma-exec/draft`，原channel envelope／节点草稿读写          | 原版本与未完成文件标记；401清载体                              |
| 待办计数   | POST `/api/zhuma-exec/inbox-counts`，原channel envelope／可选 scope     | 分组计数，带回 actorId 与请求 scope；401清载体                 |
| 执行事件   | POST `/api/zhuma-exec/events`，原channel envelope／游标与可选 scope     | 游标之后的事件，带回成员、scope 与节点引用；401清载体          |

现有 Host 的其它 method 仍由 Host 拒绝；未知 endpoint、额外路径段、编码斜线、普通插件／owner API 不携带成员值。没有新增 WebSocket 成员协议；官方 owner WebSocket 路径保持原实现。上表与实现路径集合为身份6操作加执行11操作，无新增／漏列操作；内部 `forward` callback 和 `clear` 只在主进程内调用，不是新的跨进程接口。

只接受登录响应中唯一的 `zhuma-member`，值为1–4096位当前格式的 ASCII token；属性恰为 `Max-Age`（1–43200秒）、`Path=/`、`HttpOnly`、`SameSite=Strict`，重复／额外／缺失属性及重复成员 Cookie 均拒绝。该格式是当前 Host 的窄运输合同，不是通用 Set-Cookie parser。其它 Cookie 不保存、不下发。TTL 到期清理；401清理；空间403或业务404不清全局身份。

## 顺序、恢复与敏感数据

新登录、退出、Host认证重启先递增代次并清令牌；Host origin或owner改变也清。所有在途产品响应只对捕获的当前代次生效；旧登录200不能覆盖新成员，旧401／退出回执不能清新成员。过期或旧代次响应丢弃并返回401；已取消请求不复活令牌。网络错误无自动重试；登录／退出此前已清，普通读取运输失败不会变成新的授权事实。

同一 owned Host 的窗口重载保留主进程内载体，UI仍重新读取可信 session；整个 App 进程重开或 Host 换代丢弃令牌，正常回登录。重新登录后业务数据和历史仍由既有 Host 持久存储恢复，不清空业务库、不删除原业务重启测试；此处不宣称免登录重开或已完成真实重启持久化验收。

owner和成员值只准存在可信主进程内存及发往 owned Host 的请求头；禁止进入 renderer cookie jar／DOM／UI状态／IPC、普通文件、日志、错误文本和遥测。Client只收到现有公开DTO。Host业务错误仍原样通过其已有收窄；本接缝不新增凭据输出。原生主题、缩放、操作系统差异和安装包仍独立验收。

## 验证与回退

准备与接线验证命令为 `pnpm build`、`pnpm desktop:prepare`、`pnpm desktop:verify:member`。最后一项从已准备的官方转发模块构建临时产物，并令同一HTTP用例调用实际 `authenticateWebHost`／`forwardWebRequest`，打印固定pin、补丁／helper／转发源码／产物摘要；不启动Electron。普通check的该用例直接测自研helper，两种证据分别记录。已有自有构建树发生配方／helper变化时，准备脚本拒绝覆盖，先检查再由维护者按原流程处理。

`desktop-member-cookie.test.mjs` 覆盖路径／来源／载体更换、格式预算、TTL、401／403、退出失败、迟到登录／401／退出、Abort、流式响应和重建。另以真实 Connection／身份／执行服务经 Node HTTP 控制登录、读取、明确开始、退出、Host撤销及运输重建后重新登录；其凭据／KV／access port是内存夹具，不是完整原生或持久化证明。补丁必须在临时构建树应用并编译验证接线；额外实际 Electron 表单／侧栏／空间／退出／失效／重开及浅深图由协调完成，不运行 A 浏览器。

失败门：任何 owner／Set-Cookie 外泄、来源拒绝前状态变化、任意Cookie透传、旧回执恢复身份或补丁无法应用，均停止原生交付。回退只撤发行补丁接线及复制步骤，重新准备干净的自有构建树；不改固定上游、Host身份资料和业务历史，也不降级到 owner 作为成员。实时状态继续只在原Issue31／PR86维护。
