# 本机首次成员设置

本批消费原身份／空间初始化后端 `6b124fc93ca61a2cc58e40d75e1310255c128b6a` 及 [团队基础专家目录](host-team-catalog.md)，把正常首次账号、个人／团队目录及基础专家选择接到正式 Host／Client。源码与真实 Host 验证不替代协调者的正常 GUI、安装及首版验收。

## 入口与旧资料

只有显式 `multi-member + localSetup: true` 才挂载首次设置。官方桌面第一次创建 profile 时，在创建 manifest 前以 `wx` 写入这一明确配置，再调用原 `initProfile`；若创建中断，重试保留已写的选择。已有 manifest 或 patch 时不覆盖配置。Bundle 的继承默认仍保留 legacy，避免更新发行文件就隐式改变旧 profile 的权限模式。

旧单人窗口保持原目录、凭据及数据，并说明资料不会自动迁入团队。不按已有 cookie、账号、任务或个人专家猜测团队归属；本批不实现旧库迁移。

成员界面的首屏先检查真实首次设置状态。本机 owner 可创建账号、填写团队名称、选择基础专家；同时创建实际个人空间。完成后通过原成员登录接口登录，按正式 POST 回执的 `createdTeam` 走原空间控制器重新核对目录、明确选择并确认刚创建的团队，立即可见所选专家；Client 不从 requestId 拼接空间事实。只有本次显式创建／恢复使用该落点，普通重开保留既有个人／团队记忆。视图取消不开始迟到登录／团队选择，选中后的偏好仍由原确认回调保存。已有配置直接进入成员登录／工作内容。失去 owner 运输准入的产品成员不能调用设置，不因此升级为 owner。

## Owner HTTP

- `GET /api/zhuma-local-setup/status`：只返回公开状态与四个基础包的显示信息；pending 带原 requestId。无 verifier、密码、账号正文或私有 setupContext。
- `POST /api/zhuma-local-setup/initialize`：`{requestId:uuid, accountId, password, teamName, packIds}`，strict 字段，账号最多64且不能与基础专家标识冲突、密码8–200、团队名称最多160，packIds 为公开四包的唯一非空子集。成功重新投影真实状态。

使用原 Connection exact Fetch route、owner 准入及 Host／Origin 校验。POST 在读取内容前再次确认 owner，8KiB／10秒 streaming 预算，必须提供与已验证实际 Host 相同的 canonical HTTP(S) Origin；原 HTTP bridge 的 `Request.url` 是内部占位地址，不能当真实 Origin。GET 使用原 SDK buffered 模式，避免给 GET 构造 body。响应统一 no-store，不回显原异常或输入。

桌面仍使用官方转发与既有私有 cookie bridge。只有 bridge 已验证原 `dsh-app://app` 来源后，该设置 POST 的 dispatch 才添加真实 Host Origin。设置路径属于 owner 控制面，不加入成员 cookie 路径，不把连接凭据当成员身份。

## 唯一选择事实与完成顺序

Host 生成实际 `team-${requestId}`、个人空间及成员关系，通过原目录解析器规范化；专家选择按空间与包标识排序。原身份意图持久保存一份非秘密且不可变的：

```json
{
  "schemaVersion": 1,
  "teamCatalog": [
    { "spaceId": "实际团队ID", "packs": [{ "id": "zhuma-work-planning", "version": "1.0.0" }] }
  ]
}
```

这就是 Host 私有 `setupContext`，不另存一份可变配置或业务库。原 backend 对其 strict 结构、重复项、16KiB预算及同请求指纹负责；A 再按当前四个原包的实际版本与摘要校验。`setupFingerprint` 为规范化 `{schemaVersion:1,directoryFingerprint,catalogPin}` 的 SHA256，catalogPin 来自原包目录函数。

顺序为：原私有稳定 verifier intent → 原账号写入 → 原目录 `initializeImport` 完成 → 原 `beforeComplete` 按准确 requestId／context／目录初始化指纹／当前实际团队与成员核对并导入原包 → 原身份 complete-last。Client ready 字段不能代替其中任何一步。

冷开只从原 publisher handle 的 `readSetup()` 取得脱离副本 `{requestId,setupFingerprint,setupContext}`。已 complete 时以 `initialize:false` 核验已有包和定义，缺失／冲突零写拒绝；pending 只显示恢复，用户提交相同请求及内容后才允许继续原初始化。启动、读取、登录和状态检查不会重放。配置中若另有 `teamCatalog`，须与持久 context 规范化完全相同，否则拒绝；没有 setupContext 的旧仅 Config 部署保留原接缝，不自动合并来源。

`directoryFingerprint` 来自原初始化 marker，不从当前全量目录重新生成。正常新增项目归属或后续合法成员变更不会令原初始化失效；每次成员操作仍走当前 membership 和撤权门禁，不用旧成员清单恢复已撤销权限。

HTTP 取消只结束等待。已获准的原初始化操作仍由原 backend 排空，不能因丢失回复声称回滚；相同请求重试核对真实持久结果。未知旧意图、异体输入、包 pin 改变、配置冲突及关闭均不伪装完成。

## 验证入口

`pnpm check` 包含 Client API／SSR、配置冲突零写、精确补丁后的新 profile／已有 profile／中断前缀，以及桌面原转发来源的契约；其中 profile initializer 和网络发送端为明确契约端口，不是桌面进程验收。

`pnpm test:host` 另外使用完全相同的 emitted Host、真实 SDK Connection／身份／目录／JSON 和独立进程：不提供 bootstrap，从正常 owner HTTP 创建账号和所选专家，经成员 HTTP 创建项目后冷开；另在真实目录和原包表已写、Workbench 写入阻断时杀掉旧进程，新进程保持 pending／不能登录／不自动续写，异体零写、同体显式恢复及重复无额外版本。全程只用临时合成账号与资料，零模型调用、无预置确认计划。正式 GUI／安装及模型执行证据由协调者绑定实际版本单列。
