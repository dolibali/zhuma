# DSH ACP Adapter 来源登记

| 项目   | 固定输入                                                                                |
| ------ | --------------------------------------------------------------------------------------- |
| 仓库   | https://github.com/zaimokuza-yoshiteru/dsh-acp-adapter                                  |
| 源码   | `28ccc6745ec82139c684c3642637e93e00d800f2`                                              |
| 发布包 | `@zaimokuza/dsh-acp-adapter@0.2.1-rc.4.1`                                               |
| 许可   | MIT；包内 LICENSE 原文随依赖保留                                                        |
| 完整性 | `runtime.lock.json` 的 `plugins.acpAdapter.integrity` 以及官方 SDK 构建树的 pnpm 锁文件 |

本仓发行补丁仅将发布包加入官方 Web Bundle，并在发行 overlay 中以附加插件注册。该包不进入根 Workspace，不替换默认 Agent factory；包内 Host 工具交接和注册接缝使用单独的固定源码／发布包补丁，见 [补丁说明](../patches/dsh-acp-adapter/README.md)。原包版本与完整性不改，pnpm 另外固定补丁摘要。发布包的源码与完整性分别核对，源码 tag 名称本身不作为字节证明。

Zhuma 自有适配只在 Host 接入固定版本的实际接口：被动读取 profile 缓存、阻止普通会话命令访问任务会话、过滤全局任务会话目录。完整性失败、未知结果形状、来源撤销或更换均拒绝返回；不修改原插件会话事实或实现第二份历史。

验证分层：自有类型和单测；固定 SDK Gateway dispatch 契约；实际发布插件注册及默认原生 factory；SDK Host／Client／Web 构建。后几项使用独立临时目录，子进程和模型端口禁止实际执行。真实 CLI、认证、正常 GUI、任务交付和安装包仍需对准确候选分别验收。CodeArts 工具 handoff 的源码树、源码补丁和已发布包补丁分别登记；工具调用、认证、权限隔离和业务交付仍按实际链路验收，不能由字节一致性代替。
