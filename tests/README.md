# 验证分层

当前可执行的纯逻辑测试在 `packages/*/tests/`，由 `pnpm test` 运行。

GitHub Actions 的 `scaffold` 在所有 PR、`main` / `develop` push 执行源码与契约检查、工作台 Host/Client bundle 构建、浏览器契约冒烟和上游检查。保留这个 job 名，主分支 required check 依赖它；失败不会被忽略。这里仍预留真实集成与目标工程验证，没有接入的测试不计为通过。

## 组合 Host 发行文件

`pnpm test:host` 先构建再用真实已发布 DSH 服务运行六组隔离进程测试；已构建时可用 `pnpm test:host:run`，CI 在同一 bundle 构建步骤后执行该命令。测试从 `.build/workbench` 复制四个原始发行文件到临时 SDK 包作用域，不重新打包源码，使用合成凭据和私有文件目录，模型调用明确禁用。可选 `S1A_PROOF_FILE` 只在成功后输出来源提交、源码洁净标记及四文件摘要；[S1a 详细结果与边界](../docs/review/s1a-host/README.md)。这与内存契约、浏览器重放和原生桌面是不同证据层次。

## 浏览器契约冒烟

在仓库根目录执行（不需要现有 Host、登录、密钥或模型）：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec playwright install --with-deps chromium
pnpm test:ui
```

`test:ui` 先构建工作台，再运行 Chromium 浅色和深色场景。统一使用 Playwright 的 `chromium` channel，即完整 Chromium 的新 headless 模式；本地与 CI 使用相同配置，不依赖已安装的 Chrome。已完成构建时可用 `pnpm test:ui:run`；只跑一组用 `pnpm test:ui:run --project=chromium-light`。UI 测试文件在 `packages/client/tests/browser/`，不属于 `pnpm test` 的 Node 用例发现范围。

身份浏览器项目另外运行 `packages/dsh-adapter/tests/browser/identity-session.spec.mjs`，使用真实 Connection 与内存依赖，验证两个浏览器上下文和退出登录，不属于下述工作台 RPC 重放，也不能认证真实凭据文件或完整多人交付。

临时静态服务由 Playwright 启停，只监听 `127.0.0.1:8796`；端口占用直接失败，不复用未知进程。需要换端口时设置 `ZHUMA_UI_TEST_PORT`。它只提供测试页面和打包脚本，未配置的 API 返回 404。所有 RPC 在每个用例内拦截；非本地网络请求、意外 API 或页面异常都会使测试失败。

| 场景           | 行为断言                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 任务创建与编辑 | 负责人、执行者、多人评审与交付内容保存后刷新重开；嵌套人员选择取消不污染外层草稿                                                    |
| 主题           | 浅色/深色/系统切换保留未保存内容、节点选择和画布位置，不调用保存或规划                                                              |
| 规划连续调整   | 后续请求引用当前未应用提案；十节点、依赖和非目标分工保留；失败、取消与迟到响应保留上次草案                                          |
| 冲突恢复       | 关闭错误提示后仍有恢复入口；取消确认保留预览，接受后读取最新快照                                                                    |
| 目录与表单     | 26 人目录筛选、长中文能力搜索多选；取消/错误保留原值和输入；保存中禁止 Escape 关闭；720×450 仍能操作保存                            |
| 连接状态       | 等待、错误重试、空目录和创建入口                                                                                                    |
| 三层工作树     | 全树点击保持、路径/每层选择恢复、搜索/折叠/依赖跳转不写入、正常入口保存重开                                                         |
| 定位失效       | 新版本删除子树后回到可见上级，搜索和右栏不残留已不可见内容                                                                          |
| 小屏树导航     | 720×600 键盘定位/进入，抽屉关闭与进入本层后恢复触发按钮焦点                                                                         |
| 长任务表单     | 720×450、26 位参与者，真实滚轮滚动正文并露出末项；逐项 Tab 到负责人，footer 贴底且不随焦点偏移                                      |
| 目标创建与恢复 | AI 默认、一次保存后直达规划；保存悬挂期间卸载/重挂载不启动规划、创建/规划失败重试、取消迟到响应、同一任务转手动、刷新重开不自动规划 |
| 负责人信息栏   | 空值可选、标签与按钮同行、小屏长姓名不越界、只读可读且无保存或模型副作用                                                            |

创建用例另加载显式 development bundle，以 React StrictMode 的真实 effect 重放检查首轮规划只启动一次；其他场景仍运行 production bundle。

用例运行真实的 `WorkbenchPage`、`TaskEditor`、`createWorkbenchApi`、公共控件、画布和 CSS。测试传输与主题服务替代官方 Host 边界；命令复用 `agent-core` 的纯 reducer，并只保存在每个用例的内存快照中；规划使用预设响应，不调用模型。刷新重开是客户端读写契约验证，不是磁盘持久化、真实模型规划质量、官方 DSH 认证/主题持久化/插件注册或安装版桌面验收。

失败时保留截图、trace、HTML 报告及脱敏 fixture 请求记录；CI 上传 `workbench-browser-failure`，保留 7 天。无自动重试、无 `continue-on-error`、不以像素快照相等代替业务行为。复现后可执行 `pnpm exec playwright show-report` 或 `pnpm exec playwright show-trace <trace.zip>`。

测试结构参考 [Playwright webServer](https://playwright.dev/docs/test-webserver)、[API 响应重放](https://playwright.dev/docs/mock) 与 [CI 指南](https://playwright.dev/docs/ci-intro)。真实 Host、执行交付、多用户权限与桌面验收继续按对应领域独立验证。
