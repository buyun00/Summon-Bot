import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Do not trust forwarded IP headers: the public tunnel and local callers share this listener.
export function createWebAuth(token) {
  if (typeof token !== 'string' || token.length < 43) throw new Error('web.accessToken must contain at least 43 characters');
  const failures = new Map();
  const lifetime = 30 * 86400000;
  const sign = value => createHmac('sha256', token).update(`summon-web-session:${value}`).digest('base64url');
  const issue = now => {
    const value = `${now + lifetime}.${randomBytes(32).toString('base64url')}`;
    return `${value}.${sign(value)}`;
  };
  const expiresAt = cookie => {
    if (!cookie || cookie.length > 160) return 0;
    const parts = cookie.split('.');
    if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return 0;
    return equal(parts[2], sign(`${parts[0]}.${parts[1]}`)) ? Number(parts[0]) : 0;
  };
  let globalWindow = 0, globalCount = 0;
  return (req, res, url, requestOrigin) => {
    const now = Date.now();
    const secure = requestOrigin.startsWith('https:');
    const cookieName = secure ? '__Host-summon_session' : 'summon_local_session';
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const setSession = () => res.setHeader('Set-Cookie', `${cookieName}=${issue(now)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`);
    const bearer = equal(req.headers.authorization, `Bearer ${token}`);
    const expiry = expiresAt(cookie);
    const session = expiry > now && expiry <= now + lifetime;
    const login = url.pathname === '/auth/session' && req.method === 'POST';
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(JSON.stringify(value));
    };
    if (login && bearer) {
      setSession();
      send(200, { authenticated: true });
      return false;
    }
    if (!login && (bearer || (!req.headers.authorization && session))) {
      if (session && expiry - now < lifetime - 86400000) setSession();
      return true;
    }
    // A login shell is the only unauthenticated resource; it contains no application data.
    if (url.pathname === '/' && req.method === 'GET' && !req.headers.authorization) {
      const nonce = randomBytes(18).toString('base64');
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Summon Bot · 登录</title><style nonce="${nonce}">body{font:16px system-ui;background:#f6f7fb;margin:12vh auto;padding:24px;max-width:380px}input,button{box-sizing:border-box;width:100%;padding:14px;margin:10px 0;font:inherit}button{cursor:pointer}p{line-height:1.6}</style><h1>Summon Bot</h1><p>输入访问 Token 以连接你的工作空间。此设备会记住登录 30 天，使用时自动续期。</p><form><input type="password" autocomplete="current-password" aria-label="访问 Token" placeholder="访问 Token" required maxlength="512"><button>连接</button></form><p id="message" role="status"></p><script nonce="${nonce}">document.querySelector('form').onsubmit=async e=>{e.preventDefault();const b=document.querySelector('button');b.disabled=true;try{const r=await fetch('/auth/session',{method:'POST',headers:{Authorization:'Bearer '+document.querySelector('input').value.trim()}});if(r.ok){location.replace('/');return}document.getElementById('message').textContent=r.status===429?'尝试过于频繁，请一分钟后重试。':'Token 不正确，请重新输入。'}catch{document.getElementById('message').textContent='连接失败，请稍后重试。'}finally{b.disabled=false}};</script></html>`);
      return false;
    }
    for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key);
    if (now >= globalWindow) { globalWindow = now + 60000; globalCount = 0; }
    const key = req.socket.remoteAddress || 'unknown';
    let entry = failures.get(key);
    if (!entry) {
      if (failures.size >= 4096) { send(429, { error: '请求过于频繁' }, { 'Retry-After': '60' }); return false; }
      entry = { until: now + 60000, count: 0 }; failures.set(key, entry);
    }
    if (++entry.count > 20 || ++globalCount > 200) send(429, { error: '认证尝试过于频繁' }, { 'Retry-After': '60' });
    else send(401, { error: '需要有效的访问 Token' }, { 'WWW-Authenticate': 'Bearer realm="Summon Bot"' });
    return false;
  };
}
