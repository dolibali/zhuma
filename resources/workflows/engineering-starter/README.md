# 工程工作流资源

默认「需求到代码验收」沿用 WorkflowTemplate v1：需求澄清 → 设计与任务 → 代码实现 → 验证与失败反馈 → 独立与人工评审 → 固定交付。原四个模板及其 ID、原十个 Skill ID 保留；短任务仍可只用一个 Skill。

`catalog.json` 的首项供现有选择器作为默认项。节点的 `skillIds` 引用模板资源，资源再通过 `suggestedAssetId` 建议真实 Skill；`roleSkillSuggestions` 仅作建议。选择角色不表示资源或执行权限已生效，实际参与者、可用执行者与资源绑定沿现有客户端/Host 核对。

设计节点需要人工正式评审。实现者自检后，指定不同的实际参与者负责独立代码评审，人工对该报告及代码的固定版本作正式决定。模板无法凭角色名称保证身份不同，也没有新增可信测试门禁、失败条件调度或并行执行器。运行失败与评审退回继续使用现有修正和新版本重提；旧报告和旧票只属于旧版本。

新增 `controlled-implementation` 负责已批准范围内的实现；已有 `bounded-fix` 负责实际失败或评审意见触发的有界返工。验证使用工程自己的命令并保存源码版本、argv、cwd、退出码和报告摘要；语法检查、领域契约、模型行为、GUI 和真实部署证据分开记录。

## 来源与许可

参考版本和许可索引在 [references.json](references.json)。仅采用方法组织，没有复制第三方代码或模板，也不安装 OpenSpec/Aider。

- [OpenSpec 固定版本的 spec-driven schema](https://github.com/Fission-AI/OpenSpec/blob/3e4d5f0769e2857c8eb54f149cbf5e4f703fa04c/schemas/spec-driven/schema.yaml)：需求场景、设计、可验证任务与上游产物的划分；[MIT 许可](https://github.com/Fission-AI/OpenSpec/blob/3e4d5f0769e2857c8eb54f149cbf5e4f703fa04c/LICENSE)。
- [Aider 固定版本的 lint/test 说明](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/docs/usage/lint-test.md)：真实项目命令及失败诊断反馈；[Apache-2.0 许可](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt)。

本资源与新增 Skill 使用各自保留的 Zhuma MIT 许可。

## 验证

仓库根目录执行：

```sh
pnpm build
node --test resources/workflows/engineering-starter/tests/catalog.test.mjs
```

这是静态模板与绑定契约验证，不认证真实模型编排、正式评审或 GUI。公共注册、固定来源与安装后可见性由对应装配批次验证。
