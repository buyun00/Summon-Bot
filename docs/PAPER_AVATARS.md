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
- Standalone Bloub avatar generator project (maintained externally at `D:\Summon-Bloub-Avatars`): wraps the Bloub engine, builds the Web bundle (`web/frontend/avatars.js`), and exports the 20 FPS native vector motion catalog (format v3) via `node export-paper.mjs --target D:/Relay-Bot`.
- iOS `PaperLibrary.swift` & Android `PaperAvatars.kt`: native Canvas renderers interpolating shared vector geometry and eye transforms directly (no frame bitmaps or WebViews).

Committed cross-platform outputs in this repository:
- `web/frontend/avatars.js`
- `ios/Summon/Resources/paper-avatars.json` & `Bloub-LICENSE.txt`
- `android/app/src/main/assets/paper-avatars.json` & `Bloub-LICENSE.txt`

## 4. Performance & Licensing

- Visible Web avatars cap rendering at 30 FPS and pause automatically when off-screen or backgrounded; native mobile clients respect app lifecycle transitions and the system Reduce Motion accessibility setting.
- Bloub MIT license terms are preserved in `ios/Summon/Resources/Bloub-LICENSE.txt` and `android/app/src/main/assets/Bloub-LICENSE.txt`.
