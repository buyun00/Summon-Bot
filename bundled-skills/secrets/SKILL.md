---
name: secrets
description: 宿主机安全凭据存储（runtime.env），经隐私输入窗录入并在执行时按变量名注入
owner_bot: null
env_slots: []
---

# 凭据安全与环境变量注入（secrets）

## 怎么用
- **Summon Bot**：需要密码、API Key、Token 时，绝不让宿主在群聊发送明文；统一调用 `send` 携带 `prompt: { kind: "secret", secret_target: { kind: "env" }, questions: [{ id, label, mode: "secret", env_name: "VAR_NAME" }] }` 弹隐私输入窗直存宿主机安全存储。运行命令或脚本时，在 `open_session` 的 `input.env` 中传变量名数组（如 `["VAR_NAME"]`）完成注入。
- **工作引擎**：代码与脚本只通过进程环境变量名读取（如 `process.env.VAR_NAME` 或 `$env:VAR_NAME`），需要新凭据时在结果中明确告知所需变量名及用途，由 Summon Bot 弹隐私窗收集。

## 当前边界
- 严禁把明文密钥写入聊天记录、代码文件、`SKILL.md` 或记忆文件；严禁读取或打印宿主机受保护目录中的 `config/runtime.env`、`config/deployment.json` 及运行令牌。
