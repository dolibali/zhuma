# Agent Skill 域的显式归属

关联 #35、#113。固定 DSH `687f282e8625c6b8d11ff58211a90524be2e4317`，通过发行补丁交付，不改默认 Agent factory、Loop、用户目录或另一套 Skills 库。

## 问题与接口

`ToolRuntime.getRegistered()` 是忽略可见性的注册身份查询，仍保留原语义。空资源 Run 的固定工具清单可以为空，不能为了覆盖父级 loader 而向旧 Run 添加 `skill`。单纯隐藏 schema 或拦截 execute 也挡不住父级显式 `/skill-name` 钩子在 pre-step 读取全局正文。

官方 ToolSkill 模块新增同步公开接口：

```ts
bindSkillRegistry(agentCtx: Context, actualRegistry: SkillRegistry): undefined;
```

调用者在真实 Agent scope 中创建并等待隔离 SkillRegistry 后、注册任何 ToolSkill 或开始首 step 前，传入 `isolated.get('skills')` 的真实服务对象。缺接口、返回异步结果或非 undefined 结果时，Host 必须在运行前失败关闭，不能回退父级库。注册器仍由原 SDK/Cordis 管理。

绑定检查 `scopeOf(agentCtx)` 的真实对象及其当前 `.ctx`，不按会话 ID、名称或 DTO 匹配。合法 Cordis tracing proxy 按 `symbols.original` 比较；同原服务重复绑定幂等，异实例、同名外观对象和活动期间重绑拒绝。原服务的 provider context、服务与方法身份和 Agent context 必须持续有效。

SDK 只保存以实际 scope 对象为键的进程内弱引用归属元数据，不保存定义、会话或执行事实，也不产生权限。失效绑定保留关闭域标记直到原 Agent scope 结束，不能删除后恢复全局回退。父级 hook 在目录 ensure、list、get 前核域归属；异步查找返回后再次核验。未绑定普通 Agent 保持原行为，user-only Skill 的显式使用独立于模型可见性。

## 装配与兼容

固定 Web bundle 的 manifest/importer 增加 Skill、MCP client、Tools、Scope、SystemPrompt 五个现有 SDK peer 的直接映射，沿原 workspace 路径与精确版本解析，不安装新执行框架或形成第二个模块图。ToolSkill 已有直接映射。旧注册身份 API 与第三方许可不变。

资源采用方仍须使用同一 SDK 模块图、原真实 Run grant 与固定配置。空域只隔离并绑定空 registry，工具清单保持原保存值；非空域按固定清单注册自己的 loader。本文接口不证明 Host/Run 已采用、MCP 已连接或模型已完成工作。

## 验证边界

定向 SDK 资格包含原 ToolSkill 测试与所有权用例，检查两种加载顺序、无 loader 的空域、父 provider 在读取前被拒、user-only 正例、异步失效、同对象幂等、外观对象拒绝、provider 关闭后无回退及普通 Agent 不受影响。负控制在隔离 SDK 中恢复旧源码，要求父 provider 的实际 get 计数从正确的 0 变成 1，不能仅用正文过滤或缺 API 报错算复现。

正式 `skill-loader` phase 保留原所有权负控制，并追加空域负控制；阳性与旧源码探测分开记录。SDK 定向/类型检查不认证真实 Cookie、默认原生 factory、正式 Host 采用、安装包或产品验收；原生资源矩阵由对应工作项另验。

同批仅公开导出已接受的纯 core `submitExpertDelivery`，供后续适配使用；没有接入自动完成或放宽人工提交权限。真实持久结果引用和提交 authority 仍是后续调用的必要前置。
