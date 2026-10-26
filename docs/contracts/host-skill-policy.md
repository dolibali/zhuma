# Host 原包 Skill 调用策略

范围入口：[#113](https://github.com/dolibali/zhuma/issues/113)。本文只定义原包策略来源，Run 快照冻结与原生注册由执行服务分别交付；交付状态及完整 SHA 以工作项和 PR 为准。

## 内部读取接口

`OpenedWorkbench.createRunSkillPolicies(execution)` 返回 Host 内部的 `read(originalMemberRequest, locator)`。locator 为 `spaceId/taskId/planId/revision/nodeId`；结果是不可变的已选 Skill 策略数组，不是授权凭证。

每项包含：

- `ref: { id, version }`：已确认节点的 Skill 引用，version 是 AppliedPlan.id。
- `definitionDigest`：该计划中完整 Asset 的 canonical SHA256。
- `invocation: { modelInvocable, userInvocable }`：两个独立布尔值；两者为 false 也原样保留。
- `policySource`：导入项为 `{ kind: 'asset-package', versionId, digest, entryPath }`，手工且无 origin 的定义为 `{ kind: 'manual-default' }`。

包 versionId 与 AppliedPlan.id 属于不同版本域；包摘要与定义摘要也分别计算，不能互换。手工默认仅适用于没有 origin 的定义，两个调用权限均为 true。存在 origin 时，任何缺失或异常都拒绝，不能回落到手工默认。

## 来源和有效期

读取前后都使用同一个原始 MemberRequest 调用原执行服务 `readRunCompositionInputs`，检查准确空间、任务、计划、节点和可见输入，最终 actor 不得改变。节点来自同一执行服务 `readRunNode`；其 handoff 必须对应准确已确认计划，读取期间的 command.version 和完整 handoff 不得变化。工厂随原工作台 owner 关闭失效。

工厂只在原 `openWorkbench` 内捕获已经打开的 `zhuma_asset_packages` 版本表。逐个已选 Skill 读取已确认 origin.versionId，不查当前资产定义、最新版本、旧 owner RPC 或 `Workbench.resourceFiles`。不打开第二个工作台域，不增加包表、flags 或策略的浏览器接口。

每次核对包 schema、版本、文件唯一性、原入口与授权文件子集、字节预算和包 SHA256。摘要算法与现有导入器一致：对原持久化文件数组的 JSON 字节计算 SHA256，不重新排序或另造摘要。该核对能发现当前内容与保存摘要不一致；它不构成恶意存储方同时改写内容和摘要的外部真实性证明。

只静态解析入口 SKILL.md 的 YAML frontmatter，不执行脚本、模板、连接或模型。调用标志沿固定 SDK `687f282e8625c6b8d11ff58211a90524be2e4317` 的 `disable-model-invocation` / `user-invocable` 语义：支持布尔值、0/1 和大小写无关的 true/false、yes/no、on/off；缺省均允许。无效值、旧 camelCase 别名、重复键、标签、锚点和 alias 均拒绝。解析器是 Host 的显式 `yaml` 依赖，随插件打包；不新增 SDK 服务身份。

失败只返回 `run-authority-unavailable`，不透出正文、解析诊断或内部位置。

## 接入和验证边界

本切片交付 producer 与既有表闭包，尚不表示 Run 已采用。后续仅在新 Run composition 冻结前，把策略交给执行服务的私有 `resourceCatalog.skills`；执行服务仍须独立核对定义摘要、选中集合与来源，并将策略和来源纳入新 Run 快照及摘要。旧 receipt / schema 1 / 已持久化快照不补读当前包，也不追写新策略。原生注册和真正工具调用继续遵守执行服务的授权与生命周期。

`host-run-skill-policy.test.mjs` 使用真实 WorkbenchService 静态导入、原包存储形状和核心确认计划映射；成员授权是显式 double，属于契约验证。`workbench-plugin.test.mjs` 检查内部工厂失效及无额外公共入口。正式 bundle 构建验证依赖打包边界。以上都不替代真实成员 Host、Run 采用、模型、GUI 或安装验收。
