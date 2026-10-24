# 执行台落盘失败审计

用户发起的同步命令在 `journal.save` 失败时整段退回，内存与调用前一致，不记 `persistenceFault`。只有执行器异步事件这种不能撤销的外部事实才保留内存并标出故障。下一次成功的保存会清掉 `persistenceFault`。`rewritePersistence` 成功时同样清掉，并不是只有它能清。用户命令先提交；延后队列恢复失败只记故障，不回滚刚提交的草稿和配置。附件字节仍只在当前进程，不另建文件存储。删除字节和会话目录都发生在对应日志已经写上之后。

写锁不另建存储，也不挪动可能仍活着的锁。锁记录和回收互斥都是先写完临时文件再硬链接到目标路径。只有 EEXIST 表示目标已在，不覆盖；ENOENT 不提示删除一条已经不在的路径。确认互斥还在和读到内容之间文件消失时，继续抢锁。EPERM、ENOTSUP、EXDEV 改为只读，拒绝理由带上目标路径，不把进程打崩。崩溃留下的 `.tmp` 不自动清理，也不挡住别的写入者。别的主机、pid 被复用，或锁内容读不出来时只读，理由里不写路径。读者要么看不到这个文件，要么看到完整内容，不会读到空文件或半截 JSON。过期回收先挂上 `<lock>.reclaim`。只有持有互斥的进程可以再读锁。确认仍是同一个已死持有者的令牌后才删除锁文件，再挂上完整的新锁，然后删掉互斥。死进程留下的互斥文件不做第二层自动回收，也没有超时。进程被 SIGKILL 留下的 `.reclaim` 一直只读，直到人工删除，错误信息给出要删除的完整路径。释放时只读锁文件，令牌是自己的才 `unlink`，不改名。进程退出和 SIGTERM、SIGINT 都走这条释放。每次 `save` 前核对令牌；文件不在或令牌对不上都抛 `ELOCKED`，`writable` 设为 false，不写会话文件。核对和写入之间的空隙只有持有者死亡之后才可能被别人补上，死亡进程不会写完这次保存。

| 写锁情形                     | 位置                              | 策略                                                      | 测试                                                                  |
| ---------------------------- | --------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| 两个进程同时回收同一把过期锁 | `file-journal.ts` `reclaimStale`  | 互斥里确认死令牌后才删，只有一方可写，活锁留在原地        | `契约：两个进程同时回收同一把过期锁时只有一个能写`                    |
| 过期观察碰上活锁             | `file-journal.ts` `reclaimStale`  | 不挪走活锁。空隙里的第三人写不进去，`twoWriters` 为 false | `契约：过期观察碰上活锁时，空隙中的第三人不能和持有者一起写成功`      |
| 非持有者释放                 | `file-journal.ts` `releaseOne`    | 先读令牌，不是自己的就不删除，不改名                      | `契约：非持有者释放时新锁不会被删掉或覆盖`                            |
| 死进程留下的回收互斥         | `file-journal.ts` `acquireLock`   | 只读，信息含完整路径，不删互斥和旧锁                      | `契约：死进程留下的回收互斥保持只读并指出要删除的文件`                |
| 旧持有者退出                 | `file-journal.ts` `releaseOne`    | 正常退出、SIGTERM 和 SIGINT 都先对令牌，对不上不删        | `契约：旧持有者退出不会删掉新持有者的写锁`                            |
| 锁被接走后保存               | `file-journal.ts` `save`          | `ELOCKED`，`writable` 变为 false，会话文件保持原样        | `契约：写锁被接过后再次保存得到 ELOCKED 并变成只读`                   |
| 锁文件不在时保存             | `file-journal.ts` `save`          | 缺失不是仍持有。`ELOCKED`，只读，不写会话文件             | `契约：锁文件不在时保存得到 ELOCKED 并变成只读`                       |
| 锁内容发布                   | `file-journal.ts` `publishRecord` | 临时文件写完再硬链接。发布前路径不存在，发布后一次完整    | `契约：写锁路径在内容发布前不存在，发布后一次就是完整记录`            |
| 硬链接不受支持               | `file-journal.ts` `acquireLock`   | EPERM、ENOTSUP、EXDEV 只读，理由含目标路径，进程不崩      | `契约：硬链接返回 EPERM、ENOTSUP 或 EXDEV 时日志只读，拒绝理由带路径` |
| 回收新锁的其他错误           | `file-journal.ts` `reclaimStale`  | 非 EEXIST 把路径抛出，不再吞掉                            | `契约：回收新锁遇到权限错误时把路径抛出来`                            |
| 互斥在读到前消失             | `file-journal.ts` `mutexBlock`    | ENOENT 继续抢锁，不要求删除已经不在的路径                 | `契约：回收互斥在读到之前消失时继续抢锁，不要求删除已经不在的路径`    |
| 崩溃留下的临时文件           | `file-journal.ts` `publishRecord` | 不自动清理，不挡住别的写入者                              | 见上文                                                                |

