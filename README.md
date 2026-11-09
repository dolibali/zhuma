# 铸码 Zhuma

<img src="branding/default/icon.png" alt="铸码 Zhuma" width="100" />

面向团队的人与 Agent 协作工作台。从一个目标出发，编排工作流、分配成员与专家、执行任务、提交产物，再通过评审接续下一步，让每个人都能看清当前要做什么、交付什么。

## 核心功能

- **从目标到计划**：用 AI 规划、复用团队工作流或从空白开始；生成的计划可继续自由编辑，明确每步负责人、技能、前置工作和评审人。
- **看清工作流**：在列表与工作流视图中编排节点、拖动和连线；默认突出执行顺序，随时展开全部依赖，在工作树中定位当前节点及相关子工作流。
- **处理我的工作**：从个人待办进入需要处理的节点或评审；人工完成，或在本机选择模型和 Agent 专家执行，明确工作区与文件交付范围。
- **交付与评审**：提交文字和文件，按固定版本查看内容、评论、退回修改与重新提交；指定评审通过后，后续节点使用已接受产物。
- **沉淀团队资产**：围绕项目管理任务、资料与成果，维护工作流、Skills 和专家的草稿与发布版本，支持导入和复用。
- **持续协作**：在同一工作会话中补充要求、停止或明确继续；成员姓名和分工在任务、节点及评审中保持可识别。

## 下载与支持平台

[下载正式版本](https://github.com/dolibali/zhuma/releases/latest) · [查看全部版本](https://github.com/dolibali/zhuma/releases) · [v1.5.1 发行说明](docs/release-v1.5.1.md)

| 平台                | 下载内容                           |
| ------------------- | ---------------------------------- |
| Windows x64         | 桌面安装器，文件名含 `windows-x64` |
| macOS Apple Silicon | arm64 桌面 DMG                     |
| Linux amd64         | 共享服务镜像、便携服务包及部署材料 |

下载后核对同版 `SOURCE.json` 和 `SHA256SUMS`。Windows 安装器当前未签名，macOS 为 ad-hoc 签名、未公证；自动更新尚未提供。Linux 提供共享服务，不提供桌面客户端。可下载文件及发布状态以正式 Release 为准。

## 快速上手

1. **安装并登录**：选择对应平台的正式安装包。首次使用创建本机账号和团队；接入团队共享服务时，在“连接设置”填写操作者提供的服务地址，使用该服务的成员账号登录。
2. **创建任务**：在“团队工作台”新建项目和任务，描述目标，选择参与的成员与 Agent 专家。
3. **编排计划**：选择“AI 规划”“使用工作流”或“从空白开始”，调整节点、分工、依赖及评审人，保存并确认计划。使用 AI 规划前，需要由服务操作者配置规划模型；人工编排不要求模型。
4. **开始处理**：进入“我的工作”，提交人工产物，或选择“使用 Agent”“运行工作流”。执行前配置本机模型，并确认工作区权限和交付范围；查看任务或重开应用不会自动执行。
5. **提交与评审**：提交文字或文件，由指定真人或独立 Agent 专家评审。收到退回意见后修改重提；全部指定评审通过且本轮运行结束后接续下游。
6. **查看成果**：在节点“上游输入”和项目“资料与成果”查看已接受内容。“我的工作”标题右侧的“导出”菜单可下载已记录数据的 JSON 或 CSV。

完整操作见[工作台使用指南](distribution/workbench/README.md#正常操作)。客户端安装不会自动升级团队共享服务，已有数据与配置的升级安排见[服务部署说明](distribution/server/README.md)和本版发行说明。

## 项目结构与源码启动

```text
packages/       产品领域、上下文、运行适配与客户端代码
resources/      工作流、技能和专家资源
scripts/        开发、构建与检查入口
distribution/   桌面、共享服务与部署模板
docs/           架构、运行及开发说明
tests/          分层验证约定
examples/       独立示例与演示项目
```

源码环境使用 Node.js **24.15.0**、pnpm **12.4.2** 和可用的 Corepack、Git。安装版桌面无需这套源码工具；Linux 便携服务包的运行要求单独见指南。

在完成工具安装后，从自选目录取得完整源码并准备桌面构建目录：

```sh
git clone --recurse-submodules https://github.com/dolibali/zhuma.git
cd zhuma
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm desktop:prepare
```

桌面源码入口面向 macOS arm64 和 Windows x64。启动前先按[指南第 3 节](docs/getting-started.md#3-从源码启动桌面)为当前平台设置新的状态目录，再执行 `pnpm desktop:dev`，避免复用已安装应用的 profile。完整依赖准备、可选共享后端、Linux 便携/镜像启动、端口与数据保留见[源码运行与本地部署指南](docs/getting-started.md)。根 Workspace 保持独立，具体分包和实现来源见技术文档。

## 技术文档

| 文档                                           | 内容                         |
| ---------------------------------------------- | ---------------------------- |
| [源码运行与本地部署](docs/getting-started.md)  | 从克隆到启动、配置和停止     |
| [开发指南](docs/development.md)                | 环境准备、开发命令与协作约定 |
| [架构说明](docs/architecture.md)               | 模块边界、接口与实现来源     |
| [桌面发行指南](distribution/desktop/README.md) | 源码构建、平台打包与来源核验 |
| [共享服务部署](distribution/server/README.md)  | 服务运行、配置与数据保留     |
| [测试说明](tests/README.md)                    | 各层验证方法及证据边界       |
| [产品范围](docs/product-coverage.md)           | 已有能力、保留范围与退出条件 |

v1.5.1 范围与发行记录见[工作项 #449](https://github.com/dolibali/zhuma/issues/449)，协作入口见[总索引 #25](https://github.com/dolibali/zhuma/issues/25)。

## 许可

自有代码采用 [MIT License](LICENSE)。依赖和资源保留各自的版权、许可与来源，见[第三方说明](THIRD_PARTY_NOTICES.md)；发行包同时携带相应许可文件。
