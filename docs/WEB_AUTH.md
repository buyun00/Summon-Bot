[English](WEB_AUTH.md) | [简体中文](WEB_AUTH.zh-CN.md)

# Web & App Access Authentication

User access control is enforced by `web/backend/auth.mjs` ahead of every HTTP route—including APIs, SSE streams, attachment downloads, client release endpoints, static assets, and the legacy Service Worker cleanup script. Localhost access is not exempted.

## 1. Access Token (`web.accessToken`)

- Production deployments store an independent 32-byte random token (base64url encoded, at least 43 characters) under `web.accessToken` in the formal data root's `config/deployment.json`.
- This token is separate from internal gateway/control credentials and is never committed to source control.
- Fresh deployments generate it automatically; Web refuses to start if the token is missing or shorter than 43 characters.

## 2. Client Authentication Flows

- **Native iOS & Android**: Users enter the access token in connection settings (stored in iOS Keychain / Android encrypted storage) and send `Authorization: Bearer <token>` on requests.
- **Web & Electron Desktop**:
  - Unauthenticated requests to `/` or pages receive a minimal `401` login shell containing zero application data, hardened with a per-request CSP script/style nonce, `Referrer-Policy: no-referrer`, and `frame-ancestors 'none'`.
  - Submitting the token calls `POST /auth/session` via the `Authorization: Bearer` header (never placed in URLs or `localStorage`). On success, the server sets an HMAC-SHA256 signed session cookie:
    - Public HTTPS uses `__Host-summon_session` with `Secure`;
    - Local HTTP uses port-scoped `summon_local_session` (or `summon_local_session_<port>` for non-8787 ports).
  - Cookies carry `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (30-day lifetime) and renew daily on active use. Sessions survive page reloads, browser restarts, and server restarts.
  - Because signatures bind to `web.accessToken`, rotating the token in `config/deployment.json` and restarting Web immediately revokes both the old token and all existing browser sessions. On any API `401`, the Web client returns to the login view.

## 3. Rate Limiting & Local Release Fallback

- Missing or invalid credentials are throttled by raw TCP socket address (`req.socket.remoteAddress`, ignoring spoofable forwarded IP headers): up to **20 failures/minute** per source and **200 failures/minute** globally (tracking table capped at 4,096 sources), returning `429` with `Retry-After: 60`.
- Visitors behind a reverse tunnel may share the same local socket bucket, but valid tokens and valid signed session cookies bypass failure limits so attackers cannot lock out legitimate users.
- Signed sessions are stateless and consume no server-side session table memory. This throttling guards authentication attempts and does not replace edge network protection.
- Unauthenticated local release download requests are rejected; clients automatically fall back to public GitHub Releases.
