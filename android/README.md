# Summon Bot Android

与 `ios/` 同层的原生 Android 客户端。界面、接口和交互与 iOS 客户端一致：会话、聊天、附件、Bot 资料、长期记忆、工作委托、知识、定时职责和事件投递。服务端仍是现有 Summon Bot API，默认地址 `https://bot.lin0.org`。

正式 APK 在仓库根目录打包和发布：

```sh
npm run release:android -- --publish
```

版本统一读取根目录 `release.json`，固定签名保存在正式主机的数据目录，安装包发布到 `D:/Relay-Bot-data/client-releases/android/universal`。应用前台检查新版，设置中可下载 APK 并交给系统确认安装。完整发布流程见 [客户端发行与更新](../docs/CLIENT_RELEASES.md)。

访问令牌保存在加密存储中。HTTP 只接受 `localhost`、无点主机名和 `.local`，与 iOS 的本地网络例外一致。

工作台菜单的“Token 统计”同步提供日期筛选、Bot/单聊/群聊排行、来源/模型/每日汇总、逐次调用及供应商截图用量对照。截图总量与本机留存明细分开显示，缺失数据不分摊到 Bot，也不用于推算全天缓存命中率。
