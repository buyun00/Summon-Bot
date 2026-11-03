---
name: bot-management
description: 普通独立 Bot 的职责、运行与持续安排
---

先用 bots_list 查询现有同伴的职责、资料入口、生命周期和责任关系。普通临时任务通过 work_create 承接，不克隆 Bot。群聊项目需要独立成员时，通过 chatroom_team_raise 联系本群 EggBot，先复用已有同伴，再由 chatroom_team_manage 创建临时成员。形成持续维护责任后判断是否升级常驻。已授权的普通独立身份仍可通过 bots_create 创建。

主控接住目标，EggBot 管成员，专业成员独立判断。每个工作 Bot 都从自己的职责关注协作是否失效；有依据的范围、依赖、时间或能力缺口在原群讨论，不等用户纠正。具体工具和交接方式参见 eggbot Skill 或当前 chatroom_team_* 声明。

交接保留目标、来源、已有授权、实际进度、等待与外部绑定。新 Bot 不是原 Bot 的副本，不复制凭据、完整私聊或结果未知的操作。bots_start/bots_stop 管理运行，停止受理不等于外部任务已终止。

持续职责用 routines_create，已有职责复用 id/eventKey。watch 支持已知 work、task 或 room，状态不变时不唤醒模型；同职责在途项会合并。临时外部等待用 work_wait，不为每个任务创建轮询职责。enabled:false 停止后续触发，当前外部工作需按实际能力单独取消。
