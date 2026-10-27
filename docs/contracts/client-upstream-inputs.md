# 上游输入客户端投影

本切片属于 [#32](https://github.com/dolibali/zhuma/issues/32)，消费已集成 [#81](https://github.com/dolibali/zhuma/pull/81) 的 `ExecutionNodeView.inputs` 及 [#100](https://github.com/dolibali/zhuma/pull/100) 的只读 `upstream-content`（基线 `eb1d9f80c52f7811dc5ebd7599c02df8eb4a0671`）。实时交付／验收结论仍留在 Issue／PR。本文件只记录行为、接口和退出边界。

## 数据与展示

`ExecutionNodeWire.inputs?: readonly UpstreamInputWire[]` 与服务 `UpstreamInputView` 对齐，Client 在既有 `readExecutionNode` 中校验并复制公开字段。生产 Client 不导入适配层或 Host；测试通过公共类型入口对服务真实 `ExecutionNodeView['inputs']` 做双向检查，类型路径映射只存在于 conformance 测试配置，不新增生产依赖。

- `visible` 展示服务给出的来源节点、可选目标、已接受版本与名称；携带真实冻结 `artifactVersionId`。正常交付页提供“查看内容”，只用该引用请求准确版本，不从数字版号、其他节点或旧产物推测内容。
- `pending` 保留 `none`／`replaced` 及公开来源节点、服务提示。它不等于失败或必然阻塞，不自行补出来源目标。
- `hidden` 只保留匿名数量、服务公开提示与 `blocking`，不复制来源任务／空间／节点／版本标识及正文、文件等额外属性。公开提示由服务生成，Client 不另建授权过滤器或重写服务消息。

缺失 `inputs` 表示未返回，展示刷新待办提示；明确 `[]` 才展示没有上游输入。未知 access、缺失／非布尔 blocking、异常版本／数量或不完整提示均作为验证错误，不降级为空数组或有权来源。

## 正常入口与提交

原提交、退回修改入口都复用 `DeliveryPanel`，来源区紧邻节点目标与交付内容。仅消费当前待办返回的投影，正文按需调用已集成的服务读取，不新增 Host 接口；既有成员／空间、节点身份、轮次与迟到响应门禁继续生效。

提交按钮和提交处理函数都按已返回的 `blocking` 布尔值判断，不按 access 类别另造阻塞规则。当前服务的 pending 是提示；即使未来某类返回不同 blocking，Client 仍消费该值。未返回投影既不被解释为“无来源”，也不据此添加本地阻塞：它不是授权成功，原 `submit` 仍由服务写前重新检查权限与上游状态，服务拒绝时保留正文／链接并显示真实错误。

刷新输入投影不重置表单、不自动提交，不向写请求回传输入投影或权限字段。切账号／空间／API／完整节点身份及旧轮次处理沿用 #73／79／86／88 的生命周期规则；未新增第二套状态机或扩张提交回执生命周期。

## 设计与证明边界

旧 [#67](https://github.com/dolibali/zhuma/pull/67) 冻结 `9396abdf8a44f144b5543ee3b473068bff60d2bf` 只作展示来源。保留适合的来源目标／节点／版本与提示逻辑；不继承旧实现的缺失即空、缺失 blocking 即 false 或客户端消息重建，也不合入旧交付表单和文件元数据编辑器。

沿用 frontend-design 与 [diagram-design 固定参考](https://github.com/cathrynlavery/diagram-design/tree/7a12007b) 的语义层级与删减原则：使用现有中性浅深 token、分隔线和紧凑来源行，突出已接受与阻塞的区别，不嵌套新卡片、图解、权限选择器或虚假文件预览。长名称换行；无隐藏标识置于 DOM key、属性或可访问名称。

对应测试包括 DTO/HTTP 回执与静态渲染，以及正常提交／修改入口的浅深响应重放场景。响应重放不证明真实权限、持久化或文件字节；编译 harness 不等于浏览器通过。A 不运行浏览器，协调侧按实际提交安排界面、同数据前后截图及必要真实服务验收。文件字节/预览、草稿协议变更、Agent、待办重构及完整多人闭环不在本切片。

## 已接受内容按需读取（#100 接缝）

`ExecutionApi.upstreamContent(query, signal)` 仅在已绑定 `spaceId` 的 API 上可用；无空间在派发前拒绝。请求严格发送 `{ taskId, planId, revision, nodeId, sourceNodeId, artifactVersionId, spaceId }`，不发送actor、数字版号或回传权限。Client的 `expectedArtifactVersion` 只是来自visible行的数字版本校验值，不是新增服务字段。

返回 `UpstreamContentWire` 与服务公共DTO双向类型检查：`{actorId, spaceId, downstream, source, version:{id,version}, content:{text?,links,files}}`。逐层严格解码、复制公开字段，核对空间、完整下游定位、同任务/计划/修订的来源节点、固定ID及数字版本；异常响应拒绝，不降级为空正文或latest。文本上限100000字符、链接/文件各20项沿当前提交边界，文件只接收既定元信息，不接路径或字节。成员入口沿 `createExecutionHttpApi` 的可信session预检、same-origin/no-store、RPC关联、账号回显与isCurrent/Abort门禁；不另造认证库。

`UpstreamInputsPanel` 的可选 `api/node` 保持原纯投影调用兼容；正式 `DeliveryPanel` 传入当前API及节点。visible行默认收起，原生details/summary显式展开才挂载读取器；隐藏浏览器marker并复用空间/账号同一 `ControlIcon` SVG箭头，闭合向右、展开向下，沿共享图标盒居中。关闭取消等待并清除正文，再打开重新请求；切API/节点版本/状态/轮次/固定引用会重挂该来源，迟到成功或错误都不能回显。刷新元信息不全量读取，也不重置交付草稿；没有跨来源或跨会话正文缓存。已合法送达内容不被宣称可远程撤回；刷新为hidden/pending时立即去掉当前展开内容。

正文作为转义纯文本呈现，局部滚动/键盘聚焦；只有无账号密码的HTTP(S)链接可点击，其他链接为普通文本，不执行HTML。文件仅显示标识、类型与大小并说明内容尚不可查看，不生成预览/下载URL。pending/hidden/replaced保持服务提示，不提供内容操作。来源not-found/不可用和解码错误在当前来源显示，并可显式重试；它们不清空交付草稿。账号失效/错误账号及空间不匹配仍由现有边界关闭旧视图，来源拒绝不冒充账号退出。

参考机制→操作问题→实现：沿用渐进展开解决“先识别来源，再读所需正文”，由 `UpstreamContent.tsx` 承担打开期间的读取生命周期，`ExecutionApi.ts/http.ts`承担DTO与成员/空间回执校验；`DeliveryPanel`仍只拥有原有编辑/保存/提交义务。公共样式沿既有浅深token，来源区不新增同权工具栏。实际多角色权限/恢复、桌面尺寸/键盘/浅深与前后图由协调正常入口验证，单元/HTTP重放不能认证这些结果。

## 固定文件接续

正常成员的已接受内容展开区接[文件 Client](client-files.md)，按准确下游节点、来源节点与固定 artifactVersionId 请求授权元数据及字节。原 upstream-content 查询仍只返回引用，隐藏来源不产生文件入口，未接文件 API 的静态组件保留元信息展示。
