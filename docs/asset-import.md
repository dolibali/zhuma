# 本地专家与资产包导入：首批接口

状态：A-ASSET-IMPORT 首批实现中。领域、Host 服务契约与浏览器交互已实现；正式 Host ZIP 导入／重开正在验证，尚未作为完整产品、发布系统或真实运行兼容性验收。兼容格式见[边界表](asset-import-compatibility.md)。

## 同一目录与显式保存

团队资产展示全部／工作流／Agent 专家／Skills／MCP，分类按当前搜索计数，专家复用既有 Participant(kind=expert)，不另外复制身份。旧成员与专家入口仍可编辑同一记录；真人成员不能携带包来源或专家默认能力。

文件／目录／ZIP → 静态识别 → 预览定义、文件、声明与缺项 → 编辑名称／用途／分工能力，选择新建或明确更新 → 同一持久化命令保存。识别和预览不写目录，不启动模型、脚本、插件或 MCP。普通短文字继续进入原编辑器，仍需明确保存。

新建用本地新 ID；更新显式指定同类型现有 ID，保留任务引用。源专家 ID 只作为来源记录，不能成为登录身份或权限。名称冲突、错误目标类型、重复目标与越界路径不静默覆盖。缺失引用文件／未选中默认 Skill 会保存为停用，需补齐来源后重新导入。当前归属仅为现有工作台，个人／团队真实授权投影待 B-ID0，未增加虚构的“团队／我的”状态。

## 定义、文件与来源版本

Asset 与专家 Participant 的可选 origin 记录源文件包版本 UUID、格式、入口、允许文件清单、字节数、缺项及可选的来源 ID／版本。它是来源文件版本，不是专家发布版本系统。已确认计划照常冻结当时定义和 origin；重新导入产生新源包版本，不回写旧快照。

技能正文上限 60000 字符，专家方法 32000；MCP／普通短文本仍为 8000。新默认 resourceBindings 引用目录 Skills/MCP。规划在预算内优先取参与专家声明的能力，人员完整方法保留；来源文件清单不进入提示词，只保留包版本，连接和执行权限仍为 unknown。候选可用不等于运行可用。

SourceFiles 只读查看／下载当前定义的允许文件。源码正文不能通过普通编辑伪造源版本；名称、用途、能力偏好和可用性仍可编辑。文件更新走重新导入。脚本仅作文件保存，界面按文字预览，不执行。普通编辑不能解除来源缺项门槛。

## 格式与边界

- Agent Skills：解析 SKILL.md 的静态 YAML 元数据与正文；保留目录中的 references/assets/scripts 及上级许可证／说明文件。标签、别名、重复键、无效元数据拒绝；工具声明不授予执行权限。静态相对 Markdown 引用用于缺项预览，不是完整运行依赖解析器。
- OpenClaw：SOUL.md 与 AGENTS.md 映射人格／方法，IDENTITY.md 可提供名称，skills/ 映射默认能力。不是 OpenClaw 运行时。USER.md、MEMORY.md、会话、常见凭据与私人目录排除；目录选择先按路径过滤，再读取内容；ZIP 在 Host 跳过这些条目的解压和保存。
- Zhuma 专家 JSON：format=zhuma-expert，schemaVersion=1，声明 name/role/capabilities/instructions、可选 id/version/skillPaths。未知可执行配置字段拒绝。导入时不安装 Host 插件。
- 工作流 JSON：使用现有 v1 定义与图验证，不转成提示词；已有模板预览、参与者映射与实例化链不变。

一次最多 100 个文件、20 项定义，单文件 256 KiB、总量／ZIP 2 MiB。相对路径、大小写与 Unicode 等价重复、链接／特殊文件、加密、实际解压大小及 CRC 均检查；不解压到任何 Host 文件路径。文件选择器不能提供链接元数据，目录来源按浏览器已授权的 File 清单处理，不将其宣称为本地原生目录链接扫描。

参考 [Agent Skills 规范](https://agentskills.io/specification)、[OpenClaw 工作区约定](https://docs.openclaw.ai/concepts/agent-workspace)、[YAML 数据解析](https://eemeli.org/yaml/)与 [yauzl 逐项读取／大小验证](https://github.com/thejoshwolfe/yauzl)。没有复制外部执行框架。

## Host 与 S1 接缝

保留已打开的 zhuma_workbench 域；源文件单独使用官方 storage-domain 的 zhuma_asset_packages(version=1, per-record)，versions 表存不可变文件包。各域只打开一次；没有新数据库、文件提取器或原生桌面壳。目录快照不携带包内字节，写任务也不重写全部包文件。

同一 command(expectedRevision/requestId) 增加 import-package，payload 为 versionId、files(path/base64) 与 choices。纯领域校验后，先持久化不可变包，再提交带收据的目录。目录写入失败只留下不可见包，原请求可重试；同版本不同文件拒绝。尚未实现未引用版本清理或用户容量管理。

新增 exact /api/zhuma/preview-import（files 或 zip）、/api/zhuma/resource-files（asset/expert 与当前目录 ID），沿用官方 Connection owner carrier。后者只返回当前定义 origin 允许的文件，不接受任意 Host 路径／原始版本扫描。WorkbenchApi 对应 previewImport/resourceFiles。**S1 成员模式必须由 B 的显式模式／失败关闭门禁覆盖这两个入口及 import-package 写入**，不能因 identity 模块缺失落回 owner；本批单人契约不认证多人授权。B 的执行、提交、评审与文件物化不在这里实现。

## 当前验证

- pnpm check：181/181；其中包识别、范围／缺项、复制／更新、字节保留、版本写入失败／同键恢复及 Host 入口是契约验证。
- 完整浏览器回归 58/58，最终导入专项 8/8：目录／ZIP 预览、取消、同键重试、来源下载、更新 ID、分类与成员互通、小窗及旧文字入口。ZIP 的浏览器测试为已标注的响应重放，不能认证实际 Host 解压。
- 原生 Host、空间权限、包发布／维护者、原生 Agent 执行与产物评审仍单独验收，不能由这些数量关闭 FR12。
