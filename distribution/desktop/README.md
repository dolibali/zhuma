# Zhuma macOS Desktop 发行指南

Zhuma 使用固定的官方 DSH Electron 实现。所有产品改动保存在 `patches/deepseek-harness/zhuma-desktop.patch`；构建脚本在 `.build/desktop/deepseek-harness/` 创建一次性的 DSH Git worktree，**不修改** `upstream/deepseek-harness/` 的已固定代码。

## 前置条件

- Apple Silicon macOS、Node.js 24、pnpm 12（根项目）、Corepack；上游使用其声明的 pnpm 11。
- 首次构建需能访问 npm 注册表和所需的 DSH/Electron 运行时下载地址。
- 图标源文件为用户确认的 `branding/default/icon-source.png`，保留原始 PNG 字节；`icon-manifest.json` 固定其 SHA-256。桌面 `.icns` 从已提交的无损 PNG 尺寸封装，内部 UI 使用 1×／2×／3× 同源资源，禁止重新绘制。

```bash
cd /path/to/zhuma  # 替换为实际仓库路径
pnpm desktop:prepare             # 创建隔离工作树，应用补丁与品牌图标
pnpm desktop:dev                 # 首次构建上游 Host/Client、启动 Electron 和 DevTools
pnpm desktop:package:mac         # 创建 macOS arm64 未签名发行版（DMG）
pnpm desktop:verify:mac          # 校验安装包名称、App ID、图标、签名和 DMG
```

桌面预览开发应用位于 `.build/desktop/deepseek-harness/apps/desktop/.desktop-build/development/Zhuma Dev.app`，Renderer CDP 默认 `127.0.0.1:9222`，Main/Host 分别为 `9229`/`9230`。切换 DevTools 使用 `Command + Option + I`。

未签名 DMG 输出位于 `.build/desktop/deepseek-harness/apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/`，具体名称以构建产物为准，构建成功后脚本同时复制到项目根目录下**不会提交 Git 的 `dist/`**，方便直接双击安装。此为开发者测试发行；正式分发仍需独立 Apple Developer ID 签名、公证、更新服务和安全验收。勿将其称为已签名正式发行。

## 本地优先，登录策略与数据隔离

Zhuma 桌面冷启动直接进入本地工作台，不再强制弹出 DeepSeek 账号登录/欢迎界面。此修改发生在 Electron 壳的窗口选择逻辑，不伪造服务器账号状态、不修改模型服务身份验证、不自动填入或上传 API Key。用户如需调用在线模型，应在模型设置中自行配置有效的供应商凭据。

使用 `Zhuma` 应用名称和独立的 App ID `dev.zhuma.app`、`zhuma://` URL 协议；`DSH_HOME` 默认隔离在 Zhuma userData 下，避免与另一个 DSH 桌面安装共用工作区。开发版使用上游开发器自己的隔离目录。升级、遥测、登录回调、CLI 命令安装均不应沿用上游官方发布基础设施而未经评审启用。

## 维护和再构建

修改图标导出后，可以在桌面退出且临时工作树仍匹配源码补丁时执行 `pnpm desktop:prepare --refresh-assets`，仅刷新资源。源码补丁不匹配时先检查差异；确认临时树可丢弃后，再执行 `pnpm desktop:reset` 和 `pnpm desktop:prepare`。`desktop:reset` 仅清理专用临时工作树，不删安装版用户资料。上游版本升级必须更新 `runtime.lock.json`，重新校验并调整补丁，不能直接跟随浮动 `master`。

保持 DSH 上游的版权与 MIT 许可声明；公开仓库中的独立 Zhuma 许可另行确定。当前四个自研包仍处于基础骨架阶段。

## 原图一致性验收

`pnpm brand:check` 检查原始 PNG 的固定 SHA-256 和全部导出资源；`pnpm desktop:verify:mac` 继续检查安装包内 ICNS 与本次准备的 ICNS 完全相同。运行时通过 CDP 读取两个品牌图标的实际 `currentSrc`、像素密度和响应字节摘要，确认窗口加载的是原图导出而不是缓存中的旧图。修订安装包采用 `brand.json` 的独立构建版本，保留旧包作为历史，不将同名旧包误认为已修复。
