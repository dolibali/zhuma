# 执行台落盘失败审计

每一处都是先改内存，再 `journal.save`。保存失败要么退回这次修改，要么保留内存并标出 `persistenceFault`。已有故障不会被随后无关的成功保存清掉，只有 `rewritePersistence` 成功重写当前内存之后才清除。附件字节仍只在当前进程，不另建文件存储。

| 入口                                 | 位置                                                | 策略                                                                          | 测试                                                           |
| ------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ExecutionDesk.create`               | `execution-desk.ts:320`                             | 保存失败则抛出 `persist-failed`，不交出工作台                                 | `契约：创建时日志写不进去就不交出工作台`                       |
| `resumeInteraction`                  | `execution-desk.ts:338`                             | 回滚 `interactionReady`                                                       | `契约：恢复交互写不进去时仍不能发送`                           |
| `rewritePersistence`                 | `execution-desk.ts:348`                             | 重写当前内存；只有这次成功才清除故障                                          | `契约：执行事件保存失败不产生未处理拒绝，恢复后可以重写`       |
| `updateConfig`                       | `execution-desk.ts:437`                             | 回滚选择、配置标识和轮次                                                      | `契约：配置、上下文、附件和恢复请求保存失败时退回`             |
| `setAvailability`                    | `execution-desk.ts:461`                             | 回滚专家或执行器可用状态                                                      | 同上                                                           |
| `setContextIncluded`                 | `execution-desk.ts:479`                             | 回滚勾选和上下文块                                                            | 同上                                                           |
| `addAttachment`                      | `execution-desk.ts:495`                             | 回滚附件记录和字节                                                            | 同上                                                           |
| `removeAttachment`                   | `execution-desk.ts:557`                             | 回滚删除                                                                      | 同上                                                           |
| `send` / `beginRun`                  | `execution-desk.ts:933`                             | 回滚 claims、runs、turns                                                      | `契约：首次受理保存失败后同键重试会启动，写权不残留`           |
| `enqueue`                            | `execution-desk.ts:1086`                            | 回滚队列、运行和节点，失败项不可被消费                                        | `契约：排队受理保存失败后不会被自动执行，同键重试只启动一次`   |
| 重新打开后的同键重试                 | `enqueue` / `beginRun`                              | 日志里没有失败项，重试只启动一次                                              | `契约：排队受理失败后重新打开，同键重试只启动一次`             |
| `stop` 取消之前                      | `execution-desk.ts:594`                             | 回滚停止请求，不调用取消                                                      | `契约：停止请求没有写入时不取消执行器`                         |
| `stop` 取消回执之后                  | `execution-desk.ts:613`                             | 故障。取消已经发生，保留内存，不记成成功回执                                  | `契约：取消回执之后的保存失败不撤销已经取消的运行`             |
| `retry` / `restart`                  | `execution-desk.ts:626`                             | 回滚节点迁移和因此启动的运行                                                  | `契约：重试和核实断开保存失败时不改节点`                       |
| `recover`                            | `execution-desk.ts:675`                             | 回滚恢复请求                                                                  | `契约：配置、上下文、附件和恢复请求保存失败时退回`             |
| `verifyAbandoned`                    | `execution-desk.ts:686`                             | 回滚核实结果和 `resumeGap`                                                    | `契约：重试和核实断开保存失败时不改节点`                       |
| `saveDraft`                          | `execution-desk.ts:733`                             | 故障。草稿留在内存，返回 `persist-failed`，没有单独的编辑或丢弃入口           | `契约：草稿保存失败不是成功回执，恢复后可以重写`               |
| `acceptReviewResult`                 | `execution-desk.ts:759`                             | 回滚这次保存；它不结算节点                                                    | `契约：接受当前轮次的结果保存失败时不报成功`                   |
| `confirmCompleted`                   | `execution-desk.ts:790`                             | 回滚完成迁移                                                                  | `契约：确认完成、退回和等待输入保存失败时退回`                 |
| `reopenForRework`                    | `execution-desk.ts:826`                             | 回滚退回                                                                      | 同上                                                           |
| `markWaitingForInput`                | `execution-desk.ts:845`                             | 回滚等待输入                                                                  | 同上                                                           |
| `dropRecordedEntry`                  | `execution-desk.ts:876`                             | 故障。测试钩子保留丢掉的入口，供重写                                          | `契约：丢掉入口的测试钩子在保存失败时保留内存标记`             |
| 队列附件                             | `execution-desk.ts:1426`                            | 记录冻结引用和校验和；字节缺失则 `attachment-reupload` 或未应用，不启动执行器 | `契约：排队附件进入幂等指纹并交给执行器，缺失字节要求重新上传` |
| 重新打开后的附件                     | `unknownAttachment`                                 | 快照标 `contentAvailable: false`，界面写「需重新上传」                        | `契约：移除或重新打开后缺失的附件字节不会启动执行器`           |
| `applyExecutorEvent`                 | `execution-desk.ts:1274`                            | 故障。不抛出未处理拒绝，保留内存事件                                          | `契约：执行事件保存失败不产生未处理拒绝，恢复后可以重写`       |
| `finishRun` / `consumeQueue`         | `execution-desk.ts:1386` / `execution-desk.ts:1426` | 事件保存失败走故障；消费只处理已经入队的项，并带上仍有字节的附件              | 同上，以及排队附件测试                                         |
| `failInconsistentRun` / `applyFault` | `execution-desk.ts:1481` / `execution-desk.ts:1503` | 故障。保留内存里的失败事实                                                    | `契约：执行事件保存失败不产生未处理拒绝，恢复后可以重写`       |
| `noteUnconnectedMcp`                 | `execution-desk.ts:2008`                            | 故障。活动记录留在内存                                                        | 同上                                                           |
| `fail`                               | `execution-desk.ts:2134`                            | 故障。领域错误留在内存；快照同时带持久化故障                                  | 各命令的拒绝路径                                               |
| `succeed`                            | `execution-desk.ts:2141`                            | 保存失败返回 `persist-failed`，由调用方回滚或保留                             | 上表各入口                                                     |
