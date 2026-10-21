---
name: capability-management
description: 注册独立能力服务，发布不可变版本，协调 Bot 准备切换并排空旧版本
---

先调用 capabilities_list，核对当前激活版本、各 Bot 绑定、待切换状态、在途请求和未知结果。版本号必须唯一，不能在同一版本下覆盖文件。

独立服务已部署时，用 capabilities_register 提交 id、version、endpoint 和所需服务凭据。本机新代码用 capabilities_deploy，提供 id、version 和 packageRoot 或 releaseRoot 之一；packageRoot 必须包含 capability.json 与完整依赖，releaseRoot 必须是经过校验的完整发行物。默认部署后激活，设置 activate:false 可以只注册。不要用完整系统重启来替代能力发布。

注册不会授予权限。管理伙伴可以用 capabilities_grant 指定目标 botId 的完整工具白名单；先读取现有名单，再明确增加或删除所需项目，保留其他已授权工具。管理工具自身属于高权限能力，仅按用户授权委派。

capabilities_activate 发布后，新 Bot 使用新版。已有 Bot 完成当前任务、预加载并校验工具，再在 ready/commit 握手后切换；模型无需额外口头确认。不要中断任务或直接修改运行中 Bot 的 config.json。切换未完成时报告实际 preparing/committing/failed/blocked 状态。

capabilities_unload 停止新绑定，并通知旧 Bot 移除工具。capabilities_retire 仅在无绑定、未确认切换、在途请求、未知结果和后台工作时关闭受管版本。外部服务只撤下路由，仍由其部署者关闭。保留仍被运行版本或任务引用的代码和数据。

准备失败先查原因，修复后用 capabilities_retry；数据 stateVersion 不兼容需要单独迁移，不能强行热切换。网络断线后的未知调用不能重放或推定成功。实际核对证据后，管理伙伴用 capabilities_reconcile 提交 requestId、outcome 和 evidence；没有证据就保留未知状态。
