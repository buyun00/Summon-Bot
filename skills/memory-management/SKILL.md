---
name: memory-management
description: 来源可追溯的记忆整理与合并
---

通过 memory_propose 查看 deliveryId 的新增经验、父体基准和当前版本。相同事实去重，冲突保留双方来源；禁止用分身整份记忆覆盖母体。memory_merge 默认只合并可确定部分；冲突需显式 resolutions[id]={text:所选文字} 或 {action:reject}，说明来源和适用条件。代码与工作区文件的合并不属于记忆合并。
