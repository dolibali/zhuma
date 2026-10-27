# 成员执行入口装配

工作项与实时进度见 [#32](https://github.com/dolibali/zhuma/issues/32)。
本切片消费已合入的执行服务与可信持久化空间目录；成员任务／已确认计划的权威发现及空间约束由执行服务提供。

## Host 与可信初始化来源

正式发行入口为 `host-plugin.ts`，明确配置 `deploymentMode`。
先调用一次 `openWorkbench` 注册旧 owner 路由的早期门禁，再依次装配目录、身份和执行子作用域。
执行端只复用同一克隆读取闭包，不再打开另一份工作台领域或复制业务状态机。
默认发行补丁保持 `legacy-single-user`；没有自动升级为多人部署。

Host 配置只携带 DSH 私有凭据记录地址：

- `identityBootstrapKey` 指向原有账号初始化记录。
- `spaceDirectoryBootstrapKey` 指向目录初始化记录，其 `kind` 必须为 `grant`，非空 `payload` 必须通过 B 的 `SpaceDirectoryImport` 验证。

生产目录由 B 的 `applySpaceDirectory` 在 `zhuma_spaces` storage domain 中打开、恢复和注册，
身份与执行消费同一个正式 Host bundle 内的目录实例。
初始空间、成员关系和项目归属只来自显式可信种子或已持久化事实。
配置不接受内联种子或客户端映射，不从 notes、项目 ID、工作台参与者或测试数据推导空间授权。
A 只读取私有记录地址并管理子作用域；不复制 B 的事实模型、校验、导入恢复或授权算法。

没有种子时重开已有持久化目录；若没有已有事实，则目录为空，不产生默认成员或空间。
显式指定的私有记录缺失、类型不符或种子初始化失败时，保留失败子作用域及旧路由门禁，成员访问保持关闭。
目录错误不会导致 owner 回退。初始化数据和原始异常不进入成员响应。

### 原身份域的首次配置接缝

`applyIdentity` 保持原三参调用和 `Promise<void>` 返回；可选第四参 `IdentityInitializationOptions.publish(handle)` 仅向同 Host 装配层发布当前已打开域的句柄，回调返回撤回函数，不另开域。句柄的 `status()` 仅返回 `unconfigured`、`pending`（原 requestId）、`configured` 或 `recovery-required`；不含账号表、指纹、verifier、会话 secret 或凭据 grant。

`initialize({requestId, imported})` 只供受信 Host 调用，不是 HTTP 准入本身。最多排队 8 项，单份规范化输入不超过 64 KiB／100 账号。它先在原 global 固定请求 ID、种子指纹及 writing 阶段，再向原表补同一种子的缺失记录，最后标记 complete。相同键和种子返回同一 `initialized` 回执；相同键异体或未完成的异键返回 `conflict`。既有完成库返回 `already-configured`，不能把它当成本次账号已创建；没有可证明指纹的旧 partial 返回 `recovery-required`，零覆盖。固定错误仅为 `invalid-input`、`conflict`、`recovery-required`、`unavailable`。

多成员模式的未完成 partial 不能登录或继续使用旧会话；显式 legacy 单人语义保持。关闭先撤回句柄并取消新写，再等原存储队列排空后关闭原域。同盘重开只读原状态，不自动恢复写入。Host 的异步密码生成和私有初始化记录重试核对复用原 scrypt 队列限制；renderer 不生成或接收 verifier。

新配置控制面必须先通过原 DSH 连接的 Host／Origin 门禁及真实 owner admission；这是本机操作方的首次配置权限，不映射为产品成员，也不开放旧 owner 业务路由。原 SDK exact Fetch route 已有 owner 限制；GET 状态使用 buffered，POST 初始化单独使用 streaming 并施加有界读取，不能把流式 GET 交给原 Request 构造器。此处仅记录已验证的接缝方向；完整 credentials／目录／工作区装配、配置 UI 与正式默认模式仍须同一产品切片接续，尚未认证新安装可用。

## 生命周期与执行句柄

`spaceDirectoryPlugin` 与身份、执行同属正式 Host 作用域，目录挂载成功才发布本次实例。
执行侧的 `projectSpaces` 接缝既核对拥有的实例，也核对当前 `spaceDirectoryFor(ctx)` 注册。
异步查询返回时再次核对；卸载或关闭失败已经移除注册的旧实例不能继续授权。
目录子作用域重新挂载会发布新实例，旧实例的清理不会清掉新句柄。
子作用域关闭使用 B 现有的“先注销、再关闭”机制，不增加第二套目录或授权库。

持续执行授权复用 [成员 lease 接缝](execution-member-lease.md)。Host 将私有
`currentDirectoryBinding` getter 通过 `applyIdentity` 的第三参交给实际身份安装源。
每次目录发布持有稳定 binding 与独立 token；替换、撤回及 Host `beforeClose` 在首个
await 前撤销 publication，旧 disposer 不能撤销重新发布的同一 handle。
binding 同时观察真实目录的原始 signal；直接关闭目录也立即失效，不等待存储 drain。
异步项目查询返回后复核同一 binding，不能用同对象的后续发布接纳旧查询。

执行侧调用正式 Host 入口导出的两参数 `openExecutionMemberLease(ctx, originalRequest)`，
与已安装身份保持同一个模块图。不能另从源码或第二份 bundle 导入签发函数，否则私有
安装源不相同。此装配不新增 HTTP 签发入口、授权快照或轮询，不接入节点／Run 调度。

旧工作台 owner 路由仍遵守原有早期门禁。服务已有的恢复逻辑照常运行；
装配或打开界面不会派发新计划，也不调用模型。

## 客户端

官方 Client 插件注册“我的工作”导航，先经过既有 `MemberSessionBoundary`，验证成员后再读取执行待办。
成员空间选择、显式 scope 请求／回显与切换生命周期见 [空间消费契约](member-spaces-client.md)；数据仍来自同一执行服务，不读取或过滤旧 owner snapshot。
该入口不读取旧 owner 工作台 API，不自动开始计划；登出、会话失效时卸载工作内容和当前输入。
原团队工作台及专家入口保持原有行为。

DSH SDK RPC 当前把 HTTP 失败变成没有结构状态的通用异常。
成员执行入口使用同源 Fetch，发送同一 RPC 信封、核对 rpcId，并保留 401／403 状态。
浏览器正常携带 DSH 连接凭据和 HttpOnly 成员 Cookie：前者是连接准入，后者才是成员身份。
401 使当前成员会话失效；403、目录拒绝和其他失败不能伪装成空成功结果。
取消或卸载后的旧 401 不得影响新会话。错误页不回显原始传输诊断。

## 后续接线边界

可信持久化目录 producer 及身份对它的消费已经由 B 交付，本切片完成正式 Host 启动来源与装配。
空间选择／切换由 #31 客户端接续，真实多成员业务及安装版验收不能用 Host 装配测试替代。

授权后的任务／已确认计划发现查询 `startable` 已随 #78 合入；本批正常同步其服务、Fetch 路由和现行目录签名。
对应 typed Client、选择计划和显式开始入口在 #77 集成后作为下一主切片消费，当前成员导航仍只读取待办。
旧 `/api/zhuma/snapshot` 继续在多人模式关闭，A 不从 owner 快照复制任务列表或另写 UI 授权过滤。
因此本批不是整个 #32、FR16、成员工作台或安装版桌面的完成声明。

## 验证入口与证据边界

`pnpm check` 覆盖源码、类型、Node 契约；`pnpm test:host` 使用正式发出的 Host 产物、已发布的真实 DSH 服务、
临时私有凭据和存储，模型端口明确拒绝调用。
Host 过程经真实 owner API 保存定义，再重启多人 Host，验证连接凭据不能代替成员身份。
缺种子、私有记录缺失和非法种子均不授权；通过私有测试种子写入真实目录域后验证空个人／团队空间、
不同 project／space 标识、文字执行链、成员撤销后便笺直接读写拒绝、进程重开保留撤销，以及关闭失败时的旧查询拒绝。
四个领域各开一次。测试种子只包含虚构账号和空间，不配置真实用户资料。

协调者的浏览器契约入口为 `node packages/client/tests/browser/server.mjs`，
打开 `http://127.0.0.1:8796/?member-execution&strict`；测试需要重放身份及执行 HTTP 响应。
定向交互见 `member-execution.spec.mjs`，验证登录前不读取执行、无旧 owner 回退、401 后移除输入及重新登录隔离。
A 提供代码、类型、Node／真实服务及静态打包证据；额外浏览器操作、正式导航与浅深截图由协调安排。
