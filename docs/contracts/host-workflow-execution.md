# Host 工作流执行接缝

## 范围与事实来源

本接缝消费原 `ExecutionService` 的工作流意图、节点、Run、产物和评审事实，以及 `createNativeWorkflowBridge`。Host 继续拥有原 native 会话、Agent、授权和物理资源收尾；Client 只显示公开投影和发送显式操作。没有新的工作流事实库、Agent factory、聊天记录库或第二份结果订阅。

人工节点通过现有派发、待办和提交入口处理，不因工作流启动自动调用模型。Agent 节点使用已确认计划中的专家和固定资源；依赖只有在原业务接受上游产物后才解锁。并行数量是上限，原工作区单写者、资源和授权限制仍生效。

## 公开运输

成员 Fetch 使用原账号、空间和页面世代边界，地址为 `/api/zhuma-workflow/<operation>`。RPC method 与地址精确对应。所有操作由当前原成员请求重新取得权限；Client 不传 actor、原生授权、完整工作区根路径、票或内部意图。

| 操作      | 公开输入                                                 | 行为                                             |
| --------- | -------------------------------------------------------- | ------------------------------------------------ |
| `read`    | `spaceId/taskId/planId/revision`                         | 读取原事实，不自动启动或继续。                   |
| `options` | 同上                                                     | 被动读取原模型目录和成员可选工作区，不调用模型。 |
| `start`   | 位置、`requestId`、`model`、工作区公开选择、`concurrent` | 显式冻结默认配置并启动原工作流意图。             |
| `resume`  | 位置、`requestId/intentId/generation/expectedVersion`    | 对原意图和版本显式继续。                         |
| `stop`    | 位置、`requestId/intentId/generation`                    | 沿原桥和 Run 停止口撤销准入并等待实际收尾。      |

工作区公开选择只允许 `{kind: 'text-only'}` 或 `{kind: 'local', id}`。Host 根据当前成员、空间、项目和原注册表解析完整工作区，保存的配置仍按原完整授权校验；公开 ID 或路径本身不是权限。模型来自原可用目录，不能把失败调用解释成成功或自动切换供应商。

公开投影包含目标位置、标题、状态、`planStarted`、`requiresResume`、活动 Run 数、专家节点数，以及最小 `intentId/generation/version/concurrent` 和模型／工作区选择。它不序列化完整领域 intent、预留票、Run 授权或私有工作区字段。Client 按位置和控制世代核对回执，旧页面、旧账号或旧空间的异步结果不能更新新页面。

尚未开始的计划没有原启动回执，不能假定 workflow read 已经可用。Host 仅在原 `startable` 精确目录确认同一计划、当前成员仍有效且不存在部分节点执行事实时投影 inactive；不会为读取状态隐式调用 start-plan。

## 私有准入与生命周期

原桥保留首次授权请求及原 Service 签发的不可序列化 `WorkflowStartTicket`。Host 的私有 `beginWorkflowRun` 使用这张原票装配固定配置，并作为原 `startRun` 第三个参数交给原队列的最终写入门禁。不得复制、包装或由 JSON 重建票，也不能只在 Host 检查一次就绕过最终门禁。

工作流默认 `accepted-input-reader` 表达允许按需读取固定输入的策略：可信当前节点没有 inputRefs 时采用 text-only，有固定输入时必须采用 accepted-input-reader。未知或无法核实的输入不当成空。冻结的 text-only 不自动升级，local-tools 的原规则不变。派生结果与票的输入指纹、原节点和最终配置同时复核，不删除输入引用，也不放宽原 composition 门禁。

待准入状态按原完整 native scope 保存在 owner 内，包含成员、空间、任务、计划版本、节点、Run、原生运行世代和 segment。工作流控制 generation 与原生运行 generation 不互相比大小或当作同一编号。不得改用 configurationId 全局索引，也不能让旧任务的 finally 删除后继 owner。

在配置准备、原 Run 提交、授权打开、原 Agent 工厂／compose 和实际 send 之间持续核对准入。票撤销只使同一待准入条目的原授权失效；private port 返回后移除该临时关联，正常票 dispose 不能终止已接受的 Run。原 Run 继续由原授权和生命周期拥有。

Stop 先通过原 Service 验证并撤销准入，再等待在途启动和原 Run 的停止／实际 drain。尚未物理收尾不能报告 paused。关闭按桥 fence、原 Run owner 收尾、桥 join 的顺序执行；收尾失败保留失败和门禁，不以持久化标签或 CLI 退出冒充恢复。

正常固定结果提交成功同样通过原 `retireForCleanup` 取得 scope 清理凭据，再释放原 owner。Host 仅在原资源收尾和 settle 完成后，按完整 scope 和原 native.service 保留原 drain 对象、signal 与 assertCurrent 方法的引用；每次读取重新核验。原迁移凭据优先，只有已知尚未准备或尚未建立 binding 时才查询本 owner 的真实清理凭据，未知失败不被缓存遮盖。该有界缓存不持久化，不由 settled／active0 标签生成，关闭时清除。

