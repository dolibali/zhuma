# 上游输入客户端投影

本切片属于 [#32](https://github.com/dolibali/zhuma/issues/32)，消费已集成 [#81](https://github.com/dolibali/zhuma/pull/81) 的 `ExecutionNodeView.inputs`。实时交付／验收结论仍留在 Issue／PR。本文件只记录行为、接口和退出边界。

## 数据与展示

`ExecutionNodeWire.inputs?: readonly UpstreamInputWire[]` 与服务 `UpstreamInputView` 对齐，Client 在既有 `readExecutionNode` 中校验并复制公开字段。生产 Client 不导入适配层或 Host；测试通过公共类型入口对服务真实 `ExecutionNodeView['inputs']` 做双向检查，类型路径映射只存在于 conformance 测试配置，不新增生产依赖。

- `visible` 展示服务给出的来源节点、可选目标、已接受版本与名称；不从其他节点或旧产物推测正文、文件或导航。
- `pending` 保留 `none`／`replaced` 及公开来源节点、服务提示。它不等于失败或必然阻塞，不自行补出来源目标。
- `hidden` 只保留匿名数量、服务公开提示与 `blocking`，不复制来源任务／空间／节点／版本标识及正文、文件等额外属性。公开提示由服务生成，Client 不另建授权过滤器或重写服务消息。

缺失 `inputs` 表示未返回，展示刷新待办提示；明确 `[]` 才展示没有上游输入。未知 access、缺失／非布尔 blocking、异常版本／数量或不完整提示均作为验证错误，不降级为空数组或有权来源。

## 正常入口与提交

原提交、退回修改入口都复用 `DeliveryPanel`，来源区紧邻节点目标与交付内容。仅消费当前待办返回的投影，不新增读取或 Host 接口；既有成员／空间、节点身份、轮次与迟到响应门禁继续生效。

提交按钮和提交处理函数都按已返回的 `blocking` 布尔值判断，不按 access 类别另造阻塞规则。当前服务的 pending 是提示；即使未来某类返回不同 blocking，Client 仍消费该值。未返回投影既不被解释为“无来源”，也不据此添加本地阻塞：它不是授权成功，原 `submit` 仍由服务写前重新检查权限与上游状态，服务拒绝时保留正文／链接并显示真实错误。

刷新输入投影不重置表单、不自动提交，不向写请求回传输入投影或权限字段。切账号／空间／API／完整节点身份及旧轮次处理沿用 #73／79／86／88 的生命周期规则；未新增第二套状态机或扩张提交回执生命周期。

## 设计与证明边界

旧 [#67](https://github.com/dolibali/zhuma/pull/67) 冻结 `9396abdf8a44f144b5543ee3b473068bff60d2bf` 只作展示来源。保留适合的来源目标／节点／版本与提示逻辑；不继承旧实现的缺失即空、缺失 blocking 即 false 或客户端消息重建，也不合入旧交付表单和文件元数据编辑器。

沿用 frontend-design 与 [diagram-design 固定参考](https://github.com/cathrynlavery/diagram-design/tree/7a12007b) 的语义层级与删减原则：使用现有中性浅深 token、分隔线和紧凑来源行，突出已接受与阻塞的区别，不嵌套新卡片、图解、权限选择器或预览控件。长名称换行；无隐藏标识置于 DOM key、属性或可访问名称。

对应测试包括 DTO 与静态渲染，以及正常提交／修改入口的浅深响应重放契约。响应重放不证明真实权限、持久化或文件字节；编译 harness 不等于浏览器通过。A 不运行额外浏览器，协调侧按实际提交安排界面、同数据前后截图及必要真实服务验收。文件预览、草稿、Agent、待办重构及完整多人闭环不在本切片。
