# 固定 Run 的 Skills 与 MCP 接缝

关联 #35 / #37。D 维护资源快照和 SDK 采用；A 维护可信 Host 生产者、公共装配与发行资格。复用原 C compose、官方 Agent / Skill / MCP 生命周期，不创建会话、执行器或第二份事实库。

## 数据与兼容

`freezeExecutionRunComposition(input)` 接受可选 `resourceCatalog`。旧空资源继续生成并严格读取 schema 1；非空资源显式生成 schema 2，resources 与配置摘要一起存入原 Run composition。独立[固定文件 reader 槽](execution-run-accepted-files.md)也可显式生成没有 resources 的 schema 2，此时运行桥仍绑定实际空 Skill 域。重放读取旧保存值，不引用最新资产。

纯 schema / freeze / read 位于 `execution-run-resource-snapshot.ts`；composition 只依赖该纯模块。官方 Skill / MCP 服务仅由 `execution-run-resources.ts` 的实际采用入口加载，读取旧快照不会隐式加载新增 SDK 服务。

- Skill / MCP 的 `ref.version` 保持已确认 `AppliedPlan.id`，不改成第三方版本或 latest。只读同一冻结计划、准确节点的资源，专家默认绑定也必须已在该节点明确选择；不自动加入其他定义。
- Skill 保存选中的完整定义与摘要，未选定义不进入 Run。初始上下文只有节点引用，正文由官方 Skill loader 按需读取。虚拟注册不加载用户目录、项目文件或相对资源，opaque resource base 不产生文件权限。
- 导入 Skill 必须提供 `QualifiedExecutionSkillPolicy`：准确 `ref`、`definitionDigest`、布尔 `invocation.modelInvocable/userInvocable`，以及 `policySource: {kind:'asset-package',versionId,digest,entryPath}`。`versionId` 对应 `definition.origin.versionId`，与 `ref.version` 的计划 ID 不混用；`entryPath` 也必须一致。digest 是经授权、已核原包的摘要，不用正文散列冒充包来源。该私有 producer 数据由 A 从原不可变包与唯一入口静态解析，缺包、无权、未知格式或标记无效均拒绝。D 不从正文猜策略。无 origin 的手写定义才使用 `{kind:'manual-default'}` 和双方可调用默认值。两个调用标志均 false 也保留，不扩大权限。
- 调用策略及其来源随新快照一起冻结和计入配置摘要。读取旧保存记录不回填、不套最新目录；改变策略需显式创建新 Run。
- MCP 保存可信、已资格化 producer 的连接引用 / 版本、命名空间和工具描述；不解析资产正文为命令，不复制 MCP 正文、endpoint、env、headers 或凭据进 Run。描述来自实际资格化目录，形状合法和 tools/list 成功均不产生执行授权。
- tools 描述包含 SDK 实际 name / description / parameters / output schema / deferLoading。空缺、未选、错版本、重复、命名空间与内容摘要不符均拒绝；严格配置摘要覆盖整个派生 payload。

资源上限：8 个 Skills，单正文 16 KiB、正文合计 32 KiB；4 个连接、每连接 8 个选定工具、描述合计 16 KiB。继续服从原 64 KiB 完整 composition 和原上下文限制，超限失败，不截断正文。

## Host API

```ts
registerExecutionRunResources(
  agentCtx, frozenSnapshot, binding, genuineGrant, producer
): Promise<ExecutionRunResourceAdoption>

producer = {
  sourceVersion: EXECUTION_RESOURCE_SOURCE_VERSION,
  signal,
  assertCurrent(snapshot, binding, grant): undefined,
  openMcp(resource, signal): Promise<ExecutionMcpConnectionLease>,
}
```

`assertCurrent` 必须由 A 经原 D manager 核真正 grant、同一持久 Run / 配置、当前资源和 Host 权限；不能用 DTO 回显、目录可见或 tools/list 代替。`openMcp` 仅在已有耐久 Run 的未发布 Agent compose 中调用，解析真正 Host 配置与凭据；没有可信已连接生产者时不可用。源函数身份、信号与 SDK service 身份持续复核；异步断言消化拒绝后仍失败。

