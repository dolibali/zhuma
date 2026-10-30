# Zhuma

<img src="branding/default/icon.png" alt="Zhuma" width="100" />

基于 DeepSeek Harness（DSH）官方 Electron 桌面实现的插件化 AI 工作台。

本仓库是产品主仓：维护自己的任务核心、工程上下文、DSH 适配、客户端和发行配置。DSH 完整源码作为固定提交的 Git 子模块放在 `upstream/deepseek-harness/`，官方桌面入口位于其 `apps/desktop/`，不另外复制一套 Electron 应用。

## 当前状态

已发布基线为 **v1.2.0**，当前开发目标为 **v1.3.0**，自有代码采用 MIT。共享后端保存团队业务，成员在官方桌面明确授权本机 Zhuma Agent 接续处理自己负责的工作节点；任务、交付与评审复用原领域，会话与执行模型凭据仍由成员本机原 Harness 管理。共享后端的 AI 规划使用其自身配置的模型。

源码、Host／Client 契约及历史安装结果按版本分层保留，不能追认后续修改。正常桌面、真实模型＋Skill、同工作区同 Session、文件、独立 Agent 评审与恢复按准确候选分别验收。实时结论以 [交付总索引 #25](https://github.com/dolibali/zhuma/issues/25) 和 [v1.3 工作项 #310](https://github.com/dolibali/zhuma/issues/310) 为准，本轮范围和验证边界见 [v1.3.0 说明](docs/release-v1.3.md)；[v1.2.0 说明](docs/release-v1.2.md) 保留原版本边界。

## 开始使用

1. 取得已核对来源的 macOS arm64 候选 DMG，或按[桌面发行指南](distribution/desktop/README.md)从源码构建。当前候选使用 ad-hoc 临时签名、未公证，不代表正式发布或全平台通过。
2. 全新安装首次打开后创建本机账号、团队并选择基础专家；已有账号从成员登录入口进入。在账号与空间入口选择有权团队。旧单人 profile 的资料与模式不会自动迁移。
3. 在“团队工作台”新建项目和任务，选择参与者。成员任务可用“AI 规划”或“从空白开始”，在列表／工作流中编辑节点、负责人、Skills、依赖和评审人，再保存并确认计划。模板复用的当前入口与限制见[正常操作说明](distribution/workbench/README.md#正常操作)。
4. 使用 AI 前配置相应运行位置的模型：共享 AI 规划由服务操作者在后端官方模型页配置，本机 Agent 在桌面模型页配置。检查节点专家所需的 Skill；无模型也能编排人工任务。规划失败保留输入，不以模板结果冒充 AI 成功。
5. 在“我的工作”开始已确认计划。成员可逐节点“提交产物”或“使用 Agent”，也可选择“运行工作流”，明确本机模型、工作区权限、交付范围与自动返工上限。本机只接续本成员获准处理的节点；其他成员或人工节点进入各自待办，离线时等待，不让后端代跑。查看或重开应用不自动执行，停止后须明确继续。
6. 需要评审的固定文字／文件提交交给指定真人或独立 Agent 专家；自动退回修改受本轮上限约束，真人评审和预算耗尽都等待人工。全部指定评审通过且原运行收口后才接续。下游查看“上游输入”，项目“资料与成果”查看“已接受成果”；会话回复或停止状态本身不等于已交付。

完整入口与执行方式见[工作台组合指南](distribution/workbench/README.md)；本地共享后端部署见[服务说明](distribution/server/README.md)。本轮多成员执行与恢复以同机共享后端及两个隔离成员 Host 为验证边界，实体异机网络、休眠差异另验。非空 MCP、资产／工作流发布版本、批量反馈、复杂子流程与工作树执行、效能统计、完整跨会话通信、个人专家直接使用和外部 CLI 继续后置，范围保留而非完成。

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
- `dsh-adapter` 是 Host 侧接触 DSH 类型与执行接口的边界；码道执行者后续按需实现，不做隐藏自动降级。
- `client` 使用公开 DTO 和 DSH Client 扩展，不导入 Host 实现，不新增第二套执行状态。
- 产品能力通过插件交付；代码包、插件入口、操作系统进程不是一一对应。

详细说明见 [架构](docs/architecture.md)、[开发指南](docs/development.md)、[实施顺序](docs/roadmap.md)。

## 桌面与发行

桌面复用上游 `apps/desktop/`。品牌、插件预装及发行补丁在 `distribution/`、`branding/` 与补丁层维护；在 `.build/` 临时构建树应用，不直接长期修改子模块。当前已有构建集中于 macOS arm64；Windows、Linux 不计为已验证。Developer ID 签名、公证和自动更新尚未提供；正式 v1.2.0 的支持平台、安装限制、签名状态与必要验收按最终发行说明核对。

桌面构建使用可验证的上游补丁和独立临时 Git worktree，避免修改固定子模块。桌面不强制显示 DeepSeek 平台账号欢迎界面；Zhuma 成员登录与供应商模型凭据各走自己的正常入口。macOS 安装包构建指令、签名限制和调试说明见 [桌面发行指南](distribution/desktop/README.md)。

## 许可与公开发布

自有代码采用 [MIT License](LICENSE)。所有包保留 `private: true`，用于防止意外发布到包注册平台。DSH 及其他第三方内容保留各自版权、许可与声明，见 [第三方说明](THIRD_PARTY_NOTICES.md)。发行构建同时携带自有许可证全文和打包依赖的许可文本；资产授权、应用标识和发行配置仍按各自范围验证。
