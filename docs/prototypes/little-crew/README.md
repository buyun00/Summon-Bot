# Little Crew 分层 SVG 动画原型

启动：`node docs/prototypes/little-crew/serve.mjs`，打开终端输出的本地地址。

12 个职业：开发、美术、音乐、策划、测试、文案、运维、研究、数据、协调、翻译、知识。沿用已选的深蓝描边、暖白底与局部点色；SVG 为重新手绘的矢量实现，并非概念 PNG 的自动描摹。

## 动作

每个角色具备待机（4.8s）、思考（3.6s）、工作（2.4s）、完成（2.2s）、等你（4.4s）、困惑（3.2s）。完成播一次后停住，其余循环。各职业用独立的部件关节、节奏与动作修饰构成 72 组状态表现，具体动作名见 `characters.js` 的 `verbs`。

切状态只重置目标动作的时间，不替换 SVG，不重置当前显示姿态或速度。每个变换通道使用临界阻尼弹簧追踪目标，常规过渡约 0.35–0.5 秒；可中途再次切换。颜色独立于动画状态，切换动作保留已选颜色。表情通过透明度及眼形插值变化。页面隐藏时不推进动画；系统减少动态效果偏好下默认暂停。

## 接入接口

```js
import { CrewAvatar } from './animator.js';
const avatar = new CrewAvatar(element, 'dev', { size: 32 });
avatar.setPalette({ accent: '#ffc18e', ink: '#142443' });
avatar.setState('think'); // idle / think / work / done / wait / confused
// 在宿主共用的 requestAnimationFrame 内推进，dt 为秒。
avatar.tick(dt);
// 移除宿主时：
avatar.destroy();
```

`snapshot()` 导出当前帧的静态 SVG；完整动画需要 `characters.js` 与 `animator.js`。不要把静态导出称为动画 SVG。该目录为独立原型，尚未接入生产 Bot 状态和头像配置。