`ExecutionMcpConnectionLease` 返回 `connectionRef`、`signal`、官方 `McpClient.Config`、同步 `assertCurrent():undefined` 和 `release():void`。config 仅在 Host 私有内存交给原 SDK，不返回给 Client 或日志。producer 应遵守取消；即使晚到，桥也等待真实 source completion 并释放其租约。

`ExecutionRunResourceAdoption` 返回 `signal`、真实工具全名、描述、`ready`、幂等 `drain()` / `dispose()`。异步注册仅在 SDK 真正激活后返回，ready 不代表 Agent 或业务 Run 已接受。drain 与 dispose 是同一个关闭并排空操作；不把中断等待或 CLI 退出当成清理证明。

所有受控 Run 均须调用采用入口并安装独立 SkillRegistry。没有 resources 的 schema 1、文件 / 完成意图独立槽不注册通用 loader，资源贡献的 `toolAllowlist` 必须为 `[]`；空域 guard 拒绝执行继承的同名 loader。真正已冻结的非空 resources schema 2 保留原官方 loader 和选中 Skill / MCP 行为，MCP-only 的 Skill registry 仍为空。A / C 必须采用原冻结 allowlist，且实际 schema keys 完全相等，不得 union / append 额外能力或改写旧 JSON / 配置 ID。显式用户调用的全局钩子仍需下面的准确 SDK 所有权资格，单凭空 registry 或执行 guard 不足以阻止该独立路径。

| 操作                    | 顺序与拒绝                                                                         | 取消、幂等与敏感信息                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| freeze / read           | 同一计划、节点与精确 refs → 严格资源快照 → 旧 / 新 schema 派生及摘要               | 纯函数；不连接、不安装、不读取资源文件；MCP config 不进入快照                             |
| register / ready        | 真正 grant + source → scope 独立官方 registry → 实际连接与目录一致 → 才返回        | 每次实例明确调用；普通 read / 重放不能调用；启动失败关闭并排空                            |
| source assert / openMcp | 每次同步断言核原权限；先接收可信私有配置租约，再调用官方连接                       | 借用 source / grant signals；late lease 仍归本实例释放；禁止普通日志带私有 config         |
| Skill catalog / load    | 官方 SkillRegistry 与 ToolSkill 按真实 scope 和 source.kind；只提供已选冻结定义    | 原 user-invocable / model-invocable 的 SDK 语义由正式 SDK 资格化，不用正文匹配伪造来源    |
| MCP list / call         | 同一配置版本 / namespace；真实 SDK tools/list 与冻结描述完全相符；原调用处理器执行 | 不重连扩大能力；定义 identity 变化即关闭；前后核 source / grant，错误中不透传私有连接细节 |
| dispose / drain         | 同一关闭 Promise，先 fencing，再撤注册、关官方 SDK、等真实 source 与调用、释放租约 | 真实 Agent scope 关闭前保留拒绝 guard，不能退回继承的同名工具；没有发出第二个业务命令     |

错误为中性的 `resources-unavailable` / `resources-mismatch` / `resources-budget`；不携带原 provider 错误、路径或配置。SDK 工具 gate 返回明确拒绝，调用失败不冒充产物或评审。

## SDK 采用

同图官方 ToolSkill 必须提供同步公共 `bindSkillRegistry(agentCtx, actualRegistry): undefined`。桥在 await 实际隔离 SkillRegistry 激活后，以同一真实服务调用一次，先于局部 ToolSkill 安装和任何 Agent step；空域也调用。SDK 按真实 Agent scope 绑定 registry 原身份与 owner 生命周期，保留失效墓碑直到实际 scope 关闭；不比较可能不同 child context 的 caller.skills，不允许父级 registry 回退。相同 original 的合法 Cordis proxy 绑定幂等，其他 original / 同名假体或 active 重绑拒绝，未绑定普通 Agent 保持原语义，这些由 A SDK 实现和资格化。

