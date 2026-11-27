---
name: self-update
description: 通过官方 manage_update 接口安全检查、下载并无人值守更新本机 Summon Bot（支持 Windows 与 macOS）
owner_bot: null
env_slots: []
---

# 本机自更新能力（self-update）

## 怎么用
- 使用平台工具 `manage_update` 管理本机 Summon Bot 的版本检查、预下载与静默更新（底层自动脱离进程树、等待当前回合排空后静默覆盖安装并重启，重启后自动往本房间回传升级结果）：
  - `manage_update({ action: "status" })`：查看本机当前运行版本、构建号、已下载包与上一次自更新回执。
  - `manage_update({ action: "check", expected_commit? })`：查询本机发行目录与 GitHub Releases 最新发行包；自研提交推送后可传入 `expected_commit`（commit 前缀）确认新包是否已产出。
  - `manage_update({ action: "download", expected_commit?, source? })`：后台下载对应平台安装包并校验大小，不中断当前对话。
  - `manage_update({ action: "install", expected_commit?, source?, room?, force? })`：自动补下载（如尚未下载）、启动脱离进程树的独立更新器并立即返回 `{ scheduled: true }`。收到 `scheduled: true` 后，简短告知用户即将离线重启（约 20–30 秒后上线）并立刻结束本回合，让系统完成排空与安装。

## 授权规则
- 若用户已在群里明确要求更新本机（例如“有新版直接更新”“打包完自动把自己更新了”），检查/下载就绪后可直接调用 `manage_update({ action: "install" })`。
- 若用户未明确提出要立即更新（例如只是让你查版本、或者你主动发现有新版），先调用 `send` 附带 `prompt: { kind: "permission", ... }` 弹确认卡说明版本变化与短暂重启影响，获用户同意后再调用 `install`。

## 标准自研闭环
1. 代码修改完成并自检后，执行 `npm run release:version`、提交并推送到 `main`，触发 GitHub Actions 打包。
2. 等待构建时使用 `manage_update({ action: "check", expected_commit: "<sha>" })` 核对新包就绪状态（可配合 `set_wakeup` 提醒，不必死循环轮询）。
3. 确认新包就绪且符合上述授权规则后，调用 `manage_update({ action: "install", expected_commit: "<sha>" })`，向用户发出即将重启的简短提示后结束本回合；重启恢复后系统会自动往本房间回发升级结果。
