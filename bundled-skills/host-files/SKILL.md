---
name: host-files
description: 读写全团队共享知识库（knowledge）、跨群只读检索、授权工作区文件、Bot 独立文件夹、用户画像与平台能力文档
owner_bot: null
env_slots: []
---

# 文件空间、共享知识库与能力目录（host-files）

## 怎么用
- **Summon Bot**：
  - **共享知识库（全团队单一事实源）**：`find({ kind: "knowledge", query? })`、`read({ ref: { kind: "knowledge", id: "<path>" } })`、`save_file({ space: { kind: "knowledge", id: "shared" }, path: "<topic>.md", content_or_source: "..." })`——服务器基线、网络拓扑、运维手册与重要沉淀结论统一写这里，所有群与所有 Bot 共用一份（禁存密钥）。
  - **跨群只读检索**：`find({ kind: "room" })`、`find({ kind: "event", query })`（省略 `scope`）、`find({ kind: "session", query })` 支持跨所有普通群只读查历史结论与执行回执（发言权与唤醒仍按群成员隔离，私聊保持隔离）。
  - **能力文档**：`find({ kind: "capability" })`、`read({ ref: { kind: "capability", id } })`，新增或更新自定义能力用 `save_file({ space: { kind: "capability", id }, path: "SKILL.md", content_or_source: "..." })`。
  - **自身空间与用户画像**：`read` / `save_file` 读写自身目录（`instructions.md`、`skills/`、`scripts/`、`.local/memory/`）及跨群用户画像（`{ kind: "user", id: "user" }, path: "host-profile.md"`）。
  - **工作区文件**：`find({ kind: "workspace" })` 后读写对应工作区，或直接传合法本机绝对目录路径给 `open_session`。
- **工作引擎**：直接在当前工作区目录读写项目文件；读取平台能力文档访问 `$SUMMON_CAPABILITIES_DIR/<id>/SKILL.md`，读取团队共享知识库访问 `$SUMMON_KNOWLEDGE_DIR/<path>`。

## 当前边界
- 平台受保护目录（`config/` 等内部状态与凭据目录）不可作为工作区或脚本执行目录，不可写入密钥或篡改运行时内部文件。
