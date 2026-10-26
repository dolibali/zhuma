# 固定文件 reader 的 Run 配置槽

关联 #35 / #33。仅冻结 C 的独立 `read_accepted_file` 工具描述，不注册工具、不读取文件、不签发权限或提交产物。正式注册、固定文件 issuer 和逐读校验由 C 提供，Host / 导出由 A 接入。

## 私有输入与版本

`ExecutionRunCompositionInput.acceptedFileReader?: AcceptedFileToolDefinition` 是与既有 `tools` 独立的可选字段，支持 `accepted-input-reader` 和 `local-tools` 组合。只有 Host 拿到 C 的实际就绪端口后才能显式传入其同一注册描述；类型声明、文件存在、目录可见或浏览器字段都不产生该能力。省略字段保持原配置，显式 null / false / 错描述不会静默降成省略。

准确 name 为 `read_accepted_file`，sourceVersion 为 `zhuma-accepted-files@1`。C 从实际参数 parser 以 `io:'input'` 生成描述；原 JSON SHA256 为 `ecca93908e40ff02a407da784eeb1f0f3acc52b3f36d53f5a267d9230738ba1b`，canonical 字段 SHA256 为 `4532b28ad0a0efa69ba27a2b997b8d39f4e7b154ba1829aa94c3584381345ca6`。校验保留完整参数 / 返回 / 描述，而不是仅信任工具名或版本字符串。

- 参数顶层是 `type: object` + `oneOf`，两分支分别为 `part: files` 与 `part: file`；不替换为 anyOf。
- file 分支仅 `inputRef / part / fileId` 必填；offset / length 可省略，默认 0 / 4096，单次 length 最大 8192。
- 返回保持错误白名单、完整来源 / 文件元数据，或 UTF-8 范围；不在此模块添加其他编码、路径、连接或文件正文。

未发布的旧 WIP descriptor 不提供兼容桥。真实实现提交、注册和实际调用需分别验证，持有该 JSON 也不是实现就绪证明。

## 快照与恢复

新 Run 显式提供该槽时使用 schema 2，将完整描述纳入原 composition 配置指纹及 `toolAllowlist`。不复用或替换 `read_accepted_input`；固定输入仍须满足原正文 / 链接 reader 和准确可见 inputRefs 的要求，文件工具不能补齐缺失的上游授权。

schema 2 支持 resources 或 acceptedFileReader，至少一项；二者可以并存。无 resources 的文件 schema 2 仍由资源桥绑定实际空 Skill 域，不继承全局正文。工具注册 / 调用权限继续由各原 issuer 校验，allowlist 本身不授予读取权。

schema 1 与原资源 schema 2 的保存 JSON / 配置 ID 保持原值，不回填 descriptor、重读最新包或因新增 Host 端口扩权。给旧配置显式加入新槽会产生新指纹；恢复必须沿旧保存配置，不能把当前能力反写旧 Run。

## 验证边界

`execution-run-accepted-files.test.mjs` 使用 C 的准确描述副本及 PR146 前置快照，验证纯配置组合、字段篡改、错误版本、旧 JSON 恢复与指纹。Host 就绪、C issuer、实际授权文件读、共享 Run 预算和停止排空均不由该契约测试认证。

实际工具继续受 C 的 24 KiB 输出、共享 Run 64 KiB / 16 次及 5 秒逻辑超时约束，实际 drain 后才归还资源；此槽不新建或绕过这些预算。
