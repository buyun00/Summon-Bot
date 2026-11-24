[English](PAPER_AVATARS.md) | [简体中文](PAPER_AVATARS.zh-CN.md)

# Bloub 纸片几何头像

网页、Electron 桌面端、iOS 与 Android 四端的 Bot 头像统一采用 **Bloub 矢量动画引擎 + Summon Bot 纸片拼贴材质**。跨端共享同一套造型、配色、衬纸、细纸纹与眼睛留白规范，同时保留用户自定义上传的图片头像（PNG / JPEG / WebP）。

## 1. 造型与纸色规范

定义位于 `capabilities/shared/avatar-style.mjs`：

- **8 种几何造型**：`cercle`（圆形）、`galet`（卵石）、`squircle`（圆角方形）、`capsule`（胶囊）、`triangle`（三角形）、`hexagone`（六边形）、`nuage`（云朵）、`goutte`（水滴）。
- **12 套纸色预设**：`olive`（橄榄绿）、`sage`（鼠尾草）、`clay`（陶土红）、`apricot`（杏褐色）、`ochre`（赭石黄）、`mist`（雾蓝）、`violet`（灰紫）、`rose`（豆沙粉）、`graphite`（石墨蓝）、`kraft`（牛皮棕）、`stone`（暖石灰）、`natural`（原色纸），统一搭配 `#E6DDC8` 衬纸、`#414A3C` 墨线与 `#FFFBF0` 纸底，并支持自定义 HEX 颜色。
- **历史兼容映射**：早期职业头像 ID 与旧默认色在读取和保存边界由 `normalizePaperAvatar` 自动映射至当前纸片头像，无需批量改写历史数据。

## 2. 运行状态与表情动画

运行状态只驱动表情与动作，不改变 Bot 已选的造型和纸色：

| 运行状态 | 视觉表现 |
| --- | --- |
| 空闲（`idle`） | 原始眼神漂移与自然眨眼 |
| 思考 / 工作（`think` / `work`） | 专注表情；工作中附带原引擎旋转轨道环 |
| 等待（`wait`） | 好奇神情 |
| 完成（`done`） | 眨眼后开心（工作结束后播放一次） |
| 失败（`error`） | 难过表情 |
| 暂停（`paused`） | 困倦表情 |

## 3. 源码结构与跨端导出

- `capabilities/shared/avatar-style.mjs`：跨端造型、纸色、旧值映射与规范化逻辑。
- `web/avatar-showcase/src/relay/rig.ts`：直接调用 Bloub 原引擎的运行状态适配。
- `web/avatar-showcase/src/relay/browser.ts`：正式网页 SVG 渲染与生命周期管理。
- `web/avatar-showcase/src/components/BloubBot.tsx`：原展示页，保留完整动画时间线。
- `scripts/build/export-paper.mjs`：构建网页入口并导出 20 FPS 原生矢量动作目录（版本 3）。
- iOS `PaperLibrary.swift` / Android `PaperAvatars.kt`：使用原生 Canvas 直接绘制共享矢量动作并插值，不使用逐帧位图或 WebView。

修改头像引擎或样式后，在安装 `web/avatar-showcase` 依赖的前提下，使用 Node 24+ 在仓库根目录运行：

```powershell
node scripts/build/export-paper.mjs
```

该脚本自动生成并更新以下产物（随源码提交）：
- `web/frontend/avatars.js`
- `ios/Summon/Resources/paper-avatars.json` 与 `Bloub-LICENSE.txt`
- `android/app/src/main/assets/paper-avatars.json` 与 `Bloub-LICENSE.txt`

## 4. 性能与许可

- 网页端可见头像限帧 30 FPS，滚出视口或切到后台时自动暂停；原生移动端同步响应应用前后台生命周期与系统“减少动态效果”设置。
- 在线演示页：`https://bot.lin0.org/api/avatar-showcase/#etat=idle`。更新上线沿用 [运行维护](OPERATIONS.zh-CN.md) 中的正式发布安装流程。
- 保留 Bloub MIT 许可，来源及修改说明见 [avatar-showcase 说明](../web/avatar-showcase/README.md)。
