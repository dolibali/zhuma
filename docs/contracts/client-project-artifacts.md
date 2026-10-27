# 项目成果公开接缝

项目“资料与成果”页消费原 `ExecutionService.projectArtifacts`。只展示当前成员参与任务的最新已确认计划中，原节点当前接受指针指向的固定版本；不回退旧计划，不从完成标签推断已接受，也不把项目可见等同于全部任务内容可读。

## 查询与文件

`POST /api/zhuma-exec/project-artifacts` 复用原成员 Fetch carrier、请求原对象及 `openFileAuthority`。list 请求带 `spaceId/projectId`、可选 limit/cursor；content 请求带原完整固定 ref。Host 重新核当前成员、项目、任务、计划、节点和接受指针，读取不隐式修复依赖或写入事实。

列表每页最多 20 项，仅返回标题、版本、状态与文字／链接／文件数量；正文在显式展开后单独读取。稀疏扫描允许返回空页及 nextCursor，空页不等于扫描完成。cursor 只是位置提示；目录变化时可失效，不能跨页宣称同一快照，也不能用它授权内容或文件。

文件沿原 `FileReferences` 与 `/api/zhuma-exec/file`，使用 `purpose: 'accepted'` 加 `spaceId/projectId/taskId/planId/revision/nodeId/artifactVersionId/uploadId/mode`。Host 每次读取及发送字节前复核当前接受指针。旧 `artifact` purpose 保留负责人的既有历史语义，不能由项目参与者借用。

## Client 生命周期

项目页的查询和文件 API 属于当前账号、空间和目录页面世代，与“我的工作”页面原控制器分别绑定。查询前后重新检查当前账号／空间；响应中的固定 ref、项目、空间、版本、游标与数量均受限并核对。Client 不传 actor，不持有 owner、原生授权或文件系统路径。

页面组件仅在成果页挂载，列表展开、加载更多、正文展开及文件预览均为显式操作。项目、API／权限世代变化时取消旧操作并清理旧内容。文件继续走原元数据、字节大小、摘要与引用核对；不复制新的文件读取器或自动提交入口。

## 证据边界

DTO、账号更换和延迟响应测试是 Client 契约；正常 Host 查询使用原 Service／file authority。`desktop:verify:native-lifecycle --phase host-project-artifacts` 为实际发射 Host、真实 owner/member Cookie 和原文件服务准备定向验证：手工上传、提交接受、摘要／固定正文、accepted 文件实际字节及非参与者拒绝。实际结果以对应 PR 的精确源与证据为准，命令和用例存在不代表通过；源别名 SDK、正常编译 GUI及安装验收分开记录。
