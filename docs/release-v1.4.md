# v1.4.0 范围、安装与来源

v1.4 将 Windows x64 客户端、现有 macOS arm64 客户端和 Linux amd64 共享服务放在同一产品来源下，保留 v1.3 的账号、团队、工作台、原生会话、固定文件和评审能力。工程版本号不是发布或验收证明；实际结果只见 [v1.4 工作项 #372](https://github.com/dolibali/zhuma/issues/372) 和对应正式 Release，历史 v1.3 资产与证据保持原范围。

## 下载与安装

下载对应平台产物及 `SOURCE.json`、`SHA256SUMS`，先核全部所下载文件的 SHA-256。清单中的准确 source commit、tree、产品版本、SDK pin 和各平台来源应一致；不要把旧候选改名成新版本。

- Windows x64：`zhuma-1.4.0-win-x64-unsigned.exe`。使用正常安装器安装、打开；当前未提供 Authenticode 签名，无自动更新。系统警告时先核来源与摘要，不关闭系统保护或修改全局安全策略。Windows arm64 尚不在本版支持目标内。
- macOS Apple Silicon：`zhuma-1.4.0-mac-arm64-unsigned.dmg`。打开后将 Zhuma 拖入 Applications。当前为 ad-hoc 签名、未公证，无自动更新；按 [Apple 正常允许打开流程](https://support.apple.com/zh-cn/102445)处理已核对来源的应用。Intel Mac 尚不在本版支持目标内。
- Linux amd64 共享服务：`zhuma-1.4.0-server-linux-amd64-image.tar.gz` 是压缩的原 Docker SAVE，使用 `docker load -i <文件>`，不能用 `docker import`。镜像身份及原始归档摘要在总来源清单中；便携包 `zhuma-1.4.0-server-linux-amd64-portable.tar.gz` 保留准确 SDK／工作台／启动器与逐文件清单，需要 Node 24.15.0 和相应 Linux 原生运行库。

Windows 与后端原始来源分别保留为 `windows-SOURCE.json`、`server-SOURCE.json`；总清单同时绑定 Linux 原始资格 run、artifact ID／digest、原六文件摘要、Docker image ID 与本次压缩字节。构建、安装、业务与恢复各自留证，归档和摘要本身不证明真实模型任务已经交付。

## 连接共享服务

在桌面的“连接设置”中选择“本机服务”或“自定义共享服务”，填写操作者提供的 HTTP(S) 根地址并保存。当前地址与“最近检查”分开展示；“检查连接”读取原成员会话接口，可访问仍可能需要登录。读取已保存地址不表示服务在线；无效响应应核对根地址与客户端／服务版本，不自动切回本机。

切换遵守未保存内容确认和原生工作收口，进行中 Run 尚未结束时先停止并等待。随后使用所选服务中的成员账号登录；服务地址、团队／个人空间与成员本机执行工作区是独立概念。共享后端管理团队业务和 AI 规划；节点 Agent 和码道仍在成员设备执行，不把本机模型凭据或整个工作区交给共享服务。

模型使用各自运行位置的官方设置入口配置：本机执行在桌面模型页，后端 AI 规划由操作者在服务的官方模型页配置。资料、Skill 与专家定义并不代替模型配置和本机执行授权；导入和查看不会启动任务。

## 服务部署与数据

`zhuma-1.4.0-deployment.tar.gz` 只包含本版公开的服务说明、Dockerfile 和单实例 K8s 模板。先按[部署说明](../distribution/server/k8s/README.md)填写自己的镜像、可达入口和持久卷；示例不带实际集群地址或凭据，不应未经核对直接套用。命名空间、存储、入口、权限和资源由部署操作者确认，不操作其他应用或共享供给器。

原运行时以非 root 用户、只读应用目录运行，工作数据保存在独立 `/data`。临时目录维持 noexec；原生模块使用官方直接加载模式，不通过放宽挂载权限解决缓存加载。单实例、持久卷、同版本备份／恢复和升级避免双写的要求见[服务说明](../distribution/server/README.md)。保留原数据、配置和会话，不能用另一安装的 profile 覆盖；备份中有私密资料，不上传到公开仓库或 Release。

## 发行与验证边界

所有 topic 普通合入 develop，再普通合入 main。发布前必须完成对应真实候选验收和准确 main 最新必要 CI；Mac/Windows 构建、Linux 正式 qualification 均绑定该完整 SHA、同一版本与固定 RC.4。Linux 在原唯一工作流以 main 的 `workflow_dispatch` 完整资格通过后，Release 才接收其 run ID；纯 native-probe、PR 来源、失败任务、过期资产或旧版本不能进入正式资产。

`Product Release` 默认只保存完整资产；明确选择 `publish` 才创建新的 `v1.4.0` tag／草稿，逐项核远端上传大小和 digest 后公开。不移动旧 tag、不覆盖既有资产，不在部分失败后自动删除对象或换源重试。正式包仍需按协调安排补必要平台差异冒烟，不能从 CLI 退出、归档成功或历史通过推定业务验收。

本版不扩大到 HA、集群范围组件、SSO、第二数据库或共享服务代跑成员 Agent。个人专家独立使用／导入、非空 MCP 完整资格、批量反馈、复杂子流程与完整工作树执行、效能统计、其他 CLI 完整资格及跨 CLI 接管仍按原工作项保留。Windows/macOS 正常 UI、跨平台固定文字／文件、指定独立评审、停止排空及重开恢复按准确候选分别认证；未覆盖场景不能以源码检查代替。

自有代码采用 [MIT](../LICENSE)，保留 DSH 与全部第三方许可和真实供应商名称。公开产物不包含成员凭据、会话库、内部资料或签名文件。
