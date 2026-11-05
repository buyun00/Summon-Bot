# Summon Bot：iOS 自动打包、TestFlight 与消息推送操作教程

适用日期：2026-11-05。Windows 负责准备源码与配置，GitHub Actions 的 macOS runner 负责 Xcode 编译、签名归档、上传。手机通过 TestFlight 安装。没有模拟器、UI 或核心自动测试发布门槛。

## 1. 本应用固定填写内容

| 字段 | 值 |
| --- | --- |
| 应用显示名称 | `Summon Bot` |
| Apple Team ID | `6Y29E7PSVF` |
| Bundle ID / 套装 ID | `org.lin0.summon` |
| App ID 描述 | `Summon Bot` |
| SKU | `summon-bot-ios` |
| 平台 / 主要语言 | iOS / 简体中文 |
| 能力 | Push Notifications |
| 描述文件名称 | `Summon App Store` |
| 描述文件类型 | App Store Connect（有些界面显示 App Store） |
| 内部测试组 | 在 **Summon Bot 应用内**创建 `Personal` |
| 工程 / Scheme | `ios/Summon.xcodeproj` / `SummonBot` |
| 最低系统 | iOS / iPadOS 26 |

本次已按要求改用 Summon 标识。不要使用 `org.lin0.relay`、Lin Gym 的 Bundle ID、Widget 标识或 App Group。既有桌面和 Android 签名身份不在本次 iOS 更名范围内。

## 2. 哪些新建，哪些复用

| 材料 | 操作 |
| --- | --- |
| App ID | 新建 `org.lin0.summon`；如已有相同标识则核对并启用推送 |
| Apple Distribution 证书及私钥 | 复用团队现有材料，已在本机确认团队匹配、私钥存在、有效至 2027-11-05 |
| App Store 描述文件 | 必须为 Summon 新建，包含推送能力并选择上述证书 |
| App Store Connect 应用记录 | 新建 Summon Bot；应用记录不能从另一应用复制 |
| App Store Connect API Key | 复用已有私钥，核对新应用访问权限；不重新下载已下载过的私钥 |
| APNs 密钥 | 与上传 API Key 不同；指定私有目录未发现，需创建或提供已有且授权本应用的 APNs 密钥 |
| 内部测试组 | 本应用独立建立；可以同名，但不能使用 Lin Gym 的组 ID |

仅使用 APNs token 认证，不需要另外创建 APNs SSL 推送证书，也不需要登记 iPhone UDID。TestFlight 安装不要求开启开发者模式。

## 3. 注册应用标识符并启用推送

