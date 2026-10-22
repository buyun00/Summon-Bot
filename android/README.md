# Relay Android

与 `ios/` 同层的原生 Android 客户端。界面、接口和交互与 iOS 客户端一致：会话、聊天、附件、Bot 资料、长期记忆、工作委托、知识、定时职责和事件投递。服务端仍是现有 Relay API，默认地址 `https://bot.lin0.org`。

用 Android Studio 打开本目录，或在本目录执行：

```sh
./gradlew assembleDebug
```

调试 APK 位于 `app/build/outputs/apk/debug/app-debug.apk`。访问令牌保存在加密存储中。HTTP 只接受 `localhost`、无点主机名和 `.local`，与 iOS 的本地网络例外一致。
