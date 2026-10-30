# DSH 补丁

`zhuma-desktop.patch` 应用于固定上游 `504a01a9578abc2c6f1fb896b1dc322c9fe24f66`，只在发行脚本创建的 `.build/` 临时工作树生效，固定子模块保持原样。

当前补丁覆盖：

- 桌面名称、应用标识、协议、图标路径和构建产物命名；保留第三方许可。
- 发行包装器显式传自有根包产品版本 `P`，品牌配置给构建版本 `B`，固定 SDK manifests／runtime 保持原版本 `R`。原版本解析器仍严格校验 `B` 对 `P` 的版本与后缀；未传自有产品版本时沿用 SDK 行为。主打包、构建记录、签名和 electron-builder 共用该解析器；成品 `extraMetadata.version` 仍对真实 SDK manifest `R` 比较并写入 `B`，原 runtime-tree 校验继续期待 `R`。不改第三方 package 版本、不绕过平台校验，不以改名代替应用内版本。
- 开发版本地工作台入口和公开品牌文字；不伪造模型平台登录状态。
- macOS 侧栏使用现有浅深主题的不透明背景，移除蓝紫渐变和壁纸叠色。继续使用官方主题服务、原生主题同步和窗口拖动机制。

## 构建来源隐私

固定工具链的 tsdown `0.22.2`／Rolldown `1.1.1` 及 Vite `8.2.2`／Rolldown `1.2.7` 默认会将 CSS 虚拟模块的绝对构建根写入 `//#region`。根 workspace 配置、桌面独立配置（含其 welcome Vite 调用）和 DevTools 的独立 Vite 构建均使用原生 `experimental.attachDebugInfo: 'none'`（分别位于 `inputOptions`／`build.rolldownOptions`）关闭调试标签；不使用 `comments: false`、额外压缩或字符串替换，保留原版权／许可策略、虚拟模块读取与 watch 合同，由编译器生成有效 SourceMap。原 DevTools 的 Oxc 压缩本就不保留内联法律注释，其独立许可文件仍由原生成器输出，本补丁不改变这两项策略。

`desktop:prepare` 将自有只读 `verify-build-source-paths.ts` 复制到隔离 SDK 并纳入原 recipe 摘要。官方构建在原产物摘要写入前检查生成的 JavaScript；运行时复制后在签名、清单及完整性描述前再次检查 SDK 输出。门禁只识别真实单行 region 注释中的绝对路径，包含未知虚拟前缀；字符串、模板、块注释和公开示例不作替换。无生成输出或有残留即失败，不改固定子模块、SourceMap、已签 ASAR 或生产依赖锁。

定向契约为 `node --test packages/dsh-adapter/tests/desktop-build-source-paths.test.mjs`。另将 `ZHUMA_DESKTOP_SOURCE_TOOLCHAIN` 显式指向已安装依赖的固定 SDK，可运行 tsdown、Vite、Vite 原 Oxc 压缩三个离线四类 CSS 虚拟 ID 探针：旧配置确实泄漏，原开关移除标签，法律注释策略、非注释 token、执行结果和有效映射保持；不同构建根下的生成 JS 相同。缺少该工具链时只跳过这三个编译探针，源码／门禁契约仍执行。升级固定工具链须更新并重验探针；最终重封包的 ASAR／DMG 全文件扫描仍须独立完成，契约通过不代表发行隐私已验收。

## Python 构建冒烟与缓存

原 `smoke.py` 的 venv／ensurepip 子进程不继承父解释器的 `-B`。仅在原发行 smoke 的子进程 `env` 强制 `PYTHONDONTWRITEBYTECODE=1`，由其后代继承；不修改全局环境、成品默认运行环境或原五类功能检查。不删除、重编或字符串替换字节码，保留固定归档的原始 payload 基线，不能据此声称问题 App 或最终安装包的字节不变。

`verify-runtime-privacy.ts` 随原 prepare recipe 精确复制并纳入摘要。它只读校验当前固定 CPython 3.12 缓存标签／头、对应常规 `.py` 及路径／原字节 SHA 集合，未知、无源、异常链接和读取失败均拒绝。复制后、原 smoke 前后以及 runtime 签名／清单／完整性描述前核验；完整准备运行时若含实际逻辑／物理准备根的 UTF-8 或 UTF-16LE 字节则拒绝，不打印其值。解释器或缓存格式升级须重新核对，未建立新的持久清单或锁机制。

定向契约为 `node --test packages/dsh-adapter/tests/desktop-python-runtime-privacy.test.mjs`；这些契约不冒充原解释器运行。实际资格需使用校验过的离线原归档，在独立副本执行原准备与完整 smoke，核对原缓存不变、源／依赖元数据／许可保留，并由最终 cut 的独立整 App／DMG 扫描补齐发行证据，不要求重跑已验证的整套安装功能。

