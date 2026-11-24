# Summon Bot iOS

主仓库根目录的原生 iOS 客户端，使用 Swift 6、SwiftUI 和 iOS 26 的系统 Liquid Glass 控件。工程不依赖跨平台框架、CocoaPods 或 XcodeGen；iPhone 与 iPad 共用 `SummonBot` target。

## 在 Mac 上运行

1. 安装 Xcode 26 或更新版本及 iOS 26 SDK，clone 本仓库。
2. 打开 `ios/Summon.xcodeproj`，选择 `SummonBot` scheme 和 iOS 26 模拟器或 iPhone。
3. 真机运行时，在 target 的 **Signing & Capabilities** 中选择自己的 Team；使用 `org.lin0.summon` Bundle Identifier，Team 为 `6Y29E7PSVF`，并在 iPhone 开启开发者模式。
4. 点击 Run。首次启动时填写部署机的服务地址与访问令牌。正式入口为 `https://bot.lin0.org`。

应用连接既有 Summon Bot API，Bot、模型凭据和服务端能力仍在服务器上运行，手机只负责原生交互。无需在 Mac 上启动 Node 服务即可连接已部署的服务器；需要自行部署时参考仓库根目录说明。

## 原生界面

- 群聊和私聊支持文本、@ 成员、回复、置顶、文件与资料引用。成员、群名和置顶使用统一的 Room 修订。
- 会话资料支持查看、修订、下载与分享。文件和照片先保存在本机草稿，每个附件最多 20 MB，每条消息最多 8 个附件。
- 支持 Bot 头像、行为指令、默认模型、资源授权和启停，以及群基础关注、事件订阅和提醒。
- 支持读取执行会话与内部对话，按服务返回的目标提交输入、查看实际输出、请求停止或恢复。
- 连接和用量设置包括模型连接、执行目录和宿主额度，并保留 Token 统计。
- 协议升级和服务维护期间保留草稿、附件和未确认发送。重试先用原 clientId 查询保存状态。

导航、菜单、按钮、表单、弹层和文件选择使用系统原生组件，自定义搜索及输入区域使用 SwiftUI Liquid Glass API。服务端记录保持为数据来源，后台不保持长连接；新消息通过 APNs 生产环境推送，授权与登记状态见连接设置。

## 连接与本地开发

优先使用有效证书的 HTTPS 地址。工程保留 ATS 保护，只启用 `NSAllowsLocalNetworking`，供本地开发时使用不带点的主机名或 `.local` 名称；未全局放开任意 HTTP，也未预设任意局域网 IP 的 HTTP 例外。连接本地服务时，iPhone 与服务主机需处在可互通的网络，且服务必须允许外部连接；不要将 Mac 的 `localhost` 当成 iPhone 可访问的服务地址。

访问令牌存入系统 Keychain。服务地址保存在本机设置中，不要把模型密钥填入手机应用。

## 工程说明

版本统一由根目录 `release.json` 管理。已配置 GitHub Actions 签名上传与 TestFlight 内部组分发代码，启用步骤见 [完整教程](../docs/IOS_TESTFLIGHT.zh-CN.md)。应用更新由 TestFlight 完成。手动归档命令 `npm run release:ios` 继续保留，需要导出 IPA 时传入本机 `--export-options` 文件。各端云端发布见 [客户端发行与更新](../docs/CLIENT_RELEASES.zh-CN.md)。

`Summon/` 是 Xcode 自动同步目录，新增 Swift 文件会自动进入 target；`Info.plist` 已从资源 membership 排除。未添加测试 target 或第三方包。

`Assets.xcassets/AppIcon.appiconset` 已配置用户提供的蓝色层叠云朵图标，使用完整、不透明的 1024 像素 PNG；应用内 `SummonIcon.imageset` 与网页 共用同一原图。系统负责应用图标的圆角裁切。

签名和真实发布状态以 GitHub Actions 与本应用 TestFlight 的准确版本、构建号为准。