桥通过官方 namespace 的显式反射兼容根 npm 声明，缺 API 或不是函数即拒绝；非 undefined / 异步返回也在 Agent 执行前拒绝，异常异步工作的真实结束纳入原 pending / drain。持续检查 namespace 方法身份与真实 registry 原 identity，不用配置数据、工具名、私有 SDK 函数或本地 slash 解析替代该栅栏。D 组件证明采用 A [PR #155](https://github.com/dolibali/zhuma/pull/155) 准确 head `a99279ff9c1265afca93f03bedb7257071e4537f` 的完整补丁 SHA256 `c6b3c03c3b29b8cf36ad91e7d8a4c402229b4ec818fd7d134705dc771b68fcd1`，在 pin `687f282e8625c6b8d11ff58211a90524be2e4317` 的独立新 SDK 树资格化；ToolSkill 源 SHA256 `0bd2bc2e83778e401a8338b7366b41c792b255687f38a1ff3a0b64f36251d794`，CoreTools 保持 `3711a1cb28bd787ec75c461168b8a8dd1c7c92f7824907ce4fc84c9310d54d83`。该准确输入的组件证明不替代正式 Host / 发行集成；旧 #144 只有 getRegistered 的版本在进入模型前明确拒绝。

Skill 使用公开 `Context.isolate('skills')` 和该域独立的官方 `SkillRegistry`，虚拟注册本 Run 冻结定义；只有非空 resources 才安装官方 `ToolSkill`。目录保留 `skill-catalog` 来源；显式调用保留 `skill-invocation`，不复刻 loader 或另造聊天库。

MCP 的完整发现目录放在公开隔离的官方 ToolRuntime。其构造器也会注册 prompt tools provider，因此构造阶段连 SystemPrompt 一起隔离；仅隔离 tools 曾实测泄漏未选工具。连接通过公开相同 tools label 加入该 registry，并保留官方、限定此 Agent 的 server instructions；只把实际选中且已核对的原 ToolDefinition 注册到正常 Agent 的工具层。禁止复制未选 schema 或把另一个 SDK 图打进 Host。

重连关闭、SDK 调用限时 5 秒、SDK 激活限时 5 秒、结果 32 KiB、每次 attachment 最多 64 次资源工具尝试。这些是该实例 / 工具层的实际边界，**不是持久化的整个 Run 总预算**。超时不伪造晚到 source 已排空；远端服务器已经发生的副作用也不承诺可撤销。

## 正常 profile 的 SDK 门禁

实际固定 SDK 复现过祖先全局官方 ToolSkill 干扰局部 loader：catalog 钩子会移除局部目录，显式 `/skill` 钩子还可读取其原 registry 的未选正文。仅隔离 registry 不能认证正常官方 profile。

桥要求 A [SDK owner 补丁 PR #144](https://github.com/dolibali/zhuma/pull/144) 的公开只读 `ToolRegistry.getRegistered(name, scope)`；消费版本为 `f4b23f172632b9732548988837b425e846c81103`，完整发行补丁 SHA-256 为 `b63fb203f217bda93bf3236b55d6f34a1692b06f9fa803434514dd5b684475ad`。该方法只核最近实际注册身份，不改变模型可见性或执行授权。缺 API 即拒绝，不退回 `get()` 假装完成 owner 资格化。

已用该精确 SDK 的实际 Agent / 官方 loader 在 global-first 与 local-first 顺序验证只读当前 Run 所选定义；机械还原两个 SDK 生产文件后，同一两项探针均因父级私有正文进入实际模型请求而失败。该组件证据后才移除先前拒绝所有祖先 loader 的临时限制。桥仍持续核同一 Tools service / 查询方法和注册 identity；资源失效或 dispose 后，拒绝 guard 保留到真正 Agent scope 关闭，避免继承工具或全局显式钩子成为后备权限。

新增空域精确工具集验证修正了早先夹具中的 union：原实现对旧 `[]` 配置实际贡献 `['skill']`，真实默认 factory 的精确断言失败。去掉空域 loader 后，在仍使用 #144 的固定 SDK 上，已有及迟到全局 loader 两种顺序的 legacy / accepted-input / file / result / file+result 十项场景虽通过初始精确 schema keys 检查，第二轮显式 `/parent-private-skill` 却均因父级私有正文进入模型请求而失败。#144 原十九项通过只说明当时断言范围，不能认证这条新路径；这些失败按原源码和报告保留，不转换成通过。随后在上述准确新补丁与独立新缓存下，31 项真实 SDK 场景全部通过，包括原十项精确空域、选中 user-only / MCP、普通未绑定 Agent，以及非 undefined 拒绝、异步返回拒绝并等待真正结束。只从生成 bundle 删除 D 的一次公共绑定调用后，同一 legacy 探针再次因父级私有正文进入实际模型请求而失败；生成 bundle 已恢复准确摘要，生产 / SDK 源未改。缺新 API 的旧 #144 另由默认 factory 探针证明执行前拒绝、模型请求为零。

这不是正常 Host、GUI 或安装包采用证明。A 仍须在正式 Host 装配并资格化同一 SDK 模块图、已授权资源 producer 和所有受控 Run 的空 / 选定域；不能只增加包依赖或一个 allowlist 字符串便关闭 #35 / #37。

## 验证与交接

纯契约在 `execution-run-resources.test.mjs`，实际 SDK 场景在 `execution-run-resources.spec.ts`。后者明确：SDK / Agent / 网络是真实的，Run / Host 身份生产者与模型响应是契约；不认证正常 Host、成员登录、GUI、安装包或真实模型质量。

SDK 资格环境使用固定补丁 upstream、单一源码模块图和现有 `native-work-session-fixture.mjs` 的实际 boot。A 的验证入口需把本 spec 放入 SDK agent-loop 测试目录，并供应：

1. `zhuma-run-resources-bundle.js`：从公开 agent-core / context 构建入口组合 resources、composition、`compositionFacts` 以及 native fixture 的 boot / grant / ScriptedAdapter，另导出 C 的 `describeAcceptedInputTool` 与准确 JSON fixtures `acceptedFileDescriptor / resultIntentDescriptor`；所有 live `@deepseek-ai/*` 保持外部并统一指向该固定 SDK。
2. `zhuma-run-resource-http.js`：SDK 官方 `mcp-client/tests/http-fixture.ts` 的本地 HTTP server，增加一个未选工具、明确 server instructions 和可暂停一次 initialize 的测试 gate。没有模型凭据、假 binding 或假 absence。

新增独立工具集合测试只在实际 SDK 注册 C 同一描述，独立文件 / 结果工具处理器为禁止执行的 surface-only contract；不重复或代替 C 的真实文件 IO、complete_work 调用、cut 或提交资格。所有场景都使用默认 factory、冻结 allowlist 与实际 schemas / 模型请求精确比较。

新增 public binding API 非 undefined 与异步返回用实际同图 namespace 的受控故障验证，前者不发布 Agent，后者在 gate 真正结束前不报告排空；不以故障替身认证正常 SDK 行为。

覆盖二选一 Skill catalog / load、两种 global / local 安装顺序、父和 sibling scope、正确 user 来源显式调用、user-only / model-only / both-false、空域 / MCP-only、实际 MCP list / call 与 server instructions、未选工具、错描述 / 版本、源撤销、同名 loader 替换、其他普通 Agent、断连、启动中取消，以及 final close 等待晚到 Host 租约。原全局 ToolSkill 失败、旧版本临时祖先拒绝，以及精确 SDK 修复后的正常 profile 通过分列，不把旧验证认证后续源码。

发行依赖与 Host SDK allowlist 由 A 单写并逐模块资格化。依赖在 manifest 中、source SDK 通过或额外字符串出现在 allowlist，都不等于实际 Host 已采用同一 SDK / 安装包可用。A 接入时还须把 adoption.signal 接入原 Run owner 的停止清理，继续原生 drain 与业务结算，不让本桥自行写 received / accepted / 产物事实。
