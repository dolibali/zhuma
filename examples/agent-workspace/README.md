# Agent 处理演示

这个目录的演示可以跑真实 DSH 执行器，也可以跑显式选择、并清楚标明模拟的执行器。真实 DSH 通过环境变量配置。未选择执行器时不会改用模拟。它不是已经完成的桌面产品。

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc -b
node examples/agent-workspace/server.mjs
```

也可以使用 `pnpm workspace:demo`。浏览器打开标准输出里打印的 `url`。

操作顺序：

1. 在配置里选择「DSH」或「模拟执行器」。模拟执行器会在界面上标明模拟。未选择时发送按钮禁用，页面不会改用模拟执行器。
2. 搜索并勾选 Skills、MCP，必要时上传文本附件，再发送。
3. 运行中的补充会进入下一轮队列，并标明发送成功不等于已应用。
4. 停止会等待执行器回执。取消之后出现的输出只作为迟到记录，不把节点改成已完成。
5. 「保存草稿」只保存草稿，不自动交付，也不跳过评审。记录异常时这个按钮仍然只保存草稿。
6. 「返回任务」只切换视图，不创建运行。

可选环境变量：

- `PORT`：监听端口。省略时由系统分配。
- `ZHUMA_HOLD_RUNS=1`：执行器接收后暂停，直到 `POST /api/release`。
- `ZHUMA_SESSION_FILE`：会话文件。请放在临时目录，不要提交。
- `ZHUMA_MODEL_BASE_URL`、`ZHUMA_MODEL_API_KEY`、`ZHUMA_MODEL_ID`：真实 DSH 的模型路由。未设置模型时直接失败并点名该变量。运行时文件用 `ZHUMA_DSH_BIN`，未设置时用 `pnpm upstream:build-dsh` 构建出的 CLI。不要写下地址或密钥。

进程重启后会先装回该文件里的事实。即使执行器声明可以恢复会话，重启后原来的子进程已经不在，所以不会把未结束的运行推断成完成。页面上的「继续交互」之后，才能核实为执行器已断开。

浏览器流程：

```bash
pnpm test:browser
```

它使用本机 Chrome，不下载 Playwright 自带浏览器，也不属于 `pnpm check`。
