# Relay paper collage avatar showcase

Adapted from the Bloub 0.4.1 demonstration application at
https://github.com/NorbertBodziony/bloub (main snapshot, 2026-10-28), originally by
Jérémy Perret, https://github.com/jeremy-prt/bloub. The upstream MIT license is
preserved in LICENSE and in the served THIRD_PARTY_NOTICES.txt.

The animation engine, state geometry, transitions, gaze, expressions, timeline,
and export controls are from upstream. Relay changes the rendering material,
paper palette, default language, page styling, and local storage namespace.
The paper backing follows the engine's current body path. Eye masks and material
filters are shared by the on-screen avatar, state thumbnails, and SVG exports.

Build with Node 24.21.0 or newer and the dependencies in package-lock.json:

```powershell
npm install --prefix web/avatar-showcase --ignore-scripts --no-audit --no-fund
npm run build --prefix web/avatar-showcase
```

The compiled static files live in web/frontend/avatar-showcase and are included
by the existing release build. Install through docs/OPERATIONS.md. This page
uses the one existing production server and data root; no separate service is
started. Open https://bot.lin0.org/api/avatar-showcase/#etat=idle to use the page.
The /api/ prefix deliberately bypasses installed versions of the Relay service
worker that return the cached chat shell for other navigation paths. The page
has no connection to the Bot API and does not write Bot settings or chats.

Upstream test files and test commands are excluded from this adaptation.