侧栏修改的独立官方桌面验证、前后截图及未验收项见 [桌面外壳记录](../../docs/review/desktop-shell/README.md)。原生拖窗、真实系统浅色矩阵和安装包不因该记录自动通过。上游若提供可配置的中性侧栏，优先改用其公开配置并删除对应 CSS 补丁。

确需改动时，以固定版本生成最小补丁，记录目的、上游提交、修改文件、验证与退出条件。按明确顺序应用到 `.build/` 临时工作树，应用失败立即停止，不静默跳过。

新增功能优先使用仓外插件；不把普通工作流、上下文和界面业务直接写进上游 Agent Loop。

Skill loader 的隔离补丁仅增加 `ToolRegistry.getRegistered(name, scope)` 的只读注册身份查询，并在官方 `ToolSkill` 的工具调用、目录和用户显式调用三条路径中核对实际调用 Agent 的 loader 所有权。该查询忽略模型可见性以识别 owner，不授予工具执行权限；原 `get`／schema／execute 的限制语义保持不变。Skills 保留注册时隔离域的绑定，Tools 和工作目录来自调用 Agent 的实际上下文，异步结果返回后重新核对服务及注册身份。非 owner 不读取内容、不改写其他 loader 的目录，模型可见性与用户显式调用策略分别沿用官方判断。

固定源码 SDK 的回归命令：`pnpm desktop:verify:native-lifecycle --phase skill-loader --upstream <已安装测试依赖的固定SDK>`。验证器在自己的临时检出应用完整发行补丁，执行 ToolSkill／Tools 原套件与隔离探针，再将这两个生产文件还原为固定上游版本，要求同一正文泄漏探针确实失败。仅证明 SDK 组件契约，不认证 Host 资源接入、真实模型、GUI 或安装；每个受控 Run（包括空资源和仅 MCP）仍须由 Host 装配独立空／选定 SkillRegistry 和唯一 loader。

`ToolSkill` 使用 `scopeOf` 核对原 Agent 身份，因此 `@deepseek-ai/dsh-scope` 必须同时声明为运行时 peer。仅有开发依赖时，正式 tsdown 构建会把另一份私有 scope Symbol 内联，导致正常专家在首次模型调用前被拒绝；源码别名测试不能识别这个模块图问题。补丁只增加这一项 peer，不改身份检查、注册表、工作目录或工具权限；原 devDependency 和已固定的锁文件保持不变。

正式编译回归：`node scripts/desktop/verify-compiled-skill-scope.mjs --upstream <已安装测试依赖的固定SDK>`。验证器在自己的临时检出使用 SDK 原 pnpm 离线、冻结锁文件、禁用安装脚本，按原 TypeScript references 和 tsdown／Typert 配置构建相关运行时包。独立 Node 进程从普通编译包创建原生 Agent，由原 factory 提供未发布的 Agent scope，装配真实 SkillRegistry 并绑定。仅撤销新增 peer 后，同样创建必须在模型调用前失败并回滚；恢复后须通过绑定和一次本地脚本模型调用，父／继承上下文、假注册表及已退出 scope 仍拒绝。运行探针没有源码别名、加载 hook 或替换 factory；该证据仍不替代正式 Host 资源接入、正常 GUI、真实模型效果或安装验收。

Host 本地工作区接入复用 Web 已有的 `dsh-workspace`／`dsh-tool-fs`，并将受控 FS facade 使用的 `dsh-fs-observation-policy` 增加为 Web 的直接运行时依赖。补丁同时记录 SDK 锁文件 importer 的原 workspace 链接，不更新依赖版本、不将 SDK workspace 并入根仓，也不把该依赖当成文件或发布授权。安装仍须使用固定 SDK 自己的 pnpm 与冻结锁文件；详细授权边界见 [Host 本地工作区接缝](../../docs/contracts/host-local-workspaces.md)。

正式 Web 的全局 FsSandbox 不能当作 D 的裸 local producer。策略交集修复把私有后端使用的原 `dsh-fs-local` 和真实策略来源 `dsh-sandbox-policy` 从 Web 的开发依赖移到运行时依赖，同步原锁文件位置；不改全局 FS 或 sandbox 默认值。权限仍逐次与 SDK 部署／真实 session 策略相交，默认 read-only 不因操作方 write 绑定被提升；没有改原 producer 的 sandbox 拒绝分支。

## MCP 实例关闭确认

MCP Client 增加公开 `captureMcpClientClose(originalMcpFiber.ctx): McpClientCloseHandle`，其 `close(): Promise<void>` 绑定原插件 supervisor。仅接受该实例的原 Context；父、兄弟、继承或 JSON 对象均拒绝。句柄应在销毁前捕获，调用方先等待明确关闭成功，再把原 fiber 销毁结果用于后续清理。句柄不授予连接、工具执行或 Run 权限，消费方仍须核对原私有配置与成员／Run 资格。

