# B-ID0b 可信项目空间事实源契约

工作项：[#29](https://github.com/dolibali/zhuma/issues/29)。主责：B；范围：FR16 的授权事实部分。

本契约分三个切片交付可信、持久的空间目录：

1. **纯模块**（[PR #72](https://github.com/dolibali/zhuma/pull/72)）：`zhuma_spaces` 域、导入与校验、读侧 `SpaceDirectory`、写侧 `SpaceDirectoryWriter`。
2. **身份接线**（[PR #75](https://github.com/dolibali/zhuma/pull/75)）：成员会话 `spaceIdsFor`、`/zhuma-id/session` 空间枚举、`/zhuma-id/spaces/:id` 与 `memberPolicy` 空间分支统一改消费目录；便笺级授权不变；无目录时成员无空间，不从便笺推断。
3. **S1 对齐**（本切片）：`applySpaceDirectory` 进入 `S1Startup` 加载顺序，`spaceDirectoryFor` 供给 A 注入 `applyExecution` 的 `projectSpaces`；conformance 类型双向约束。

## 事实与存储

事实保存在服务端 `zhuma_spaces` 存储域（`@deepseek-ai/dsh-storage-domain`），随宿主介质持久化。域内三张表：

| 表               | 键                  | 记录                                     | 含义               |
| ---------------- | ------------------- | ---------------------------------------- | ------------------ |
| `spaces`         | `spaceId`           | `{ id, kind: 'personal'\|'team', name }` | 空间存在与展示字段 |
| `memberships`    | `spaceId/accountId` | `{ spaceId, accountId }`                 | 成员属于空间       |
| `project_spaces` | `projectId`         | `{ projectId, spaceId }`                 | 项目归属空间       |

- 归属、枚举和后续资源授权消费同一份持久化事实；不从便笺存在性推断成员关系，不把 `projectId` 或浏览器 actor 里的声明当事实。
- 读取是域的内存读；写入先落盘成功再改内存，落盘失败内存不变。域的写链只串行单次落盘，内存要等这次落盘成功才变。`createSpace`、`grantMembership`、`revokeMembership`、`assignProjectSpace` 把检查和这次落盘放在同一条目录写队列里，后一次调用看到的是前一次已经提交的事实。撤销成员资格是一次持久化删除，删除落地后枚举与授权立即一致。
- 重开后事实保留；目录关闭后 `spaceForProject` 返回 `unavailable`，不会误报 `unknown`（不存在的项目才返回 `unknown`）。未完成导入不会作为可读目录打开，因此也不会把尚未导入的项目报成 `unknown`。

## 接口

`packages/dsh-adapter/src/space-directory.ts`：

- `openSpaceDirectory(storageDomain, imported?)`：打开域，并按介质上已经写下的状态处理 `imported`。
  - **空**：没有空间、成员、项目行，也没有未完成导入。不传 `imported` 得到空的读写目录。传入时先落「导入中」和这份 seed 的身份，再写行，最后才把 `importComplete` 写成 true。
  - **写口占用**：行来自写口（或介质上标了写口占用），导入没有完成。不传 `imported` 直接读写。再传 seed 则拒绝打开，不覆盖已有空间、成员或项目归属。
  - **导入未完成**：介质上有导入中标记和 seed 身份，行可能只写了一部分。只有同一份 seed 能继续写完，并且只有在完成标记落下之后才返回读写句柄。缺少 seed、seed 与标记不一致，或已有行和这份 seed 对不上，都关闭域并拒绝，不返回句柄。
  - **导入完成**：忽略 `imported`，直接读写，从不覆盖。
- 读侧 `SpaceDirectory extends ProjectSpaceDirectory`：
  - `spaceForProject(projectId)`：项目归属查询，与 #55 的内存目录同一形状。
  - `spacesForMember(accountId)`：当前成员有权的个人／团队空间枚举，含尚无项目和便笺的空空间；无权空间不出现。
  - `isMember(spaceId, accountId)` / `space(spaceId)` / `spaces()`：同一事实的点查与诊断枚举。
- 写侧 `SpaceDirectoryWriter`（授权事实的唯一写口，A 只注入不另建）：
  - `createSpace(space)`：重复标识 `conflict`，超过 100 个空间拒绝。存在性、上限和落盘在同一条写队列里，并发创建不能超过上限。
  - `grantMembership(spaceId, accountId)`：幂等；空间不存在拒绝。上限检查和落盘在同一条写队列里，并发授权不能超过 1000 条。
  - `revokeMembership(spaceId, accountId)`：幂等删除，和其它写入共用这条队列。
  - `assignProjectSpace(projectId, spaceId)`：仅首次归属；已归属返回 `conflict`，不静默移动。并发的另一次不同归属也返回 `conflict`，先成功的归属保留。空间不存在拒绝；上限同 `PROJECT_SPACE_LIMIT`，并发下仍然成立。

## 校验

导入与写口共用同一套规则：标识为 1–100 字符的 `[\w-]+`，名称不超过 200 字符；成员与项目归属必须引用已存在的空间；同一项目不能归属两个空间（相同记录折叠，冲突记录拒绝）；导入整体超限（100 空间／1000 成员记录／100 项目归属）整体拒绝，不留下半个可用目录。未完成导入在恢复前不可用。写口占用和未完成导入分开记：前者拒绝另一份 seed，后者只接受开始那次导入的同一份 seed。已有行若和这份 seed 不一致，同样拒绝，不覆盖。

## 与既有切片的关系

- 本模块实现 #55 的 `ProjectSpaceDirectory` 接口，可经 `applyExecution(ctx, { readWorkbench, projectSpaces })` 直接注入；是否注入仍由 A 在 Host 决定（#28／#32）。
- `decideProjectSpace` 不变：目录给出归属，成员枚举给出可见性，两者在调用点汇合。
- 个人空间按显式导入建立（建议每账号一个 `personal-*` 空间）；本模块不做隐式派生。

## 验证层级

| 层级   | 证据                                                                                       | 不是什么                 |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------ |
| 纯模块 | `tests/space-directory.test.mjs`：内存介质 + 共享 media 模拟重开                           | 不是真实 Host 持久化验收 |
| 接线   | `tests/identity-session.test.mjs`：真实 Connection／成员 cookie 的枚举、空空间、撤销与重开 | 不是已安装桌面产品       |
| 装配   | `tests/types/s1-identity-conformance.ts`、`s1-conformance.ts`：签名双向约束                | 不是 A 的 Host 集成验收  |

## 延期项

- 空间的项目移除、空间删除与归档语义：随 #31／资产管理批次评估。
- 便笺级授权（`ownerId`／`teamMemberIds`）语义不变；空间级可见性已改消费成员事实。
- 运行时创建空间的 UI：A 的 #31 范围。
