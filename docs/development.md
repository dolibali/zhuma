# 开发指南

## 第一次准备

安装 `.node-version` 中的 Node 和 `package.json` 中的 pnpm。仓库提供版本声明，不自动修改开发者全局工具。

```bash
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm check
pnpm upstream:check
```

## 常用命令

项目环境检查使用 `pnpm run doctor`，显式写 `run`，避免命中 pnpm 自带的同名命令。

| 命令                                | 作用                                                |
| ----------------------------------- | --------------------------------------------------- |
| `pnpm build`                        | 按 TypeScript 引用构建四个自研包                    |
| `pnpm typecheck`                    | 构建引用声明，再检查各包类型                        |
| `pnpm test`                         | 构建后运行 Node 原生测试，不调用模型                |
| `pnpm check:repo`                   | 检查目录、包名、版本和源码依赖方向                  |
| `pnpm format` / `pnpm format:check` | 处理自有文件，排除上游和生成目录                    |
| `pnpm check`                        | 仓库边界、格式、类型和单元测试                      |
| `pnpm workspace:demo`               | 构建后启动 Agent 处理演示，地址打印在标准输出       |
| `pnpm test:browser`                 | 构建后用本机 Chrome 跑模拟执行器的浏览器流程        |
| `pnpm upstream:check`               | 核对子模块 URL、gitlink、HEAD、包版本及上游干净状态 |
| `pnpm clean`                        | 只删除四个自研包的 dist                             |

`pnpm test` 验证契约和内存事务，不调用模型。`pnpm test:browser` 用浏览器操作显式选择的模拟执行器，不计入 `pnpm check`。真实 DSH 插件、桌面安装、模型调用和 CLI 联动仍未验证，不把这些项目计为通过。

## DSH 的工具链

本仓使用 pnpm `12.4.2`；锁定的上游使用 pnpm `11.28.5`，二者分别安装与构建。先读取上游 `AGENTS.md`、`docs/architecture.md`、`apps/desktop/README.md`，再执行上游自己的命令。

初次初始化不安装上游全部依赖，不下载 Electron，不改动已有 DSH 应用。后续桌面构建需在隔离工作树准备。不能把根目录 `pnpm build` 的成功解释为官方桌面构建成功。

## 升级上游

通过专门分支选择标签和精确提交；同步子模块 gitlink 与 `runtime.lock.json`，检查其工具链和接口变化，运行最小插件、状态、桌面及打包回归后再合并。不使用自动跟踪远程分支或启动时安装 latest。

## 首次提交后的下一步

先接通一个真实 Host 工具和 Client 页面，证明自研 Bundle 能在锁定的官方桌面中加载。再验证任务执行、取消和重开历史，最后完成品牌、签名和安装包。见 [roadmap](roadmap.md)。
