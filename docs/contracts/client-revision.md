# 退回修改客户端

本切片对应 [#32](https://github.com/dolibali/zhuma/issues/32)，基于已集成的 `revision` 查询（[PR #80](https://github.com/dolibali/zhuma/pull/80)）。实时交付、SHA、CI 与验收结论留在 Issue／PR，本文件只记录接口、行为与证明边界。

## 入口与内容

成员执行页沿用 `ExecutionWorkspace → InboxPanel`；待办的 `action: revise` 打开 `RevisionWorkspace`，上方 `RevisionPanel` 对照意见，下方复用 `DeliveryPanel` 编辑后重新提交。适合的展示逻辑取自关闭的 [PR #66](https://github.com/dolibali/zhuma/pull/66) 冻结提交 `bcf4630a0c73d43d330418daa4a4dbe378e54823`，没有整支合入旧实现。

默认展示服务返回的 `reviewed`，对照选择器只包含它与 `previous`。节点投影中更晚的产物不能代替被退回版本。`previous` 是服务返回的相邻前版，不用客户端猜版本。每条总体意见显示评审人、引用版本和引用评论 ID；只有该版本正文确实返回时，才可“查看引用版本”。更早历史正文未返回时直接说明，不制造可定位到正文的评论锚点。

原 revision 查询的文件 DTO 只有 ID、媒体类型与字节数；无文件 API 的静态组件只展示元信息。正常 RevisionWorkspace 已接[固定版本文件读取](client-files.md)，通过独立授权接口读取当前选中的准确 artifact，而不从 DTO 伪造预览地址。评论 DTO 只有被引用 ID，没有正文或范围，不能据此提供行内定位。链接仅允许无内嵌凭据的 HTTP(S)，新窗口使用 `noopener noreferrer`，其他值显示为文字。

## 查询与作用域

`ExecutionApi.revision(query, signal?)` 的请求严格为 `{ taskId, planId, revision, nodeId }`，从当前冻结节点取值，不添加 `spaceId`、账号或执行者覆盖字段。成功响应解包 `{ ok: true, value: { view } }`；Client 校验版本、文件大小、意见与引用类型，再只复制公开投影。生产 Client 不导入适配层或 Host 代码。

成员 HTTP API 复用现有账号／空间会话预检与页面代次门禁，每次读取重新确认，不缓存授权成功。空间失效或登录失效沿用现有收口；单项 `not-found`／`not-returned`／`not-participant` 保留为本地可重试错误，不把整个空间清空，也不改写服务状态。

读组件以 API、完整节点身份、节点版本、状态、当前轮次和对应产物 ID 为生命周期边界。刷新会取消旧读取，只有最新读取能展示；服务返回版本与已知轮次产物不一致时提示刷新待办，不偷偷替换。取消、切页、切账号／空间后的迟到成功和错误均不能进入新视图。

## 输入与提交

查询组件与编辑表单分别管理生命周期。同节点刷新意见或待办版本更新保留正在编辑的正文／链接；API 或任务／计划／计划版本／节点身份变化则沿用表单重置及未保存输入保护。查询结果不自动填入、清空或保存用户输入。

只有明确点击“重新提交”才调用原有 `submit`，携带当前 `expectedVersion` 和幂等键；刷新、打开、切版本及切主题均不提交或执行。成功回执在当前表单和当前节点版本／状态／轮次仍匹配时才清空输入、刷新待办。旧上下文的成功／错误不能关闭新上下文或清除输入。前一个提交尚未结束时仍保留原有单请求门禁。需修改义务、新轮次和下游推进由服务处理，Client 不自行清除。

## 视觉与验证

使用 `frontend-design` 并参考 [diagram-design 固定源码](https://github.com/cathrynlavery/diagram-design/tree/7a12007b) 的语义层级、克制焦点和删减原则。这里的核心关系是“固定版本 ↔ 具名意见”，采用正文／意见两列及窄屏单列；复用现有中性浅深 token、字体、按钮和单选控件，不引入新图解或主题皮肤。输入与对照内容分开，避免把已提交版本误当正在修改的草稿。

Node 测试覆盖 DTO、HTTP 预检与迟到响应、静态渲染、安全链接及缺失内容。`revision.spec.mjs` 是浅深主题响应重放契约，覆盖正常待办入口、版本切换、刷新／重试保输入、旧轮次与 API／节点切换、显式重提、迟到提交、窄屏与键盘。编译 harness 不能算浏览器通过；浏览器、真实成员服务／持久化、Native 和文件字节各按实际执行结果分别记录。A 不运行额外界面验证，协调侧安排。文件上传／预览、内容锚点、草稿持久化和 Agent 执行不在本切片。
