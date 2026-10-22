# PR #2 界面对照

拍摄日期：2026-10-22。实现提交为 `c095d99de6622a9558bac950982a2fe5964faed1`；对照提交为本 PR 内首版工作台 `56cf230e0cf49586cd10969e31635bd0c0039c62`。目标分支 main 原来没有团队工作台，因此这里展示的是新增功能在本 PR 内的迭代，不把首版截图称为 main 的原界面。

所有图片均为官方 DSH Web Host 中实际渲染的完整 1440×900 视口，未经图像编辑。修改前使用首版客户端构建，修改后使用当前客户端构建，其余宿主模块相同。通过官方主题入口分别选择浅色、深色，待状态稳定后拍摄；首版工作台没有深色适配，所以深色对照中宿主为深色而内容仍为浅色。

使用同一份公开演示数据快照：五项任务，工作流查看场景为十节点、22 位参与者，选中根工作流的首节点。旧版解析器不认识新增的 ownerId，因此只在旧版响应中去掉这个字段，其他可表示字段完全一致。新版本显示显式负责人，不能将该差异解释成模型自动分配。

AI 草案场景重放此前真实 DeepSeek 调用记录的六节点提案；快照读取和规划请求在浏览器中替换响应，截图过程禁止 command 写入。此对照没有再次调用付费模型，也不计为新的真实模型成功。真实调用、持久化、负责人操作和契约测试证据分别见 [组织与编排验证](../../workbench-validation.md) 和 [界面验证](../../ui-validation.md)。

| 场景            | 修改前                                                 | 修改后                                               | 变化                                                      |
| --------------- | ------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| 任务清单·浅色   | [before-tasks-light.png](before-tasks-light.png)       | [after-tasks-light.png](after-tasks-light.png)       | 减少外围卡片，使用中性主动作与紧凑信息层级                |
| 任务清单·深色   | [before-tasks-dark.png](before-tasks-dark.png)         | [after-tasks-dark.png](after-tasks-dark.png)         | 宿主与工作台统一深色，文字/背景直接切换避免渐变中间帧发灰 |
| 工作流查看·浅色 | [before-workflow-light.png](before-workflow-light.png) | [after-workflow-light.png](after-workflow-light.png) | 默认可读节点，查看态展示正文，配置不再伪装为可编辑表单    |
| 工作流查看·深色 | [before-workflow-dark.png](before-workflow-dark.png)   | [after-workflow-dark.png](after-workflow-dark.png)   | 画布、连线、小地图、详情与宿主统一主题                    |
| AI 草案·浅色    | [before-proposal-light.png](before-proposal-light.png) | [after-proposal-light.png](after-proposal-light.png) | 草案状态与应用动作可见，重新规划为次要动作                |
| AI 草案·深色    | [before-proposal-dark.png](before-proposal-dark.png)   | [after-proposal-dark.png](after-proposal-dark.png)   | 单一高对比主要动作，底部应用区保持可见                    |

两版使用相同任务、节点选择和侧栏场景。画布默认缩放是本次修改内容：旧版自动缩至全图，新版默认 100% 定位当前节点，需要全局概览时主动“适应全图”，因此截图没有强行改成相同缩放。长目标的默认折叠与查看态正文也是预期界面差异。

旧 `ux1-button-neutral-tasks-*` 图片捕获了主题过渡中间帧，仅保留为本地问题证据，不在这里充当最终效果。这里的新任务行均为 enabled、opacity=1；浅色背景/文字分别为 #fff / #252a30，深色为 #1b1d21 / #e6e8ec。

截图只证明对应渲染状态，不替代拖拽连线、保存重开、鉴权、真实执行或安装包验收。整体视觉精修 A-UX1b 及 B-M1 的真实待办/提交/评审接入仍分批推进；后续 UI 改动须更新受影响截图。
