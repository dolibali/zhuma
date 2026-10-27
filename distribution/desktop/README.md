# Zhuma macOS Desktop 发行指南

Zhuma 使用固定的官方 DSH Electron 实现，自有工作台通过插件预装，必要的上游改动保存在 `patches/deepseek-harness/zhuma-desktop.patch`。构建脚本在 `.build/desktop/deepseek-harness/` 创建一次性的 DSH Git worktree，**不修改** `upstream/deepseek-harness/` 的已固定代码。

## 安装与首发边界

目标产品版本为 `1.0.0`，计划 tag 为 `v1.0.0`；工程包、Draft PR 或候选资产不等于正式 Release。当前已有候选构建集中于 **macOS arm64（Apple Silicon）**，使用 ad-hoc 临时签名、未公证，不认证 Intel Mac、Windows 或 Linux。正式分发仍需签名、公证与最终发行资产核对。

安装时打开已核对来源的候选 DMG，将 Zhuma 拖入 Applications 后运行。正常首次账号／团队、模型与交付入口见[工作台正常操作](../workbench/README.md#正常操作)。已有 profile 不因安装新包而自动迁移或更改部署模式。

源码／服务契约、历史安装操作与最终候选验收分别留证。最新候选的正常界面、真实模型＋Skill、独立 Agent 评审、下游及安装／恢复尚须完成对应实际验证；实时结果见 [#25](https://github.com/dolibali/zhuma/issues/25)，不从构建成功或既往记录推定全链路通过。首发后置范围见 [v1.0.0 说明](../../docs/release-v1.0.md)。

## 前置条件

- Apple Silicon macOS、Node.js 24、pnpm 12（根项目）、Corepack；上游使用其声明的 pnpm 11。
- 首次构建需能访问 npm 注册表和所需的 DSH/Electron 运行时下载地址。
- 图标源文件为用户确认的 `branding/default/icon-source.png`，保留原始 PNG 字节；`icon-manifest.json` 固定其 SHA-256。桌面 `.icns` 从已提交的无损 PNG 尺寸封装，内部 UI 使用 1×／2×／3× 同源资源，禁止重新绘制。

```bash
cd /path/to/zhuma  # 替换为实际仓库路径
pnpm desktop:prepare             # 创建隔离工作树，应用补丁与品牌图标
pnpm desktop:dev                 # 首次构建上游 Host/Client、启动 Electron 和 DevTools
pnpm desktop:package:mac         # 创建 macOS arm64 工程候选 DMG
pnpm desktop:verify:mac          # 校验安装包名称、App ID、图标、签名和 DMG
```

桌面预览开发应用位于 `.build/desktop/deepseek-harness/apps/desktop/.desktop-build/development/Zhuma Dev.app`，Renderer CDP 默认 `127.0.0.1:9222`，Main/Host 分别为 `9229`/`9230`。切换 DevTools 使用 `Command + Option + I`。

候选 DMG 输出位于 `.build/desktop/deepseek-harness/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/`，具体名称以构建产物为准，构建成功后脚本同时复制到项目根目录下**不会提交 Git 的 `dist/`**。目录名沿用 `unsigned-artifacts`；当前验收候选采用 ad-hoc 临时签名，与 Apple Developer ID 签名和公证不同。此为开发者测试包；正式分发仍需正式签名、公证、更新服务和安全验收。

## 本地优先，登录策略与数据隔离

全新桌面外部 profile 首次创建时，仅在 `package.json` 和 `cordis.patch.yml` 均不存在的情况下写入 `deploymentMode: multi-member` 与 `localSetup: true`，进入首次成员设置。已有 profile 保留其显式或继承的模式与数据，不自动迁移；Bundle 中的 `legacy-single-user` 默认用于旧 profile 兼容，不代表全新安装的默认模式。已有 profile 的成员模式迁移需独立实施和验收。

成员模式的原生HTTP登录运输使用壳内单槽载体，复用现有Host签发／校验与执行权限；所有Set-Cookie仍不回renderer。窗口重载可恢复同一Host会话，整App／Host换代需重新登录，业务数据仍由原持久存储恢复。格式、路径、来源、退出与迟到回执边界见[桌面成员运输契约](../../docs/contracts/desktop-member-cookie.md)；实现／契约测试不等于原生安装版验收。

Zhuma 桌面不强制弹出 DeepSeek 平台账号登录／欢迎界面；成员模式仍通过本机首次设置或成员登录进入工作台。此修改发生在 Electron 壳的窗口选择逻辑，不伪造服务器账号状态、不修改模型服务身份验证、不自动填入或上传 API Key。用户如需调用在线模型，应在模型设置中自行配置有效的供应商凭据。

使用 `Zhuma` 应用名称和独立的 App ID `dev.zhuma.app`、`zhuma://` URL 协议；`DSH_HOME` 默认隔离在 Zhuma userData 下，避免与另一个 DSH 桌面安装共用工作区。开发版使用上游开发器自己的隔离目录。升级、遥测、登录回调、CLI 命令安装均不应沿用上游官方发布基础设施而未经评审启用。

## 维护和再构建

修改图标导出后，可以在桌面退出且临时工作树仍匹配源码补丁时执行 `pnpm desktop:prepare --refresh-assets`，仅刷新资源。源码补丁不匹配时先检查差异；确认临时树可丢弃后，再执行 `pnpm desktop:reset` 和 `pnpm desktop:prepare`。`desktop:reset` 仅清理专用临时工作树，不删安装版用户资料。上游版本升级必须更新 `runtime.lock.json`，重新校验并调整补丁，不能直接跟随浮动 `master`。

Zhuma 自有代码采用 [MIT 许可](../../LICENSE)。DSH 上游及其他第三方的版权和许可声明均保留，见[第三方说明](../../THIRD_PARTY_NOTICES.md)；发行包同时携带自有许可与打包依赖的许可文本。

## 持续会话的队列保留能力

发行补丁为可信 Host 生命周期拥有者提供 `retainPendingInboxOnDispose`：在 `ctx.agents.lifecycleCapabilities.retainPendingInboxOnDispose === true` 时，方可在 `agents.create`／`resume` 顶层选项显式开启。A 的 `requireNativeInboxRetention` 提供公开兼容类型与能力检查；未补丁 npm SDK、缺失／不支持的 factory 关闭该能力，不能以接受未知字段判断支持。实际发行绑定固定上游、补丁 SHA-256 和准备配方摘要，不只判断同为 `0.2.1-rc.2`。

默认仍销毁并取消队列；只有成功发布且 opt-in 的会话在销毁时保留未消费输入。销毁先封住该实例的新输入和唤醒，再取消、等待静止、关闭持久句柄；保留不代表自动重放。默认 child、配置与失败 setup 的清理不变，显式清空仍持久取消。该选项是 Host 策略，不是 Client／模型权限；真实成员 Run、撤权、工作区和工具授权仍由业务接缝验证。

在已安装固定上游测试工具链后执行 `pnpm desktop:verify:native-lifecycle`，也可用 `--upstream /path/to/fixed-upstream` 指定精确检出。脚本仅在独立临时 Git worktree 应用完整发行补丁，运行既有取消／child 清理回归、新 opt-in 与挂起唤醒用例，并以两个独立 Node 进程验证同盘关闭／恢复没有自动模型请求。测试使用本地脚本 Adapter，输出补丁／夹具摘要及分层证据；它不认证真实模型、产品 Run 授权或已安装桌面。失败证据保留，不修改固定上游、gitlink 或用户应用数据。

同一入口还定向检查配套布局守卫：编译当前 LayoutController（依赖按原项目引用边界构建），运行官方原用例与新增导航负例，核对一次确认、目标注销、New Session／工作区返回 Conversation、后续导航／卸载／异常抑制。该层是实际补丁布局对象测试，不驱动浏览器，也不替代真实窗口、取消回焦和慢业务回执验收。

## 原图一致性验收

`pnpm brand:check` 检查原始 PNG 的固定 SHA-256 和全部导出资源；`pnpm desktop:verify:mac` 继续检查安装包内 ICNS 与本次准备的 ICNS 完全相同。运行时通过 CDP 读取两个品牌图标的实际 `currentSrc`、像素密度和响应字节摘要，确认窗口加载的是原图导出而不是缓存中的旧图。修订安装包采用 `brand.json` 的独立构建版本，保留旧包作为历史，不将同名旧包误认为已修复。

## 外侧黑边修复

构建 `0.2.1-rc.2.20261021.3` 使用 `icon-transparent.png` 派生母版：只改外部透明度，原图保持不变；蓝色圆角内的图案和背景保留。Dock、Finder、内部侧边栏、首页及分享卡片统一使用这套资源。

维护者执行 `python3 branding/default/export_icons.py --check` 验证像素；CI 的 `pnpm brand:check` 验证原始 RGB 与 alpha 规则。实际启动应用后执行 `pnpm desktop:verify:icons` 校验 UI 资源字节、四角透明度、无 CSS 背景／阴影并保存真实窗口截图。需要临时用回环 CDP 端口 9333 启动对应应用；正式正常启动不主动开启调试端口。
