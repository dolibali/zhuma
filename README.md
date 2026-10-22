# Zhuma

<img src="branding/default/icon.png" alt="Zhuma" width="100" />

基于 DeepSeek Harness（DSH）官方 Electron 桌面实现的插件化 AI 工作台。

本仓库是产品主仓：维护自己的任务核心、工程上下文、DSH 适配、客户端和发行配置。DSH 完整源码作为固定提交的 Git 子模块放在 `upstream/deepseek-harness/`，官方桌面入口位于其 `apps/desktop/`，不另外复制一套 Electron 应用。

## 当前状态

已在四包边界上实现第一批组织与编排能力：项目、成员与专家、资产定义、任务参与者、列表/画布编辑、嵌套草稿和模型规划提案。Host/Client 插件挂载到官方 DSH，数据由 DSH storage domain 保存。启动方式见 [工作台集成](distribution/workbench/README.md)，实现边界见 [A 开发记录](docs/development-a.md)。

当前是单个本地 Host 的开发版本。多人登录与授权、执行待办、产物与评审服务由后续工作包接入；完整多层任务权限及安装包尚未验收。模型规划需要在 DSH 中配置模型；不会用固定模板替代失败的真实调用。

## 开发准备

- 本仓工具链：Node.js `24.15.0`、pnpm `12.4.2`。
- 上游基线：DSH `dsh-v0.2.1-rc.2`，精确提交和独立工具链见 [runtime.lock.json](runtime.lock.json)。这是候选发布版本，不代表已完成本产品桌面集成验收。
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
│   └── client/                 # 多视图模型，后续接入 DSH Web Client
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
- `dsh-adapter` 是 Host 侧接触 DSH 类型与执行接口的边界；码道执行者后续按需实现，不做隐藏自动降级。
- `client` 使用公开 DTO 和 DSH Client 扩展，不导入 Host 实现，不新增第二套执行状态。
- 产品能力通过插件交付；代码包、插件入口、操作系统进程不是一一对应。

详细说明见 [架构](docs/architecture.md)、[开发指南](docs/development.md)、[实施顺序](docs/roadmap.md)。

## 桌面与发行

正式产品将复用上游 `apps/desktop/`。品牌、插件预装、更新和签名在 `distribution/`、`branding/` 与补丁层完成；在 `.build/` 临时构建树应用，不直接长期修改子模块。

桌面构建使用可验证的上游补丁和独立临时 Git worktree，避免修改固定子模块。开发版直接进入本地工作台，不强制显示 DeepSeek 账号欢迎界面；使用模型仍需配置相应供应商凭据。macOS 安装包构建指令、签名限制和调试说明见 [桌面发行指南](distribution/desktop/README.md)。

## 许可与公开发布

代码仓库公开可见，自有代码的对外许可证尚未确定，继续标记 `UNLICENSED`，许可声明见 [LICENSE](LICENSE)。所有包保留 `private: true`，用于防止意外发布到包注册平台，不影响 GitHub 仓库的公开可见性。DSH 及其他第三方内容保留各自许可；其 MIT 许可不会自动成为本仓全部代码的许可。正式分发前另行确定自有许可、资产授权、独立应用标识和发行配置，见 [第三方说明](THIRD_PARTY_NOTICES.md)。
