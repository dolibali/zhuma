# Run 资源的操作级资格接口

关联 #35 / #113。此模块提供私有数据 / 生命周期接缝；ExecutionService 的 startRun / beginRun 在原队列外准备元数据，再进入原写队列验证和提交。不改 Host 装配、公开 index 或持久事实模型。成员与源授权仍由实际安装的 Host producer 和原 D 门禁完成，元数据、JSON 合法及摘要相同均不是授权。

Host 最小方法为 `prepareResourceCatalog(originalRequest: MemberRequest, command: BeginRunRequest): Promise<ExecutionRunResourceQualification>`；返回 `{catalog, signal, assertCurrent():undefined, release():undefined}`。provider 在读取私有包 / MCP 连接目录前必须核原请求权限与完整 scope / Run / 世代 / 段 / 配置；MCP-only 不得跳过。Skill policy 读取可使用 #145 的原包表，MCP 需真实已资格连接版本 / 目录。不得从保存 resources 直接组装成可信 catalog；MCP-only 数据形状本身也无法证明来源。

`withExecutionRunResourceQualification({host, ownerSignal, originalRequest, command}, work)` 必须在原写队列外调用，因为 policy reader 自己会进入该队列。回调只收到冻结 `catalog` 与包装的 `assertCurrent()`，不收到 metadata signal / release。回调仍须执行原全部门禁，并在每次含 await 的 verify 前后检查当前源；不能用此包装代替原断言或授权。

方法、信号、catalog 身份与内容、原命令保持固定，严格拒绝非 undefined / 异步断言；不记录或比较请求中的凭据。无 resources 的旧路径不读取私有包或连接。当前原 schema1 / schema2 保存源保持，不查 latest 来重写旧配置。

整个 Promise 包含迟到 qualification 和真实 release。owner 应先 fence / abort 新 prepare，再等待该 Promise，而非只等写队列；ExecutionService 已按方法级交接让 startRun / beginRun 共用 prepareRunBegin，beginRunNow 接受 catalog 并保留原全部门禁；closeRuns 先 fence，再等待所有在途 prepare（包括 release）及原写队列。release 缺失、抛错或非 undefined 会产生内部 `ExecutionRunResourceQualificationCloseError.cleanupFailed`，owner 必须保留清理失败，不能把 allSettled 或逻辑取消当排空成功。

操作 metadata signal 不得被用作持续 Run 的资源 producer 信号。后者仍由原 owner 的真实 grant、lifetime、停止和 drain 管理；本操作完成释放 metadata 不应终止新 Run。

测试是 Host / 授权 double 下的编排契约，另以真实 Cordis / DSH JSON 服务验证原读写队列的重入、固定配置重算、幂等、关闭与迟到 release；成员、配置、工作区与资源来源仍是契约 double，未认证真实 Cookie、包权限、MCP 连接、正常 Host 或 GUI。原 installed Host 身份由调用者提供；此模块不签发或伪造它。
