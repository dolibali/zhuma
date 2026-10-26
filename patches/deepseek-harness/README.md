# DSH 补丁

`zhuma-desktop.patch` 应用于固定上游 `687f282e8625c6b8d11ff58211a90524be2e4317`，只在发行脚本创建的 `.build/` 临时工作树生效，固定子模块保持原样。

当前补丁覆盖：

- 桌面名称、应用标识、协议、图标路径和构建产物命名；保留第三方许可。
- 开发版本地工作台入口和公开品牌文字；不伪造模型平台登录状态。
- macOS 侧栏使用现有浅深主题的不透明背景，移除蓝紫渐变和壁纸叠色。继续使用官方主题服务、原生主题同步和窗口拖动机制。

侧栏修改的独立官方桌面验证、前后截图及未验收项见 [桌面外壳记录](../../docs/review/desktop-shell/README.md)。原生拖窗、真实系统浅色矩阵和安装包不因该记录自动通过。上游若提供可配置的中性侧栏，优先改用其公开配置并删除对应 CSS 补丁。

确需改动时，以固定版本生成最小补丁，记录目的、上游提交、修改文件、验证与退出条件。按明确顺序应用到 `.build/` 临时工作树，应用失败立即停止，不静默跳过。

新增功能优先使用仓外插件；不把普通工作流、上下文和界面业务直接写进上游 Agent Loop。

Skill loader 的隔离补丁仅增加 `ToolRegistry.getRegistered(name, scope)` 的只读注册身份查询，并在官方 `ToolSkill` 的工具调用、目录和用户显式调用三条路径中核对实际调用 Agent 的 loader 所有权。该查询忽略模型可见性以识别 owner，不授予工具执行权限；原 `get`／schema／execute 的限制语义保持不变。Skills 保留注册时隔离域的绑定，Tools 和工作目录来自调用 Agent 的实际上下文，异步结果返回后重新核对服务及注册身份。非 owner 不读取内容、不改写其他 loader 的目录，模型可见性与用户显式调用策略分别沿用官方判断。

固定源码 SDK 的回归命令：`pnpm desktop:verify:native-lifecycle --phase skill-loader --upstream <已安装测试依赖的固定SDK>`。验证器在自己的临时检出应用完整发行补丁，执行 ToolSkill／Tools 原套件与隔离探针，再将这两个生产文件还原为固定上游版本，要求同一正文泄漏探针确实失败。仅证明 SDK 组件契约，不认证 Host 资源接入、真实模型、GUI 或安装；每个受控 Run（包括空资源和仅 MCP）仍须由 Host 装配独立空／选定 SkillRegistry 和唯一 loader。

## MCP 实例关闭确认

MCP Client 增加公开 `captureMcpClientClose(originalMcpFiber.ctx): McpClientCloseHandle`，其 `close(): Promise<void>` 绑定原插件 supervisor。仅接受该实例的原 Context；父、兄弟、继承或 JSON 对象均拒绝。句柄应在销毁前捕获，调用方先等待明确关闭成功，再把原 fiber 销毁结果用于后续清理。句柄不授予连接、工具执行或 Run 权限，消费方仍须核对原私有配置与成员／Run 资格。

该确认口沿原 supervisor 关闭连接、停止重连、排空工具同步，并移除其工具；没有新增 manager 或连接池。原关闭确认时限保持 5000ms。没有原 owner 时抛 `McpClientCloseError('mcp-close-unavailable')`；transport 未确认关闭，或先前一代曾无法确认关闭时，抛 `mcp-close-unconfirmed`。并发调用共享原 Promise，失败持续拒绝；旧句柄不会在重载后改绑新实例。Cordis 会容纳 finalizer 的错误，因此仅 `fiber.dispose()` 返回不能证明 transport 已关闭。

固定源码 SDK 的增量验证命令为 `pnpm desktop:verify:native-lifecycle --phase mcp-close --upstream <已安装测试依赖的固定SDK>`。在独立临时检出应用完整累计补丁，按 MCP 包原有 TypeScript project references 编译，并检查公开入口的句柄／Promise／错误码类型。仅运行受影响的 3 项原 SDK 关闭契约和 3 项真实本地 HTTP 案例：正常 list/call/close、错误上下文拒绝，以及实例 transport.close 返回但真实请求仍持有时，明确确认必须拒绝。后者还核对恢复原 close 后真实请求才排空；没有修改产品超时或用日志签发排空结论。

该验证不调用模型、不读凭据或用户 profile，也不证明远端业务回滚、stdio 子进程、Run 的 MCP 资源采用、编译后的 Web 模块图、正常 GUI 或安装包。正式资源桥必须实际等待该明确确认口；公开 API 和定义可选本身不表示已完成 MCP 接入。
