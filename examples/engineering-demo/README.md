# 订单 CSV 导入工程案例

这是有真实 Node HTTP API、浏览器预览页和项目测试的小工程。它提供**可通过的现有功能基线**，留出一项未实现的跨模块需求，供 Zhuma 的「需求到代码验收」工作流真正修改代码、验证、评审和返工。

不使用模型、数据库、外部服务或第三方运行依赖。所有姓名、订单和文件都是合成数据。需要 Node 24.15.x；无需安装 npm 包。

## 先创建独立工作区

在仓库根目录运行：

```sh
node examples/engineering-demo/tools/create-workspace.mjs
```

输出新临时目录及 `workspace-manifest.json`。也可用 `--destination /已有父目录/全新目录` 指定位置，已存在目录会拒绝。只复制示例工程；不复制 Zhuma 源码、凭据、会话库、Git 元数据或独立验收器。将该新目录作为实际 Agent 的工程目录，授权范围见 [task.md](task.md)。这是操作约定，不能替代系统沙箱。

在输出的新目录中：

```sh
npm run lint
npm test
npm start -- --port 4179
```

用浏览器访问打印的 `127.0.0.1` 地址，选择 `fixtures/basic.csv`，预览两条订单并下载 JSON 报告。`lint` 是 JavaScript 语法检查，项目没有 TypeScript/typecheck。测试包含纯业务与真实本地 HTTP；本交付没有执行 GUI 或模型。

## 基线与变更任务

现有基线接受固定四列表头、UTF-8 中文、LF/CRLF、正整数数量、最多两位小数的非负单价，输出以分为单位的整数金额。每行独立校验，合法行可以部分成功。支持原 `application/json` 请求 `{ "csv": "..." }` 和 `text/csv` 原始字节，最大请求 64 KiB。

CSV 方言有意限制为不带引号、逗号分隔、无字段内换行；不在本次任务扩展 Excel/完整 RFC CSV，也不提交数据库。金额安全整数、固定返回结构、原 JSON API 和传输错误属于保持行为。

请将 [task.md](task.md) 作为任务原始输入。**当前未实现** BOM、忽略空行、重复订单号、严格 UTF-8 和模块拆分。不要预填计划已批准、模型已完成、评审已通过或节省时间。实际需求、设计和执行产物由参与者/Agent 在产品内正常提交。

## 独立验收

从 `workspace-manifest.json` 读取 `acceptanceCommand`。该命令使用原仓库的固定验收器检查新工作区，不能复制或修改为被验工作区里的同名测试。执行前核对 manifest 中的 SHA-256，并由协调方固定验收器与 fixtures 的源码提交；本工具不提供对同一操作系统账号的防篡改保护。

```sh
node /固定资源目录/examples/engineering-demo/acceptance/check.mjs --project /独立工程目录 > /证据目录/acceptance.json
```

原始基线运行此命令必须 exit 1：正常保持行为检查通过，新需求场景失败，报告 `not-ready`。任务完成后应 exit 0 且 `checks-passed-review-pending`，仍需人工评审。报告包含逐场景诊断、准确 argv/cwd、Node 版本、被验代码摘要、验收器与 fixture 摘要；不含伪造源码提交或模型成绩。

基线单元测试不固定“旧缺陷应存在”，因此实现新需求后可以继续运行。独立验收重复保留关键旧行为断言，不能通过削弱工作区测试制造业务通过。

## 产品演练与固定交付

1. 在 Zhuma 创建任务，选择默认工程工作流，绑定真实实现者、不同的独立评审者和人工评审者。授权仅指向上述独立工程。
2. 提交需求和设计产物，人工确认准确范围后，实现者在新工作区修改代码。运行项目命令并保留真实输出；测试失败时把原诊断交实现者有界修正。
3. 提交实际源码/补丁、项目检查日志与独立验收 JSON。评审者核对版本、内容和报告，不以退出成功代替实际代码审查。
4. 发现真实问题后，在固定版本具体内容留下意见并退回。负责人读取意见，修正后提交新代码/报告版本；旧意见和旧票保留原版本。不要故意植入缺陷来伪造返工。
5. 交付节点固定上传 `source` 代码文件或补丁、`project-checks` 原日志、`acceptance.json`、`review` 具体意见与结论、`delivery-manifest.json`。清单列每个文件的文件名、字节数、SHA-256、被验版本和来源。只写正文报告不等于交付工作区代码。

正常 GUI 使用 `fixtures/bom.csv`、`blank-lines.csv`、`duplicates.csv` 和真实坏字节 `invalid-utf8.csv`，确认上传、错误物理行号、部分成功表格和报告下载内容。`invalid-utf8.hex` 提供同一坏字节的可读编码。领域契约、真实 HTTP、模型改动、GUI 与正式评审分别留证。效率仅使用实际开始/结束和返工记录，不从节点数量估算收益。

[Zhuma MIT 许可](LICENSE.txt)。工作流的开源方法引用见 [资源来源](../../resources/workflows/engineering-starter/references.json)；本例没有依赖或复制 OpenSpec/Aider 实现。
