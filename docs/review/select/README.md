# A-UI-controls：锚定菜单与桌面顶栏

状态：本地实现待评审。基线 main `2f7d8d7`。截图只包含独立测试目录内的公开虚构项目；未上传用户原图。

## 行为与边界

项目、目录类型、创建表单、外观共用 SingleSelect。短列表使用 Select，超过 8 项使用带搜索的 Combobox；默认在按钮下方相隔 5px，窗口边缘自动移位/翻转，列表最多 320px 并受实际可用高度限制。选项和按钮均为 13px，主题来自现有官方 theme 服务。原生 dialog 内的菜单 portal 到 dialog，Esc 只关闭菜单，Tab 可以离开；禁用项遵循原语的可聚焦语义，但不能提交或改值。

外观使用太阳/月亮/显示器图标，tooltip 显示当前模式，展开后仍有模式名称和选中标记。桌面主面板消费官方 `--dsh-frame-top-clearance`，独立 48px 顶栏与正文滚动区域分离，使用官方 `data-window-drag` 标记。没有改上游源码或引入另一个桌面壳。

先检查了固定 DSH 的公开 Menu/MenuSurface：其菜单命令语义、Tab 行为与固定 body portal 不直接适用于搜索选择和原生 modal dialog。这里采用无样式 [Base UI Select](https://base-ui.com/react/components/select) / [Combobox](https://base-ui.com/react/components/combobox)，精确版本 1.9.0，子路径导入；不复制上游内部实现。新增依赖代价：生产客户端 648327 → 826396 bytes；gzip 156412 → 218392 bytes。完整许可证随既有构建流程收集，未删除第三方声明。

## 实际验证

- `pnpm check`：134 项通过；`pnpm workbench:build` 成功。
- `pnpm test:ui:run`：40 项通过，Chromium 浅/深色；真实 click/keyboard 展开，包含搜索/空结果、窗边避让、禁用不可提交、Enter、Esc、Tab、弹窗目标保留及零任务写入。浏览器不同 viewport 是布局验证，不冒充真实桌面 zoom。
- 官方 macOS arm64 DSH `687f282e8625c6b8d11ff58211a90524be2e4317`，Electron 44.7.0 / Chrome 152.0.7977.130，`dsh-app://app/`，独立数据目录，Host 持久化 24 个虚构项目。未调用模型。
- 实际 `webContents.setZoomFactor(1 / 1.25 / 2)`，1280×800 内容区对应 CSS viewport 1280×800 / 1024×640 / 640×400、DPR 2 / 2.5 / 4。六组菜单在可视区内，字号同为 13px，搜索选中可生效；原始尺寸在 [desktop-metrics.json](desktop-metrics.json)。这是控件样式阶段记录，尚未包含随后新增的独立顶栏。
- 真实创建弹窗中长项目搜索、键盘选择、Esc、焦点回到所属项目和目标保留通过。冷启动及重载成功；热替换一次触发插件导入失败，完整冷启动后未复现，不据此认定运行中替换已受支持。
- 随后修复用户发现的顶栏重叠：200% 侧栏收起后，官方按钮 y=11..39，正文从 y=48 起、标题从 y=64 起；正常 100% 标题 y=76。正文独立裁剪，不滚入宿主按钮区。正常尺寸图见下。用户随后开始使用窗口，已停止交互自动化并恢复 100%；最终顶栏 200% 配套截图、窗口实际拖动坐标变化及全屏/还原留待独立桌面复核，不能把 CSS 声明当成拖动已验收。

## 对照

修改前原生菜单：[浅色 100%](before-desktop-light-100.png)、[深色 100%](before-desktop-dark-100.png)、[浅色 200%（含标题重叠）](before-desktop-light-200.png)。

控件阶段（顶栏修复前）：[浅色 100%](after-desktop-light-100.png)、[125%](after-desktop-light-125.png)、[200%](after-desktop-light-200.png)；[深色 100%](after-desktop-dark-100.png)、[125%](after-desktop-dark-125.png)、[200%](after-desktop-dark-200.png)。这些图保留真实先后边界，不用旧顶栏图代表最终布局。

最终顶栏正常缩放：[100% 完整窗口](after-desktop-header-light-100.png)。

创建弹窗：[浅色](after-desktop-dialog-light-100.png)、[深色 200%](after-desktop-dialog-dark-200.png)。外观菜单：[名称与选择标记](after-desktop-appearance-light-100.png)（该图为图标触发器改动前）。

本批不认证完整产品、模型质量、安装包或 Windows/Linux 桌面。中性侧栏材质、系统解析/原生同步及完整窗口操作为 A-DESKTOP1；PLANQ、TEMPLATE 和资产包导入见覆盖账本。
