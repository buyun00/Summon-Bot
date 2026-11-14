---
name: memory-management
description: 选择、维护和共享普通记忆资料
---

通过 save_file 保存普通笔记、知识或 Skill。用 configure_bot 的 material_index_ref 登记明确选择的索引 File。索引 JSON 的 items 可含 id、revision、note 或 material_ref、material_revision、source_refs、applies_to、selected 和 target_ref。技能用 skill 的 name、description 和 ref 指向其正文。需要引用共享索引时使用 shared_indexes。修改已有条目时递增该条目的 revision，修改文件时使用实际文件修订。处理位置使用 find(kind=material_consumption) 查看。
