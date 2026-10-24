# 开发指南

## 交付入口

[交付规则与总索引 #25](https://github.com/dolibali/zhuma/issues/25) 是统一入口；实时阶段、优先级和依赖读取对应 Issue 标签／正文，由协调者维护。Project 只作用户总览，开发者无需 Projects 写权限。范围与退出条件保留在[覆盖账本](product-coverage.md)，接口与分期见 [roadmap](roadmap.md)，不另建状态副本。

A/B 全程用 GitHub 插件或 `gh` 处理 Issue 与 PR，不打开或自动化操作浏览器。开始、交付、阻塞／依赖变化、验收时，在原工作项更新一次：分支与完整 SHA、PR、实际完成、证据与未覆盖边界、阻塞负责人、下一交付。无变化不重复确认，评审细节留在 PR；用 `Refs #工作项` 关联，未满足退出条件不自动关闭。

A 的 Host 身份装配见 [#28](https://github.com/dolibali/zhuma/issues/28)，登录／空间 UI 见 [#31](https://github.com/dolibali/zhuma/issues/31)，执行业务和显式开始的共享装配见 [#32](https://github.com/dolibali/zhuma/issues/32)。B 的可信身份、项目空间事实和人工链分别见 [#27](https://github.com/dolibali/zhuma/issues/27)、[#29](https://github.com/dolibali/zhuma/issues/29)、[#30](https://github.com/dolibali/zhuma/issues/30)。A 消费真实接口并单写共享入口，不创建第二份授权事实或执行业务。

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

`pnpm test` 验证契约和内存事务，不调用模型。`pnpm test:browser` 用浏览器操作显式选择的模拟执行器，不计入 `pnpm check`。真实 DSH 插件、桌面安装、模型调用和 CLI 联动仍未验证，不把这些项目计为通过。`pnpm check` 覆盖仓库、类型和 Node 契约测试，不等于业务验收。已有工作台、项目与资产等切片的正式 Host／隔离桌面记录分别保存在[验证记录](workbench-validation.md)和 `docs/review/`；这些历史证据只认证注明的提交和环境。契约、响应重放、作者报告、独立验证、真实 Host／多账号／模型、原生桌面与安装包分列，没有执行的层次不计通过。额外验证由对应工作项约定，不因文档维护重跑旧 UI。

## DSH 的工具链

本仓使用 pnpm `12.4.2`；锁定的上游使用 pnpm `11.28.5`，二者分别安装与构建。先读取上游 `AGENTS.md`、`docs/architecture.md`、`apps/desktop/README.md`，再执行上游自己的命令。

初次初始化不安装上游全部依赖，不下载 Electron，不改动已有 DSH 应用。后续桌面构建需在隔离工作树准备。不能把根目录 `pnpm build` 的成功解释为官方桌面构建成功。

## 升级上游

通过专门分支选择标签和精确提交；同步子模块 gitlink 与 `runtime.lock.json`，检查其工具链和接口变化，运行最小插件、状态、桌面及打包回归后再合并。不使用自动跟踪远程分支或启动时安装 latest。

## 后续开发

从 #25 依赖关系拉取一个主要交付切片，在已集成基线上准备；未合入实现写作“已发布待审”，不能据此声称正式集成，也不能忽略已经交付的模块。后续仍需逐项完成真实成员入口、人工／Agent 处理、固定产物、评审、恢复与安装验收，具体退出条件见[覆盖账本](product-coverage.md)。
