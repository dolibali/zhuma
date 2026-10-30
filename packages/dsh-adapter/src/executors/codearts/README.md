# CodeArts 接入叶子

`registration.ts` 提供 Host 内部的 `CodeArtsProfileRegistrationProducer`。`prepare` 校验实际 Node／Electron、适配入口和 CLI launcher 的路径与 SHA256，返回完整 ACP profile 和本代不透明对象。注册时调用 `guardForProfile(profileId, actualFullConfig)`，取得本代闭包；注册替换、撤销、卸载、父信号取消、配置或文件变化都会令旧闭包失效。A 的 registry 另外核对当前完整配置，产品接入传动态闭包。普通目录展示无需启动 CLI。

`http.ts` 仅连接本进程拥有的 loopback 服务，使用单独生成的 Basic 凭据。会话创建固定目录和明确 permission 配置；恢复读取原 ID，失败保留错误。历史和 SSE 只返回已绑定会话，流关闭会取消 reader。写请求遇到不确定结果不会自动重发；abort 返回的是确认回执，真实进程排空沿原 Harness Subprocess 能力核对。

这两个叶子尚未提供 ACP 可执行入口或任务 prompt。文件校验、permission 回显、SSE、CLI 退出均不认证成员权限、内置工具的读写范围、产物提交或独立评审。任务接入还需核定 CodeArts 本会话权限的实际执行边界，复用原 Run／成员／固定提交门禁。原 Harness 工具交接补丁由 A 按协调冻结的社区源 pin 纳入发行。

本地契约测试使用合成文件和 HTTP 响应。真实 CLI 会话与恢复的无模型证据分别记录准确 launcher 和编译产物；Windows／Linux、真实模型和完整任务交付另验。
