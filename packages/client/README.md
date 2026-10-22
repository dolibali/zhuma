# @zhuma/client

对话、运行和编排三种视图的客户端包；未来通过 DSH Web Client 的 Slots、客户端模型和现有传输注册界面。

当前提供共享任务视图模型与状态文案，以及节点执行报告和待办的只读投影。投影不保存第二套执行事实。不提供产品页面或第二个 Web 服务。等真实 Client 插件接入时再引入与宿主兼容的 React 和图形依赖，避免先打包一份冲突的前端运行时。

视图切换不能启动新执行；客户端不得持有第二套权威任务状态。不得从这里导入 Host 插件、Node 文件系统或 Electron 主进程能力。

`createAgentWorkspaceView` 把执行事实投影成 Agent 处理视图。调用它不会创建运行。可操作页面在 `examples/agent-workspace`，本包不导入 Host，也不启动服务。
