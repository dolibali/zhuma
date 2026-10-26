# B-M1b 真实文件交付：有界接口与复用取舍

工作项：[#33](https://github.com/dolibali/zhuma/issues/33)。当前主责：C，接续 B 的原始实现与历史；范围：FR06/08/09/13 的文件部分。本文保留完整交付约定，首批实现仅上传与可信回执。客户端 UI 与公共 Host 运输归 A。

## 首批上传接入与边界

- `ExecutionService.uploadFile(caller, options, lease)` 的第三参是 Host 用原始成员请求经 `openExecutionMemberLease` 签发的 `ExecutionMemberLease`。不接收浏览器声明的成员／lease，不依赖 NativeRun 开关；请求、当前成员会话、空间目录和插件生命周期共同约束上传。
- 所有持久字段在读取字节前按同一记录 schema 校验。初发和重放都校验真实字节，并在向附件 SDK 返回 EOS 前核对摘要和长度；错误声明不能先发布 CAS 再拒绝登记。SDK 包装错误后仍保留 `digest-mismatch`、`file-too-large`、`upload-timeout`、`cancelled` 等业务码。
- 幂等指纹包含成员、空间、任务／计划／版本／节点、文件名、媒体类型、长度和摘要。在途同键同体返回 `conflict` 且 `details.reason=upload-in-progress`，调用方保留同键重试；在途同键异体返回 `idempotency-mismatch`，不读取第二份字节。完成后的同键重放仍校验本次真实字节并返回原 UUID。
- 只有短准入／资源预留和最终新鲜授权、配额与回执写入进入既有业务队列；真实字节 I/O 不阻塞其他节点的停止或查询。每空间最多 8 个实际在途上传；进程内预留仅控制资源和并发，可信事实仍只写 `zhuma_files.files` 一行。60 秒时限同时覆盖初发与重放等待 `next()`／附件服务；逻辑取消不伪装物理清理已完成，关闭插件会等待实际资源收敛。
- 首批未实现固定文件提交、授权内容读取／下载、文件锚点评论与文件下游消费。下面相应章节仍是后续交付约定，不能据上传成功宣称完整 #33 验收。GUI 与模型均不由本切片认证。

## 复用取舍

**采用**：上游固定提交 `687f282` 的公开附件接口——Cordis 服务 `ctx.attachments: AttachmentStore`（`packages/attachment/attachment/src/index.ts`）：

- `saveFileStream(input)`（流式原字节保存，内容寻址 sha256，原子发布＋目录 fsync，崩溃安全）
- `readFileStream(ref)`（流式读取＋字节数与摘要校验，见修正 4 的完成语义）
- `FileAttachmentRef = { attachmentId: 'sha256:<digest>', name, bytes }`

产品经公开 `ctx.attachments` 注入，不跨包导入内部 `attachment-local` 函数、不自行硬编码存储根目录（内部 `file-store.ts` 仅作行为依据）。它提供：不可变原字节持久、可信回执（服务端计算的 digest/长度）、崩溃恢复。**它不提供**：本产品的成员／空间／固定产物授权，也不提供应用限额。

**舍弃**：不自建文件系统或第二份字节库；不把字节塞进现有 JSON 命令通道；不把浏览器 `uploadComplete:true` 或客户端算的哈希当证明。

## 服务接缝（C 接续）

存储布局：宿主 `DSH_HOME/attachments/v1` 下内容寻址（上游机制）；`zhuma_files` 存储域登记元数据 `{ attachmentId, mediaType, byteSize, spaceId, uploadedBy, uploadedAt }`（记录型事实在域，字节在上游存储）。

### 1. 上传 `POST /api/zhuma-exec/upload-file`（字节流，不进 JSON 信封）

- 请求头声明：`x-zhuma-file-name`、`x-zhuma-file-type`、`x-zhuma-file-size`、`x-zhuma-file-sha256`（调用方声明，仅作失败诊断，不作证明）＋成员会话＋完整定位 `taskId/planId/revision/nodeId`（待提交文件绑定有权执行节点）＋`spaceId`（必填）＋幂等键 `x-zhuma-idempotency-key`。
- **字节去重与产品回执分开**：sha256 只去重底层对象；产品上传回执用独立的逻辑标识 `uploadId`（服务端发放的 uuid）＋`spaceId/accountId` 归属。相同字节由不同账号上传到不同团队/节点产生各自的回执与元数据，不共享授权事实。
- 服务流式写入上游存储并**实际计算** sha256 与长度；声明值与实际不符即失败，不写元数据。可信回执返回服务端计算的 `{ uploadId, attachmentId, name, bytes, sha256 }`。
- 幂等键：同键重试返回同一回执（不重复登记元数据）；同键异体返回 `idempotency-mismatch`。
- 恢复：完整字节已发布但元数据写失败／回执丢失／取消迟到时，按同幂等键重试——字节对象已存在则直接补登元数据返回回执；中断的不完整对象不发布。
- 授权：成员会话当前持有该 spaceId **且**是该任务该节点的当前执行者；非参与者／无权／撤销即 `not-found` 不泄露。
- 元数据 `zhuma_files` 记录 `{ uploadId, attachmentId, name, mediaType, byteSize, sha256, spaceId, taskId, planId, revision, nodeId, uploadedBy, uploadedAt, state }`。

### 2. 读取/下载/预览 `GET /api/zhuma-exec/file/<uploadId>`

- **对象授权（不只核空间成员）**：哈希只定位字节，授权按用途绑定——待提交文件读取绑定上传者＋有权执行节点；评审读取绑定固定产物/轮次的当前评审人；下游读取绑定准确 inputRef 与固定版本（复用 `upstream-content` 的完整定位与引用校验）。读取要求显式 `spaceId`，响应回显完整定位（uploadId、taskId/planId/revision/nodeId、版本）供 A 做迟到门禁。
- 负例：同团队非参与者、非引用文件、错轮次/节点、撤销后旧回执均 `not-found`，拒绝不读取字节、不增加业务事实。
- **校验完成才暴露**：单文件在内存/并发预算内先完整读入并校验字节数与摘要，校验通过才响应；损坏或丢失 `unavailable`。**不**把上游流直接转发 HTTP（上游先 yield 数据后校验，直接转发会在校验前发出损坏字节）。等长末字节损坏及流中断的负例证明不产生成功回执/可用预览。
- **安全呈现**：纯文本按 `text/plain; charset=utf-8` 显示（不随调用方声明的 `text/html` 等类型 inline）；Markdown 禁止原始 HTML 执行；主动内容（HTML/SVG/脚本类）一律 `Content-Disposition: attachment` 下载；图片/PDF 按验证后的支持范围预览。所有响应带 `X-Content-Type-Options: nosniff` 与隔离的 `Content-Security-Policy`，缓存 `private, no-store`。nosniff 只约束类型嗅探，不能替代安全呈现。真实 HTML、伪装 MIME/扩展名、SVG/HTML 改名图片的负例证明不执行脚本、不发起上传内容指定的请求。

### 3. 草稿引用与固定提交

- 草稿 `files` 的 `ArtifactFileRef` 引用可信回执：`checksum`＝服务端回执的 sha256，`uploadComplete` 由服务端据 `zhuma_files` 中该回执的完成状态判定，客户端声明无效。保存草稿时校验回执存在、属当前空间、且该成员是当前执行者。
- `submit` 提交固定版本：校验每个文件回执存在、字节与摘要匹配、属当前空间与本轮节点；固定版本的文件不可变（内容寻址不可覆盖）；重提产生新版本，旧版本可追溯；同键重放／并发不多产物或重复引用。
- 下游授权读取（`upstream-content`）的文件元信息来自固定版本事实。
- 移除草稿里引用的文件：仅解除引用，不删字节——同一字节可被其他固定版本共用，移除不删底层对象。

### 预算（明确，不沿用底层默认值）

| 项                       | 上限         | 计量点                                   |
| ------------------------ | ------------ | ---------------------------------------- |
| 单文件大小               | 20 MiB       | 实际流入字节（声明不符即失败）           |
| 单次提交文件数           | 20           | 固定提交时                               |
| 单节点文件总量           | 100 MiB      | 固定版本事实                             |
| 上传时间预算             | 60 秒／文件  | 流式上传                                 |
| 数量上限（单空间）       | 1000 文件    | 元数据登记                               |
| 并发上传预留             | 8            | 同空间在途上传                           |
| 临时／未引用对象         | 计入空间配额 | 发布成功但元数据未登的对象按周期对账清理 |
| 上传内存（单文件／并发） | 20 MiB／8    | 校验完成才暴露的先读后验缓冲             |

## 负例与恢复

- 伪造回执／ID／摘要：上传声明与实际计算不符即失败；提交时回执不存在或不属当前空间拒绝。
- 丢失或损坏字节：读取校验失败 `unavailable`；崩溃后部分对象不发布（上游原子性）。
- 跨空间／无权／撤销：每次上传、读取、下载、草稿引用、提交、下游读都重新校验成员／空间／任务／节点／版本。

## 分层证据

- 纯领域：回执校验、预算、授权规则（agent-core 纯函数）
- 契约模拟：内存存储的端到端服务测试
- 真实 Host：发行 bundle 上真实文件上传→固定提交→读取→重开保留（沿用 #92 harness）
- GUI：协调者操作验收

## 待 A 单写的交点

- 客户端提交页「添加文件」入口、上传进度/取消/重试/移除 UI（#33 产品范围）
- 公共 Host 运输的字节流路由装配
- 本层只声明服务与通道形状。

## 明确不覆盖

- 内容锚点评论（FR09 评论部分）：后续切片
- 图片/PDF 的复杂渲染预览：首版如实下载或基础预览
- 真实 GUI 与付费模型