该确认口沿原 supervisor 关闭连接、停止重连、排空工具同步，并移除其工具；没有新增 manager 或连接池。原关闭确认时限保持 5000ms。没有原 owner 时抛 `McpClientCloseError('mcp-close-unavailable')`；transport 未确认关闭，或先前一代曾无法确认关闭时，抛 `mcp-close-unconfirmed`。并发调用共享原 Promise，失败持续拒绝；旧句柄不会在重载后改绑新实例。Cordis 会容纳 finalizer 的错误，因此仅 `fiber.dispose()` 返回不能证明 transport 已关闭。

固定源码 SDK 的增量验证命令为 `pnpm desktop:verify:native-lifecycle --phase mcp-close --upstream <已安装测试依赖的固定SDK>`。在独立临时检出应用完整累计补丁，按 MCP 包原有 TypeScript project references 编译，并检查公开入口的句柄／Promise／错误码类型。仅运行受影响的 3 项原 SDK 关闭契约和 3 项真实本地 HTTP 案例：正常 list/call/close、错误上下文拒绝，以及实例 transport.close 返回但真实请求仍持有时，明确确认必须拒绝。后者还核对恢复原 close 后真实请求才排空；没有修改产品超时或用日志签发排空结论。

该验证不调用模型、不读凭据或用户 profile，也不证明远端业务回滚、stdio 子进程、Run 的 MCP 资源采用、编译后的 Web 模块图、正常 GUI 或安装包。正式资源桥必须实际等待该明确确认口；公开 API 和定义可选本身不表示已完成 MCP 接入。

## 任务原生会话的普通命令门禁

`Gateway.registerSessionAdmission` 在原 exact 参数及原 RemoteAccess 校验之后、任何 receiver/Agent lookup 之前，串行检查 `session` 与附加 `dshAcp` 命名空间的 unary／mux stream，以及会在写入后停止会话的 `workspace/archiveSession`。ACP 方法以 `dshAcp/` 加实际方法名交给同一原 Host 资格查询；不按前缀授予执行权限。注册后保持 required 状态；卸载、迟到通过或当前守卫失效不会恢复默认放行。可配置 `sessionAdmissionRequired: true`，使产品启动尚未安装守卫时也拒绝命令。无产品配置、未注册守卫的 SDK 保持原行为。

产品 Host 消费 C 原 native 表的 reverse lookup：只有明确 `null` 表示普通会话；work/review 命中、foreign、损坏、关闭或初始化未完成均不得走普通 Session 命令。覆盖实际 create/reuse、prompt、queue、cancel、model selection、rename/fork、attachment/projections，以及 page/follow 的直接和父子地址。该接缝本身不授予任何任务历史、发送、停止或评审权限；Task 界面仍使用原成员、Run、世代、幂等与评审绑定。

定向 SDK 检查入口为 `node scripts/desktop/verify-session-admission.mjs --sdk <已构建的固定公开SDK>`。脚本只在临时源树应用 Gateway 两文件增量，使用公开编译依赖并检验真实 Gateway dispatch 顺序；业务 service/lookup 为明确夹具，不能当作原 SessionController、原生 Agent、模型、两 Host 或 GUI 验收。原生归组、普通侧栏导航与共享后端装配另按实际 SHA 验证。

## 附加 ACP 插件及会话目录

官方 Web Bundle 的 manifest／锁文件固定附加 `@zaimokuza/dsh-acp-adapter@0.2.1-rc.4.1`，具体源码与完整性见 `runtime.lock.json` 和 [来源登记](../../third_party/acp-adapter.md)。仅附加插件路由，不替换默认 Agent factory，不修改用户 profile 或 CLI 认证。SDK 的独立 pnpm 安装验证了原发布包与官方 Host 共用 Cordis、LLM、Session、Tools peer 图。

`Gateway.registerSessionResultProjection` 只为插件 `health`／`projectedSubagentIds` 的 unary 结果捕获当前 Host 投影 owner；执行前及异步返回后均核对同一注册。产品 required 模式下缺少投影拒绝派发；卸载、替换、停止和迟到结果均拒绝返回，未配置的 SDK 保持原行为。产品投影按原 C native 绑定逐项过滤完整任务会话记录，未知数据形状或查询失败整体拒绝，避免普通设置页获得任务会话、continuity cause 或 detail；`boundSessions` 不对普通入口开放。纯全局 provider 路由和普通个人会话继续原语义。

任务模型选项只读取插件无参数 `health()` 缓存视图以识别其实际注册路由，不对 ACP 路由调用会主动探测 CLI 的 `listModels()`。此保守过滤不表示码道执行器已经取得任务权限；后续原生工具 handoff 和 CodeArts producer 单独交付验证。新增目录投影、实际 Gateway dispatch 和发布包注册契约均不证明真实 CLI／模型／GUI／安装资格。
