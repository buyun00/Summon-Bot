---
name: host-files
description: 读写授权工作区文件、Bot 独立文件夹、跨群宿主画像与平台能力文档
owner_bot: null
env_slots: []
---

# 文件空间与能力目录（host-files）

## 怎么用
- **Summon Bot**：
  - 查能力与文档：`find({ kind: "capability" })`、`read({ ref: { kind: "capability", id } })`，新增或更新自定义能力说明用 `save_file({ space: { kind: "capability", id }, path: "SKILL.md", content_or_source: "..." })`。
  - 自身空间：`read` / `save_file` 读写自身目录（`instructions.md`、`skills/`、`scripts/`、`.local/memory/`）。
  - 共享宿主画像：`read` / `save_file` 操作 `{ kind: "user", id: "user" }, path: "host-profile.md"`（仅存简洁偏好与背景，禁存密钥）。
  - 工作区文件：`find({ kind: "workspace" })` 后读写对应工作区，或直接传合法本机绝对目录路径给 `open_session`。
- **工作引擎**：直接在当前工作区目录读写项目文件；读取本机平台能力说明直接访问 `$SUMMON_CAPABILITIES_DIR/<id>/SKILL.md`。

## 当前边界
- 平台受保护目录（`config/` 等内部状态与凭据目录）不可作为工作区或脚本执行目录，不可写入密钥或篡改运行时内部文件。
