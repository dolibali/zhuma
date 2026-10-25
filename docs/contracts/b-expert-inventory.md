# B 专家目录可信定义接口清单

工作项：[#30 指派](https://github.com/dolibali/zhuma/issues/30#issuecomment-6395347310)，沿 [#37 个人专家范围](https://github.com/dolibali/zhuma/issues/37#issuecomment-6394118856)。本文件是只读盘点：现有可能事实、归属与拒绝证明、缺口。不含产品改动；客户端 UI 归 A，本清单只列服务接缝。

## 方法与现状基线

基线 develop `c85b455`。每个事实给可核验的源码路径与形状。所有路由的授权以可信成员会话（`resolveMember`）和空间目录（#29）为准；`snapshot` 选择器或全局快照不能充当权限。

## (a) 个人专家独立使用

### 定义存储与形状

| 事实             | 路径                                                                                                             | 形状                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 个人专家定义     | workbench 域 `participants[]`，`kind: 'expert'`                                                                  | `ParticipantSchema`（`packages/agent-core/src/workbench.ts:25`）：`{ id, name, kind, role, capabilities[], instructions, available, origin?, resourceBindings? }` |
| 内置基础专家候选 | `resources/experts/starter-pack/`（4 个：work-planning、interaction-review、engineering-docs、workflow-diagram） | 每个目录含 `expert.json`（`format:'zhuma-expert'`、id、version、name、role、capabilities、instructions、skillPaths）+ README + skills/。**不自动预装**            |
| 版本事实         | expert.json `version`（semver 字符串）；participants 无独立版本字段                                              | —                                                                                                                                                                 |

### 现有公开入口（标注消费可达性）

| 动作             | 入口                                              | 正常成员可消费？                    |
| ---------------- | ------------------------------------------------- | ----------------------------------- |
| 读取个人专家列表 | `/api/zhuma/snapshot`（owner 路由）               | **否**：多人模式 404（legacy-gate） |
| 创建/修改        | `/api/zhuma/command` save-participant             | **否**：多人模式 404                |
| 导入预览         | `/api/zhuma/preview-import`                       | **否**：多人模式 404                |
| 导入保存         | `/api/zhuma/command` import-package               | **否**：多人模式 404                |
| 来源文件读取     | `/api/zhuma/resource-files`                       | **否**：多人模式 404                |
| 直接会话使用     | 无服务端接缝（个人会话属 A 侧 UI + DSH 会话能力） | 待 A                                |

**已有拒绝证明**：`identity-session.test.mjs:1931-1957`——多人模式下 `authorizeLegacyOwnerRoutes` 对全部 legacy owner 路由返回 404/not-found。

### 归属与授权事实

- 个人专家当前**没有 actor 归属字段**：participants 无 ownerId/spaceId 维度，全局共享于 workbench。这是核心缺口——个人专家需要「归当前成员所有」的所有权事实。
- 空间维度：participants 不带 spaceId；团队资产（assets）同样全局。

### 最小缺口（B 服务侧）

1. 成员级个人专家读取端点（当前成员的本人专家列表）
2. 成员级创建/修改/删除（所有权=当前成员，ownership 事实）
3. 成员级导入（预览+保存，归本人，不隐式安装工具/运行模型）
4. 内置基础专家装载与修改保护（只读基础 + 个人副本，升级不覆盖个人修改）
5. 负例：无权读取他人专家、越权写入、导入校验失败

## (b) 团队工作台专家目录

### 定义存储与形状

| 事实         | 路径                                                                      | 形状                                                                                                         |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 团队专家资产 | workbench 域 `assets[]`，`kind: 'expert'`                                 | `TeamAsset`（`packages/agent-core/src/workbench.ts`）：`{ id, name, kind, description, content, available }` |
| 导入格式     | `zhuma-expert`                                                            | `asset-package.ts:356`：`{ format, id, version, name, role?, capabilities, instructions, skillPaths? }`      |
| 使用接缝     | 任务节点 `skillIds[]` 引用资产 id；评审 `reviewerIds` 引用 participant id | —                                                                                                            |

### 现有公开入口（标注消费可达性）

| 动作                   | 入口                                | 正常成员可消费？     |
| ---------------------- | ----------------------------------- | -------------------- |
| 团队专家目录读取       | `/api/zhuma/snapshot`               | **否**：多人模式 404 |
| 导入到团队             | `/api/zhuma/command` import-package | **否**：多人模式 404 |
| 分享/发布（个人→团队） | 无                                  | **否**：无端点       |

### 归属与授权事实

- assets 无 spaceId/归属维度——团队专家需要按空间授权（复用 #29 目录），当前全局共享。

### 最小缺口（B 服务侧）

1. 成员级团队专家目录读取（按成员有权空间过滤）
2. 显式分享/发布动作（个人专家 → 团队资产，显式授权，不自动公开）
3. 负例：无权空间不泄露、跨空间不串、撤销即失效

## 消费可达性总结

| 能力                   | 正常成员（多人模式）       | owner/旧单人      |
| ---------------------- | -------------------------- | ----------------- |
| 个人专家读/写/导入     | **不可**（owner 路由全关） | 可（legacy 路由） |
| 团队专家目录/导入/分享 | **不可**                   | 可（legacy 路由） |
| 专家进入个人会话       | 待 A 接缝                  | —                 |

## 最小纵向切片建议（B 接口主责）

**切片 E1（个人专家目录服务接缝）**：

- 新增 `/api/zhuma-exec/experts`（或 workbench 成员路由）端点组：`list`（本人专家）、`save`（创建/修改，所有权=当前成员）、`import`（预览+保存归本人）
- 存储：个人专家独立域 `zhuma_experts`（按 accountId 分区）或 workbench participants 加 ownerId——**建议独立域**，不污染团队 workbench
- 内置基础专家：starter-pack 4 候选作只读内置，个人定制为副本（origin 标记），升级不覆盖
- 采用：复用 #29 成员会话；舍弃：不动团队 assets
- 成本：1 个域 + 3 端点 + 授权；负例：越权/导入校验/内置保护
- 错误：`not-found`（他人专家不泄露）、`validation`（导入格式）、`conflict`（内置只读不可改）

**切片 E2（团队专家目录+分享）**：个人专家显式发布到团队空间（写 assets + spaceId），团队目录按空间读。依赖 E1。

**个人会话使用**：专家定义读出后由 A 的客户端进入 DSH 个人会话（B 不提供会话服务，会话是 DSH 官方能力）。

## 不在本盘点

- 客户端专家库 UI（A，ExpertBrowser 已有可复用）
- 专家评审执行（#41，WP05 后续）
- 文件字节与锚点评论（#33）
