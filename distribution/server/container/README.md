# Linux amd64 后端镜像

本镜像运行同源 SDK 原 Web CLI 与工作台插件，使用普通 Node，不包含 Electron、成员设备的执行工作区或个人 profile。容器和 [K8s](../k8s/README.md)只负责运行／部署，成员身份、权限、流和文件仍由原 Host 及业务实现处理。

## 构建输入

- 产品准确源码提交与 `runtime.lock.json` 中固定 RC.4；不得从宿主 macOS 的已编译目录拷贝 native 模块。
- Node 24.15.0、根 pnpm 12.4.2、SDK 自有 pnpm 11.28.5；SDK 不合入根 Workspace。
- `Dockerfile.builder` 提供 Linux/glibc 的编译器、Python、Git、Node headers 与两个独立 pnpm 版本；它不是运行镜像。
- `build-linux.mjs` 仅接受完整产品 SHA，从公开仓库取得原源码／固定子模块，执行产品 server prepare，再运行 SDK 自有 native-system／lib／web 和根工作台构建。调用失败立即停止，不输出成功 stage。

先构建隔离 builder，以新建、仅用于本次源码构建的 volume 运行；复用非空 volume 前先核对所有权和源码，脚本不会覆盖已有检出。

```sh
docker --context "$BUILD_CONTEXT" build --platform linux/amd64 \
  -f distribution/server/container/Dockerfile.builder \
  -t zhuma-server-builder:node24 distribution/server/container

docker --context "$BUILD_CONTEXT" volume create zhuma-server-source

docker --context "$BUILD_CONTEXT" run --name zhuma-server-build \
  --mount type=volume,source=zhuma-server-source,target=/workspace \
  --mount "type=bind,source=$PWD/distribution/server/container/build-linux.mjs,target=/build-linux.mjs,readonly" \
  zhuma-server-builder:node24 node /build-linux.mjs --source "$SOURCE_SHA"
```

构建阶段需要公开依赖下载网络；不传模型凭据、宿主 home、Docker socket、会话库或真实项目数据。上面的源码构建退出成功只表示编译完成，portable 包生成、原生依赖检查和 HTTP 运行需接续验证。

## 运行包与封镜像

运行 Dockerfile 的 context 必须是产品 portable 准备命令生成的 Linux 输出，根内容约定如下；具体生成命令随 A 的服务准备接口交付，不以不存在的脚本名代替。

```text
sdk/
workbench/
start.mjs
member-gateway.mjs
runtime-manifest.mjs
SOURCE.json
LICENSE
THIRD_PARTY_LICENSES.txt
```

`SOURCE.json` 必须绑定产品完整 SHA、固定 SDK 与原生平台；工作台和 SDK 同源。只允许已校验且不逃出包根的相对依赖链接，无 Git、构建源码、绝对链接、模型配置或数据。Dockerfile 按上述清单 COPY；禁止以个人目录或原 profile 为 context。基础 Node 镜像 digest 固定，系统包实际版本与 native `ldd` 结果在准确运行候选证据中记录。

```sh
docker --context "$BUILD_CONTEXT" build --platform linux/amd64 \
  -f "$PWD/distribution/server/container/Dockerfile" \
  -t "zhuma-backend:$SOURCE_SHA" "$PORTABLE_STAGE"
```

镜像成功生成后，先在 Linux amd64 上以 UID 10001、只读 root、独立空 `/data` volume 和受限 `/tmp` 首启，核对实际成员 HTTP、原生动态库、来源校验和 SIGTERM；再按已授权的现有私有镜像通道交付，部署使用最终 digest。此处不自动推送镜像、创建仓库或发布版本。

运行参数由同源 `start.mjs` 提供：`--data /data --host <明确IP> --port 3080 --operator-port 3081 --file-uploads --independent-reviews --public-origin <明确成员根Origin>`。宿主映射端口与容器地址不同时必须显式声明实际 Origin，不接受任意 Host 或转发头。成员门监听 3080，原 SDK 操作员控制平面只在容器 loopback 3081；成员 Service 不暴露后者。操作员临时能力只保留在 `/data` 私有文件，不能写入命令参数、镜像、日志或成员链接。

## 验收边界

本目录的构建定义不认证后端可用。准确源码、运行包摘要、镜像 digest 与平台绑定后，还需检查非 root／只读启动、成员与操作员隔离、错误 Host／Origin、真实固定文件字节、停止与同版本重启／离线备份恢复。CPU／内存记录来自相同镜像的实际工作负载；真实规划模型由协调统一调用。当前结论以 [#372](https://github.com/dolibali/zhuma/issues/372) 为准。
