# A-ENTRY：从目标直接开始规划

修改前基线：`27c018a`。修改后为本目录所属 PR 的实现版本。截图使用同一份三层工作流演示目录和 22 位参与者；只有创建表单中的目标/名称输入，没有加入真实资料。页头修正的修改前截图取自本分支修正前版本，与基线的负责人布局相同。

点击“生成计划”后先持久化一次草稿，再由该次用户提交启动既有规划 API，直接进入规划面板。目标/项目/参与者在生成前可调整，任务名称可省略，负责人仍由人选择；AI 和手动入口复用同一工作流编辑器。无可用参与者时就地提示。没有假装已完成模板选择，模板映射应用保留为后续独立范围。

失败保留同一任务、目标与参与者，可重试或转手动。创建响应中断时重试复用任务 ID、请求 ID 和版本；未确认保存成功不调用模型。取消/离开使未完成规划失效；迟到结果不能覆盖手动编辑。刷新和重开不自动规划。生成、应用、确认及执行仍分开。

负责人信息栏修复继承纵向 `.zm-field` 导致的错位：标签、姓名和箭头同行，长姓名截断但保留完整 title，小屏整组换行，空值与只读状态也有明确呈现。参与者选择按钮只显示前三位加剩余数量，完整选择在统一目录内查看；多人评审选择仍明确“全部通过后交接”。

## 同场景画面对照

静态 harness 运行真实产品组件/CSS，快照和规划为响应重放。它不是官方 Host 或安装版截图。创建/页头为 1440×900，紧凑视图为 720×600；浅深各一套。创建后旧版停留空工作流，新版已经开始规划，这个不同状态正是本批行为变化。所有图片包含完整应用视口。

| 场景              | 修改前                               | 修改后                              |
| ----------------- | ------------------------------------ | ----------------------------------- |
| 创建 · 浅色       | ![](before-create-light.png)         | ![](after-create-light.png)         |
| 创建 · 深色       | ![](before-create-dark.png)          | ![](after-create-dark.png)          |
| 紧凑创建 · 浅色   | ![](before-compact-light.png)        | ![](after-compact-light.png)        |
| 紧凑创建 · 深色   | ![](before-compact-dark.png)         | ![](after-compact-dark.png)         |
| 提交后 · 浅色     | ![](before-created-light.png)        | ![](after-created-light.png)        |
| 提交后 · 深色     | ![](before-created-dark.png)         | ![](after-created-dark.png)         |
| 完整页头 · 浅色   | ![](before-header-light.png)         | ![](after-header-light.png)         |
| 完整页头 · 深色   | ![](before-header-dark.png)          | ![](after-header-dark.png)          |
| 小屏长姓名 · 浅色 | ![](before-header-compact-light.png) | ![](after-header-compact-light.png) |
| 小屏长姓名 · 深色 | ![](before-header-compact-dark.png)  | ![](after-header-compact-dark.png)  |

## 行为与真实边界

- 代码/契约：`pnpm check`，134 项纯逻辑测试及边界、格式、类型检查。
- 浏览器：15 场景 × 浅深主题，目标创建、首轮 StrictMode 重放、保存失败、规划失败、取消迟到、转手动、刷新/重开及原有交互回归。页头另检查 420px 长姓名、空值与只读。StrictMode 使用 development bundle，其他场景使用 production bundle。
- 实际官方 DSH Host：核对隔离工作区与固定上游版本，更新本批 Client bundle；通过真实 command 创建 1 个任务、应用草案、手动编辑保存，共 3 次真实命令，刷新重开确认磁盘状态。两次规划请求仅在浏览器边界重放“失败→成功”，没有真实模型调用；重试使用相同任务，目标与参与者保持。没有确认执行或改动 B 服务。
- 未完成：真实模型质量提升、模板应用、实际执行与交付评审、多用户账号空间、安装版桌面。原生 select 展开定位/字号按 A-UI-controls 独立处理，不能用本批关闭状态截图认证。

## 采用的机制

[n8n AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder.md) 的“描述目标→查看生成→审阅并继续调整”使启动和编辑连贯；[Cursor Projects](https://cursor.com/docs/agent/projects) 的目标与团队能力入口说明规划上下文应在发起前明确。这是官方文档研究，不是登录后实测。Zhuma 采用目标优先和可编辑提案，生成后仍需用户应用/确认，不复制云端自动派发或付费套餐机制。
