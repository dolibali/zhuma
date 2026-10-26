# 固定文件 reader 的 Run 配置槽

关联 #35 / #33。仅冻结 C 的独立 `read_accepted_file` 工具描述，不注册工具、不读取文件、不签发权限或提交产物。正式注册、固定文件 issuer 和逐读校验由 C 提供，Host / 导出由 A 接入。

## 私有输入与版本

`ExecutionRunCompositionInput.acceptedFileReader?: AcceptedFileToolDefinition` 是与既有 `tools` 独立的可选字段，支持 `accepted-input-reader` 和 `local-tools` 组合。只有 Host 拿到 C 的实际就绪端口后才能显式传入其同一注册描述；类型声明、文件存在、目录可见或浏览器字段都不产生该能力。省略字段保持原配置，显式 null / false / 错描述不会静默降成省略。

准确 name 为 `read_accepted_file`，sourceVersion 为 `zhuma-accepted-files@2`。C 为固定 SDK 声明其支持的 JSON schema 子集，严格业务规则继续由同一 runtime parser 在 IO 前校验；原 JSON SHA256 为 `d2fa881375b612a32f2dcb554984145f00eb8e49f7fa2d3a4a15f5f6723b448b`，canonical 字段 SHA256 为 `6e676da0e4023d3daf24872e7598f9f7f382978cdbec746c13613efb7bdd96f9`。校验保留完整参数 / 返回 / 描述，而不是仅信任工具名或版本字符串。

- 参数为 flat object / properties，required 为 `inputRef / part`，part 枚举 files / file；不声明固定 SDK 不支持的 type + oneOf 组合。
- `part:file` 的 fileId 条件必填、offset / length 的默认 0 / 4096、最大长度 8192 及范围约束均由 C 的严格 parser 在 IO 前执行；声明简化不放宽业务校验。
- 返回使用 SDK 支持的 oneOf，保持错误白名单、完整来源 / 文件元数据，或 UTF-8 范围；不添加其他编码、路径或连接。

未发布 @1 file descriptor 明确拒绝解码 / 启动，不把 @2 当作旧保存引用的恢复能力；旧提交和证据保留，不提供静默升级桥。真实实现提交、注册和实际调用需分别验证，持有该 JSON 也不是实现就绪证明。

## 快照与恢复

新 Run 显式提供该槽时使用 schema 2，将完整描述纳入原 composition 配置指纹及 `toolAllowlist`。不复用或替换 `read_accepted_input`；固定输入仍须满足原正文 / 链接 reader 和准确可见 inputRefs 的要求，文件工具不能补齐缺失的上游授权。

schema 2 支持 resources / acceptedFileReader / 独立 resultIntentTool，至少一项；三者可以并存。无 resources 的文件 schema 2 仍由资源桥绑定实际空 Skill 域，不继承全局正文。工具注册 / 调用权限继续由各原 issuer 校验，allowlist 本身不授予读取权。完成意图槽的候选资格与边界见 execution-run-result-intent.md。

schema 1 与原资源 schema 2 的保存 JSON / 配置 ID 保持原值，不回填 descriptor、重读最新包或因新增 Host 端口扩权。给旧配置显式加入新槽会产生新指纹；恢复必须沿旧保存配置，不能把当前能力反写旧 Run。

## 验证边界

`execution-run-accepted-files.test.mjs` 使用 C 的准确描述副本及 PR146 前置快照，验证纯配置组合、字段篡改、错误版本、旧 JSON 恢复与指纹，并调用官方 rc2 的 JSON validators 检查声明子集。该检查不是工具注册 / 调用证明；Host 就绪、C issuer、实际授权文件读、共享 Run 预算和停止排空需分别验证。

实际工具继续受 C 的 24 KiB 输出、共享 Run 64 KiB / 16 次及 5 秒逻辑超时约束，实际 drain 后才归还资源；此槽不新建或绕过这些预算。
