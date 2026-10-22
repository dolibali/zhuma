# A-UX1b：工作区与规划交互对照

日期：2026-10-22。修改前 `8731fae003432b12e23e3630a64833fb9678bf7d`，UI 实现 `49d3271ef9ba7e41d8690fbd1c9c54c172194ed3`；随后常规合并 main 的执行契约，集成提交 `2cd716b6298e4d995ef4f528f0a2fa2c22ecdd51`。合并没有再修改这些 UI 文件。

12 张图片均为官方 DSH Web 页面实际渲染的 1440×900 完整视口。沿用上一批相同公开演示快照、选中节点、主题、默认 100% 画布及六节点规划响应；旧图来自上一批对应提交，新图在最新构建中重新拍摄。截图未做图像编辑，快照和规划响应通过浏览器重放，禁止 command 写入，不产生新模型调用。

| 场景          | 修改前                                                 | 修改后                                               | 变化                                           |
| ------------- | ------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------- |
| 任务清单·浅色 | [before-tasks-light.png](before-tasks-light.png)       | [after-tasks-light.png](after-tasks-light.png)       | 导航与筛选同层、负责人可见、参与者数量完整     |
| 任务清单·深色 | [before-tasks-dark.png](before-tasks-dark.png)         | [after-tasks-dark.png](after-tasks-dark.png)         | 减少等权横线与重复页头，维持文字对比度         |
| 工作流·浅色   | [before-workflow-light.png](before-workflow-light.png) | [after-workflow-light.png](after-workflow-light.png) | 标题/分工相邻，画布与属性栏用轻边界表面区分    |
| 工作流·深色   | [before-workflow-dark.png](before-workflow-dark.png)   | [after-workflow-dark.png](after-workflow-dark.png)   | 保持节点可读与路径定位，减少重复工具栏边界     |
| AI 草案·浅色  | [before-proposal-light.png](before-proposal-light.png) | [after-proposal-light.png](after-proposal-light.png) | 草案优先，正文滚动，调整输入与应用动作固定底部 |
| AI 草案·深色  | [before-proposal-dark.png](before-proposal-dark.png)   | [after-proposal-dark.png](after-proposal-dark.png)   | 规划依据按需展开，当前节点分工依据就地阅读     |

同数据并不意味着冻结页面布局；本次调整了工作区边距、工具栏和滚动容器，节点在视口中的位置因此变化，但仍保持相同节点选择与 100% 缩放。背景、边界、输入框和侧栏都使用同一组主题变量，未新增主题状态。

截图无法证明持久化与失败处理。实际 Host 应用/编辑/保存重开、故障注入保留提案、小窗口抽屉及集成后的 125 项契约检查见 [验证记录](../../ui-validation.md)。B 的真实执行、待办和评审仍待联调；不是安装包或成品视觉验收。
