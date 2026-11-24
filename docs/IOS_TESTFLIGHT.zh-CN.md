[English](IOS_TESTFLIGHT.md) | [简体中文](IOS_TESTFLIGHT.zh-CN.md)

# Summon Bot：iOS 自动打包、TestFlight 与消息推送操作教程

Windows 负责准备源码与配置，GitHub Actions 的 macOS runner 负责 Xcode 编译、签名归档、上传与分发，iPhone / iPad 通过 TestFlight 内部测试安装与更新。不设模拟器、UI 或核心自动测试发布门槛。

## 1. 本应用固定标识

| 字段 | 值 |
| --- | --- |
| 应用显示名称 | `Summon Bot` |
| Apple Team ID | `6Y29E7PSVF` |
| Bundle ID / 套装 ID | `org.lin0.summon` |
| App ID 描述 | `Summon Bot` |
| SKU | `summon-bot-ios` |
| 平台 / 主要语言 | iOS / 简体中文 |
| 启用能力 | Push Notifications |
| 描述文件名称 | `Summon App Store` |
| 描述文件类型 | App Store Connect（部分界面显示 App Store） |
| 内部测试组 | 在 **Summon Bot 应用内**创建 `Personal` |
| 工程 / Scheme | `ios/Summon.xcodeproj` / `SummonBot` |
| 最低系统要求 | iOS / iPadOS 26 |

> 注意：请严格使用 `org.lin0.summon`，不要混用历史 `org.lin0.relay` 或其他应用的 Bundle ID、Widget 标识与 App Group。桌面端和 Android 沿用各自既有签名身份。

## 2. 凭据与材料分工（新建 vs 复用）

| 材料 | 处理方式 |
| --- | --- |
| App ID | 注册 `org.lin0.summon` 并启用 Push Notifications |
| Apple Distribution 证书及私钥 | 复用团队现有证书材料（与本机 `.p12` 对应） |
| App Store 描述文件 | 为 `org.lin0.summon` 单独生成，包含推送能力并绑定上述分发证书 |
| App Store Connect 应用记录 | 独立创建 `Summon Bot` 应用记录 |
| App Store Connect API Key | 复用已有团队上传 API Key，确保具备访问 `Summon Bot` 的权限 |
| APNs 推送密钥（`.p8`） | 与 ASC API Key 独立，须允许 Production 环境，仅部署在正式后端 |
| 内部测试组 | 在 `Summon Bot` 应用内独立创建 `Personal` 组 |

仅使用 APNs Token（`.p8`）认证，无需创建 APNs SSL 证书，无需登记设备 UDID，TestFlight 安装也不要求开启开发者模式。

## 3. 注册 App ID 并启用推送

