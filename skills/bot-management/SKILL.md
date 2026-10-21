---
name: bot-management
description: 外部创建、复制与回收
---

通过 bots_list 查询现有实例。创建分身使用 bots_clone，指定稳定 requestId、parentId、任务与继承范围；重试沿用 requestId。分身是新身份，不能复制或重放母体在途动作。完成后 bots_deliver 持久交付结果，再用 bots_recycle 回收；已交付不等于记忆已合并，未合并数据与产物不能删除。
