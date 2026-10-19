# Relay Bot

一个独立运行在本机的 Bot 协作工作台。长期专业成员平级交流、维护自己的记忆与共享知识，通过 pi-agent-core 自主读写文件、搜索和执行命令，并可把复杂专业工作交给 Codex。用户始终是唯一最终权威。

Relay 自己持有身份、消息和工作记录，不需要启动 Hermes。社交统一使用 **DeepSeek Flash**；快聊、深聊和专业执行使用独立队列与上下文。

## 启动

需要 Node.js 24+；使用 Codex 委托时还需本机 Codex CLI 已登录。首次使用或更新依赖后执行 `npm ci --ignore-scripts`；pi-agent-core/pi-ai 固定为 1.3.0，依赖版本由 package-lock.json 保存。

```powershell
cd D:\Relay-Bot
npm ci --ignore-scripts
.\Run.cmd
```

打开 [本机工作台](http://127.0.0.1:8787)。也可以使用 `npm start`，按 Ctrl+C 停止。

后台运行：`powershell -ExecutionPolicy Bypass -File .\Start.ps1`；停止：`powershell -ExecutionPolicy Bypass -File .\Stop.ps1`。后台日志位于 `.relay/server.log` 与 `.relay/server-error.log`。这些是手动启动脚本，不注册开机自启。

密钥从进程环境、本项目 `.env`、已有 Hermes `.env` 依次读取；本机另保留原始 `Documents/ds.txt` 的最后回退读取。无需复制现有密钥。独立配置可参考 `.env.example`，仅在本地忽略的 `.env` 写入 `DEEPSEEK_API_KEY`。模型固定 `deepseek-flash`，不会自动切换 Pro。界面展示真实调用状态，未调用时显示待验证。

## 使用

- **会话栏**：上方是群聊，下面是 Bot 列表；左上搜索，右上 `+` 创建 Bot 或会话。浅灰侧栏、彩色头像与气泡构成主界面，消息预览来自实际对话。
- **消息**：在项目群发言、@成员或进入私聊；底部 `+` 可发起深聊或委托工作。成员通过结构化动作主动联系同事，来源与回传提示显示在原会话，深聊产生结论并回传来源群。
- **详情与头像**：点击聊天上方的名称打开右侧详情；Bot 支持修改 13 种头像造型、11 种参考颜色或上传图片，也可编辑职责、专业提示、启停状态和长期记忆。群成员页可修改参与者。预置工程、组件、质量三个平级成员，没有中央主控 Bot。
- **工作**：创建实际 Codex 委托，填写工作目录、目标和约束。查看进度、咨询与结果，可取消、补答或恢复已保存的线程。工作期间仍可聊天。
- **Bot 自主操作**：直接告诉成员要读取、搜索或生成什么文件。每位成员有独立个人目录，工具结果返回模型后再决定下一步；共享项目默认是 `RELAY_WORKSPACE`。聊天中的操作卡可展开查看真实工具输入、输出、失败与取消状态。文件工具限制到个人目录与共享项目，并保护运行数据库、凭据和其他成员目录；命令运行在本机用户权限下，工作目录不是系统沙箱。
- **知识**：保存事实、假设、来源与版本，建立需求/设计/组件/测试等关系，检索关联并修订旧记录。
- **职责**：为成员安排间隔职责，启停并查看下一次执行。重启后只补一次错过的到期职责。

左下“连接应用”集中显示现有模型与执行端状态，并提供成员、工作、知识与例行任务管理入口。

Bot 可以提议与发起工作。请在工作目标中明确范围；默认 Codex 使用本机配置、workspace-write 和 never approval，Relay 不添加审批链。默认提示禁止擅自提交、推送和发布。服务只监听本机回环地址，不提供多人账户或公网部署功能。

## 状态与恢复

业务数据统一保存在 `.relay/relay.sqlite`；聊天原文、摘要、Profile、知识、职责、工作与日志都在其中。备份时先停止服务，复制 `.relay`，恢复后再启动。不要在服务运行时只复制 SQLite 主文件而漏掉 WAL。

重启恢复 queued 消息和职责；未确认完成的执行标为 interrupted，使用工作详情的恢复入口继续已有 Codex thread。恢复会重查现状，不会自动重派原目标。不能把同一线程恢复等同于恢复某条被杀掉的操作系统命令。

## 开发与证据

```powershell
npm test                 # 自动功能测试，模型与协议替身明确标记
npm run test:live         # 消耗真实 DeepSeek API，隔离数据库
node test/live.mjs --with-codex  # 加上真实 Codex + Flash 咨询及文件产物
npm run test:codex        # 独立验证本机 Codex 协议、取消与恢复
npm run test:agency       # 真实模型从聊天保存记忆/知识并自主委托 Codex
npm run test:pi           # 三位 Bot 分别用真实模型完成文件/命令/记忆与重启验收
```

真实验证数据写入忽略的 `.relay/evidence/`，不污染日常工作台。每次测试的结论以实际报告为准。

- [开发进度与恢复入口](docs/DEVELOPMENT.md)：唯一开发状态记录、已跑验证、限制与下一步。
- [独立架构与实现方案](docs/ARCHITECTURE.md)：默认值、模块、API、Hermes 参考与许可证边界。
- [项目目标](docs/PROJECT_GOALS.md)：长期方向及首版核心原则。

这是本地精简底座。Unity/Figma/QA Hub 专用适配、真实游戏项目验收、长期稳定性和自动系统升级需要后续实测，不由本地演示代替。
