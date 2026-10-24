# WP03 独立演示界面

截图在 `e0f48851dd133e318e8b95b5c931ee8661591329` 上截取，之后的改动不涉及这一页。基线 `79a4466f2dc26cedf8495be58a16078f663b9fa5`。视口 1440×900。主题只有浅色。

展开态：配置侧栏保持展开，没有收起。草稿图打开「编辑产物草稿」对话框。记录异常图的侧栏停在上下文和恢复。

执行器是模拟执行器，数据是 `examples/agent-workspace/server.mjs` 里的演示种子。这是独立 HTTP 演示，不是正式 Host。这一页是新界面，没有旧界面可以对照。

深色是缺口。这个演示没有主题开关，也没有深色样式，所以没有深色截图。

| 状态       | 文件                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| 配置       | [configure-light-1440x900.png](configure-light-1440x900.png)                 |
| 执行中     | [running-light-1440x900.png](running-light-1440x900.png)                     |
| 草稿       | [draft-light-1440x900.png](draft-light-1440x900.png)                         |
| 记录异常   | [record-abnormal-light-1440x900.png](record-abnormal-light-1440x900.png)     |
| 持久化故障 | [persistence-fault-light-1440x900.png](persistence-fault-light-1440x900.png) |

截图脚本是 [capture.mjs](capture.mjs)。它启动同一份演示服务，用本机 Chrome 截取上述五张浅色图。持久化故障图是运行已经接收之后，把会话目录改成不可写，下一次执行事件写不进去。
