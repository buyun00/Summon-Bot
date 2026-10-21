# Relay iOS

主仓库根目录的原生 iOS 客户端，使用 Swift 6、SwiftUI 和 iOS 26 的系统 Liquid Glass 控件。工程不依赖跨平台框架、CocoaPods 或 XcodeGen；iPhone 与 iPad 共用 `Relay` target。

## 在 Mac 上运行

1. 安装 Xcode 26 或更新版本及 iOS 26 SDK，clone 本仓库。
2. 打开 `ios/Relay.xcodeproj`，选择 `Relay` scheme 和 iOS 26 模拟器或 iPhone。
3. 真机运行时，在 target 的 **Signing & Capabilities** 中选择自己的 Team；如签名账户无法使用 `org.lin0.relay`，改成自己的唯一 Bundle Identifier，并在 iPhone 开启开发者模式。
4. 点击 Run。首次启动连接设置默认使用 `https://bot.lin0.org`，可在应用中修改服务地址并填写部署所用访问令牌。

应用连接既有 Relay API，Bot、模型凭据和服务端能力仍在服务器上运行，手机只负责原生交互。无需在 Mac 上启动 Node 服务即可连接已部署的服务器；需要自行部署时参考仓库根目录说明。

## 原生界面

- 深色会话列表、顶部群聊、Bot 之间的会话、底部搜索与工作台菜单。
- 私聊、群聊、深聊、指定消息对象、引用回复与实时消息；Bot 回复使用灰色气泡，保持原正文宽度。
- 等待回复时仅展示 Bot 动画头像与流光状态文字，按实际排队、分析、查资料、绘图或电脑操作切换提示；群聊分别展示各位忙碌的 Bot。
- 13 种 Bot 头像、11 色、相册头像、资料与长期记忆编辑。
- 文件和照片附件、图片预览、Quick Look、系统分享；每个附件最多 20 MB，每条消息最多 8 个附件。
- 工作委托及恢复、知识及有向关联、定时职责、人工事件投递。
- 本机聊天缓存、逐会话草稿、失败消息手动重试；回到前台时同步记录，当前会话独立接收实时更新并在断流时补读。

导航、菜单、按钮、表单、弹层和文件选择使用系统原生组件，自定义搜索及输入区域使用 SwiftUI Liquid Glass API。服务端记录保持为数据来源，后台不保持长连接，也未接入 APNs 离线推送。

## 连接与本地开发

优先使用有效证书的 HTTPS 地址。工程保留 ATS 保护，只启用 `NSAllowsLocalNetworking`，供本地开发时使用不带点的主机名或 `.local` 名称；未全局放开任意 HTTP，也未预设任意局域网 IP 的 HTTP 例外。连接本地服务时，iPhone 与服务主机需处在可互通的网络，且服务必须允许外部连接；不要将 Mac 的 `localhost` 当成 iPhone 可访问的服务地址。

访问令牌存入系统 Keychain。服务地址保存在本机设置中，不要把模型密钥填入手机应用。

## 工程说明

`Relay/` 是 Xcode 自动同步目录，新增 Swift 文件会自动进入 target；`Info.plist` 已从资源 membership 排除。未添加测试 target 或第三方包。

`Assets.xcassets/RelayIcon.imageset` 原样保留 Web 的 512 像素品牌图。当前未配置最终 AppIcon，发布前需要在 Xcode 中添加符合要求的正式应用图标。

本次在 Windows 上编写工程，未执行 Xcode 构建、模拟器运行或真机安装。
