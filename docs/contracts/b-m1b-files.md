# B-M1b 真实文件交付：有界接口与复用取舍

工作项：[#33](https://github.com/dolibali/zhuma/issues/33)。当前主责：C，接续 B 的原始实现与历史；范围：FR06/08/09/13 的文件部分。已实现上传、文件草稿、固定版本提交及真人执行者／评审人／下游执行者的授权读取。客户端 UI、公开导出与公共 Host 装配归 A；本文不认证这些界面已接入。

## 首批上传接入与边界

- `ExecutionService.uploadFile(caller, options, authority)` 的第三参是 Host 用原始成员请求经 `openExecutionMemberLease` 签发的真实成员 lease 加同步 `assertProjectSpace(projectId, spaceId)`。后者读取同一当前已发布目录的 `spaceForProjectNow`，每个读取边界、EOS 和写前都重新核对实际项目归属；映射事件撤销该请求的资源信号，旧异步查询结果不能授权发布。不接收浏览器声明的成员／lease，不依赖 NativeRun 开关；请求、当前成员会话、空间目录和插件生命周期共同约束上传。
- 所有持久字段在读取字节前按同一记录 schema 校验。初发和重放都校验真实字节，并在向附件 SDK 返回 EOS 前核对摘要和长度；错误声明不能先发布 CAS 再拒绝登记。SDK 包装错误后仍保留 `digest-mismatch`、`file-too-large`、`upload-timeout`、`cancelled` 等业务码。
- 幂等指纹包含成员、空间、任务／计划／版本／节点、文件名、媒体类型、长度和摘要。在途同键同体返回 `conflict` 且 `details.reason=upload-in-progress`，调用方保留同键重试；在途同键异体返回 `idempotency-mismatch`，不读取第二份字节。完成后的同键重放仍校验本次真实字节并返回原 UUID。
- 只有短准入／资源预留和最终新鲜授权、配额与回执写入进入既有业务队列；真实字节 I/O 不阻塞其他节点的停止或查询。每空间最多 8 个实际在途上传；进程内预留仅控制资源和并发，可信事实仍只写 `zhuma_files.files` 一行。60 秒时限同时覆盖初发与重放等待 `next()`／附件服务；逻辑取消不伪装物理清理已完成，关闭插件会等待实际资源收敛。
- 上传与读取均沿用原始 Cookie 签发的成员 lease 及同句柄同步项目空间断言。JSON 草稿／提交只在需要处理文件时懒创建此能力；正文提交保持原通道语义。实际文件校验在原命令队列外进行，提交在原队列中重新检查完整节点、评审轮次／人员、固定输入、回执绑定和当前权限；最后一次上游异步查询之后、实际写入之前再次检查。
- 文件锚点评论、Agent 身份的文件读写／自动提交、图片与 PDF 渲染仍未实现；不以真人测试或上传成功宣称完整 #33／Agent 链验收。GUI 与模型均不由本切片认证。

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
- 服务流式写入上游存储并**实际计算** sha256 与长度；声明值与实际不符即失败，不写元数据。可信回执返回 `{ uploadId, attachmentId, name, mediaType, bytes, sha256, reference }`，其中 `reference` 是可原样传给草稿／提交的规范 `ArtifactFileRef`：`{ id: uploadId, mediaType, byteSize: bytes, checksum: sha256, accessPolicyId: 'space:' + spaceId, uploadComplete: true }`。`accessPolicyId` 只是标签，不授予权限。
- 幂等键：同键重试返回同一回执（不重复登记元数据）；同键异体返回 `idempotency-mismatch`。
- 恢复：完整字节已发布但元数据写失败／回执丢失／取消迟到时，按同幂等键重试——字节对象已存在则直接补登元数据返回回执；中断的不完整对象不发布。
- 授权：成员会话当前持有该 spaceId **且**是该任务该节点的当前执行者；非参与者／无权／撤销即 `not-found` 不泄露。
- 元数据 `zhuma_files` 记录 `{ uploadId, attachmentId, name, mediaType, byteSize, sha256, spaceId, taskId, planId, revision, nodeId, uploadedBy, uploadedAt, state }`。

### 2. 读取／下载／纯文本预览 `GET /api/zhuma-exec/file`

- query 必须提供 `taskId/planId/revision/nodeId/spaceId/uploadId/purpose`，`mode` 为 `metadata`（默认）、`preview` 或 `download`。拒绝未知字段、重复字段及不匹配的用途字段。GET 使用官方 buffered 请求桥，不创建 GET 请求体流。
- 用途是互斥的：`draft` 为当前真人执行者读取其在 ready／needs-revision 节点上传的文件；`artifact` 额外提供 `artifactVersionId`，供当前真人执行者读取已固定版本；`review` 额外提供 `artifactVersionId/roundId`，要求同一固定轮次与当前节点两处都包含该评审人，已作废轮次拒绝；`upstream` 额外提供 `sourceNodeId/artifactVersionId`，要求当前下游执行者和准确 inputRef，源节点已接受版本必须就是该固定版本。下游执行者可与上传者不同。历史退回轮次仍可按原轮次读取原文件以便比较，不换成最新版本。
- **对象授权（不只核空间成员）**：上述每种用途均重核实际任务参与、当前成员与项目空间、完整计划／节点、文件账本与固定产物的引用。哈希和 UUID 只定位，不授权。HTTP metadata JSON 返回 `{ ok: true, value: { request, uploadId, name, mediaType, bytes, sha256, reference } }`，无控制函数或文件字节，不触发 SDK 读取。二进制响应通过 `x-zhuma-file-context`（完整请求的 JSON 经过一次 URI 编码）、`x-zhuma-file-upload-id` 和 `x-zhuma-file-sha256` 回显定位，供 A 做迟到门禁。
- 负例：同团队非参与者、非引用文件、错轮次/节点、撤销后旧回执均 `not-found`，拒绝不读取字节、不增加业务事实。
- **校验完成才暴露**：单文件在内存/并发预算内先完整读入并校验字节数与摘要，校验通过才响应；损坏或丢失 `unavailable`。**不**把上游流直接转发 HTTP（上游先 yield 数据后校验，直接转发会在校验前发出损坏字节）。等长末字节损坏及流中断的负例证明不产生成功回执/可用预览。
- **安全呈现**：仅白名单文本类型、合法 UTF-8 且无 NUL／`<` 的内容可按 `text/plain; charset=utf-8` inline。Markdown 也显示原始文本，不执行 HTML；主动扩展名、伪装内容、图片、PDF 和其他类型均以 `application/octet-stream`＋`Content-Disposition: attachment` 下载原字节。文件名仅取可信原上传叶名，通过 `filename*=UTF-8''...` 编码。所有响应带 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cross-Origin-Resource-Policy: same-origin` 与 `private, no-store`。实际 HTTP 测试验证声明、改名 HTML／SVG／PDF 的响应头与原字节；尚未据此认证浏览器脚本隔离或 GUI 渲染。
- Host 内部 `ExecutionService.fileContent(caller, query, authoritySource)` 返回的 `AuthorizedFileContent` 含 `info/bytes/signal/check/release`。仅运输层持有，不能序列化传给 Client；消费者发送前及每个后续块调用 `check()`，正文 EOF／取消／异常必须 `release()`。同空间最多 8 个读取资源，完整校验后仍保留至响应消费／释放，防止慢响应绕过缓冲配额。取消／超时先拒绝响应，唯一插件 closer 仍等待真实 SDK pending 读取收敛，再关闭账本和执行域。
- 状态码：无成员会话沿原会话服务返回 401／403；无权对象 404 `not-found`；请求字段错误 400 `validation`／`unknown-field`；文件损坏／缺失 409 `unavailable`；超时 409 `file-timeout`；取消、并发配额或生命周期拒绝返回对应 409 业务码。响应开始后撤权会中断正文，不伪造已完成下载。

### 3. 草稿引用与固定提交

- 草稿 `files` 的 `ArtifactFileRef` 引用可信回执。除忽略调用方 `uploadComplete` 外，UUID、类型、字节数、摘要和策略标签必须与账本完全相符，且属于该当前执行者、空间和完整节点定位。持久草稿仍把完成标记存为 false；返回视图依据当前授权账本投影 true，并通过可选 `fileDetails: [{ id, name }]` 返回可信文件名。旧草稿中的未知引用保留为未完成，正文不丢失；新保存不得把伪造引用当完成。草稿版本独立于节点版本，保存使用草稿 expectedVersion，提交使用节点 command.version。
- `submit` 提交固定版本：校验每个文件回执存在、字节与摘要匹配、属当前空间与本轮节点；固定版本的文件不可变（内容寻址不可覆盖）；重提产生新版本，旧版本可追溯；同键重放／并发不多产物或重复引用。
- 下游授权读取（`upstream-content`）的文件元信息来自固定版本事实。
- 移除草稿里引用的文件：仅解除引用，不删字节——同一字节可被其他固定版本共用，移除不删底层对象。
- 非空文件可单独提交，不强制填充说明；只包含零字节文件的提交沿用既有核心 `empty-delivery` 语义。上传／读取零字节文件本身允许，不以补假文字改变核心判定。

### 预算（明确，不沿用底层默认值）

| 项                       | 上限        | 计量点                               |
| ------------------------ | ----------- | ------------------------------------ |
| 单文件大小               | 20 MiB      | 实际流入字节（声明不符即失败）       |
| 单次提交文件数           | 20          | 固定提交时                           |
| 单节点文件总量           | 100 MiB     | 固定版本事实                         |
| 上传／完整读取时间预算   | 60 秒／文件 | 初发、重放与 SDK 完整读取            |
| 数量上限（单空间）       | 1000 文件   | 元数据登记                           |
| 并发上传预留             | 8           | 同空间在途上传                       |
| 并发读取资源             | 8／空间     | 含已验证、尚未消费或释放的 HTTP 响应 |
| 读取缓冲（单文件／并发） | 20 MiB／8   | 完整校验后才构建响应                 |

空间数量与节点字节预算目前对已登记上传累计计量，移除引用不返还上传配额。不完整 staging 清理由上游负责；已发布但未登记、或未被引用的对象尚无产品级定期对账／GC，不能宣称已清理。读取的 60 秒覆盖 SDK 完整读取，不是给已开始下载的慢客户端另设的墙钟截止；其内存和资源仍受并发及当前 lease／连接生命周期约束。

## 负例与恢复

- 伪造回执／ID／摘要：上传声明与实际计算不符即失败；提交时回执不存在或不属当前空间拒绝。
- 丢失或损坏字节：读取校验失败 `unavailable`；崩溃后部分对象不发布（上游原子性）。
- 跨空间／无权／撤销：每次上传、读取、下载、草稿引用、提交、下游读都重新校验成员／空间／任务／节点／版本。

## 分层证据

- 纯领域与契约：既有提交／评审状态机、内存执行存储与合成 lease 下的回执／元信息、配额、DTO 拷贝测试。实际附件和文件账本用发布版 SDK 与 JSON 域，仍不冒充完整成员授权验收。
- 真实 Host：`m1-acceptance-host.test.mjs` 通过官方 Connection、真实四账号 Cookie、真实 SDK 字节与 JSON 域、独立 Node 子进程覆盖文件草稿重开、纯文件 V1 提交、评审退回／V2 重提、两位评审全员通过、不同下游执行者读取准确 V2 以及再次重开。另有同团队无权者／错轮次／错空间／未接受输入零 SDK 读取，真实字节损坏／缺失、读取中撤权／取消／可控时钟截止、上游 await 后评审配置／绑定变化、关停保留 pending 读取负例。测试专用 seed、原始 JSON 事实注入和延迟流仅作故障注入，不是公开迁移／改轮次接口。
- `S1A_HOST_MODULE` 显式绑定实际构建模块；源码构建与正式 bundle 分列，不用旧 SHA 的通过认证后续代码。最新执行结果与完整 SHA 留 PR，Issue 引用结论。
- GUI：协调者操作验收

## 待 A 单写的交点

- 客户端提交页「添加文件」入口、上传进度/取消/重试/移除 UI（#33 产品范围）
- 消费本服务上传与 GET 文件接口；Host 注入同一公开附件服务及文件存储，不另开同名事实域。
- 公开包入口由 A 导出 `ExecutionFileAuthoritySource`、`FileContentRequest/Info`；`AuthorizedFileContent` 仅 Host 运输需要，不提供给客户端。

## 明确不覆盖

- 内容锚点评论（FR09 评论部分）：后续切片
- 图片／PDF 渲染预览：当前如实下载
- Agent 身份的文件读取、固定提交与内容锚点：仍需消费同一 Run 授权，不以真人 lease 冒充
- 真实 GUI 与付费模型
