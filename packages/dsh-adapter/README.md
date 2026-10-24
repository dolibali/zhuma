# @zhuma/dsh-adapter

Host 侧接入 DSH 的边界，未来负责插件注册、服务与工具、会话事件映射、原生执行和可选码道 CLI 适配。

当前只有执行端口和明确的执行者选择逻辑。没有导入 DSH 内部包，没有注册真实 Cordis 插件，也不会假装已接通码道。`completed` 仅表示执行者返回结束，不代表独立验收或人工批准通过。

下一步按锁定提交的 DSH 公开接口注册一个最小 Host 插件，再验证构建、加载、卸载和清理；届时按上游要求声明宿主 peer dependencies。不得直接相对引用 `upstream/` 的源码。

模拟执行器必须显式选择，未配置时不会改用它。`DshChatExecutor` 在显式选择后启动 `dsh --profile sdk`。码道执行器保持未实现、未验证，调用会失败，而不是伪造成功。运行事务在 `ExecutionDesk`。可操作演示在 `examples/agent-workspace`。授权、补丁、事件字段和 `DSH_HOME` 的清理时机见 `docs/contracts/wp03-execution-context.md`。
