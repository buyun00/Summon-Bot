# 架构

Summon Bot 使用同一正式数据根。Web 负责认证、页面和 API 传输。网关承载平台处理器及 Pi 运行器，执行连接按实际协议运行相应的外部请求或命令。

| 代码 | 职责 |
| --- | --- |
| `capabilities/platform` | Bot、Room、Event、Session、File、Wakeup 的对象接口，实际访问、修订、投递、调用及宿主资源 |
| `capabilities/chatroom` | 群成员、消息、引用、附件与置顶使用同一套房间数据 |
| `bot/src` | 持久收件箱、内部对话、Pi 工具循环、上下文和资料 |
| `capabilities/services` | Codex、CLI、MCP、HTTP 的实际调用、输入目标和原生结果 |
| `web`、`desktop`、`ios`、`android` | 网页、桌面外壳、iOS 与 Android 客户端 |
| `scripts` | 构建、安装、运行维护和各端发行 |

Pi 的工具为 `find`、`read`、`send`、`save_file`、`create_bot`、`configure_bot`、`create_room`、`configure_room`、`open_session`、`send_input`、`stop_session` 和 `set_wakeup`。执行连接的原生方法通过读取连接说明取得。

群消息保存原文、作者、时间、实际引用及客户端发送身份。Bot 通过 `send` 公开发言。调用先保存提交身份和返回关系，结果沿原调用回到所有等待者。普通观察与定时由 Wakeup 控制，群基础关注和自定义规则各自显示。传输、收件和内部处理各有位置。

内部对话和执行会话以真实引用区分。暂停及停止进度独立于执行器报告的运行状态。原生输入按实际 turn、run、进程实例、服务操作或空闲输入位置定位。私有 Pi 会话保存创建时的模型、内置职责、用户指令和授权资源。

Bot 运行绑定内置职责和用户指令，和实际获准读取的原文、资料及调用共同组成模型输入。角色配置和执行授权独立保存。Markdown、Skill 和选材可以通过普通 File 管理。知识写入及处理记录各自持久保存，内部消费沿实际资料和目标修订推进。[EggBot 与内置职责](EGGBOT.md)

安装窗口在旧写入者退出后转换数据，再选择新的正式运行。部署位置和操作见 [运行维护](OPERATIONS.md)。
