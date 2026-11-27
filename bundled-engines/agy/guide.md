# Antigravity (AGY) 工作引擎维护指南

- 命令名：`agy`（Windows 下常见路径为 `%LOCALAPPDATA%\agy\bin\agy.exe` 或 `%LOCALAPPDATA%\Microsoft\WinGet\Links\agy.exe`；macOS/Linux 常见 `~/.local/bin/agy` 或 `/usr/local/bin/agy`）。
- 桥接脚本：`bridge.mjs` 使用 `agy --input-format stream-json --output-format stream-json --dangerously-skip-permissions --disable-slash-commands` 以 NDJSON 双向流驱动任务，默认读取「设置 → 模型」中配置的 `standard` 档位（自动将基础模型名与思考深度拼为对应 CLI 模型 ID，兜底 `gemini-4-hydrogen-high`），支持实时工具进度上报、排队追加 `steer` 与 `--conversation` 会话续跑。
- 额度读取：`quota.mjs` 读取本机 `antigravity-usage-monitor` 插件同步的 `cli-status-snapshot.json` 快照，实时上报各配额池的 5 小时与每周剩余比例及重置时间。
- 模型分档（均可在设置页通过「AI 自动填写」按 `agy models` 最新目录自动更新）：
  - `standard`（默认）：`gemini-4-hydrogen`（`high`），常规现场摸底、排障、脚本与中等修改；
  - `deep`：`gemini-4-neon`（`xhigh`），复杂多文件工程、架构设计与疑难根因攻关；
  - `fast`：`gemini-3.8-flash`（`low`），轻量速查与简单整理。
- 效率约定：派给 AGY 的只读摸底/排障任务尽量将同端检查合并成少量复合脚本，快速收口输出实测结论与盲区，避免逐文件地毯式慢扫。
- 自检与自愈：
  1. 用 `open_session({ engine: "exec", input: { shell: "agy --version; agy models" } })` 检查本机安装、登录状态与可用模型清单；
  2. 再用 `open_session({ engine: "agy", workspace: "ws-summon-home", work_summary: "验证 AGY 桥接连通性", input: { text: "只回复 OK，不修改任何文件。", tier: "fast" } })` 端到端验证；
  3. 若报 `authentication required`，提示用户在终端执行一次交互式 `agy` 完成账号登录；
  4. 若上游 `agy` 参数或 `stream-json` 协议变更，直接通过 `read` / `save_file`（`{ kind: "engine", id: "agy" }`）更新 `bridge.mjs` 与本指南。
- 上游文档：`https://antigravity.google/docs/cli/headless`
