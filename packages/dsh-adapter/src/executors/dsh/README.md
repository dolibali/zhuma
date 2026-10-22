# DSH 原生执行

`DshChatExecutor` 显式选择后启动 `dsh --profile sdk`，经 stdio JSON-RPC 对话。补丁、技能和工具授权、事件字段、遥测关闭，以及 `DSH_HOME` 的位置和清理时机，写在 `docs/contracts/wp03-execution-context.md`。

找不到运行时、缺少模型路由或二进制不可执行时，这次运行失败，不改用模拟执行器。码道不在这里实现。
