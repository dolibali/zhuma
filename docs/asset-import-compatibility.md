# 资产包导入兼容边界

小文本导入已保留。目录／ZIP 首批实现与分层验证正在推进，见[接口与验证记录](asset-import.md)；结构复用与空间授权分别衔接 A-TEMPLATE、B-ID0。下表是支持范围，不认证外部运行时执行兼容。

| 格式                  | 首批计划支持                                                                                | 不包含                                                   |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Agent Skills          | SKILL.md 与 references/assets/scripts，预览依赖、文件和缺项                                 | 导入时执行脚本                                           |
| Zhuma 专家导出        | 声明式专家定义、稳定 ID/版本及允许的资源绑定                                                | 可执行 Host 插件配置                                     |
| OpenClaw 工作区约定   | SOUL.md 人格、IDENTITY.md 身份、AGENTS.md 方法、skills/ 的受控映射；单个 SOUL.md 可补元数据 | 完整 OpenClaw 运行时兼容；USER.md、MEMORY.md、会话和凭据 |
| Claude agent Markdown | 后续独立评估                                                                                | 首批兼容承诺                                             |

入口是文件/目录（不支持目录选择时用 ZIP）→识别与清单→预览来源/依赖/忽略项→归属/重名处理→保存。需限制文件数量、总大小和解压规模，拒绝路径越界/链接，坏包和不支持字段具体报错。不可把任意 YAML、!!js 或 plugins 字段直接安装为可执行代码；固定 DSH presets 本身可包含 Host 代码，并非沙箱。

导入不启动模型或 MCP。静态定义可选入任务与实际运行采用正确版本分开验收；可信 actor、空间写入/共享权限、运行能力检查由 B 提供。跨空间负例未通过前不宣布个人/团队隔离可用。

来源：[Agent Skills](https://agentskills.io/specification)、[OpenClaw agent workspace](https://docs.openclaw.ai/concepts/agent-workspace)、[Claude sub-agents](https://code.claude.com/docs/en/sub-agents)。SOUL.md 是 OpenClaw 工作区约定，不是通用 Agent 包标准。