1. 登录 [Apple Developer](https://developer.apple.com/account/)，确认右上角团队为 `6Y29E7PSVF`。
2. 进入「证书、标识符和描述文件 / Certificates, Identifiers & Profiles」→ 左侧「标识符 / Identifiers」→ 点击「＋」。
3. 选择 **App IDs** → Continue → **App** → Continue。
4. Description 填写 `Summon Bot`；Bundle ID 选择 **Explicit** 并填写 `org.lin0.summon`。
5. 在 Capabilities 中勾选 **Push Notifications**（本项目不使用 HealthKit、iCloud、App Groups 或 Sign in with Apple，无需勾选）。
6. 核对并点击「注册 / Register」；随后重新打开确认推送能力已启用（无需创建 SSL Certificate）。

参考：[Apple：注册 App ID](https://developer.apple.com/help/account/identifiers/register-an-app-id/)。

## 4. 创建 App Store Connect 应用记录

1. 打开 [App Store Connect](https://appstoreconnect.apple.com/) →「App」→「＋」→「新建 App」。
2. 平台选 **iOS**，名称填 **Summon Bot**，主要语言选 **简体中文**，套装 ID 选 **org.lin0.summon**，SKU 填 **summon-bot-ios**。
3. 用户访问权限选「完全访问权限」，确保团队 API 凭据与内部测试员均可访问，点击「创建」。
4. 仅用于 TestFlight 内部测试，无需提交 App Store 正式审核、商店截图或外部 Beta 审核。

参考：[Apple 中文：添加新 App](https://developer.apple.com/cn/help/app-store-connect/create-an-app-record/add-a-new-app/)。

## 5. 生成 App Store 描述文件

**请先完成第 3 节启用 Push Notifications，再生成描述文件。**

1. 回到 Developer →「Profiles / 描述文件」→「＋」。
2. Distribution 下选择 **App Store Connect**（或 App Store），不要选 Development、Ad Hoc 或 Developer ID。
3. App ID 选择 `Summon Bot / org.lin0.summon`，证书选择团队现有 **Apple Distribution** 证书。
4. 描述文件名称填 **Summon App Store** → Generate → Download。
5. 将下载的 `.mobileprovision` 保存至本机私有目录：
   `C:\Users\win11\.codex\private\summon-ios-signing\app.mobileprovision`

后续若调整应用 Capabilities，需重新生成描述文件并更新 GitHub Secret。参考：[Apple：创建 App Store 描述文件](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile)。

## 6. 创建并配置 APNs 生产推送密钥

1. Developer →「Keys / 密钥」→「＋」，Key Name 填 **Summon APNs Production**。
2. 勾选 **Apple Push Notifications service (APNs)** 并点击 Configure（如显示），环境必须允许 **Production**（TestFlight 使用生产 APNs，而非 Sandbox）。
3. 注册并下载 `.p8` 私钥（通常仅可下载一次），保存为 `C:\Users\win11\.codex\private\summon-ios-signing\apns.p8`，并将页面上的 Key ID 单独写入同目录 `apns-key-id.txt`。

> **切勿混用**：不要把 App Store Connect 上传用的 AuthKey `.p8` 当作 APNs 私钥。APNs 私钥仅留在正式后端，绝不上传 GitHub 或打入手机包。

材料就位后运行配置脚本写入正式数据根 `config/apns.json` 与 `config/apns.p8`（随后通过正式安装部署并重启网关生效）：

```powershell
$apnsKeyId = (Get-Content "$env:USERPROFILE/.codex/private/summon-ios-signing/apns-key-id.txt" -Raw).Trim()
node scripts/ios/configure-apns.mjs "$env:USERPROFILE/.codex/private/summon-ios-signing/apns.p8" $apnsKeyId
```

参考：[Apple：创建服务私钥](https://developer.apple.com/help/account/keys/create-a-private-key/)、[APNs Token 认证](https://developer.apple.com/documentation/UserNotifications/establishing-a-token-based-connection-to-apns)。

## 7. 核对 App Store Connect API Key 与内部测试组

1. 在 App Store Connect →「用户和访问」→「集成」→「App Store Connect API」中核对现有团队上传 API Key 具备上传构建、访问 `Summon Bot` 与管理内部测试的权限（App Manager / Admin），并将 **Issuer ID** 保存至 `C:\Users\win11\.codex\private\summon-ios-signing\asc-issuer-id.txt`。
2. 在 App Store Connect →「App」→ **Summon Bot** → **TestFlight** 中新建内部测试组 **Personal**，添加需要接收测试版本的 App Store Connect 团队用户（支持开启或关闭自动分发）。

参考：[Apple：添加内部测试员](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)。

## 8. 同步 GitHub 配置并启动发布

材料齐全后在仓库根目录运行（依赖本机 `gh` 登录、Python、`cryptography` 与 `PyJWT`；若存在多份 API Key 可用 `-ApiKeyFile` 指定）：

```powershell
pwsh -NoProfile -File scripts/ios/configure-github.ps1
gh workflow run ios-testflight.yml --repo buyun00/Summon-Bot --ref main -f action=release
```

| GitHub 配置项 | 用途 |
| --- | --- |
| Secret `SUMMON_IOS_DISTRIBUTION_P12_BASE64` | 团队分发证书及私钥 |
| Secret `SUMMON_IOS_DISTRIBUTION_P12_PASSWORD` | 分发证书导出密码 |
| Secret `SUMMON_IOS_APP_PROFILE_BASE64` | `org.lin0.summon` 的 App Store 描述文件 |
| Secrets `SUMMON_ASC_KEY_ID`、`SUMMON_ASC_ISSUER_ID`、`SUMMON_ASC_PRIVATE_KEY` | App Store Connect 上传与分发凭据 |
| Variable `SUMMON_APPLE_TEAM_ID` | `6Y29E7PSVF` |
| Variable `SUMMON_TESTFLIGHT_GROUP` | `Personal` |
| Variable `SUMMON_IOS_RELEASE_ENABLED` | 材料齐全后设为 `true` |

- `SUMMON_IOS_RELEASE_ENABLED=true` 后，推送 `main` 上的 `release.json` 变更会自动触发发布；也可手动运行 `action=compile` 仅做无签名编译验证。
- CI 构建号格式为 `<buildNumber>.<GITHUB_RUN_NUMBER>.<GITHUB_RUN_ATTEMPT>`（例如 `172.12.1`），始终以 Actions 汇总中的实际版本与完整构建号为准。
- 工作流依次执行：配置校验 → Xcode 归档 → 签名导出 → API 上传 → 等待 Apple 处理 → 核对准确版本/构建号 → 关联内部组 → 回读 `IN_BETA_TESTING` 状态。
- 若超过 30 分钟 Apple 仍在处理，可用汇总记录的版本与完整构建号续接分发：

```powershell
gh workflow run ios-testflight.yml --repo buyun00/Summon-Bot --ref main -f action=resume -f version=VERSION -f build_number=APPLE_BUILD
```

## 9. 在 iPhone 上安装与确认推送

1. 确保 iPhone 为 iOS 26 或更新版本并安装 **TestFlight**，使用内部测试员对应 Apple 账户接受邀请。
2. 在 TestFlight 中确认 **Summon Bot** 的版本与完整构建号与 Actions 汇总一致后安装。
3. 打开应用填写正式地址（`https://bot.lin0.org`）与访问令牌，在系统提示通知权限时点击「允许」，确认应用「设置 → 消息通知」显示「已启用新消息推送」。
4. 通知默认隐藏敏感正文（仅显示“Bot 发来一条新消息”，进入应用后从服务端加载），只推送用户参与会话中的 Bot 回复；后台不保活 SSE，不依赖应用常驻后台。

## 10. 常见问题排查

| 现象 | 排查方式 |
| --- | --- |
| 新建 App 找不到 Bundle ID | 核对团队是否为 `6Y29E7PSVF` 且 `org.lin0.summon` 已注册 |
| 描述文件缺少 `aps-environment` | 为 App ID 勾选 Push Notifications 后重新生成描述文件并更新 Secret |
| 证书与描述文件不匹配 | 确认描述文件绑定的是本机现有 Apple Distribution 证书 |
| Actions release job 被跳过 | 检查仓库 Variable `SUMMON_IOS_RELEASE_ENABLED` 是否为 `true` |
| ASC API 返回 401 / 403 | 核对 Key ID、Issuer ID、权限与是否误用了 APNs `.p8` |
| TestFlight 看不到新版本 | 核对 `Summon Bot` 下的 `Personal` 组、测试员邀请与完整构建号关联 |
| iPhone 提示系统不兼容 | 本工程最低要求 iOS / iPadOS 26 |
| 服务端显示推送待配置 / APNs 403 | 确认已执行 `configure-apns.mjs` 并重启正式网关，核对 Production 环境、Team ID、topic 授权与主机时钟 |

服务端 APNs 推送队列持久化并对临时故障自动重试，失效设备令牌会自动清理，单条通知最长保留 24 小时。
