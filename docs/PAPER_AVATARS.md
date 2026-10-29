# 纸片头像

正式网页/PWA、iOS 和 Android 的 Bot 头像使用 Bloub 动画引擎加 Relay 纸片拼贴材质。
提供 8 个几何造型、12 套纸色、衬纸、细纸纹和眼睛留白。用户上传的图片头像继续使用。
旧职业头像 ID 和旧默认颜色在展示与保存边界映射到新头像，不批量改写历史记录。

## 源码与构建

- `capabilities/shared/avatar-style.mjs`：跨端造型、预设色、旧值映射和规范化。
- `web/avatar-showcase/src/relay/rig.ts`：直接调用 Bloub 原引擎的运行状态适配。
- `web/avatar-showcase/src/relay/browser.ts`：正式网页 SVG 绘制与生命周期。
- `web/avatar-showcase/src/components/BloubBot.tsx`：原展示页，保留完整动画时间线。
- `scripts/build/export-paper.mjs`：生成正式网页入口和两端共用的矢量动作数据。
- iOS `PaperLibrary.swift` / Android `PaperAvatars.kt`：原生 Canvas 绘制共享动作数据。

在已安装展示页构建依赖后，使用 Node 24.21.0 或更新版本运行：

```powershell
node scripts/build/export-paper.mjs
```

生成的 `web/frontend/avatars.js` 和两端 `paper-avatars.json` 随源码交付。
原来的 `export-crew.mjs` 入口转交新导出器，避免再次生成职业符号头像。
网页运行原引擎；移动端读取同引擎导出的矢量几何和眼睛矩阵并插值，不使用逐帧图片或 WebView。
可见网页头像限制为 30 FPS，屏幕外与后台暂停。原生端响应应用生命周期与减少动态效果设置。

## 状态

空闲：原始眼神漂移与眨眼；思考/工作：专注表情；工作附带原引擎轨道。
等待：好奇；完成：眨眼后开心，网页工作结束后播放一次；失败：难过；暂停：困倦。
运行状态不改变 Bot 已选的造型和纸色。

演示页：https://bot.lin0.org/api/avatar-showcase/#etat=idle 。正式更新遵循 `OPERATIONS.md` 的现有构建、安装、启动流程。
包含新头像 ID 的管理服务升级还需要切换 `bot-management` 的活动能力版本；基础程序安装只注册新能力版本，保留此前活动路由。使用现有 `capabilities.mjs activate --id bot-management --version <buildId> --data-root D:/Relay-Bot-data` 激活已就绪的新版本。只更新网页外观时继续使用已支持纸片头像的管理服务即可。
保留 Bloub MIT 许可，来源及修改说明见 `web/avatar-showcase/README.md`。