新 Host 在用户显式继续时，先以原可信成员和完整工作流位置重新授权，核对意图版本及全部预留与已提交 Run 的原绑定。只有原当前、终态且已 settled、实际 received/acknowledged 并有完整原生会话身份的 Run 才能取得原 `cleanupAfterSettlement` 清理资格；资格不等于 drain。Host 再调用原 C `retireForCleanup`，核对真实返回的完整 scope、会话／Agent ID 和 flushed-and-closed 凭据，等待本 owner 尚有的资源采用收尾，并在 await 两侧重查成员和原意图。仅在上述检查通过后保留本 owner 的真实凭据，再交原 D resume 最终门禁。缺失预留回执、未知接收、缺失 binding、过期成员或未完成 drain 均不冒充恢复；不会创建 Agent、重发请求或重新提交旧产物。

## 客户端入口

任务负责人在已确认工作流上显式运行、继续或停止。首次运行选择实际模型、工作区和并行上限；继续使用原冻结选择。无 Agent 的计划通过现有“查看待办／开始执行”派发，不要求配置模型。

负责人尚未派发时，节点 Agent 入口显示不可用并指向明确的启动／派发路径。其他参与者的节点入口使用原 Run controller 读取本人有权处理的节点／Run，不能依赖负责人专有的工作流控制投影，也不开放工作流管理权限。节点未派发或授权失败仍由原节点服务拒绝，不猜测 planStarted。读取状态、打开页面、切换视图和重新登录都不会自动执行。执行中的状态刷新只是被动读取，不在 Client 另建调度循环。

## 独立专家评审的资源接入

原工作流桥把同一个可信请求及原 `WorkflowExecutionClaim` 转交原生评审桥。评审桥使用原 Service 的候选、准入、drive、固定读取和原子票；Host 在原 native owner 中按真实 review purpose 分流工作目录与 compose，不另开会话服务或替换 Agent factory。评审采用 text-only 工作目录，仅从固定评审读取工具获得本轮正文／文件；不继承作者的工作区、工具、Skill 或历史。评审分支的容量或未就绪拒绝不会 fence 同一 claim 的作者票。

Host 从原 LLM 目录准备模型配置，从本计划冻结的具名评审专家及其不可变资源包准备 Skill。实际采用持续复核原 D drive、同 C owner 的原 review grant、完整目标／配置和当前包版本，再在同一个未发布 Agent scope 中注册官方 SkillRegistry／ToolSkill。与作者共用 SDK 注册和排空内核，但评审不用作者 composition 或作者 Run 授权。交给评审桥的 allowlist 和描述符来自实际注册的工具，包括真实 Skill loader；元数据资格或 configurationId 文本不等于实际采用、发送或投票权限。

当前正常 Host 尚无可信 MCP 连接租约来源，非空 MCP 配置明确拒绝。不能从资产文本解析凭据、借用全局连接或用描述符宣称 MCP 已加载。原通用 SDK MCP 注册／关闭内核保留，后续消费具名、可撤销的可信连接租约。

Host 关闭必须先 fence 派发，再等待原评审桥的实际 cleanup 和资源 drain，然后关闭结果收集及 native owner。评审 pending／拒绝时保留这些 owner，不通过关闭输入读取来制造成功或与在途结果收集互相等待。普通工作流 Stop 通过原 claim／drive 撤权触发本 scope 清理，不调用全局评审 fence。显式继续时另核原 `reviewResources` 完整 scope，仅对终态或已请求 Stop 的原评审调用真实 cleanup；pending 继续保留恢复门禁，不重发模型或重投票。

## 验证边界

`--phase host-workflow` 是原发射 Host、原 Service／桥／factory、真实成员 Cookie、JSON／JSONL 与本地脚本模型的定向接缝入口。`host-workflow-admission` 单独覆盖并行与评审门禁、原 metadata／Agent-created 中的 Stop 窗口，以及正常准入后原 Run 的存活和显式停止。精确运行结果、源 SHA、Host 字节与失败证据以对应 PR 为准，不从命令声明推断通过。

`--phase host-workflow-cold` 独立运行旧 Host 写入并关闭与新 OS 进程重新授权／显式继续两阶段，验证读取不隐式收尾、无关／撤销成员及错误空间／版本拒绝、原继续回执幂等、旧分支不重跑、原评审通过后才执行合流与解锁人工提交。使用真实 Host／SDK／JSON／JSONL 与本地脚本模型，不扩张为正式编译 GUI 或供应商验收。

`--phase host-review-resources` 定向验证实际 Host 中独立专家加载所选 Skill、读取固定正文、原子落票和下游，以及未读取内容不投票、运行中关闭等待真实评审 stream。原身份／计划数据和模型响应使用明确隔离夹具，不据此声称正常创建、真实供应商或安装验收已通过。

源码别名 SDK、正式编译包、正常桌面入口、真实供应商和安装验收分别记录。没有完成对应层级验证前，不将本接缝或旧版本证据称为产品验收。文件结果、Agent 评审和多层子任务继续消费各自冻结的原能力，不能由本控制条冒充已经完成。
