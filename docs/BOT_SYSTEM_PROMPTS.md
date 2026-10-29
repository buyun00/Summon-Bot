# Relay Bot 系统提示词

更新：2026-10-28。依据用户认可的 OpenBot/Rakazo 调查推荐稿编写。

## 当前文件

- [公共行为主干](../roles/common.md)：所有 Bot 共用的身份原则、目标理解、上下文使用、执行、协作、群聊、授权、经验维护、职责演进和交付。
- [当前运行协议](../roles/protocol.md)：对现有核心工具、来源会话、PASS、记忆/状态、资源与可选外部能力的文字说明。
- `roles/<roleId>/profile.md`：每个角色自身的工作方向和专门规则。
- `roles/<roleId>/prompt.md`：按当前加载方式保留的完整角色提示词，由上述三部分组合。

| 角色 | 岗位来源 | 完整提示词 |
| --- | --- | --- |
| 协作伙伴 | [profile](../roles/default/profile.md) | [prompt](../roles/default/prompt.md) |
| 入口伙伴 | [profile](../roles/entry/profile.md) | [prompt](../roles/entry/prompt.md) |
| 工程伙伴 | [profile](../roles/engineer/profile.md) | [prompt](../roles/engineer/prompt.md) |
| 组件伙伴 | [profile](../roles/components/profile.md) | [prompt](../roles/components/prompt.md) |
| 质量伙伴 | [profile](../roles/qa/profile.md) | [prompt](../roles/qa/prompt.md) |
| 聊天室伙伴 | [profile](../roles/chatroom/profile.md) | [prompt](../roles/chatroom/prompt.md) |
| 管理伙伴 | [profile](../roles/manager/profile.md) | [prompt](../roles/manager/prompt.md) |
| 记忆伙伴 | [profile](../roles/memory/profile.md) | [prompt](../roles/memory/prompt.md) |
| Codex 中继 | [profile](../roles/codex-relay/profile.md) | [prompt](../roles/codex-relay/prompt.md) |

## 编写方式

公共内容只编辑 common.md 或 protocol.md；岗位差异只编辑对应 profile.md，然后运行：

```powershell
node D:/Relay-Bot/scripts/prompts/render.mjs
```

这是把文字写入九份现有格式模板的生成动作，不启动服务或模型，不运行测试，不计算哈希，不改变 role.json 中的工具、Skill 或权限。渲染器没有接入构建/安装流程。

新增角色时按当前 role.json 格式提供岗位配置，另外提供 profile.md，再生成完整 prompt.md。需要自定义的具体 Bot 名字、稳定 ID、临时目标和用户个性化职责从其实际配置提供，不在通用模板中写死。

## 本轮完成与生效边界

本轮完成系统提示词文本和九个角色模板。文字层面沿用当前 engine 的规则：一对一直连优先核心消息工具，群聊或用户指定渠道使用聊天室；不再同时规定一切联系都走 chatroom_dm。保留深聊的真实轮次唤醒、来源回流、Codex 中继专用 Skill 与禁止旧 codex_submit 等岗位差异。

没有改 engine、管理服务、记忆注入、资源加载或路由代码；没有修改正式数据中的任何 Bot config.prompt，也没有构建、安装或重启。当前管理服务创建 Bot 时可能把模板复制进持久配置；部署新版模板不等于已有 Bot 已更新。完整提示词的运行时组合、已有配置迁移与用户自定义内容保留，由另一个讨论对话继续明确。

提示词没有把尚未实现的自有 Skill 修订/登记、任务边界刷新、公共库贡献和维护唤醒说成已具备能力。当前缺少相应接口时记录具体建议，并如实说明是否生效。

## 另一个对话的讨论范围

对话：**讨论 Relay Bot 提示词与运行时统一**，GPT-6.1-Sol，max，线程 `01a181e6-ce50-7962-8993-8df50e97dec0`。

先讨论公共规则与个体职责的组合、P2P/聊天室交接与回流、记忆分层与按需加载、已有 Bot 配置迁移、资源刷新和持续维护的最小持久机制。讨论阶段不修改代码或生产配置，不部署。

研究材料：[调查总结](research/bot-system-prompts-2026-10-28/README.md)、[完整推荐稿](research/bot-system-prompts-2026-10-28/RELAY-RECOMMENDED.md)、[基础 Bot 设计](BOT_FOUNDATION_DESIGN.md)。
