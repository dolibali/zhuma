# 本地共享后端入口

本入口复用固定 SDK 官方 Web CLI、原身份、目录、工作台、执行与附件存储，不启动另一套运行器。普通成员从 `/workbench` 进入，仅使用产品成员 cookie；SDK 根页面、通用 RPC、WebSocket、连接和首次设置仍属于操作者。

## 启动

准备本仓依赖、已构建的固定 SDK（版本见 `runtime.lock.json`）和独立数据目录，然后执行：

```sh
pnpm workbench:build
node scripts/server/start.mjs --sdk /path/to/prepared-sdk --data /path/to/zhuma-data
```

默认只监听 `127.0.0.1:3080`。CLI 的 `--host` 必须是具体地址，不能用 `0.0.0.0` 或 `::`。本版不配置集群、公开网络入口或代理。

成员使用启动时显示的无 token `/workbench` 地址，可创建账号并登录个人空间。在账号菜单打开“账号与团队”，创建团队或由创建者添加已有账号。普通成员可查看自己团队的成员，只有真实管理员可增删成员；旧团队没有管理员事实时保持只读。修改密码会使旧会话失效并要求重新登录。任务列表与看板读取同一批数据，卡片打开原任务；取消或未知进度不会显示为已交付。

原首次设置的操作者入口保留在数据目录内权限为 `0600` 的 `operator-url.txt`，只供操作者在本机打开，普通成员注册不需要该链接。官方 CLI 为每个进程生成该链接；正常退出后删除，不发给成员。模板/知识页面及跨设备执行按各自集成版本验收，不能仅凭服务器已启动判断完整产品通过。

`--data` 下的 `dsh/` 持久化原 SDK 凭据、身份、目录、工作台、执行和附件；`home/` 是隔离的运行 HOME。此目录含私密资料，不提交、不复制其他安装的模型 profile 或会话库。停止服务后备份整个目录；恢复到同版本并用相同 `--data` 启动。旧单人数据不会自动迁移。启动器不继承当前 shell 的模型密钥，也不读取原用户 HOME。

## 执行位置与边界

原桌面继续保留显式启动本机 Agent 的行为。独立成员 Web 当前提供共享业务与人工交付入口，隐藏 Agent 启动操作，也不把 `/zhuma-run`、工作区授权、自动运行工作流开放给仅有成员 cookie 的浏览器。当前源没有“另一台桌面连接此共享后端并执行”的跨 Host 通道；切换请求地址不能实现本机执行。该通道的范围与验收须单独确认，不能默认为后台执行或已支持远程电脑。

| 接缝                                                    | 写者 | 本批入口                                              |
| ------------------------------------------------------- | ---- | ----------------------------------------------------- |
| 成员页面、exact HTTP 运输、Host/Client 装配、启动与验证 | A    | `memberWeb: true`；`registerProductFetch(ctx, route)` |
| 账号、目录、团队与成员工作台业务                        | D    | 原身份生命周期、`member-workbench*`                   |
| 知识与原生会话领域                                      | C    | 原会话；知识真实合同就绪后装配                        |
| 四模板和 Skills 静态资源                                | E    | 资源清单交付后装配                                    |

`registerProductFetch` 仅对显式成员 Web 模式增加产品 exact 路由。它先查 Host/Origin 和真实成员，再调用原处理器；空间/固定版本/文件授权和流式大小预算继续由原业务实现检查。没有通用 owner RPC 代理，没有 owner Peer 冒充。未启用此模式时保留原桌面行为。

账号与团队复用原身份生命周期：`POST /zhuma-id/register`、`POST /zhuma-id/password`、`GET/POST /zhuma-id/teams`、`GET/POST /zhuma-id/team-members`。注册不发会话，完成后经原 `/zhuma-id/login` 登录。改密码后领域撤销旧会话；仅在账号和 controller 代次仍匹配时，界面回到登录。改密响应不无条件清 cookie，防止迟到响应清掉另一账号的新登录；已失效 cookie 由下次正常登录覆盖。所有请求经原 Host/Origin 和领域身份/管理员检查，入参不接受浏览器提供的 actor。HTTP 有独立 8 KiB/10 秒正文预算，操作已被领域接纳后断线只结束等待，关闭仍等待原操作收口。

## 验证

```sh
node scripts/server/verify-local.mjs --sdk /path/to/prepared-sdk
node scripts/server/verify-members.mjs --sdk /path/to/prepared-sdk
```

这两项验证均用全新临时 HOME/DSH_HOME 启动真实官方 CLI，分别核首次设置/成员业务/owner 拒绝，以及无 owner 授权的注册/个人空间/团队权限/改密码/项目与冷重开。报告在 `.artifacts/server/local-proof.json` 和 `member-proof.json`。不使用导入账号夹具、不调用模型。运输与 SSR 单测只标记契约测试。浏览器交互、模型、本机跨设备执行、安装包和实际网络部署分别验收，不能由此结果代替。
