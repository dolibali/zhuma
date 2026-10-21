# 工作台组合发行

这里将维护本产品的 DSH Bundle／Profile、Host 和 Client 插件装载及默认资源。

当前目录是发行边界说明，**不是已可安装的 Bundle**。真实插件入口完成并验证后，再按锁定版本生成 `package.json` 的 `dsh.bundle` 元数据、依赖和 `cordis.patch.yml`，避免提交看似可运行但接口虚构的配置。

最终安装必须来自固定版本的打包产物，不依赖开发机器的 Workspace symlink、绝对路径或参考仓库。未配置外部执行器不影响将来的 DSH 原生路径，但不得在已选择码道的任务中静默切换。
