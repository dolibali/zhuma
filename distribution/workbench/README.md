# 工作台组合发行

工作台使用 `@zhuma` 自有领域、Host 和 Client 代码，装载于固定版本 DSH 官方 Web/Desktop Bundle。

## 正常操作

以下描述当前核心闭环的正常入口，适用于配套 Host／Client 的成员模式，不代表最终候选已完成每一步真实模型或安装验收。候选支持平台、安装及签名限制见[桌面发行指南](../desktop/README.md)，实时证据见 [#25](https://github.com/dolibali/zhuma/issues/25)。

1. **建立账号与团队**：全新 profile 的首次设置中填写本机账号、密码和团队名称，选择公开基础专家；完成后登录并进入所建团队。已有账号从成员登录入口进入，通过账号与空间入口切换有权团队；正常用户无需手改配置文件。
2. **建立项目与任务**：在“团队工作台”创建项目，再创建任务、描述目标并选择参与真人／专家。当前成员入口支持“AI 规划”和“从空白开始”；AI 提案先预览、应用后仍可编辑，手动模式直接编排。第三种“使用工作流”模板复用目前只在旧单人定义界面开放，成员侧基本复用尚未接入，继续保留在 [#36](https://github.com/dolibali/zhuma/issues/36)／[FR02 范围账本](../../docs/product-coverage.md)中。基本复用与后置的工作流发布版本是两项能力，不通过旧单人入口替代成员授权。
3. **配置并确认工作**：列表／工作流视图共用同一计划。选择节点，在“配置”中设置负责人、Skills、前置依赖、是否需要评审和多位真人／专家评审人；选择专家后检查必需能力，缺少时先补齐。保存草稿，再确认准确计划版本。确认计划不等于已开始执行。
4. **配置模型与执行资源**：AI 规划或 Agent 执行前，在设置的模型页保存自己的供应商凭据和模型选择；不需要在需求、Skill 或上传文件中填写密钥。节点使用已确认的专家与 Skill，运行时明确选择可用模型、执行者及工作区。没有模型也可以完成手动编排和人工交付；MCP 定义不等于已建立可用连接。
5. **显式开始**：含 Agent 节点或 Agent 评审时，由负责人在任务详情点击“运行工作流”，确认模型、工作区和并行上限后运行。纯人工计划在“我的工作”的已确认计划入口点击“开始执行”。分配给人的工作出现在“需要我处理”；可“提交产物”，也可“使用 Agent”或从处理中工作项“打开 Agent 会话”。打开、刷新或重新登录不会自动运行或重新发送。
6. **提交与评审**：交付支持输入正文、参考链接和上传真实文件，保存草稿后显式提交。会话回复、运行结束或停止都不冒充业务提交。评审人查看本轮固定版本的正文与文件，填写评审意见，通过或退回；退回后负责人在“退回意见”对照版本，修改并重新提交。Agent 专家评审沿已运行工作流处理同一固定版本；其真实供应商闭环仍需最终验收。
7. **接续与成果**：需评审的节点在全部指定评审人通过后才解锁后继；无需评审的节点按实际提交结果接续。下游在“上游输入”展开已接受版本，项目“资料与成果”查看“已接受成果”。可内联的文本文件提供预览，其他格式提供下载；不把引用信息或完成标签当作已读取、已接受的文件。

旧单人 profile 的项目、专家和资产定义保留原入口，但不会自动迁入团队。非空 MCP、资产／工作流发布版本、批量反馈、复杂子流程与工作树执行、效能统计、个人专家直接使用和外部 CLI 的后置边界见 [v1.0.0 范围说明](../../docs/release-v1.0.md)。

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
- S1a 组合入口要求显式 `deploymentMode`；Bundle 的 legacy 默认用于已有 profile 兼容，全新桌面选择成员模式。`multi-member` 在流式读体前关闭以上全部旧接口，包括 `command` 的 `import-package`，不因身份依赖失败回落 owner。默认读体限制 8 MiB／10 秒，可显式调整；私有初始化只配置凭据记录地址。接口与历史证据见 [Host 身份接入](../../docs/host-identity-integration.md)，不能用旧单人接口代替当前成员入口。
- 多人成员执行及可信目录的正式装配、`spaceDirectoryBootstrapKey` 私有初始化来源和失败关闭语义见 [成员执行入口装配](../../docs/contracts/execution-host-entry.md)。成员“团队工作台”提供当前有权空间的项目／任务读取、创建、编辑、保存和确认，“我的工作”提供实际执行待办。AI 规划仅在明确提交规划操作时使用 Host 当前模型。首次设置已接入同一 [团队基础专家目录](../../docs/contracts/host-team-catalog.md) 的原包与默认 Skill；目录启用和计划确认均不授予执行权限。
- 数据保存在当前 DSH home 的 `zhuma_workbench` storage domain，关闭重开继续读取。真实凭据继续由 DSH 的凭据服务管理，不在工作台目录模型中保存。
- 已确认计划是不可变快照；任务草稿和执行端状态分开。A/B 接口方案见 [交接提案](../../docs/ab-handoff-proposal.md)。
- `desktop:package:mac` 已挂接插件构建与组合，当前已有 macOS arm64 工程候选及限定安装记录；最新候选的正常界面、真实模型与安装／恢复按准确版本分别验收，不以开发环境加载或历史安装成功代替。

## 验证

`pnpm check` 不调用付费模型。规划测试使用明确命名的契约 fixture，覆盖非法引用、循环、缺失输出、一次修复、取消、版本冲突和幂等。真实模型和浏览器结果另记在 [验证记录](../../docs/workbench-validation.md)。

`pnpm test:host` 构建并以真实已发布 DSH 服务测试完全相同的 Host 发行文件，使用临时私有 home、合成凭据和拒绝模型调用的端口。它不等于安装包、三账号人工交付或原生 Agent 验收；[服务与历史单人原生桌面证据](../../docs/review/s1a-host/README.md)按各自来源 SHA 和环境分别记录，不能认证后续新增组合。
