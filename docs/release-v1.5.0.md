# v1.5.0 范围、安装与来源

v1.5.0 的交付目标是把现有任务、原生执行、固定产物与独立评审组织成可复用的工程工作流。范围、实际完成和退出条件以[工作项 #394](https://github.com/dolibali/zhuma/issues/394)为准；本说明和工程版本号不代替正常界面、工程结果或正式安装验收。已发布 [v1.4.0](https://github.com/dolibali/zhuma/releases/tag/v1.4.0) 的 tag、原资产、校验和及[历史说明](release-v1.4.md)保持原版本事实。

## 工程工作流与协作

本版接入目标为默认「需求到代码验收」工作流：需求澄清、设计与任务、代码实现、验证、独立评审、交付。原四个工程流程继续保留。成员从现有「使用工作流」入口选择模板，明确绑定参与者与 Skills 后生成独立任务草稿；在原列表／工作流编辑器自由增删、调整依赖和评审人，也可保存、复制并自定义。缺少资源或独立评审人时保留缺项，不以名称匹配代替实际绑定。

配套方法复用需求分析、方案设计、实施、验证、修复和评审 Skills，记录需求编号、影响模块与验收场景。验证执行目标工程自己的实际命令，保存准确版本、命令、退出码及报告。正式评审针对本轮固定提交，退回后修正并重提新版本；只有原授权评审通过且运行收口，才接续下游。工程案例按独立源提交和实际验证记录交付，不把人工修改或契约测试写成真实模型生成，也不虚构效率比例。

本版同时收口以下增量，具体集成与验收见对应 PR 及 #394：

- [#384](https://github.com/dolibali/zhuma/pull/384)：任务列表／画布显示实际执行节点和等待项，保留手工任务名称；收件箱和节点进度保留旧客户端兼容。
- [#385](https://github.com/dolibali/zhuma/pull/385)、[#386](https://github.com/dolibali/zhuma/pull/386)：项目目录标记和项目内任务筛选。
- [#387](https://github.com/dolibali/zhuma/pull/387)：按成员／空间隔离的规划模型选择与刷新，成员选择不改共享 Host 默认。
- [#391](https://github.com/dolibali/zhuma/pull/391)：固定正文版本差异、绑定本版的评论及退回重提；真实文件仍沿原固定交付与授权预览，不表示已提供 IDE 代码行评审。
- [#389](https://github.com/dolibali/zhuma/pull/389)：Windows 公开安装包完整标明 `windows`，SDK 内部 target 与原安装器字节保持。

## 下载与安装

从本版正式 Release 下载所需平台产物、`SOURCE.json` 和 `SHA256SUMS`，核对所下载文件摘要。总来源清单的 source commit、tree、版本、SDK pin 和各平台原始来源必须一致。

| 平台                 | 本版文件                                         | 安装与限制                                                    |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Windows x64          | `zhuma-1.5.0-windows-x64-unsigned.exe`           | 原 NSIS 安装器，当前没有 Authenticode 签名或自动更新。        |
| macOS Apple Silicon  | `zhuma-1.5.0-mac-arm64-unsigned.dmg`             | 将 Zhuma 拖入 Applications；ad-hoc 签名，未公证，无自动更新。 |
| Linux amd64 服务镜像 | `zhuma-1.5.0-server-linux-amd64-image.tar.gz`    | 原 Docker SAVE 的压缩字节，使用 `docker load -i <文件>`。     |
| Linux amd64 便携服务 | `zhuma-1.5.0-server-linux-amd64-portable.tar.gz` | 需要 Node 24.15.0 和对应原生库，沿包内公开说明启动。          |
| 部署材料             | `zhuma-1.5.0-deployment.tar.gz`                  | 同一源码的服务说明、Dockerfile 与单实例 K8s 模板。            |

Windows 与服务原始清单分别保留为 `windows-SOURCE.json`、`server-SOURCE.json`。总清单还绑定 Linux qualification 的 run／attempt、artifact ID／digest、原归档摘要及 Docker image ID。原 macOS、Windows 安装流程不因命名改变；系统警告时先核来源，按系统正常允许打开的流程处理，不关闭系统保护。Intel Mac、Windows arm64 和 Linux 桌面不在本版支持范围。

## 服务、模型与已有数据

客户端「连接设置」填写操作者提供的共享服务根地址，再使用该服务内的成员账号登录。AI 规划使用后端可用模型，本机节点执行使用成员桌面的模型和授权工作区，凭据分别由原设置管理。模型选择、导入 Skill、选择模板或查看成果都不自动启动工作。

本版网络验证范围以 #394 记录的准确候选、平台与网络环境为准；服务地址由操作者提供，私有环境不写入公开发行材料。

安装新版客户端不隐式更新已部署的共享后端。服务升级继续沿原单实例／PVC、备份和授权入口，保留已有数据、成员、会话与公网路由；不要用另一安装的 profile 覆盖原目录。跨版本交互和必要恢复按本版准确候选另行核对，用户数据与凭据不进入公开资产。

## 来源与验证边界

所有 topic 普通合入 develop，再普通合入 main。最终正式包来自同一个已验完整 main SHA；原 Linux server qualification 成功后，Product Release 在原平台 runner 构建 Windows／macOS并装配 Linux 原资产。main、最新必要 CI、版本、固定 SDK、各平台来源和摘要均沿既有发行脚本复查，创建新 `v1.5.0` tag 与草稿，逐项核远端 digest 后才公开。既有 v1.4.0 资产不重命名、不覆盖。

源码与契约、真实 Host／HTTP／持久、正常浅深界面、实际工程修改与测试、安装启动及最终发行分别记录。未变的历史证据保留原 SHA 和环境范围；案例测试不认证平台通用门禁或完整 CLI 资格。Windows 码道供应商实际调用、完整 MCP、内置效能采集、代码地图、IDE 文件行评审、更多 CLI 和跨 CLI 接管继续后置。完整工作树执行、HA 与 SSO 也不在本版范围。

自有代码采用 [MIT](../LICENSE)，保留官方 Harness、React Flow 和所有资源参考的原来源、版权与许可。公开产物不包含用户附件、成员凭据、会话库、私有环境或签名文件。
