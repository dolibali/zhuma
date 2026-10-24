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
- 读取是域的内存读；写入先落盘成功再改内存，落盘失败内存不变。撤销成员资格是一次持久化删除，删除落地后枚举与授权立即一致。
- 重开后事实保留；目录关闭后 `spaceForProject` 返回 `unavailable`，不会误报 `unknown`（不存在的项目才返回 `unknown`）。

## 接口

`packages/dsh-adapter/src/space-directory.ts`：

- `openSpaceDirectory(storageDomain, imported?)`：打开域；空库时按 `imported` 播种，导入完成标记最后写，中途失败下次用同一导入重试；已有数据的域忽略导入、从不覆盖。
- 读侧 `SpaceDirectory extends ProjectSpaceDirectory`：
  - `spaceForProject(projectId)`：项目归属查询，与 #55 的内存目录同一形状。
  - `spacesForMember(accountId)`：当前成员有权的个人／团队空间枚举，含尚无项目和便笺的空空间；无权空间不出现。
  - `isMember(spaceId, accountId)` / `space(spaceId)` / `spaces()`：同一事实的点查与诊断枚举。
- 写侧 `SpaceDirectoryWriter`（授权事实的唯一写口，A 只注入不另建）：
  - `createSpace(space)`：重复标识 `conflict`，超过 100 个空间拒绝。
  - `grantMembership(spaceId, accountId)`：幂等；空间不存在拒绝。
  - `revokeMembership(spaceId, accountId)`：幂等删除。
  - `assignProjectSpace(projectId, spaceId)`：仅首次归属；已归属返回 `conflict`，不静默移动；空间不存在拒绝；上限同 `PROJECT_SPACE_LIMIT`。

## 校验

导入与写口共用同一套规则：标识为 1–100 字符的 `[\w-]+`，名称不超过 200 字符；成员与项目归属必须引用已存在的空间；同一项目不能归属两个空间（相同记录折叠，冲突记录拒绝）；导入整体超限（100 空间／1000 成员记录／100 项目归属）整体拒绝，不留下半个可用目录。

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
