# Zhuma

<img src="branding/default/icon.png" alt="Zhuma" width="100" />

基于 DeepSeek Harness（DSH）官方 Electron 桌面实现的插件化 AI 工作台。

本仓库是产品主仓：维护自己的任务核心、工程上下文、DSH 适配、客户端和发行配置。DSH 完整源码作为固定提交的 Git 子模块放在 `upstream/deepseek-harness/`，官方桌面入口位于其 `apps/desktop/`，不另外复制一套 Electron 应用。

## 当前状态

当前源码版本为 **v1.5.0**，本版范围与实际验收见[发行说明](docs/release-v1.5.0.md)和[工作项 #394](https://github.com/dolibali/zhuma/issues/394)。已公开的 [v1.4.0](https://github.com/dolibali/zhuma/releases/tag/v1.4.0) 包含 Windows x64、macOS arm64 客户端与 Linux amd64 共享服务；新版是否已公开以 [Releases](https://github.com/dolibali/zhuma/releases) 为准。共享后端保存团队业务并提供 AI 规划，成员在自己的桌面授权本机 Agent 处理工作节点，会话与执行模型凭据仍由成员本机原 Harness 管理。

实时交付以[总索引 #25](https://github.com/dolibali/zhuma/issues/25)和对应工作项为准。源码、契约、真实 Host／正常界面、模型工程结果和安装分别留证；历史通过不认证新修改。[v1.4.0](docs/release-v1.4.md)、[v1.3.0](docs/release-v1.3.md)和[v1.2.0](docs/release-v1.2.md)说明保留各自的原资产与验证边界。

## 开始使用

1. 从对应 Release 选择 Windows x64 安装器或 macOS arm64 DMG，并核对 `SOURCE.json` 与 `SHA256SUMS`。Windows 当前未签名；macOS 使用 ad-hoc 签名、未公证。源码构建见[桌面发行指南](distribution/desktop/README.md)。
2. 全新安装首次打开后创建本机账号、团队并选择基础专家；已有账号从成员登录入口进入。在账号与空间入口选择有权团队。旧单人 profile 的资料与模式不会自动迁移。
3. 在“团队工作台”新建项目和任务，选择参与者。可选“AI 规划”“使用工作流”或“从空白开始”，在列表／工作流中编辑节点、负责人、Skills、依赖和评审人，再保存并确认计划。模板复用的入口与限制见[正常操作说明](distribution/workbench/README.md#正常操作)。
4. 使用 AI 前配置相应运行位置的模型：共享 AI 规划由服务操作者在后端官方模型页配置，本机 Agent 在桌面模型页配置。检查节点专家所需的 Skill；无模型也能编排人工任务。规划失败保留输入，不以模板结果冒充 AI 成功。
5. 在“我的工作”开始已确认计划。成员可逐节点“提交产物”或“使用 Agent”，也可选择“运行工作流”，明确本机模型、工作区权限、交付范围与自动返工上限。本机只接续本成员获准处理的节点；其他成员或人工节点进入各自待办，离线时等待，不让后端代跑。查看或重开应用不自动执行，停止后须明确继续。
6. 需要评审的固定文字／文件提交交给指定真人或独立 Agent 专家；自动退回修改受本轮上限约束，真人评审和预算耗尽都等待人工。全部指定评审通过且原运行收口后才接续。下游查看“上游输入”，项目“资料与成果”查看“已接受成果”；会话回复或停止状态本身不等于已交付。

完整入口与执行方式见[工作台组合指南](distribution/workbench/README.md)；共享后端部署见[服务说明](distribution/server/README.md)。v1.4.0 已记录正式 Windows／macOS 启动、共享服务协作、固定交付与评审、任务和会话历史恢复；v1.5.0 的新增部分按 #394 另行验证。非空 MCP、内置效能统计、复杂子流程与完整工作树执行、个人专家独立使用、更多 CLI 完整资格及跨 CLI 接管继续后置。工程案例中的项目测试不等于平台已实现通用质量门禁。

## 开发准备

- 本仓工具链：Node.js `24.15.0`、pnpm `12.4.2`。
- 上游基线：DSH `dsh-v0.2.1-rc.4`，精确提交和独立工具链见 [runtime.lock.json](runtime.lock.json)。这是候选发布版本，不代表已完成本产品桌面集成验收。
- DSH 上游使用自己的 pnpm 版本和锁文件；不要将其包纳入本仓 Workspace。

在项目根目录执行：

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm check
pnpm upstream:check
```

在其他机器克隆时，请同时获取固定版本的 DSH 子模块：

```bash
git clone --recurse-submodules https://github.com/dolibali/zhuma.git
cd zhuma
```

项目仓库：<https://github.com/dolibali/zhuma>。

`pnpm check` 检查本仓源码、类型、格式、包边界和单元测试；`pnpm upstream:check` 检查 DSH 提交及工作树。两者都不构建 DSH 桌面、不调用模型、不访问生产系统，也不改动用户的 DSH 安装。

工作台浏览器契约冒烟使用 `pnpm test:ui`，在独立临时页面中验证创建、编辑、连续规划和恢复交互。安装浏览器、CI 覆盖范围及响应重放边界见 [测试说明](tests/README.md)；它不替代真实 Host 或桌面验收。

## 目录

```text
zhuma/
├── upstream/deepseek-harness/   # 官方完整源码，固定提交
├── packages/
│   ├── agent-core/             # 任务、计划、协作与结果的领域契约
│   ├── context/                # 工程知识、来源与任务上下文
│   ├── dsh-adapter/            # DSH Host 适配与执行者边界
│   └── client/                 # DSH Web Client 工作台、成员待办与会话界面
├── distribution/               # 桌面与 Bundle/Profile 发行集成
├── branding/default/           # 中性公开品牌配置
├── patches/deepseek-harness/   # 必要的上游补丁
├── resources/                  # Skills、Rules、专家、流程资源
├── tests/                      # 集成、桌面与目标工程测试约定
├── docs/                       # 架构、开发和实施顺序
├── third_party/                # 上游来源及复用说明
└── scripts/                    # 构建、测试与环境检查
```

## 开发边界

- `agent-core` 管理工作台任务与协作，不重写 DSH Agent Loop、模型协议或 MCP 客户端。
- `context` 提供有来源和版本的上下文，不管理 Agent 生命周期。
- `dsh-adapter` 是 Host 侧接触 DSH 类型与执行接口的边界；码道适配沿附加 ACP 与明确的本机配置接入，真实 CLI 资格按准确候选验收，不做隐藏自动降级。
- `client` 使用公开 DTO 和 DSH Client 扩展，不导入 Host 实现，不新增第二套执行状态。
- 产品能力通过插件交付；代码包、插件入口、操作系统进程不是一一对应。

详细说明见 [架构](docs/architecture.md)、[开发指南](docs/development.md)、[实施顺序](docs/roadmap.md)。

## 桌面与发行

桌面复用上游 `apps/desktop/`。品牌、插件预装及发行补丁在 `distribution/`、`branding/` 与补丁层维护，在 `.build/` 临时构建树应用。Windows x64、macOS arm64 与 Linux amd64 服务沿同一准确 main 来源分别构建和核验；Linux 为共享服务包，尚无 Linux 桌面支持。Developer ID、公证、Authenticode 和自动更新尚未提供。安装限制和本版验证范围见[发行说明](docs/release-v1.5.0.md)。

桌面构建使用可验证的上游补丁和独立临时 Git worktree，避免修改固定子模块。桌面不强制显示 DeepSeek 平台账号欢迎界面；Zhuma 成员登录与供应商模型凭据各走自己的正常入口。macOS 安装包构建指令、签名限制和调试说明见 [桌面发行指南](distribution/desktop/README.md)。

## 许可与公开发布

自有代码采用 [MIT License](LICENSE)。所有包保留 `private: true`，用于防止意外发布到包注册平台。DSH 及其他第三方内容保留各自版权、许可与声明，见 [第三方说明](THIRD_PARTY_NOTICES.md)。发行构建同时携带自有许可证全文和打包依赖的许可文本；资产授权、应用标识和发行配置仍按各自范围验证。
