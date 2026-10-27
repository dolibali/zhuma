# 本机目录授权接缝

## 事实与执行

正常入口复用官方 `uiWorkspace.pickDirectory()` 和 `workspaces.create({path})` 登记目录，再由当前本机所有者及原产品成员显式确认项目权限。选中或登记目录不创建产品授权、不启动会话、不调用模型。官方目录控制器返回 `workspaceId`；本产品的权限运输不接受文件系统路径、actor 或 `confirmed` 标记。

原 `ExecutionService.openWorkspaceApprovalOwner` 是唯一授权事实写者，沿原 `zhuma_execution` domain、队列及 `workspaceApprovalWriter:1` 保存版本、回执和撤销墓碑。Host 使用原 SDK Registry、SandboxPolicy 和真实规范路径，核对目录创建身份、路径指纹和当前部署策略；写权限不能超过实际 SDK 策略。Client 无 Host／文件系统依赖。

原 `createHostRunWorkspaces` 在每次准入、工具与文件 I/O 前重新读取 D 的当前元数据，核对 actor、空间、项目、目录身份、generation、原 Run 与成员资格。动态行覆盖同一成员／项目／目录的静态绑定，包括已撤销行；不能通过另一个静态 ID 恢复已撤销权限。旧 generation 的信号立即取消，在途 I/O 仍须等待原物理资源完成收尾。没有第二份授权表或工作目录执行器。

更新读写和交付范围需原重叠目录的 Run 已停止、资源已释放且有原真实 drain。撤销不依赖目录仍存在，可立即保存墓碑；旧请求重放返回最新墓碑，不恢复权限。当前 Run 的配置保持冻结，不在执行中悄悄替换目录或增加工具。

## 公开入口

成员 POST `/api/zhuma-workspaces/options|approve|revoke`，RPC method 与地址精确对应。SDK owner 和严格同源检查在读取请求体前完成；原产品成员、项目和空间仍由 D 复核。桌面只对这三个显式 POST 从已校验的 `dsh-app://app` 转发本机规范 Origin，不放宽其他路由。

- `options`：`spaceId/projectId`；返回 SDK 目录展示信息和当前成员的授权投影。目录展示最多 100 项；只在 owner 控制入口展示路径，不输出原 owner、Run 列表、路径指纹或完整 snapshot。
- `approve`：位置、UUID `requestId`、`workspaceId`、`expectedGeneration`、`access` 与独立 `publish` 相对路径范围。最多 16 个范围，范围总量 4096 bytes，原 D 容量限制不变。
- `revoke`：位置、UUID `requestId`、`approvalId/expectedGeneration`；目录缺失时仍可撤销。

Agent 配置与工作流运行设置使用同一个授权窗口。只读／读写与本机文件交付范围分开配置。没有交付范围时不提供本机文件 publisher；允许文件发布也不等于提交或评审通过。授权完成后刷新可选目录，用户仍须显式选择并运行。窗口关闭、成员／空间／控制器世代变化会取消旧 Client 操作；目录选择返回后，在原 SDK 登记前再次核对当前成员和原控制器身份。

## 验证边界

Node 契约覆盖实际 SDK 注册表／策略、规范目录和原 D domain；其中 SDK owner、成员及 Run 端口替身明确标为契约。公共 `desktop:verify:native-lifecycle --phase host-workspace-approvals` 使用原发射 Host、原 SDK/factory、owner 和成员 Cookie、JSON／JSONL、真实文件工具及 attachment bytes；模型输出为本地脚本。

具体提交、真实执行结果、Host 字节与日志在关联 PR 记录。测试命令存在不代表通过，同一 Host 重挂载不能代替新 OS 进程恢复，源码别名 SDK 不能代替正式编译桌面、正常 GUI、供应商或安装包验收；这些层次由协调者分别安排。
