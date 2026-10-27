# Host 本地工作区与文件发布接缝

适用于 #35 的原生成员 Run。沿用原 ExecutionService、NativeWorkGrant、SDK WorkspaceRegistry／FS 与文件台账；不增加工作区、授权、Run 或会话事实库。代码入口为 `host-run-workspaces.ts` 与 `host-run-owner.ts`。实时交付及验收结论仍在 #35／对应 PR。

## 授权输入

`host-plugin` 的 `localExecution` 是本机操作方提供的私有配置。默认没有任何绑定；SDK 工作区存在、浏览器能看到目录、项目成员身份均不能单独签发文件权限。

```yaml
localExecution:
  deviceId: local-device
  bindings:
    - id: project-files
      generation: 1
      actorId: member-id
      spaceId: space-id
      projectId: project-id
      workspaceId: official-workspace-id
      access: write
      publish:
        - kind: directory
          path: deliverables
```

`workspaceId` 必须解析为原 SDK 注册表中的真实工作区。根目录仅从该对象读取，配置和 RPC 都不接收客户端路径。绑定精确匹配成员、空间与项目；原成员授权和 Run controller 在原队列中继续校验，不能用该配置替代它们。最多 100 条唯一绑定，代数为正安全整数；发布范围最多 128 项，均是工作区内规范相对路径。

`access: read` 只提供受限 `read`；`write` 提供受限 `read`、`write`、`edit`，包括读取权限。两者均不提供 shell。`publish` 默认空，单独授予向当前任务空间发布指定文件／目录内文件的权限；读取、编辑不隐含发布授权。授权指纹固定整个绑定、设备、SDK 根目录及创建代数，修改发布范围也不能扩大已有 Run 的权限。

## 选择与执行

成员 Run options 只返回已授权选择的 ID、工作区名称、读／写等级及是否允许发布，不返回根路径或完整授权描述。Client 默认仍是“仅使用任务材料”；用户明确选择工作区后，begin 仅发送 `{ kind: 'local', id }` 和 `local-tools`。未知 ID、额外路径、额外权限以及其他成员的选择均拒绝。

Host 使用真实 SDK Tools／ToolFs 的受限配置读取工具声明。元数据注册放在独立的原 SDK Tools／SystemPrompt 服务中，保持全局工具和提示不变，不创建 Agent 或会话。实际执行由原 factory 创建的 Agent、原 scope 与 D 的受控 FS facade 采用；冻结和执行两侧必须精确匹配声明，不能放宽比较来通过启动。

正式 Web 的全局 FS 是原 `SandboxedFileSystem`，D 的 local producer 明确拒绝它；不能把最初使用裸 FsLocal 的源码测试视为正式 Web 已接入。Host 在同一私有元数据 scope 装配官方 FsLocal，仅作为元数据及 D bounded facade 的后端，不替换全局 sandbox／preset，也不改变 D 的比较或权限检查。绑定原 `SandboxPolicyService`、原 resolve 方法与其生命周期；缺少或替换该来源时拒绝本地能力。

工作区新配置的权限上限是操作方授权与 SDK 真实部署默认的交集；SDK 默认 read-only 时只冻结 read，界面返回只读。策略放宽不会升级既有 frozen read，也不因当前上限变宽而把它误判未知或改写原幂等回执。创建前只准备目录资格及实际 canonical root；原 factory 的 compose 再从其真实、尚可能未发布的 Agent scope 绑定实际 session，沿原 scope 生命周期释放，没有伪 Session 或另建会话库。每次 I/O 与原 Run 资格复核调用 `resolve({session})`，绝不传显式 mode；write 还须满足原 SDK 非只读策略及真实 session immutable cwd 与已授权 canonical root 的覆盖。danger 模式也不扩大 Host 根。原 sandbox/mode 事件仅触发重新资格校验，实际执行与排空继续归原 Run／native owner。

有已接受的上游输入时继续装配原 `read_accepted_input`。有独立发布权限时才装配 C 的 `publish_output_file`，将实际读取、核验的字节写入原附件存储与 `zhuma_files` 台账，记录原 Run 来源。它不等同于提交产物、通过评审或解锁下游。

## 撤权与恢复

每次工具 I/O、发布、继续发送及原 Run 资格复核都检查当前绑定、成员／controller、SDK 根目录身份和冻结配置。绑定改变、真实服务卸载、工作区撤销或 Host 退出后，旧 capability 不能恢复；恢复相同字符串也不能使同进程中已撤销的信号复活。

