# 工作台组合发行

工作台使用 `@zhuma` 自有领域、Host 和 Client 代码，装载于固定版本 DSH 官方 Web/Desktop Bundle。

## 开发

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm desktop:prepare
pnpm desktop:dev
```

`desktop:dev` 在隔离的官方构建树完成上游依赖和编译，自有插件从源码构建后自动安装。已有构建树只刷新插件可运行 `pnpm workbench:stage`；Host 代码更新后需要重启开发进程，客户端热更新不能证明 Host 已换代。没有准备构建树时该命令失败，不隐式创建第二套运行时。

组合补丁隐藏定时任务、插件市场和账号设置入口，保留对话、模型设置与执行能力。配置由 `cordis.patch.yml` 管理；品牌和原有上游必要补丁仍由桌面发行层维护。成员“团队工作台／我的工作”导航需要同版本布局补丁提供离开守卫；仅替换插件到未补丁的旧布局时会明确拒绝装配，需刷新配套发行文件。默认单人模式不依赖这项新能力。

## 边界

产品 Bundle 默认设置 `session-log-deepseek.enabled: false`，不默认向模型请求附加会话日志；保留官方 Session Log 设置供用户主动开启，不修改上游插件默认或移除功能。Profile 在 Bundle 之后应用，已有 profile 的自定义 `config` 整体覆盖 Bundle（包括仅设置 `maxBytes` 的旧配置，省略 `enabled` 时仍使用上游默认 `true`）；本补丁不迁移旧 profile。此项只改变会话日志附加字段的默认值，不改变用户主动发送给模型的任务与消息。

全新桌面 profile 首次生成时显式设置 `multi-member + localSetup`，正常首屏创建账号、个人／团队空间并选择基础专家，见 [本机首次成员设置](../../docs/contracts/local-member-setup.md)。已有 profile 保持其原显式配置；Bundle 的 legacy 继承默认保留，不因升级自动迁移旧单人库。

- `.build/workbench` 是可再生的 Host/Client 插件产物；安装脚本只修改 `.build/desktop/deepseek-harness` 的 Web Bundle，不修改 `upstream/deepseek-harness`。
- 浏览器 React 由 DSH 的模块加载器提供，避免加载第二个 React。画布使用 React Flow。
- HTTP 接入采用 Connection 公开的 exact Fetch routes，路径 `/api/zhuma/{snapshot,command,plan,preview-import,resource-files}`，使用官方 RPC 请求/响应信封。认证、Host/Origin 校验和 owner-only 限制由 Connection 执行。已有 `/api` RPC 拦截器保留给官方网关。
- S1a 组合入口已随 [PR #23](https://github.com/dolibali/zhuma/pull/23)／[PR #48](https://github.com/dolibali/zhuma/pull/48) 合入 main `843661c`，要求显式 `deploymentMode`；发行补丁明确为 `legacy-single-user`。`multi-member` 在流式读体前关闭以上全部旧接口，包括 `command` 的 `import-package`，不因身份依赖失败回落 owner。默认读体限制 8 MiB／10 秒，可显式调整；私有初始化只配置凭据记录地址。接口、原验证版本与剩余边界见 [Host 身份接入](../../docs/host-identity-integration.md)，不代表成员业务 UI 或人工交付闭环已完成。
- 多人成员执行及可信目录的正式装配、`spaceDirectoryBootstrapKey` 私有初始化来源和失败关闭语义见 [成员执行入口装配](../../docs/contracts/execution-host-entry.md)。默认发行仍为 legacy。显式 multi-member 的“工作台”提供当前有权空间的项目／任务读取、创建、编辑、保存和确认，确认后可到“待我处理”显式开始；打开、刷新和确认均不自动执行。手动编排无需模型；AI 规划仅在明确提交规划操作时使用 Host 的当前模型。团队基础专家通过显式 Host 选择接入原包及默认 Skill，见 [团队基础专家目录](../../docs/contracts/host-team-catalog.md)；正常首次初始化入口仍待接续。目录启用和已确认计划均不授予 Agent 执行权限。
- 数据保存在当前 DSH home 的 `zhuma_workbench` storage domain，关闭重开继续读取。真实凭据继续由 DSH 的凭据服务管理，不在工作台目录模型中保存。
- 已确认计划是不可变快照；任务草稿和执行端状态分开。A/B 接口方案见 [交接提案](../../docs/ab-handoff-proposal.md)。
- `desktop:package:mac` 已挂接插件构建与组合，但本批没有生成或安装新的 macOS 包；开发环境加载成功不替代安装包验收。

## 验证

`pnpm check` 不调用付费模型。规划测试使用明确命名的契约 fixture，覆盖非法引用、循环、缺失输出、一次修复、取消、版本冲突和幂等。真实模型和浏览器结果另记在 [验证记录](../../docs/workbench-validation.md)。

`pnpm test:host` 构建并以真实已发布 DSH 服务测试完全相同的 Host 发行文件，使用临时私有 home、合成凭据和拒绝模型调用的端口。它不等于安装包、三账号人工交付或原生 Agent 验收；[服务与历史单人原生桌面证据](../../docs/review/s1a-host/README.md)按各自来源 SHA 和环境分别记录，不能认证后续新增组合。
