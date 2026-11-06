# 单实例共享后端

此目录维护 Linux amd64 的测试部署，复用固定 SDK 的原 Web CLI、成员业务和文件存储。运行镜像由相邻 [容器说明](../container/README.md)准备；客户端／Host 运输由产品服务入口负责。部署不提供成员执行 Agent，不安装 Electron，不新增认证、数据库或业务服务。

## 运行边界

| 对象       | 契约                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Deployment | `zhuma-backend`，单副本、`Recreate`；禁止并行启动两个写入同一数据目录的实例                         |
| 成员入口   | 容器 3080，仅由已核对的成员运输门提供；Service 不映射操作员端口                                     |
| 操作员入口 | SDK 原控制平面仅绑定容器 loopback；不通过 Service、NodePort 或 Ingress 暴露                         |
| 数据       | 单 PVC 挂载 `/data`，保存原身份、模型设置、业务、文件及恢复状态；不从个人 profile 拷贝初始化        |
| 临时内容   | `/tmp` 的 128Mi `emptyDir`；Pod 更换后可丢失，不存唯一交付或恢复数据                                |
| 权限       | UID/GID 10001、只读根文件系统、无 service-account token、无额外 capabilities                        |
| 资源       | requests 100m／256Mi，limits 1 CPU／1Gi；需记录准确镜像的启动、空闲、一轮规划实测，配置不是性能保证 |
| 停止       | 45 秒 grace，原启动器转发 SIGTERM 并等待；进程退出／断线不代表业务成功或 Run 物理排空               |
| 就绪       | 无身份 GET `/workbench` 返回正常入口；探针只验证 HTTP surface，不认证登录、上传、规划或恢复         |

本目录不新建存储类、Ingress controller 或其他集群组件。`storage.yaml` 的 `nfs-storage` 是显式示例，应用前核对现有供给器及其权限、容量、备份和回收策略；没有默认存储类时不能省略选择。`fsGroup` 能否使目标卷供 UID 10001 写入，必须在该卷上实际验证。

## 配置与应用

所有命令都应显式指定已核对的 context；以下 `TEST_CONTEXT` 是占位变量，不包含访问凭据。先确认 namespace 和同名 Deployment／PVC／Service 的归属。未知或非本项目已有资源不覆盖。

```sh
kubectl --context "$TEST_CONTEXT" get namespace zhuma --ignore-not-found
kubectl --context "$TEST_CONTEXT" -n zhuma get deployment,pvc,service
kubectl --context "$TEST_CONTEXT" get storageclass
```

先对命名空间、PVC、Service 分别执行 `apply --dry-run=server -f <file>`，核对后再应用。PVC 未 Bound 时停止后续部署，保留卷和错误证据。Service 使用集群分配的 NodePort，避免占用已有端口；它在后端尚未就绪时没有可用 endpoint。

运行前建立本地 overlay，使用准确的 Linux amd64 镜像 digest，替换 Deployment 的 `PUBLIC_ORIGIN` 为唯一实际成员根地址（协议＋主机＋端口，无路径／查询／令牌）。示例镜像与 `http://backend.invalid` 不可直接部署。原入口继续验证 Host／Origin，不允许任意转发头或通配 Host。

```sh
mkdir -p local-overrides/server-deployment
cp distribution/server/k8s/overlay.example.yaml local-overrides/server-deployment/kustomization.yaml
# 编辑此本地文件中的镜像仓库、digest 和成员 Origin；目录已被 Git 忽略。
kubectl --context "$TEST_CONTEXT" -n zhuma get service zhuma-backend
kubectl kustomize local-overrides/server-deployment > /path/to/private-rendered.yaml
kubectl --context "$TEST_CONTEXT" apply --dry-run=server -f /path/to/private-rendered.yaml
kubectl --context "$TEST_CONTEXT" apply -f /path/to/private-rendered.yaml
kubectl --context "$TEST_CONTEXT" -n zhuma rollout status deployment/zhuma-backend --timeout=120s
```

本地 overlay／渲染文件不提交实际地址或认证材料。普通 HTTP NodePort 只用于已授权的隔离测试网络；其他网络应使用既有 TLS 入口并冻结其准确 Origin。新增入口不是关闭原认证的理由。HTTP 失败、Host／Origin 拒绝、readiness 失败、镜像拉取失败或只读写入失败均保留真实状态，不将 Pod Running 记为可用。

## 差异验证与交付

在工作项中绑定源码完整 SHA、镜像 digest、Node／SDK 来源及实际部署 revision，然后验证：

1. Linux amd64 非 root／只读首启，成员入口可达；操作员根路径、通用 RPC／WS／连接设置不能经成员 Service 访问。错误 Host／Origin 仍被拒绝。
2. 无模型完成注册、登录、权限和至少一项固定文字／文件提交；上传、预览、下载摘要一致。后端模型仅由协调在原授权内配置和调用，不把成员密钥传入后端。
3. 明确停止现有业务后，重建同版本单 Pod，原身份和固定提交仍存在；不依赖旧 Pod 的临时文件。
4. 将完整 `/data` 做一次离线备份，恢复至隔离空目录／卷，再以相同镜像复验身份、业务版本和文件摘要。测试不能覆盖唯一原卷。
5. 记录同一镜像的启动时间、容器 CPU／内存、空闲及一轮规划占用；无 metrics API 时保留测量缺口，不能写成 0。

备份必须在停止唯一写者之后进行；含敏感模型设置、身份与文件的备份不上传 Issue／PR。不要仅备份业务 JSON 而漏掉 SDK 状态与文件。存储类若 `reclaimPolicy: Delete`，删除 PVC 可能删除唯一数据；本操作流程不删除 namespace、PVC 或 PV。

升级和回滚均保持单写者：先停止／等待旧实例退出，再换镜像；`Recreate` 只控制该 Deployment，不能阻止人为启动的第二个写者。恢复只使用已核对的同版本完整备份；不承诺新版本数据可被旧二进制读取。镜像失败时停止 rollout 并保留卷，不能以清空数据恢复就绪。

当前部署与验收结论以 [#372](https://github.com/dolibali/zhuma/issues/372) 的准确候选和证据为准，静态清单及 server dry-run 不代表运行、持久化或业务验收通过。
