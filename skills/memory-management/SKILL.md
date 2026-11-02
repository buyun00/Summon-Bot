---
name: memory-management
description: 按范围维护有来源的 Markdown 知识和可复用方法
---

S1 原始消息、工具结果与事件保留，S2 正文只在有大小约束的 Markdown 中，S3 保存工作目标、要求、进度和等待。不要复制一套 SQL 总结正文或永久上下文包。

使用 knowledge_list 查目录，knowledge_read 读取相关范围，必要时回到 read_session_history 或实际来源。knowledge_write 合并当前适用内容，简明保存来源、未确认和失效说明。用户明确纠正优先于旧推测；来源冲突不能靠投票消除。

运行时按实际增量自动调度新的短暂整理对话，保存成功后前移处理游标；失败保留旧文档与增量。每次压缩、整理和组装各自独立，不是一次固定三步，也不长期复用一个维护上下文。组装结果只用于当前输入。

先查 skills_list 并用 read_resource 读取已有方法，能修正原 Skill 就不新增。skill_write 保存本 Bot 可维护的可复用步骤、工具入口、真实失败条件与来源。公共方法由承担该职责的普通同伴维护。只贡献适合共享的最少信息，私密凭据沿既有安全配置，不能放入 MD 或 Skill。
