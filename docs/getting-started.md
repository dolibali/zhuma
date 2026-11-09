# 源码运行与本地部署

本指南面向希望体验产品、运行桌面源码或部署团队共享服务的开发者。先按目标选择运行方式，再准备对应环境、配置与数据目录。产品整体流程见[产品与功能导读](product-overview.md)，各平台支持与已验证范围见[本版说明](release-v1.5.1.md)。

## 1. 选择运行方式

| 目标                      | 入口                                              | 所需环境                                                    |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| 直接使用桌面              | 从正式 Release 安装，再按根 README 登录和创建任务 | Windows x64 或 macOS Apple Silicon；无需安装源码工具链      |
| 修改并运行桌面源码        | 下文的 `desktop:prepare`、`desktop:dev`           | 对应 Windows/macOS 本机工具链与固定依赖源码                 |
| 本机调试共享后端          | `scripts/server/start.mjs`                        | 已构建的同源 SDK、根工作台 Bundle、独立数据目录             |
| 用已安装 App 提供本机服务 | `packaged-backend.sh`                             | macOS arm64 的匹配 App 及同版两个启动文件                   |
| 部署共享服务              | 同版 Linux 便携包或服务镜像                       | Linux amd64；便携包需 Node 24.15.0/glibc 环境，镜像含运行时 |

共享后端是可选项。本机桌面可创建账号和团队，也可在“连接设置”连接团队已有服务。网页成员入口提供共享业务和人工处理，本机 Agent 执行由成员桌面承接。

## 2. 取得完整源码和工具

安装 Git、Node.js **24.15.0**，确认 Node 自带的 npm 可用。根 pnpm 为 **12.4.2**；固定 SDK 使用自己的 **11.28.5**，不要把其包加入根 Workspace。版本来源为 `.node-version`、`.nvmrc`、`package.json` 和 `runtime.lock.json`。

使用可用的 Corepack；若本机没有，可先安装 `corepack@0.34.6`（与当前 Windows 发布工具一致），再启用：

```sh
npm install --global corepack@0.34.6
corepack enable
corepack install --global pnpm@12.4.2
node --version
pnpm --version
```

已有全局工具发生冲突时先核对安装，不直接强制覆盖。Windows 还须确保 Corepack 的 JavaScript 入口存在，不能只复制一个命令包装器。不同系统分别检出、安装依赖；不要混用 Windows、WSL 和 macOS 的 `node_modules` 或原生文件。

以下 Git/pnpm 命令可在终端或 PowerShell 的自选空目录执行：

```sh
git clone --recurse-submodules https://github.com/dolibali/zhuma.git
cd zhuma
git submodule update --init --recursive
pnpm install --frozen-lockfile --ignore-scripts
pnpm run doctor
pnpm upstream:check
```

如果之前只下载了不含子模块的源码归档，应改用完整 Git 检出，不能把缺失的固定源码当作可构建输入。`upstream/deepseek-harness` 必须位于锁定的 `504a01a9578abc2c6f1fb896b1dc322c9fe24f66`；不跟踪其最新分支。根 Workspace 仅含 `packages/*`。首次构建还需公开依赖、Electron 和运行时的下载通道；仅安装根依赖不会生成桌面应用。

## 3. 从源码启动桌面

