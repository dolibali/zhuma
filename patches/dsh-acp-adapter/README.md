# 附加 ACP 原生工具 handoff 补丁

固定来源：`@zaimokuza/dsh-acp-adapter@0.2.1-rc.4.1`，MIT，源码 `28ccc6745ec82139c684c3642637e93e00d800f2`。保留包的 LICENSE／版权／版本、原始 npm 完整性及默认 Agent factory。`runtime.lock.json` 分别记录源码树、两份源码补丁和发布包补丁的 SHA256；源码和发布包不能互相冒充。

- `native-tool-handoff-source.patch` 是 C 冻结的三处业务实现及测试。摘要 `7dc8a6bbc3464308d463aec68474c75c20ada7a1c2907c51194ef96578af0789`，应用后的源码树 `fbe9a9708ace3a727553abeb8ae3850cc43b9c75`；完整替代历史静态 opt-in 补丁 1979，旧补丁不参与构建。
- `host-registration-source.patch` 仅在原 registry／composition 接入 Host 能力工厂及对应测试。生产从不传静态 true；适配器构造时捕获完整 profile 对应的同一代闭包，之后不重新取新代能力。缺少 producer 时保持原关闭行为。
- `published-package.patch` 由上述固定源码按原工具链构建，只修改发布包的 5 个 Host 模块及 4 个受影响声明。`compiled-files.json` 固定这些实际编译字节；原 Client、协议、许可和其他模块不变。该文件的精确内容同时作为 SDK `patches/zhuma-dsh-acp-adapter.patch`，由官方 SDK pnpm `patchedDependencies`／独立锁文件安装，不能直接手改 node_modules。

工具请求通过原 Harness scheduler／Session token、真实 call/result 历史及同一步 continuation 交接。bind／enqueue／执行前／结果接收时检查同一代闭包；失效拒绝新工作，不回退另一条 direct 路径。已发出的工作仍须沿原停止和真实 drain 完成，不宣称撤销能抹去已执行效果。不修改原 Agent Loop 或任务 producer 的业务权限。

Host 内部可选服务 `acpNativeToolHandoffPolicy.guardForProfile(profileId, completeProfile)` 返回本代闭包或 undefined。CodeArts producer 必须先验证准备，再注册精确 profile；已有适配器不会因迟到的新 producer 自动获得权限。该服务不进 renderer／JSON 配置，profile 名称、命令前缀和用户布尔值不授予能力。成员、Run、工作区和文件授权仍由各原服务判断。

## 重放与核对

在独立的固定源码检出中，依次以 `git apply --index` 应用两份 source patch，使用源码自己的 `pnpm@10.7.0` 冻结安装。执行原 `pnpm run build`（包含 Typert、TypeScript、tsdown、bundle 校验）；本次实际 Node 为 `24.15.0`，符合包 engines，但与社区 `.nvmrc` `24.19.0` 不同，不能称为社区原发布工具链完全相同。完整源码树应为 `4c54f49a7585f43ea41eb9c12a525fff834efff6`。

在已经安装本发行补丁的固定 SDK 检出中，用以下只读验证器核对准确源码树、源码补丁、构建字节、pnpm 安装字节、MIT 许可与原 Host peer 图：

```sh
node scripts/desktop/verify-acp-vendor.mjs --source <已构建的固定ACP源码> --sdk <固定SDK>
node scripts/desktop/verify-acp-registration.mjs --sdk <固定SDK>
```

第一条显式加 `--rebuild` 才会在指定的自有源码检出运行原 build，不自动安装、启动 CLI 或调用模型。第二条使用实际发布包的 registry 和原 SDK factory，模型／进程为明确禁止执行的契约端口；不当作真实 CodeArts producer、工具隔离、正常 GUI、业务交付或安装包资格。C 冻结补丁的 61 项叶子契约和 A registry 接缝契约分别保留原证据，不认证后续修改。
