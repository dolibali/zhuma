# A-UI-controls：锚定菜单与桌面顶栏

状态：本地实现待评审。基线 main `2f7d8d7`。截图只包含独立测试目录内的公开虚构项目；未上传用户原图。

## 行为与边界

项目、目录类型、创建表单、外观共用 SingleSelect。短列表使用 Select，超过 8 项使用带搜索的 Combobox；默认在按钮下方相隔 5px，窗口边缘自动移位/翻转，列表最多 320px 并受实际可用高度限制。选项和按钮均为 13px，主题来自现有官方 theme 服务。原生 dialog 内的菜单 portal 到 dialog，Esc 只关闭菜单，Tab 可以离开；禁用项遵循原语的可聚焦语义，但不能提交或改值。

外观使用太阳/月亮/显示器图标，tooltip 显示当前模式，展开后仍有模式名称和选中标记。桌面主面板消费官方 `--dsh-frame-top-clearance`，独立 48px 顶栏与正文滚动区域分离，使用官方 `data-window-drag` 标记。没有改上游源码或引入另一个桌面壳。

先检查了固定 DSH 的公开 Menu/MenuSurface：其菜单命令语义、Tab 行为与固定 body portal 不直接适用于搜索选择和原生 modal dialog。这里采用无样式 [Base UI Select](https://base-ui.com/react/components/select) / [Combobox](https://base-ui.com/react/components/combobox)，精确版本 1.9.0，子路径导入；不复制上游内部实现。新增依赖代价：生产客户端 648327 → 826396 bytes；gzip 156412 → 218392 bytes。完整许可证随既有构建流程收集，未删除第三方声明。

## 实际验证

- `pnpm check`：134 项通过；`pnpm workbench:build` 成功。
- `pnpm test:ui:run`：修正后完整 40 项通过，Chromium 浅/深色；真实 click/keyboard 展开，包含搜索/空结果、窗边避让、禁用不可提交、Enter、Esc、Tab、弹窗目标保留及零任务写入。浏览器不同 viewport 是布局验证，不冒充真实桌面 zoom。首轮本地通过后，独立复核发现 resize 用例会读取旧弹层框：修正前重复 20 次有 9 次失败。现在在 2 秒内用 `expect.poll` 原子读取当前弹层及视口，保留四边和可见尺寸检查；不加 sleep、不重试整个用例、不放宽边界。浅深各重复 10 次，20/20 通过；临时注入持续向右偏移 2000px 的反向验证在同一断言上失败，随后撤销注入再完整运行。
- 官方 macOS arm64 DSH `687f282e8625c6b8d11ff58211a90524be2e4317`，Electron 44.7.0 / Chrome 152.0.7977.130，`dsh-app://app/`，独立数据目录，Host 持久化 24 个虚构项目。未调用模型。
- 实际 `webContents.setZoomFactor(1 / 1.25 / 2)`，1280×800 内容区对应 CSS viewport 1280×800 / 1024×640 / 640×400、DPR 2 / 2.5 / 4。六组菜单在可视区内，字号同为 13px，逐组搜索选择通过。复核发现首次提交的尺寸文件是空数组，原始数据保留失败；已重新采集最终构建的六组数据，见 [desktop-metrics.json](desktop-metrics.json)。每条含截图、视口、弹层、触发器、标题、正文框和客户端 SHA-256，且实际服务的模块内容已与构建产物核对一致。本次数据包含最终顶栏，不能用于追认此前缺失的记录。
- 真实创建弹窗中长项目搜索、键盘选择、Esc、焦点回到所属项目和目标保留通过。冷启动及重载成功；热替换一次触发插件导入失败，完整冷启动后未复现，不据此认定运行中替换已受支持。
- 顶栏重叠修复：200% 侧栏收起后，官方按钮 y=11..39，正文从 y=48 起、标题从 y=64 起；正常 100% 标题 y=76。正文独立裁剪，不滚入宿主按钮区。此次重新使用独立官方开发应用副本、独立 Profile 和 24 个虚构项目，用户原窗口未操作，测试结束恢复 100% 并关闭副本。
- 原生全屏按钮进入全屏后，`isFullScreen=true`、窗口 1512×949，搜索选择仍可操作；从原生 Window 菜单还原后 `isFullScreen=false`、窗口恢复 1280×800。创建弹窗输入/取消通过。[原生窗口记录](native-window-checks.json)。**拖动仍未验收**：原生拖动尝试没有产生坐标变化；`isMovable=true` 和计算样式 `drag` 不能代替实际移动。PR #8 的控件及顶栏布局已独立复核合入，拖动缺口转入 [A-DESKTOP1](../desktop-shell/README.md)，不计入已验收范围。

测试副本采用官方 `prepareDevelopmentApp`，未改用户使用的构建树。Profile 禁用原工作台条目、单独插入测试构建来源，避免包解析仍指向共享安装目录；构建内容核对通过后才采集最终截图。未使用请求重放替换桌面 UI 或模型响应。

## 对照

本次同状态对照均为 24 个项目、相同主题、1280×800 内容区、菜单收起。100% 侧栏展开，200% 响应式收起。它们用于比较标题、控件与空间，**收起图不是菜单展开证据**。

| 状态      | 修改前                                | 最终构建                             |
| --------- | ------------------------------------- | ------------------------------------ |
| 浅色 100% | [基线](baseline-layout-light-100.png) | [修复后](final-layout-light-100.png) |
| 深色 100% | [基线](baseline-layout-dark-100.png)  | [修复后](final-layout-dark-100.png)  |
| 浅色 200% | [基线](baseline-layout-light-200.png) | [修复后](final-layout-light-200.png) |
| 深色 200% | [基线](baseline-layout-dark-200.png)  | [修复后](final-layout-dark-200.png)  |

最终构建的展开态：[浅色 100%](final-desktop-light-100.png)、[125%](final-desktop-light-125.png)、[200%](final-desktop-light-200.png)；[深色 100%](final-desktop-dark-100.png)、[125%](final-desktop-dark-125.png)、[200%](final-desktop-dark-200.png)。均由实际 Electron `webContents.capturePage()` 保存，包含完整应用内容区，不含系统窗口装饰。

原生 `<select>` 弹层是系统窗口，renderer 截图无法完整记录。保留首次测试已取得的 [浅色 200% 系统展开截图](before-desktop-light-200.png)，可见原生弹层横向裁切及标题重叠；本次系统捕获出现 ScreenCaptureKit 错误，后续返回的 100% 图未包含原生弹层，因此没有将其作为展开证据。原 [浅色 100%](before-desktop-light-100.png)、[深色 100%](before-desktop-dark-100.png) 也仅是收起状态。

控件阶段（顶栏修复前）：[浅色 100%](after-desktop-light-100.png)、[125%](after-desktop-light-125.png)、[200%](after-desktop-light-200.png)；[深色 100%](after-desktop-dark-100.png)、[125%](after-desktop-dark-125.png)、[200%](after-desktop-dark-200.png)。这些图保留真实先后边界，不用旧顶栏图代表最终布局。

最终顶栏正常缩放：[100% 完整窗口](after-desktop-header-light-100.png)。

创建弹窗：[浅色](after-desktop-dialog-light-100.png)、[深色 200%](after-desktop-dialog-dark-200.png)。外观菜单：[名称与选择标记](after-desktop-appearance-light-100.png)（该图为图标触发器改动前）。

本批不认证完整产品、模型质量、安装包或 Windows/Linux 桌面。中性侧栏材质、系统解析/原生同步及完整窗口操作为 A-DESKTOP1；PLANQ、TEMPLATE 和资产包导入见覆盖账本。