当前产品平台为 macOS arm64、Windows x64；Linux 使用后文的服务入口。macOS 需要可用的系统签名工具；进入系统原生模块源码构建时需要 `cc` 和对应 Node headers。Windows 在原生 Windows 文件系统和 PowerShell 中工作；WSL 的 Linux 构建不能替代 Windows 桌面资格。完整 SDK 条件见[固定开发指南](https://github.com/deepseek-ai/deepseek-harness/blob/504a01a9578abc2c6f1fb896b1dc322c9fe24f66/docs/development.zh.md)。

为这次源码运行选择新的、未使用的状态目录，不导入已安装应用的 profile、模型密钥或会话库。

macOS 终端（在仓库根目录）：

```sh
export DSH_HOME="$PWD/local-overrides/desktop-home"
export DSH_DESKTOP_USER_DATA_DIR="$PWD/local-overrides/desktop-user-data"
export ZHUMA_WORKBENCH_DEV_GATEWAY=0
pnpm desktop:prepare
pnpm desktop:dev
```

Windows PowerShell（在仓库根目录）：

```powershell
$env:DSH_HOME = Join-Path (Get-Location) 'local-overrides/desktop-home'
$env:DSH_DESKTOP_USER_DATA_DIR = Join-Path (Get-Location) 'local-overrides/desktop-user-data'
$env:ZHUMA_WORKBENCH_DEV_GATEWAY = '0'
pnpm desktop:prepare
pnpm desktop:dev
```

`desktop:prepare` 只在 `.build/desktop/deepseek-harness` 准备隔离源码、补丁和品牌资源，保留固定子模块。`desktop:dev` 安装该隔离树的冻结依赖，生成/装配工作台，构建 Host/Client 并调用原桌面开发启动器；首次较慢。它不是只开一个静态页面，也不是安装包构建。

全新桌面 profile 明确选择成员模式并提供首次账号/团队设置；已有 profile 保持原配置，不自动迁移旧单人数据。源码启动默认打开调试工具，Main/Renderer/Host 端口为 9229/9222/9230。需要改端口时分别使用 `DSH_DESKTOP_MAIN_INSPECT_PORT`、`DSH_DESKTOP_RENDERER_DEBUG_PORT`、`DSH_DESKTOP_HOST_INSPECT_PORT`；`DSH_DESKTOP_OPEN_DEVTOOLS=0` 可关闭自动打开的面板。

退出使用应用的“退出”命令，等待 Host 收尾；macOS 只关窗口可能仍保留进程。重启应用不等于重编源码。两个自选状态目录保留账号、设置及会话，下一次使用相同目录继续；不要用删除目录代替停止任务。`local-overrides/` 被 Git 忽略，仍应自行备份。安装器构建另见[桌面发行指南](../distribution/desktop/README.md)，本指南不把源码启动当安装验收。

## 4. 本机共享后端：源码或 App

### 源码调试入口

先按第 2 节准备根仓库，在本机为服务准备独立 SDK。以下构建序列来自现有服务指南；macOS/Linux 源码开发须具备对应本机依赖，Linux 原生构建需要编译器、Python、Node headers 等，完整构建环境见[容器构建定义](../distribution/server/container/Dockerfile.builder)。不要复制其他系统的原生二进制。

```sh
node scripts/server/prepare.mjs
cd .build/server/deepseek-harness
corepack pnpm install --frozen-lockfile
corepack pnpm run build:native-system
corepack pnpm run build:lib
corepack pnpm run build:web
cd ../../..
pnpm workbench:build
node scripts/server/start.mjs --sdk .build/server/deepseek-harness --data local-overrides/source-server-data --host 127.0.0.1 --port 3080 --file-uploads --independent-reviews
```

此源码入口默认回环 `127.0.0.1:3080`，成员打开 `http://127.0.0.1:3080/workbench`。它是同口的本地开发入口，操作者平面也在该进程内，不作为对外成员网关。Windows 共享服务部署使用 Linux 包；本指南不追加 Windows 后端运行资格。

### 复用 macOS 安装版

同一次 Release 的 `packaged-backend.sh`、`packaged-backend.mjs` 放在同目录。以下把 `./Zhuma.app` 替换为实际已安装 App 路径，使用新的数据目录：

```sh
sh packaged-backend.sh --app ./Zhuma.app --data ./local-overrides/app-server-data --host 127.0.0.1 --port 3080 --file-uploads --independent-reviews
```

该入口只支持匹配的 macOS arm64 App，核公开版本后复用包内运行时，不使用宿主模型配置；并非 Windows/Linux 通用启动脚本。默认成员地址同上。完整说明见[服务指南](../distribution/server/README.md)。

## 5. Linux 本地部署：正式便携包或镜像

从同一正式 Release 下载所选包、`SOURCE.json`、`SHA256SUMS`，先核对来源与摘要。以下文件名以 1.5.1 为例；使用其他版本时整套材料一起替换。

### 便携包

在 Linux amd64/glibc 主机安装 Node.js 24.15.0，准备 `ca-certificates`、`libstdc++6` 等对应运行依赖。解压后的 payload 保持原相对链接，数据放在其外部：

```sh
mkdir -p .runtime/backend
tar -xzf ./downloads/zhuma-1.5.1-server-linux-amd64-portable.tar.gz -C .runtime/backend
node .runtime/backend/start.mjs --data ./local-overrides/portable-server-data --host 127.0.0.1 --port 3080 --operator-port 3081 --public-origin http://127.0.0.1:3080 --file-uploads --independent-reviews
```

### 镜像

在 Linux amd64 Docker 环境中加载同版镜像。将 `ZHUMA_IMAGE` 的占位文本替换为 `docker load` 显示的名称或镜像 ID；不要把它当作新的镜像构建命令。容器参数沿现有 Linux 资格流程，默认单网络的容器 IP 由 `hostname -i` 取得：

```sh
docker load -i ./downloads/zhuma-1.5.1-server-linux-amd64-image.tar.gz
ZHUMA_IMAGE='替换为加载后显示的镜像名称或ID'
docker volume create zhuma-local-data
docker run -d --name zhuma-local --read-only --tmpfs /tmp:rw,nosuid,nodev,size=128m --mount type=volume,source=zhuma-local-data,target=/data -p 127.0.0.1:3080:3080 --entrypoint /bin/sh "$ZHUMA_IMAGE" -ec 'exec node /app/start.mjs --data /data --host "$(hostname -i)" --port 3080 --operator-port 3081 --public-origin http://127.0.0.1:3080 --file-uploads --independent-reviews'
```

镜像内使用 UID/GID 10001，应用目录只读，唯一持久写入为 `/data`。选用未占用的容器/卷名称；已有目录绑定时确保该用户可写。默认示例只把成员端口映射到宿主回环，不映射操作者端口。就绪后访问 `http://127.0.0.1:3080/workbench`；页面可打开不表示完整业务或模型已验证。

### 参数、停止和数据保留

| 参数                    | 实际含义                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--data`                | 必填的独立状态目录；便携包要求在不可变 payload 外部                                                          |
| `--host`                | 具体 IP；拒绝 `0.0.0.0`、`::` 等通配地址                                                                     |
| `--port`                | 成员端口，默认 3080                                                                                          |
| `--operator-port`       | Linux 运行包的内部回环端口，默认 3081，须与成员端口不同                                                      |
| `--public-origin`       | Linux 运行包允许的成员根 Origin，可重复；示例为 `http://127.0.0.1:3080`，不能带 `/workbench`、查询或认证信息 |
| `--file-uploads`        | 显式启用文件协议，省略则关闭                                                                                 |
| `--independent-reviews` | 启用独立 Agent 评审，必须同时启用文件协议                                                                    |

源码 `scripts/server/start.mjs` 和 macOS App 启动器不接受 `--operator-port`、`--public-origin`；不要将三个入口的参数混用。反向代理或不同宿主端口必须按实际成员 Origin 配置，不能仅放宽 Host/Origin 检查；部署模板及对外方案见既有[容器](../distribution/server/container/README.md)与[K8s](../distribution/server/k8s/README.md)说明。

前台服务使用 Ctrl+C/SIGTERM 停止并等待退出。容器使用：

```sh
docker stop --time 45 zhuma-local
docker start zhuma-local
```

停止不删除数据卷。不要用 `docker rm -v`、删除数据目录或覆盖其他安装的 profile 作为日常重启手段。服务的 `--data` 下包含隔离 `home/`、`dsh/` 和生成的 `zhuma-server.patch.json`；模型凭据、成员和业务数据均属私有。停服后备份整个目录/卷，同版本恢复并使用相同数据位置。操作者私有能力文件由进程创建和清理，不发布其中 URL/token。服务退出码只描述进程收尾，不等于任务已提交或已通过评审。

## 6. 配置与模型位置

| 文件/位置                                                            | 作用                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `package.json`、`.node-version`、`.nvmrc`                            | 根脚本、Node/pnpm 工具版本                                        |
| `pnpm-workspace.yaml`、`pnpm-lock.yaml`                              | 根 Workspace 范围和冻结依赖                                       |
| `runtime.lock.json`、`.gitmodules`                                   | 固定依赖源码、工具链和子模块来源                                  |
| `branding/default/brand.json`、`branding/default/icon-manifest.json` | 产品版本/标识与图标摘要；不是用户模型配置                         |
| `distribution/workbench/cordis.patch.yml`                            | 构建时工作台组合，安装到隔离构建树；不直接改已装应用              |
| `--data` 下生成的 `zhuma-server.patch.json`                          | 该服务进程使用的组合配置，由启动器生成                            |
| `distribution/server/container/`                                     | Linux 构建/运行镜像材料                                           |
| `distribution/server/k8s/overlay.example.yaml`                       | 自选本地覆盖模板；需要替换镜像 digest/成员 Origin，不是已配置部署 |

根启动脚本读取当前进程环境，未提供统一应用 `.env`/`.env.example` 加载协议。共享后端构造隔离环境，不继承终端里的模型密钥；不要新增一个同名文件后假定它会被服务读取。

人工编排、查看任务和人工提交不要求模型。未连接共享后端时，本机团队的 AI 规划使用桌面 Host 的模型配置；连接共享后端后，规划模型由该服务操作者在其自身的 Settings → Models 配置。本机 Agent 始终在成员桌面“设置 → 模型”配置执行模型。团队管理员身份不等于服务操作者权限，不把本机执行凭据复制到后端。码道 CLI 按本机安装/登录/信任目录要求准备，再从运行配置“更多 → CLI 设置”保存命令。选中模型或打开设置不会开始任务。

共享服务首次配置时，由操作者私下查看该进程 `--data` 下的能力文件：源码入口使用 `operator-url.txt`，macOS App 和 Linux 运行包使用本进程的 `operator-url-*.txt`，权限均为 `0600`。按文件中的同机回环入口打开后端根页面，完成原首次设置并进入 Settings → Models；参见[服务首次设置说明](../distribution/server/README.md#源码开发启动)。Linux 镜像示例只开放成员端口，成员页面不能作为模型管理入口；操作者回环位于容器内部，只按既有受控同机或回环转发方式访问，不新增端口映射。不要分享、提交或在日志中记录实际能力 URL/token。

源码桌面示例显式设置 `ZHUMA_WORKBENCH_DEV_GATEWAY=0`，不注入开发自定义提供商；需要开发网关时按现有[组合指南](../distribution/workbench/README.md)配置，不能从环境变量名称推断模型已连接。

## 7. 验证与故障定位

在根仓库执行 `pnpm check` 验证仓库、格式、类型及契约；`pnpm run doctor`、`pnpm upstream:check` 核对工具与固定源码。源码检查、应用启动、模型调用和安装验证分别执行、分别记录。构建与启动使用上文对应入口；验证层次及所需环境见[测试说明](../tests/README.md)。

缺少 `.zhuma-prepared.json` 时先核对是否执行过对应 prepare；配方不匹配时检查本次隔离树，保留已有工作。端口冲突时调整本次实例的端口并同步配置 Origin，保留持久数据。排查时记录准确源码或安装包版本、运行方式、实际命令与错误信息；工程案例、CLI 及平台覆盖范围见[版本说明](release-v1.5.1.md)和[产品范围](product-coverage.md)。
