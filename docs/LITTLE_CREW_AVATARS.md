# Little Crew 头像

网页、iOS 和 Android 使用同一套 12 个手绘职业角色。创建和编辑 Bot 可选择角色、16 套配色模板，并展开自定义主色、辅助色、描边/眼睛、底色。已有图片头像保持原样；旧几何形状 ID 由渲染器映射为新角色，无需批量改写 Bot 数据。

## 编辑与导出

源文件位于 `web/frontend/crew/`：`characters.js` 定义分层路径，`palette.js` 定义模板和旧 ID 映射，`animator.js` 定义六种动作与连续过渡，`adapter.js` 对接网页头像接口。

修改后在仓库根目录运行：

```sh
node scripts/build/export-crew.mjs
```

导出目标为 `web/frontend/avatars.js`、`ios/Relay/Resources/little-crew.json`、`android/app/src/main/assets/little-crew.json`。生成文件应随源文件一起交付。移动端使用原生 Canvas，读取同源路径与动作曲线，不依赖 WebView 或逐帧图片。

## 数据与动作

头像字段：`shape`、`color`、`secondary`、`ink`、`paper`、`image`。颜色为六位 HEX；后三个颜色字段可省略，使用角色辅助色与统一描边/底色。服务端支持这些字段的校验和保存。

角色 ID：`dev`、`art`、`music`、`plan`、`qa`、`write`、`ops`、`research`、`data`、`lead`、`translate`、`knowledge`。

动作 ID：`idle`（4.8 秒）、`think`（3.6 秒）、`work`（2.4 秒）、`done`（2.2 秒）、`wait`（4.4 秒）、`confused`（3.2 秒）。完成动作播放一次后保持表情，其余循环。切换动作保留姿态和速度，通过阻尼弹簧连续过渡；改色不重置动作。

网页使用 `RelayAvatars.render(avatar, size, {key, state})` 后调用 `hydrate`；原生 `BotAvatar` 使用 `motion` 参数。现有工作指示使用 `work`，其余业务状态由调用者按真实任务状态传入。选择器缩略图静止，主预览播放动画；系统减少动态效果或应用后台时停止动画更新。
