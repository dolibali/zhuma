# B 专家目录可信定义接口清单

工作项：[#30 指派](https://github.com/dolibali/zhuma/issues/30#issuecomment-6395347310)，沿 [#37 个人专家范围](https://github.com/dolibali/zhuma/issues/37#issuecomment-6394118856)。本文件是只读盘点：现有可能事实、归属与拒绝证明、缺口。不含产品改动；客户端 UI 归 A，本清单只列服务接缝。

E1 / E2 仍是待比较的接缝，尚未冻结，也不授权实现。盘点保留个人独立使用、团队对同一稳定 id 的显式发布，以及既有来源与包字节事实。它不作为删除现有专家定义、来源包或另建一套事实库的依据。

## 方法与现状基线

基线为已普通合并的 develop 尖端 `01558da`（含 #95）。每个现有字段都能在该尖端的 schema 或导入分支里找到。早先对照的 `c85b455` 是该尖端的祖先；与专家定义相关的 schema 在两处一致，下文以 `01558da` 为准。

所有路由的授权以可信成员会话（`resolveMember`）和空间目录（#29）为准。`snapshot` 选择器或全局快照不能充当权限。

## 专家定义只有一处

专家定义今天只活在 workbench 域的 `participants[]` 里，且 `kind` 为 `'expert'`。`AssetSchema.kind` 只有 `skill` / `mcp` / `template`；`TeamAsset` 就是该 schema 的推导类型。当前没有 assets 形态的专家存储。

导入预览里的 `kind: 'expert'` 只是包内分类。`applyResourceImport` 把这类项写成 `participants[kind=expert]`，并把它选中的 Skill 记入 `resourceBindings.skillIds`。节点上的 `assigneeId` / `reviewerIds` 引用 participant；节点和专家绑定里的 `skillIds` 都只匹配 `assets[kind=skill]`。其余导入项才写入 `assets`。

| 事实         | 路径                                                                                                                             | 形状                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 专家定义     | `packages/agent-core/src/workbench.ts` `ParticipantSchema`（约 21–41 行），条目在 `participants[]`                               | `{ id, name, kind: 'human'\|'expert', role, capabilities[], instructions, available, origin?, resourceBindings? }`。`resourceBindings` 为 `{ skillIds, mcpIds }` |
| 资产定义     | 同文件 `AssetSchema`（约 42–66 行）；`TeamAsset` 约 187 行                                                                       | `{ id, name, kind: 'skill'\|'mcp'\|'template', description, content, available, origin? }`。kind 枚举没有 `expert`                                               |
| 导入落点     | 同文件 `applyResourceImport`（约 641–731 行）。`item.kind === 'expert'` 约 700–716 行写入 participants；约 717–728 行写入 assets | 专家：`ParticipantSchema` + `origin` + `resourceBindings.skillIds`（来自包内 skill 选择）。非专家：`AssetSchema`                                                 |
| 预览分类     | `packages/agent-core/src/asset-package.ts` `ImportPackageItemSchema.kind`（约 100–102 行）                                       | 预览枚举为 `skill` / `expert` / `template`。该 `expert` 不进入 `AssetSchema`                                                                                     |
| 节点引用     | `WorkNodeSchema`（约 90–99 行）；校验约 313–346 行                                                                               | `assigneeId` / `reviewerIds` 引用任务中的 participant。`skillIds` 只匹配 `assets[kind=skill]`。`mcpIds` 只匹配 `assets[kind=mcp]`                                |
| 专家默认能力 | `validateDefaultResources`（约 748–761 行）                                                                                      | `resourceBindings.skillIds` 只绑定 Skill；`resourceBindings.mcpIds` 只绑定 MCP                                                                                   |

客户端资产分类（`packages/client/src/workbench/WorkbenchPage.tsx`，`aria-label="资产分类"`，约 612 行）有一档筛选，界面标签是「Agent 专家」。这一档的行来自 `participants` 中 `kind === 'expert'` 的投影（约 401–411 行），编辑打开 participant 对话框（约 873–875 行）。这是同一份定义的目录筛选，不是第二种专家存储，也不是 `assets[]` 里的 `kind: 'expert'`。

### 版本与包字节

这四件事要分开记账。不能写成「只有 expert.json 的 semver，participants 没有独立版本」。

| 层                 | 落点                                                                                                     | 约束                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源显示版本       | `ResourceOriginSchema.sourceVersion`（`asset-package.ts` 约 80 行）                                      | 可选字符串，最长 80，没有 semver 约束。zhuma-expert JSON 的 `version` 同样是 `z.string().max(80).optional()`（约 360 行）；导入时写入 `sourceVersion`（约 395 行）。内置候选文件里的 `"1.0.0"` 只是这种显示字符串的一个实例                                                                                                                                                                                |
| 不可变包版本与字节 | `origin.versionId`（uuid，`ResourceOriginSchema` 约 74 行）指向域 `zhuma_asset_packages` 的表 `versions` | `StoredAssetPackageSchema`（约 67–71 行）：`{ versionId, digest, files }`。`digest` 为 sha256 的 64 个十六进制字符。域规格在 `packages/dsh-adapter/src/workbench-plugin.ts` 约 48–53 行。`import-package` 按 `versionId` 写入；同一 `versionId` 已有不同 `digest` 时拒绝替换（`workbench-service.ts` 约 82–98 行，错误 `asset-version`）。`resource-files` 用 `origin.versionId` 取回文件（约 112–128 行） |
| 可编辑专家定义本体 | `participants[]` 中 `kind: 'expert'` 的记录                                                              | 字段就是 `ParticipantSchema`，记录上没有独立的 version / semver。没有 `origin` 时，`instructions` 可经 `save-participant` 修改。已有 `origin` 时，`keepImportedBody`（`workbench.ts` 约 733–745 行）拒绝改 `origin` 和 `instructions`，这两项只能重新导入。`name`、`role`、`capabilities`、`available`、`resourceBindings` 仍可由 `save-participant` 修改。拒绝文案把可直接改的部分称为名称、用途和可用性  |
| 所有权             | 尚无此维度                                                                                               | `participants` 与 `assets` 都没有 accountId、成员归属或 spaceId。任务上的 `ownerId` 是计划负责人，不是专家所有权                                                                                                                                                                                                                                                                                           |

`resource-files` 请求里的 `kind: 'asset' | 'expert'`（`workbench-plugin.ts` 约 77 行）只决定查 `assets` 还是查 `participants[kind=expert]`，然后再取该记录的 `origin.versionId`。它不表示存在一份 expert 资产表。

## (a) 个人专家独立使用

个人使用的就是上一节那条 `participants[kind=expert]` 记录。当前没有「归当前成员所有」的字段，因此还不能按成员列出本人专家。

### 定义与内置候选

| 事实             | 路径                                                                                                             | 形状                                                                                                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 个人侧读到的专家 | workbench `participants[]`，`kind: 'expert'`                                                                     | 见上一节 `ParticipantSchema`。与团队侧是同一条记录，不是另一份个人库                                                                                                                                      |
| 内置基础专家候选 | `resources/experts/starter-pack/`（4 个：work-planning、interaction-review、engineering-docs、workflow-diagram） | 每个目录含 `expert.json`（`format:'zhuma-expert'`、可选 id、可选 version、name、role、capabilities、instructions、skillPaths）+ README + skills/。不自动预装。`version` 导入后成为 `origin.sourceVersion` |

### 现有公开入口（标注消费可达性）

这些入口都是旧 owner 路由，读写的是全局 workbench，不是按成员过滤的个人列表。`LEGACY_OWNER_ROUTES` 为 `snapshot`、`command`、`plan`、`preview-import`、`resource-files`（`packages/dsh-adapter/src/member-session.ts` 约 85–91 行）。`import-package` 是 `command` 的载荷。

| 动作                           | 入口                                                             | 正常成员可消费？                                                                        |
| ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 读取含全部专家在内的工作台快照 | `/api/zhuma/snapshot`                                            | **否**：多人模式 404（legacy-gate）                                                     |
| 创建/修改 participant          | `/api/zhuma/command` save-participant                            | **否**：多人模式 404                                                                    |
| 导入预览                       | `/api/zhuma/preview-import`                                      | **否**：多人模式 404                                                                    |
| 导入保存                       | `/api/zhuma/command` import-package                              | **否**：多人模式 404。专家写入 participants；包字节写入 `zhuma_asset_packages.versions` |
| 来源文件读取                   | `/api/zhuma/resource-files`（`kind: 'expert'` + participant id） | **否**：多人模式 404                                                                    |
| 直接会话使用                   | 无服务端接缝（个人会话属 A 侧 UI + DSH 会话能力）                | 待 A                                                                                    |
| 显式分享到团队                 | 无                                                               | **否**：旧单人同样没有这个端点                                                          |

**已有拒绝证明**：`packages/dsh-adapter/tests/identity-session.test.mjs` 约 1931、1938、1949 行——多人模式下 `authorizeLegacyOwnerRoutes` 返回 404/not-found。

### 归属与授权事实

- 专家记录没有 actor 归属字段。`participants` 全局放在一份 workbench 上。个人专家若要「归当前成员所有」，所有权是尚缺的新事实。
- 已在库里的旧记录不能按「当前正在调用的成员」自动猜归属。多人模式下这些 owner 路由关闭；旧单人模式也没有把账号写进专家记录。
- `participants` 与 `assets` 都不带 spaceId。两者都是全局目录。`assets` 只含 skill / mcp / template。

### 最小缺口（B 服务侧）

1. 成员级读取：只返回归属已明确属于当前成员的专家，而不是整份全局快照。
2. 成员级创建/修改/删除：所有权写成当前成员；不改写尚无归属的旧记录。
3. 成员级导入（预览 + 保存）：定义归本人；包字节仍写入既有 `zhuma_asset_packages.versions`；不隐式安装工具或运行模型。
4. 内置基础专家：starter-pack 4 个候选保持只读。个人定制是新的稳定 id（副本），用 `origin.sourceId` / `origin.sourceVersion` 记下由来；升级不覆盖该副本。字节未改时复用已有 `versionId`，不另存一份包。
5. 负例：无权读取他人专家、越权写入、导入校验失败、把旧的无主记录猜给当前成员。

## (b) 团队侧使用同一份专家定义

团队工作台没有单独的专家资产库。节点要执行者或评审人时，`assigneeId` / `reviewerIds` 引用的就是 `participants` 里的那条专家（或真人）。团队若要「拥有」一份专家，缺的是对**同一条定义、同一个稳定 id** 的显式发布，而不是把定义再写进 `assets` 并加上 `spaceId`。

`assets + spaceId` 会变成第二份专家本体，并绕开现有的 participant 映射和 Skill 绑定。本盘点不采用这条路径。

### 现有公开入口（标注消费可达性）

| 动作            | 入口                                      | 正常成员可消费？     | 旧单人可消费？                                         |
| --------------- | ----------------------------------------- | -------------------- | ------------------------------------------------------ |
| 读取专家定义    | `/api/zhuma/snapshot` 中的 `participants` | **否**：多人模式 404 | 可，但是全局快照，不是按空间过滤的团队目录             |
| 导入专家定义    | `/api/zhuma/command` import-package       | **否**：多人模式 404 | 可，仍写入 `participants[kind=expert]`，不产生团队资产 |
| 显式分享 / 发布 | 无端点                                    | **否**               | **否**                                                 |

### 归属与授权事实

- 当前没有个人 / 团队归属维度，也没有 spaceId。全局可见不等于已经按空间授权。
- 旧单人保留的是同一组 legacy owner 路由，不是分享端点。不能把「旧单人能打开快照」写成「旧单人能发布到团队」。
- 资产分类界面只是把同一批 participant 专家投影出来筛选。不能把这个界面写成第二种专家存储。

### 最小缺口（B 服务侧）

1. 团队目录读取：按成员有权的空间，只列出已显式发布的稳定 id。本体仍是那一条专家定义。
2. 显式发布：把同一条定义授权给某个空间。不自动公开，不复制正文，不写入 `assets`，不为同一次发布再占一个包 `versionId`。
3. 负例：无权空间不泄露、跨空间不串。撤销只收回该空间的可见性，不改包 `digest`，也不删除成员仍在使用的个人副本。

## 消费可达性总结

| 能力                                                                                   | 正常成员（多人模式）                     | 旧单人（legacy-single-user）         |
| -------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| 读取 / 保存 / 导入专家定义（同一份 `participants[kind=expert]`，经 legacy owner 路由） | **不可**（owner 路由全关）               | 可（全局快照与 command，无成员归属） |
| 显式分享或发布到团队                                                                   | **不可**（无端点）                       | **不可**（无端点）                   |
| 按空间过滤的团队专家目录                                                               | **不可**（没有空间维度，也没有发布记录） | **不可**                             |
| 专家进入个人会话                                                                       | 待 A 接缝                                | —                                    |

## 最小纵向切片建议（待比较，未冻结）

以下只比较服务接缝和代价。不授权实现，也不要求删掉现有 `participants` 专家或 `zhuma_asset_packages`。个人独立使用和团队显式发布都保留。新增存储若需要包字节，只引用已有 `origin.versionId`，不复制 `files` / `digest`。

旧的全局专家记录保持无主，直到有人显式认领或继续只在旧单人路径可见。不能在新端点里把它们猜给当前成员。

个人副本和团队发布都避免第二份权威正文：

- 团队发布是对**已有稳定 id** 的空间授权。权威正文仍是那一条。
- 个人副本只在成员需要一份会分叉的定义时出现。它使用新的稳定 id，只权威自己的修改；原来的 id 仍权威原来的正文。字节未改时，两条记录的 `origin.versionId` 可以指向同一个不可变包版本。

### 可比较的存放方式

**复用 participants，只补所有权字段。** 同一条 `kind: 'expert'` 记录增加归属。成员路由按当前成员投影。包字节仍只在 `zhuma_asset_packages.versions`。`sourceVersion` 仍只用于显示。代价：workbench 今天仍是一份全局快照，成员路由必须自己投影，不能把 snapshot 当权限；人类和专家在同一数组里，过滤时要守住 `kind`。旧记录没有归属字段，迁移时保持无主。成本主要在投影、认领和负例，没有新的包库。

**有界分区：新索引只存归属和授权。** 索引记录 accountId 或 spaceId、稳定 id，以及指向现有 participant 的引用；可以记下 `origin.versionId` 作为包指针，不存 `files` / `digest` / `instructions`。个人副本仍是一条新的 participant。团队发布是索引上的空间授权，指向同一个稳定 id。代价：目录要拼两次读。索引一旦开始保存正文或包字节，就会变成第二权威，应停在指针。成本是一个窄域，不搬迁包库。

**独立目录域承载专家本体。** 只有在 `participants[kind=expert]` 不再充当权威正文时才成立，否则两处正文会各写各的。域内字段对应今天的 `ParticipantSchema`（id、name、kind、role、capabilities、instructions、available、resourceBindings）。`origin` 原样保留：`versionId` 仍指向 `zhuma_asset_packages.versions`，`sourceVersion` 仍是最长 80 的显示字符串。旧的全局 participant 不自动划给当前成员；要么显式认领进新域，要么留在旧单人路径。个人副本是新 id；团队发布是对选定 id 的空间授权，不再复制一条本体。代价高于前两种：要停掉双写，并迁移动读。

不把专家写进 `assets` 并加 `spaceId`。`AssetSchema` 不接受 `kind: 'expert'`，那条路会绕开 `assigneeId` / `reviewerIds` 和 `skillIds` 绑定，并造出第二份定义。

### 切片 E1（个人专家目录服务接缝）

比较中的端点形态：`/api/zhuma-exec/experts`（或 workbench 成员路由）上的 `list`（本人已归属的专家）、`save`（创建/修改，所有权=当前成员）、`import`（预览 + 保存归本人）。具体路径未冻结。

- 存储：在上一节三种放法里选，而不是默认新开一套带文件的专家库。
- 内置基础专家：starter-pack 4 个候选作只读来源；个人定制为新 id 的副本，升级不覆盖。
- 会话：复用 #29 成员会话。
- 包字节：复用 `import-package` 已有的 `zhuma_asset_packages.versions`。
- 成本随放法变化：复用 participants 时主要是授权投影；有界索引时是一个窄域；独立本体域时还要迁移并不再双写。
- 错误：`not-found`（他人专家或无主旧记录不泄露）、`validation`（导入格式）、`conflict`（内置只读不可改；同一 `versionId` 的不同 digest 仍由现有 `asset-version` 拒绝）。

### 切片 E2（同一稳定 id 的显式发布）

依赖 E1 正在比较的所有权维度。团队目录按空间读取**已发布的稳定 id**。发布写的是授权（定义 id + spaceId），专家正文仍是那一条，包版本仍是已有的 `origin.versionId`。

若成员要改已经发布的正文，待比较的做法是另做个人副本（新 id），再决定是否另行发布该副本。发布动作不把原文复制进 `assets`。

**个人会话使用**：专家定义读出后由 A 的客户端进入 DSH 个人会话（B 不提供会话服务，会话是 DSH 官方能力）。

## 不在本盘点

- 客户端专家库 UI（A，ExpertBrowser 已有可复用）。资产分类筛选也归 A，本清单只说明它不是第二份存储。
- 专家评审执行（#41，WP05 后续）
- 文件字节与锚点评论（#33）
- 删除或替换现有 `participants` 专家定义、`save-participant` / `import-package` / `resource-files`，以及 `zhuma_asset_packages`