工作区和 Host 关闭信号先禁止新 I/O，再沿原物理 I/O／附件发布 drain 释放资源。发布 owner 延迟到真实选中发布工具时创建；无附件服务的旧文本 Run 不因此失效。冷恢复从原持久化 Run／composition 读取冻结事实；内存索引仅缓存这些事实，不替代它们。新进程重新校验当前操作方配置和注册表；读取 options、刷新页面、重开会话均不会自动执行。

Host 显式关闭在原生运行和 I/O 清理确认后销毁元数据插件及其私有 Tools／SystemPrompt 注册；同一 Context 重新打开只保留当前 owner 的注册。未确认排空时关闭继续失败，不提前销毁仍可能参与清理的服务。

## 证据边界与后续出口

`host-run-workspaces.test.mjs` 是使用真实 Cordis、SDK 注册表、FS 与临时 JSON 的授权契约测试，成员／Run 事实是显式 doubles。`desktop:verify:native-lifecycle --phase host-local-workspace --upstream <固定 SDK>` 使用真实发射 Host、Cookie、Run、JSON／JSONL、磁盘与附件字节；模型响应为本地脚本，并且 SDK 使用源码别名图。证明文件同时记录源码版本、dirty 状态、补丁、Host 字节与新测试摘要。

这些证据不认证正式编译后模块图、真实供应商、正常 GUI、安装包或普通安装入口初始化。正式安装当前仍为 `legacy-single-user`，不会因私有配置正例被视为默认成员入口已交付。

修复的增量入口是 `--phase host-local-policy`：真正默认 read-only、隔离操作方明确选择 workspace-write 的文件发布正例，以及同一真实 session 变严后的撤权／持有流排空；模型仍是本地脚本、SDK 仍是源码别名图。原 #170 compiled GUI 缺失工作区的失败由协调保留；完整编译与正常界面须在修复 head 另验，旧 source-SDK 5/5 不替代它。

## Host 固定文件提交

有原附件后端时，Host 创建同一个原 `createNativeFixedResultPublicationsIssuer` 与输出发布器，通过其 `v1Issuer`／v2 视图一次装配到原 ExecutionService。新专家 Run 冻结 `complete_work@2`，原 `onReady` 链将核实、封存后的文件选择交给 Service 核验附件字节并提交。发布文件、声明完成、固定结果、业务提交、评审通过与下游解锁仍是不同事实；人工负责的节点继续手动提交。

既有 Run 按持久化 descriptor 选择协议，不能由新后端或 Client 标记升级。Host 读取、冷确认与 Client DTO 成对保留 @2 的 `protocolVersion: 2`、`manifestDigest`；旧 @1 回执保持原字段。每个 native owner 只选择一次结果 owner：明确无附件的旧文本 Host 使用一份原 @1 owner，真实后端存在却初始化失败时不降级；后端卸载后原运行撤权并排空，恢复需关闭后重开 owner。旧 @2 的配置不改为 @1，未接回文件后端不能继续采用 @2 文件结果。

登记但尚在初始化的原附件服务同样不属于“无附件”。Host 用公开非严格查询辨认登记，再用严格查询核对同一服务已经就绪；未就绪时在创建 native owner／安装 Run authority 前抛出 `run-authority-unavailable`，不接纳新 Run。依赖 child 的 `await()` 不表示等待 PENDING 服务完成。后端稍后就绪不会自动重启已经失败的独立 native child；需明确重挂载原 Host，重新绑定原附件与 ExecutionService 后才能创建 @2 运行。定向 `--phase host-backend-readiness` 覆盖真实 LocalAttachmentStore 的延迟就绪、初始化失败、明确重挂载后的 @2，以及无附件／卸载兼容；正常官方冷启动及界面可用性仍需单独验收。

新增 `--phase host-fixed-publications` 仅验证此次 Host 接入：真实发布后删除原源文件、纯文件固定提交、回执被动读取、无附件旧文本兼容、原文件台账初始化失败、注销／附件卸载撤权，以及旧 @1 写进程到双协议 Host 读进程的冷确认。使用原 SDK factory、真实 Cookie／Run／JSON／JSONL／附件和本地脚本模型，仍是源码别名模块图，不能代替正式编译包、GUI、评审／下游或供应商验收。文件业务提交按自身有界事件预算等待，不以原生声明成功推断业务成功。
