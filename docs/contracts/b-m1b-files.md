# B-M1b 真实文件交付：有界接口与复用取舍

工作项：[#33](https://github.com/dolibali/zhuma/issues/33)。主责：B；范围：FR06/08/09/13 的文件部分。本文先交有界接口与复用取舍，随后沿本项最小服务实现。客户端 UI 与公共 Host 运输归 A。

## 复用取舍

**采用**：上游固定提交 `687f282` 的 `attachment-local` 原字节存储（`packages/attachment/attachment-local/src/file-store.ts`）：
- `saveFileStreamVerbatim`（流式原字节保存，内容寻址 sha256，原子发布＋目录 fsync，崩溃安全）
- `readFileStreamVerbatim`（流式读取＋字节数与摘要校验，损坏在最后一块拒绝）
- `storedFilePath`（`sha256:<digest>` 寻址＋文件名叶子）
- `FileAttachmentRef = { attachmentId: 'sha256:<digest>', name, bytes }`

它提供：不可变原字节持久、可信回执（服务端计算的 digest/长度）、崩溃恢复。**它不提供**：本产品的成员／空间／固定产物授权，也不提供应用限额。

**舍弃**：不自建文件系统或第二份字节库；不把字节塞进现有 JSON 命令通道；不把浏览器 `uploadComplete:true` 或客户端算的哈希当证明。

## 服务接缝（B）

存储布局：宿主 `DSH_HOME/attachments/v1` 下内容寻址（上游机制）；`zhuma_files` 存储域登记元数据 `{ attachmentId, mediaType, byteSize, spaceId, uploadedBy, uploadedAt }`（记录型事实在域，字节在上游存储）。

### 1. 上传 `POST /api/zhuma-exec/upload-file`（字节流，不进 JSON 信封）

- 请求头声明：`x-zhuma-file-name`、`x-zhuma-file-type`、`x-zhuma-file-size`、`x-zhuma-file-sha256`（调用方声明）＋成员会话＋`spaceId`（必填，#87 scope 约定）。
- 服务流式写入上游存储并**实际计算** sha256 与长度；声明值与实际不符即失败，不写元数据。可信回执返回服务端计算的 `{ attachmentId, name, bytes, sha256 }`。
- 幂等：同 sha256 内容寻址天然幂等（重复上传同字节返回同一回执，不重复写）。
- 取消：AbortSignal 中断流；中断不写元数据，不完整对象不发布。
- 授权：成员会话当前持有该 spaceId；无权／撤销／未知即 `not-found` 不泄露。

### 2. 读取/下载/预览 `GET /api/zhuma-exec/file/<attachmentId>`

- 授权：文件登记的 spaceId 必须在请求成员当前空间枚举内（可信目录）；无权／撤销／伪造 ID 即 `not-found`。
- 流式返回并校验字节与摘要；损坏或丢失 `unavailable`。
- 预览白名单（`text/*`、`image/png`、`image/jpeg`、`application/pdf`、`text/markdown`）`inline` 且限界（大小上限内）；其余 `Content-Disposition: attachment` 如实下载原名。预览不执行上传内容。

### 3. 草稿引用与固定提交

- 草稿 `files` 的 `ArtifactFileRef` 引用可信回执（`checksum`＝服务端回执的 sha256）；保存草稿时校验回执存在且属于当前空间。`uploadComplete` 由服务端据回执判定，客户端声明无效。
- `submit` 提交固定版本：校验每个文件回执存在、字节与摘要匹配、属当前空间；固定版本的文件不可变（内容寻址不可覆盖）；重提产生新版本，旧版本可追溯；同键重放／并发不多产物或重复引用。
- 下游授权读取（`upstream-content`）的文件元信息来自固定版本事实。

### 预算（明确，不沿用底层默认值）

| 项 | 上限 |
| --- | --- |
| 单文件大小 | 20 MiB |
| 单次提交文件数 | 20 |
| 单节点文件总量 | 100 MiB |
| 上传时间预算 | 60 秒／文件 |
| 数量上限（单空间） | 1000 文件 |

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
