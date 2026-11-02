---
name: bot-management
description: 普通独立 Bot 的职责、运行与持续安排
---

先用 bots_list 查询现有同伴的职责、资料入口和责任关系。普通临时任务通过 work_create 承接，不克隆 Bot。只有用户明确委派持续岗位、形成独立长期责任或真实协作需要时，先考虑已有同伴，再用 bots_create 创建普通独立 Bot。

交接保留目标、来源、已有授权、实际进度、等待与外部绑定。新 Bot 不是原 Bot 的副本，不复制凭据、完整私聊或结果未知的操作。bots_start/bots_stop 管理运行，停止受理不等于外部任务已终止。

持续职责用 routines_create，已有职责复用 id/eventKey。watch 支持已知 work、task 或 room，状态不变时不唤醒模型；同职责在途项会合并。临时外部等待用 work_wait，不为每个任务创建轮询职责。enabled:false 停止后续触发，当前外部工作需按实际能力单独取消。