1. 打开 [Apple Developer 账户](https://developer.apple.com/account/)，确认团队是 `6Y29E7PSVF`。
2. 进入「证书、标识符和描述文件 / Certificates, Identifiers & Profiles」。部分开发者页面仍使用英文，以下同时列出对应名称。
3. 左侧「标识符 / Identifiers」→ 右侧「＋」。
4. 选择 **App IDs** →「继续 / Continue」→ **App** → 继续。
5. Description 填 `Summon Bot`；Bundle ID 选择 **Explicit**，填写 `org.lin0.summon`。
6. 在 Capabilities 中勾选 **Push Notifications**。本项目不使用 HealthKit、iCloud、App Groups 或 Sign in with Apple，不需要勾选它们。
7. 继续 → 核对 →「注册 / Register」。
8. 再打开该标识，确认推送能力已启用。推送项里若出现创建 SSL Certificate 的按钮，可略过：本项目走 APNs `.p8` 密钥认证。

如果已误注册 `org.lin0.relay`，不要继续为它制作本次描述文件。新建 `org.lin0.summon`；不删除其他应用正在使用的标识。

参考：[Apple：注册 App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id/)。

## 4. 创建 App Store Connect 应用记录

1. 打开 [App Store Connect](https://appstoreconnect.apple.com/)，进入「App」。
2. 点击「＋」→「新建 App」。
3. 平台勾选 **iOS**；名称填 **Summon Bot**；主要语言选 **简体中文**。
4. 「套装 ID」选刚注册的 **org.lin0.summon**；SKU 填 **summon-bot-ios**。
5. 用户访问权限可选「完全访问权限」，让已有团队 API 凭据和内部测试用户能访问它。
6. 点击「创建」。如果名称被占用，先记录实际提示，再决定名称；不要改选另一应用的 Bundle ID。
7. 创建后可把页面里的数字 Apple ID 记下来；自动化按 Bundle ID 查找，不要求你手动填写该数字。

首次后台如提示尚未接受协议，应由账户持有人先处理实际提示。只做 TestFlight 内部测试，不需要先提交 App Store 正式审核、商店截图或外部 Beta 审核。

参考：[Apple 中文：添加新 App](https://developer.apple.com/cn/help/app-store-connect/create-an-app-record/add-a-new-app/)。

## 5. 新建本应用描述文件

**先完成第 3 节的 Push Notifications，再生成描述文件。**

1. 回到 Developer →「证书、标识符和描述文件」→「描述文件 / Profiles」→「＋」。
2. Distribution 下选择 **App Store Connect**（部分界面称 App Store）。不要选 Development、Ad Hoc 或 Developer ID。
3. App ID 选择 **Summon Bot / org.lin0.summon**。
4. 选择已有 **Apple Distribution** 证书。选择与本机现有 `.p12` 对应、有效至 2027-11-05 的证书；不新建一张缺少对应私钥的证书。
5. 描述文件名称填写 **Summon App Store** → Generate → Download。
6. 将下载文件保存为：`C:\Users\win11\.codex\private\summon-ios-signing\app.mobileprovision`。

文件可重命名，内部标识不会因此改变。配置脚本会核对团队、Bundle ID、生产推送、有效期及是否包含实际分发证书；CI 再用 macOS 解码后完成签名配置校验。不要使用 openGym 的 app 或 widget 描述文件。

以后修改本应用能力，需要重新生成并更新这个描述文件 Secret。

参考：[Apple：创建 App Store 描述文件](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile)。

## 6. 创建 APNs 推送密钥

1. Developer →「证书、标识符和描述文件」→「密钥 / Keys」→「＋」。
2. Key Name 可填 **Summon APNs Production**。
3. 勾选 **Apple Push Notifications service (APNs)**，点击 Configure（如显示）。
4. 环境必须允许 **Production**。TestFlight 使用生产 APNs，不是 Sandbox。若界面提供 **Topic Specific**，限定到 `org.lin0.summon`；若使用 **Team Scoped**，确认覆盖本团队该应用。不同密钥类型的选项可能不同，以实际后台可选项为准。
5. 继续 → 注册 → 下载 `.p8`。该私钥通常只能下载一次；不要撤销别的应用正在使用的密钥。
6. 将 APNs 私钥保存为 `C:\Users\win11\.codex\private\summon-ios-signing\apns.p8`；将页面上的 Key ID 保存到同目录 `apns-key-id.txt`，文件里只放该 ID。

**不要把 App Store Connect 的 AuthKey 私钥当作 APNs 私钥。** 二者即使都是 `.p8`，权限也不同。APNs 私钥只放后端，不上传 GitHub、不放手机包。

代码端配置命令（材料准备好后可交给 Codex 执行）：

```powershell
$apnsKeyId = (Get-Content "$env:USERPROFILE/.codex/private/summon-ios-signing/apns-key-id.txt" -Raw).Trim()
node scripts/ios/configure-apns.mjs "$env:USERPROFILE/.codex/private/summon-ios-signing/apns.p8" $apnsKeyId
```

脚本写入唯一正式数据根的 `config/apns.json`、`config/apns.p8`。通过现有正式安装流程部署并重启网关后生效，不启动另一套服务。配置文件只由本机服务账号和管理员读取；不粘贴其内容到聊天或日志。

参考：[Apple：创建服务私钥](https://developer.apple.com/help/account/keys/create-a-private-key/)、[APNs token 认证](https://developer.apple.com/documentation/UserNotifications/establishing-a-token-based-connection-to-apns)。

## 7. 核对现有 App Store Connect API Key

1. App Store Connect →「用户和访问」→「集成」→「App Store Connect API」。旧版布局可能直接显示「密钥」。
2. 使用已用于 openGym 的团队 API Key。不要生成新的私钥，也不要撤销原 Key。
3. 确认 Key 有上传构建、访问 Summon Bot、管理内部测试所需权限；现有 App Manager / Admin 角色可供此流程使用。应用若使用受限访问，需要给相应用户/凭据开通 Summon Bot 访问。
4. 页面有 **Issuer ID（颁发者 ID）**。目前指定私有目录未找到它的独立文件；若原值已存其他安全位置，可直接复用。否则将现有 Issuer ID 存到 `C:\Users\win11\.codex\private\summon-ios-signing\asc-issuer-id.txt`，仅写该值，不需要重新创建 Key。

现有 `.p8`、`.p12` 和 DPAPI 加密密码继续从 `C:\Users\win11\.codex\private\opengym-ios-signing` 读取；不会复制 Lin Gym 的个人连接配置。配置脚本验证 API 确实可访问 `org.lin0.summon` 及其内部组，实际上传与分发步骤再分别报告结果。

## 8. 建立本应用内部测试组

1. App Store Connect → App → **Summon Bot** → **TestFlight**。
2. 左侧「内部测试」旁「＋」→ 名称填 **Personal**。
3. 选择是否启用自动分发；两种方式脚本均支持。开启可让后续构建自动进入本组。
4. 进入该组 →「测试员」→「＋」，选择你自己的 App Store Connect 用户。
5. 若用户不存在，先在「用户和访问」添加有权限访问 Summon Bot 的团队用户并完成邀请，再加入该组。

即使 Lin Gym 已有名为 Personal 的组，Summon Bot 仍需自己的组。脚本先定位本应用，再按组名查找，不写死其他应用组 ID。内部测试员必须是有应用访问权限的 App Store Connect 用户。

参考：[Apple：添加内部测试员](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)。

## 9. 配置 GitHub 并启动发布

材料齐全后在本仓库运行（可由 Codex 代办）：

```powershell
pwsh -NoProfile -File scripts/ios/configure-github.ps1
gh workflow run ios-testflight.yml --repo buyun00/Summon-Bot --ref main -f action=release
```

需要本机已有 `gh` 登录、Python 及 `cryptography`、`PyJWT`；这台机器已发现这些 Python 依赖。脚本通过标准输入写 GitHub Secrets，不把私钥或密码放进命令行、输出或源码。

| GitHub 配置 | 用途 |
| --- | --- |
| Secret `SUMMON_IOS_DISTRIBUTION_P12_BASE64` | 已有分发证书及私钥 |
| Secret `SUMMON_IOS_DISTRIBUTION_P12_PASSWORD` | 从本机 DPAPI 解密的现有密码 |
| Secret `SUMMON_IOS_APP_PROFILE_BASE64` | 本应用新建描述文件 |
| Secrets `SUMMON_ASC_KEY_ID`、`SUMMON_ASC_ISSUER_ID`、`SUMMON_ASC_PRIVATE_KEY` | 现有上传凭据 |
| Variable `SUMMON_APPLE_TEAM_ID` | `6Y29E7PSVF` |
| Variable `SUMMON_TESTFLIGHT_GROUP` | `Personal` |
| Variable `SUMMON_IOS_RELEASE_ENABLED` | 材料确认后设为 `true` |

发布开关打开后，main 上的 iOS、发行版本或 iOS 工作流/脚本变更触发自动发布；也可以手动运行。准备材料期间开关保持关闭，避免重复失败上传。需要提前编译时可手动选择 `action=compile`，只做 iPhone SDK 无签名编译，不跑模拟器或测试、不上传。

版本名称来自 `release.json`；CI 构建号为 `buildNumber.GITHUB_RUN_NUMBER.GITHUB_RUN_ATTEMPT`。例如源码 buildNumber 为 21、工作流第 1 次运行第 1 次尝试，对应构建 `21.1.1`。以实际 Actions 汇总为准，不把源码的单独数字 21 当作 TestFlight 完整构建号。

工作流步骤依次为：配置校验 → Xcode iPhone 归档 → 签名导出 → API 上传 → Apple 处理 → 核对准确版本/构建号 → 加入或等待内部组 → 回读 `IN_BETA_TESTING` 和组关联。

上传成功只代表 Apple 接收；最后分发步骤成功才表示该准确构建已在内部组可用。等待 30 分钟仍未完成时会明确失败，不能自动声称发布成功，也不应立即重复上传；先在后台查看原构建。工作流不公开 IPA、archive 或签名材料。

## 10. 在 iPhone 安装并检查消息推送

1. iPhone 升级到 iOS 26 或更新版本，在 App Store 安装 **TestFlight**。
2. 用内部测试员对应 Apple 账户接受邀请。已安装 Lin Gym 不代表自动获得 Summon Bot 的测试权限。
3. TestFlight 中打开 **Summon Bot**，确认版本和完整构建号与 Actions 最后汇总相同，点击安装。
4. 打开应用，连接正式服务；系统询问通知权限时选「允许」。应用「设置 → 消息通知」应显示「已启用新消息推送」。若显示「服务端推送待配置」，需完成第 6 节并重启正式网关。
5. 在已有用户会话里发起一次你需要的 Bot 对话，返回桌面或锁屏等待回复。收到通知后点开，应进入对应会话。
6. 通知默认隐藏正文，显示“Bot 发来一条新消息”；正文进入应用后从服务读取。前台通知也可显示横幅。只推送用户参与的会话里的 Bot 消息，不推送用户自己发的消息或仅 Bot 间的私有会话。

纯通知横幅不需要 Background Modes / Remote notifications。后台不保活 SSE，也不依赖手机在后台运行才能收到 APNs 通知。系统专注模式、通知权限和网络状态仍会影响展示与时机。

## 11. 常见实际问题

| 现象 | 处理 |
| --- | --- |
| 新建 App 找不到 Bundle ID | 核对团队及 `org.lin0.summon` 是否注册成功，刷新后再选 |
| 描述文件缺少 aps-environment | 启用标识符的 Push Notifications，重新生成描述文件并更新 Secret |
| 证书与描述文件不匹配 | 用包含现有分发证书的本应用描述文件重新下载，不替换另一应用证书 |
| Actions 整个 release job skipped | `SUMMON_IOS_RELEASE_ENABLED` 尚未启用；材料齐后运行配置脚本 |
| API 401 / 403 | 检查现有 Key、Issuer ID、权限与撤销状态；不要将 APNs Key 用于上传 |
| Apple 仍在处理中 | 继续查看该准确构建状态；不要把上传受理当作可安装 |
| TestFlight 看不到应用 | 核对本应用 Personal 组、测试员、邀请及准确构建关联 |
| iPhone 提示不兼容 | 本工程最低系统是 iOS 26 |
| 通知关闭 | iPhone「设置 → 通知 → Summon Bot」允许通知，再回 App |
| 设备登记失败 | 确认正式后端已部署推送接口，且手机可访问服务 |
| APNs 持续 HTTP 403 | 核对推送 Key 的团队、生产环境、topic 授权和系统时间 |

服务端推送队列持久化并重试暂时失败，失效设备令牌会清理；单条通知最长保留 24 小时。APNs 接收不等于手机一定展示，最终以手机实际体验为准。

## 12. 你准备好后告诉 Codex 什么

只需说明「标识符、应用、描述文件、APNs 密钥和内部组已准备好」，以及保存文件的本机位置。不要粘贴私钥、密码或完整描述文件。Codex 可继续读取安全文件、配置本项目 GitHub Secrets、部署正式后端、启动真实签名发布，并跟进到准确构建在本应用 TestFlight 内部组可用。
