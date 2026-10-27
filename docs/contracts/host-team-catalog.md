# 团队基础专家目录

本切片补齐正式 Host 的 `MemberWorkbenchOptions.catalog` 来源。目录来自仓库公开基础包及显式团队选择，不读取个人专家、旧单人目录、用户路径或私有资产。它只提供团队定义与固定版本，不授予模型、工作区、Skill 或 MCP 的执行权限。

## 原包与事实归属

构建只读取 `resources/experts/starter-pack` 中的交互评审、工作规划、工作流图和工程文档四个原包。原文件及许可证原样嵌入 Host；文件摘要决定稳定的 `versionId`。不在运行时依赖源码仓库或旁置资源目录。

Host 使用原 `previewResourcePackage`、导入命令、WorkbenchService 串行写队列及不可变包版本表。没有第二套专家数据库。原专家的角色、能力、正文、Skill 依赖及来源一并保留，不简化为几行固定说明。同名私人定义或不同版本文件发生冲突时拒绝接入，不覆盖。部分写入只允许按原命令及相同来源显式重试。

冷开已存在的完全相同版本只核验，不重复写入。成员目录读取不导入、不写版本、不确认任务，也不调用模型。未配置的空间返回空专家及空资产；配置指向不存在或个人空间时拒绝装配。目录替换、关闭或源文件记录改变后，旧目录不可继续消费。

## 当前显式 Host 接缝

`host-plugin` 的可选 `teamCatalog` 形状如下，空间必须已经由原空间目录创建：

```json
{
  "teamCatalog": [
    {
      "spaceId": "actual-team-id",
      "packs": [
        { "id": "zhuma-work-planning", "version": "1.0.0" },
        { "id": "zhuma-interaction-review", "version": "1.0.0" }
      ]
    }
  ]
}
```

四个公开标识为 `zhuma-interaction-review`、`zhuma-work-planning`、`zhuma-workflow-diagram`、`zhuma-engineering-docs`，当前版本均为 `1.0.0`。不接受客户端提交任意文件或个人目录作为这个来源。配置缺省维持既有语义，不默认为所有团队启用。

供后续真实首次初始化消费的 Host 函数：

- `hostTeamCatalogManifest()` 返回 `{id, version, versionId, digest}[]`，不返回文件正文，不启用空间。
- `hostTeamCatalogPin(grants: HostTeamCatalogGrants): string` 对实际团队选择及原包版本、摘要生成稳定指纹；排序不影响结果，团队或包选择改变会改变结果。它不是授权令牌。
- 已打开 Workbench 的 `openTeamCatalog({grants, directory})` 使用同一事实源初始化并返回成员目录函数，供 Host 受控装配调用。

原成员服务继续校验实际成员、任务参与者、负责人及评审人，并把选定专家和默认 Skill 传入原规划器。确认计划由原命令固定依赖快照。启用目录不等于模型就绪或专家有工具权限，执行和独立评审仍走原 Run 授权。

## 验证边界

`host-team-catalog.test.mjs` 的源码契约覆盖原包来源、固定文件与依赖、显式空间、冲突、部分失败重试、冷开不重导入、关闭失效，以及原成员规划器收到正确上下文；规划输出使用明确契约端口，不是模型质量证据。

`pnpm test:host` 另用完全相同的 emitted Host、真实 DSH Connection／身份／空间／JSON 存储及两个独立进程：从没有任务及确认计划开始，经正常成员 HTTP 创建项目、任务、选择专家并确认，再冷开保留同一依赖版本。身份与空间初始数据为临时合成 bootstrap，不读取真实用户资料；无预置确认计划、无模型生成、无原生执行或 GUI 验收声明。

此配置是受控 Host 接缝。正常首次使用由 [本机首次成员设置](local-member-setup.md) 消费原身份／目录初始化和同一目录，不要求用户手改配置；该入口的实际 Host／GUI／发行证据分别验证，不能以 bootstrap 测试宣称完整产品验收。
