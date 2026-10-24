# Host 身份组合：S1a

组合基线：已合入身份 PR #18 `eb25d30eae5d7758588c409b5c166808d9bb3068` 的 develop `772b59c41f1812051931348289f576aeadc5ae8f`，保留 PR #46 的 opt-in 客户端准备切片。Host 装配已通过 [PR #23](https://github.com/dolibali/zhuma/pull/23) 合入 develop `5b542148917cb735cd85fea6a9fd83cb5d615a07`，再由 [PR #48](https://github.com/dolibali/zhuma/pull/48) 单独集成至 main `843661c39bf1ac229fcdf011bb4e39cac54bf988`；范围与退出条件见 [#28](https://github.com/dolibali/zhuma/issues/28)。本切片只组合身份服务、显式部署模式和旧接口门禁，没有接入执行／待办／提交／评审页面。

原验证源组合 `a4ea4d1983ac6553fefc4ffd73fa3fa3e5758fe1` 的 282 项检查与六项精确发行文件 SDK 测试见[分层证据](review/s1a-host/README.md)。验证 SHA、发行摘要、合成账号／私有临时环境及历史原生桌面边界保持原记录，不据此认证后续 WP03、M1 或正式成员业务组合。

## 显式模式与服务生命周期

发行入口为 `dsh-adapter/host-plugin`，配置必须明确指定 `deploymentMode`，缺失或非法配置拒绝加载，不根据 cookie、身份模块是否存在或账号数量猜测模式。发行补丁明确配置 `legacy-single-user`，用于既有本地单人工作台。

| 配置                 | 旧五接口                            | 身份服务                                                                                           |
| -------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `legacy-single-user` | 保留 Connection 的 owner 认证后开放 | 仅显式配置私有初始化记录时挂载；不额外要求单人桌面提供 HTTP listener                               |
| `multi-member`       | 一律关闭，包括有效成员和 owner      | 作为独立 Cordis 子作用域挂载，依赖 Connection、webServer、credentials、storageDomain、remoteAccess |

父作用域先同步固定模式、注册流式门禁，再异步打开工作台／资产域；每域只打开一次。身份子作用域等待 DI、失败、卸载或重挂载均不移除父门禁。身份初始化失败保留 Cordis 的 FAILED 状态，并只记录稳定的脱敏错误；父插件存在不表示成员身份可用。

`openWorkbench()` 返回的 `readWorkbench()` 是 Host 内部克隆快照闭包，作用域释放后拒绝读取；没有新增全量浏览器 RPC。本批不把项目 ID 当作产品空间，不临时制造映射或接入 B 的执行服务。S1b 需要 B 的真实项目→空间绑定、授权投影和业务 DI，才能注册工作项、产物及评审入口。

## 初始化与凭据

可选 `identityBootstrapKey` 只接受官方 SDK 的凭据记录地址。Host 从真实 credentials 服务读取 grant 的不透明 payload，交给 B 的既有导入校验；配置不携带账号验证器、密码或签名密钥，也不新增账户管理 API。导入标记、已有账号保护与会话签名沿用身份模块，不通过重启覆盖已有成员数据。

初始化是管理员在私有服务端完成的操作。不要向普通成员分发 DSH owner 启动地址；DSH owner 身份不是产品成员身份。有效成员 cookie 也不能重新开放旧的全量 owner API。产品会话缺失、无效或依赖不可用时拒绝访问，不降级成 owner。

## 请求门禁与流式预算

范围是 exact POST `/api/zhuma/{snapshot,command,plan,preview-import,resource-files}`，其中 `command` 包含 `import-package`。顺序为：官方 Connection 的 Host／Origin／owner 检查 → 显式模式门禁 → 服务就绪 → Content-Type → 有界读取 → RPC 信封校验 → 业务操作。多成员模式在读 JSON、解压 ZIP、取文件、写域或调用模型之前返回拒绝。

这些路由使用 Connection 的 streaming 请求模式，由本插件负责读取预算：默认 **8 MiB／10 秒**；`bodyBytes` 可设 1 KiB–300 MiB，`bodyTimeoutMs` 可设 100–120000 毫秒。长度声明超限或流式实际字节超限返回 413，读取超时或中断返回 408，非法 UTF-8／JSON 返回 400。不截断后继续执行。

这是独立于 Connection buffered 模式的限制。部署若要求更小上限，应显式设置本插件配置；不声称自动继承 Connection 的私有读取预算。默认值覆盖当前 2 MiB 导入包的 base64 开销，大请求仍须遵守实际 JSON 总字节预算。

返回拒绝前不调用 Node 请求流的 `cancel()`，避免销毁 socket 后无法送达响应。真实 HTTP 负例发送了 13 字节未完成 JSON 前缀，并且不发送 EOF，仍先收到完整拒绝及连接关闭；这证明不等待完整请求体，不代表 TCP 零接收或桥接层零预取。

## 官方 SDK 与发行

构建仅通过公开 npm 入口内联 credentials／brand／storage-domain／storage 中需要的辅助函数，裁掉服务实现并保留第三方许可证。Connection、Cordis、Schemastery 仍使用固定官方 Web Bundle 的实例和依赖。构建拒绝未知 SDK 外部依赖及已知 credentials／storage 服务实现类，避免引入另一套 Host 服务。

该组合解决固定官方 Web Bundle 无法直接解析新增 credentials／storage-domain 包的问题；不修改上游、不内联第二份 Cordis，也不修改 B 的身份业务源码。模块解析成功、真实服务测试和原生桌面加载分别验证，不能互相替代。

已有自定义 profile 升级时，实际启用的插件项也必须补上显式模式；只改被禁用的同名项不会生效。模式未配导致拒绝加载应修正实际配置，不绕过校验。回退多成员部署前先停止或隔离入口，保留身份与凭据数据；不能在开放的成员服务上换回旧的无门禁 bundle，或删除身份域来“恢复”owner 访问。

## 复现与剩余范围

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test:host
pnpm upstream:check
```

本地不打开或自动化浏览器；界面契约由既有 CI 按其配置运行，额外界面验证在工作项中交协调者安排。本次同步不重跑未变化的旧桌面拖窗或系统主题。

`test:host` 构建后验证完全相同的四个发行文件，使用临时 SDK 包作用域、私有测试 home 和真实已发布服务；不重打包源码或调用模型。可选环境变量 `S1A_PROOF_FILE` 将成功后的来源提交与构建摘要写到指定文件。CI 在构建后运行 `test:host:run`，失败阻止 `scaffold` 通过。

本批证明单个合成成员的真实服务身份链与单人桌面兼容性，没有完成三账号／两团队的人工交付闭环、多成员桌面入口、产品空间权限投影、原生 Agent 会话、安装包、K8s 或跨平台验收。FR16／17 保持未关闭。
