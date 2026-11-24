[English](PAPER_AVATARS.md) | [简体中文](PAPER_AVATARS.zh-CN.md)

# Bloub Vector Paper Avatars

Web, Electron Desktop, iOS, and Android share a unified Bot avatar system combining the **Bloub vector animation engine** with **Summon Bot paper-collage textures**. All platforms share the same shapes, palettes, backing sheets, fine paper fibers, and eye cutouts while continuing to support user-uploaded image avatars (PNG / JPEG / WebP).

## 1. Shapes & Paper Palettes

Defined centrally in `capabilities/shared/avatar-style.mjs`:

- **8 geometric shapes**: `cercle` (circle), `galet` (pebble), `squircle`, `capsule`, `triangle`, `hexagone` (hexagon), `nuage` (cloud), `goutte` (drop).
- **12 paper presets**: `olive`, `sage`, `clay`, `apricot`, `ochre`, `mist`, `violet`, `rose`, `graphite`, `kraft`, `stone`, and `natural`, paired with `#E6DDC8` backing paper, `#414A3C` ink, and `#FFFBF0` paper base (with custom HEX overrides supported).
- **Legacy mapping**: Older role avatar IDs and legacy default colors are normalized automatically at read/save boundaries by `normalizePaperAvatar` without batch-rewriting historical records.

## 2. Runtime States & Motion

Runtime status drives only facial expression and motion—never mutating the Bot's chosen shape or paper color:

| Runtime State | Animation & Expression |
| --- | --- |
| `idle` | Subtle eye drift and natural blinking |
| `think` / `work` | Focused gaze; `work` adds the native orbiting ring tracks |
| `wait` | Curious expression |
| `done` | Blink followed by happy expression (plays once after work completes) |
| `error` | Sad expression |
| `paused` | Sleepy expression |

## 3. Source Files & Cross-Platform Export

- `capabilities/shared/avatar-style.mjs`: shared shapes, palettes, legacy mappings, and normalization.
- `web/avatar-showcase/src/relay/rig.ts`: runtime state adapter wrapping the Bloub engine directly.
- `web/avatar-showcase/src/relay/browser.ts`: Web SVG rendering and visibility lifecycle.
- `web/avatar-showcase/src/components/BloubBot.tsx`: showcase component preserving full animation timelines.
- `scripts/build/export-paper.mjs`: builds the Web bundle and exports the 20 FPS native vector motion catalog (format v3).
- iOS `PaperLibrary.swift` & Android `PaperAvatars.kt`: native Canvas renderers interpolating shared vector geometry and eye transforms directly (no frame bitmaps or WebViews).

After modifying the avatar engine or styles (with `web/avatar-showcase` dependencies installed), run from the repository root using Node 24+:

```powershell
node scripts/build/export-paper.mjs
```

This updates the committed cross-platform outputs:
- `web/frontend/avatars.js`
- `ios/Summon/Resources/paper-avatars.json` & `Bloub-LICENSE.txt`
- `android/app/src/main/assets/paper-avatars.json` & `Bloub-LICENSE.txt`

## 4. Performance & Licensing

- Visible Web avatars cap rendering at 30 FPS and pause automatically when off-screen or backgrounded; native mobile clients respect app lifecycle transitions and the system Reduce Motion accessibility setting.
- Live showcase: `https://bot.lin0.org/api/avatar-showcase/#etat=idle`. Production updates follow the standard release installation flow in [Operations & Maintenance](OPERATIONS.md).
- Bloub MIT license terms and attribution notes are preserved in [avatar-showcase README](../web/avatar-showcase/README.md).