| 入口                                 | 位置                                                | 策略                                                                          | 测试                                                                                |
| ------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ExecutionDesk.create`               | `execution-desk.ts:325`                             | 保存失败则抛出 `persist-failed`，不交出工作台                                 | `契约：创建时日志写不进去就不交出工作台`                                            |
| `resumeInteraction`                  | `execution-desk.ts:343`                             | 回滚 `interactionReady`，不记故障                                             | `契约：恢复交互写不进去时仍不能发送`                                                |
| `rewritePersistence`                 | `execution-desk.ts:354`                             | 重写当前内存。任何成功保存都会清除故障，包括这次                              | `契约：执行事件保存失败不产生未处理拒绝，恢复后可以重写`                            |
| `updateConfig`                       | `execution-desk.ts:445`                             | 回滚选择、配置标识和轮次，不记故障                                            | `契约：同步命令落盘失败后内存与调用前一致`                                          |
| `setAvailability`                    | `execution-desk.ts:469`                             | 回滚专家或执行器可用状态，不记故障                                            | 同上                                                                                |
| `setContextIncluded`                 | `execution-desk.ts:487`                             | 回滚勾选和上下文块，不记故障                                                  | 同上                                                                                |
| `addAttachment`                      | `execution-desk.ts:503`                             | 回滚附件记录和字节，不记故障                                                  | 同上                                                                                |
| `removeAttachment`                   | `execution-desk.ts:565`                             | 回滚删除；字节只在保存成功后丢掉                                              | 同上                                                                                |
| `send` / `beginRun`                  | `execution-desk.ts:945`                             | 回滚 claims、runs、turns、citations 和 sequence，不记故障                     | 同上，以及 `契约：首次受理保存失败后同键重试会启动，写权不残留`                     |
| `enqueue`                            | `execution-desk.ts:1103`                            | 回滚队列、运行和节点，失败项不可被消费，不记故障                              | `契约：排队受理保存失败后不会被自动执行，同键重试只启动一次`                        |
| 重新打开后的同键重试                 | `enqueue` / `beginRun`                              | 日志里没有失败项，重试只启动一次                                              | `契约：排队受理失败后重新打开，同键重试只启动一次`                                  |
| `stop` 取消之前                      | `execution-desk.ts:604`                             | 回滚停止请求，不调用取消，不记故障                                            | `契约：停止请求没有写入时不取消执行器`                                              |
| `stop` 取消回执之后                  | `execution-desk.ts:622`                             | 故障。取消已经发生，保留内存，不记成成功回执                                  | `契约：取消回执之后的保存失败不撤销已经取消的运行`                                  |
| `retry` / `restart`                  | `execution-desk.ts:636`                             | 回滚节点迁移和因此启动的运行，同键在存储恢复后仍可重试                        | `契约：重试和核实断开保存失败时不改节点`                                            |
| `recover`                            | `execution-desk.ts:685`                             | 回滚恢复请求，不记故障                                                        | `契约：同步命令落盘失败后内存与调用前一致`                                          |
| `verifyAbandoned`                    | `execution-desk.ts:696`                             | 回滚核实结果和 `resumeGap`；拿不到写锁时不核实                                | 同上，以及 `契约：同一目录上的第二个工作台拿不到写锁，不能把仍在运行的会话标成放弃` |
| `saveDraft`                          | `execution-desk.ts:744`                             | 回滚草稿，不记故障                                                            | `契约：草稿保存失败时退回，不留下故障`                                              |
| `acceptReviewResult`                 | `execution-desk.ts:771`                             | 回滚这次保存，包括错误回执；它不结算节点                                      | `契约：同步命令落盘失败后内存与调用前一致`                                          |
| `confirmCompleted`                   | `execution-desk.ts:802`                             | 回滚完成迁移；日志没写上时不删会话目录                                        | `契约：确认完成没写上日志时不删会话目录`                                            |
| `reopenForRework`                    | `execution-desk.ts:838`                             | 回滚退回，不记故障                                                            | `契约：同步命令落盘失败后内存与调用前一致`                                          |
| `markWaitingForInput`                | `execution-desk.ts:857`                             | 回滚等待输入，不记故障                                                        | 同上                                                                                |
| `dropRecordedEntry`                  | `execution-desk.ts:885`                             | 故障。测试钩子保留丢掉的入口，供重写                                          | `契约：丢掉入口的测试钩子在保存失败时保留内存标记`                                  |
| 队列附件                             | `consumeQueueBody`                                  | 记录冻结引用和校验和；字节缺失则 `attachment-reupload` 或未应用，不启动执行器 | `契约：排队附件进入幂等指纹并交给执行器，缺失字节要求重新上传`                      |
| 重新打开后的附件                     | `unknownAttachment`                                 | 快照标 `contentAvailable: false`，界面写「需重新上传」                        | `契约：移除或重新打开后缺失的附件字节不会启动执行器`                                |
| 下一轮消费                           | `execution-desk.ts:1470`                            | 落盘失败保持 `pending`，存储恢复后的成功保存继续消费，并留下故障等重写        | `契约：下一轮落盘失败时排队消息仍可在存储恢复后继续`                                |
| `startDrive`                         | `execution-desk.ts:1214`                            | 故障。驱动意外拒绝时记下故障，不产生未处理拒绝                                | `契约：驱动意外拒绝记成持久化故障，不产生未处理拒绝`                                |
| `applyExecutorEvent`                 | `execution-desk.ts:1283`                            | 故障。不抛出未处理拒绝，保留内存事件                                          | `契约：执行事件保存失败不产生未处理拒绝，恢复后可以重写`                            |
| `finishRun`                          | `execution-desk.ts:1395`                            | 故障。保留已经结束的运行                                                      | 同上                                                                                |
| `failInconsistentRun` / `applyFault` | `execution-desk.ts:1507` / `execution-desk.ts:1529` | 故障。保留内存里的失败事实                                                    | 同上                                                                                |
| `noteUnconnectedMcp`                 | `execution-desk.ts:2049`                            | 故障。活动记录留在内存                                                        | 同上                                                                                |
| `fail`                               | `execution-desk.ts:2201`                            | 保存失败则退回 `lastError`，不记故障                                          | `契约：同步命令落盘失败后内存与调用前一致`                                          |
| `succeed`                            | `execution-desk.ts:2209`                            | 保存失败返回 `persist-failed`，由调用方回滚；用户命令不记故障                 | 上表各入口                                                                          |
