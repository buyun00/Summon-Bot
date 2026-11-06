const loopback = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function workspaceOrigin(input, { httpsOnly = false } = {}) {
  const url = new URL(String(input).trim());
  if (!(url.protocol === 'https:' || !httpsOnly && url.protocol === 'http:' && loopback.has(url.hostname))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.hostname.endsWith('.')) {
    throw new Error('请填写工作区的 HTTPS 地址或本机回环地址，地址中无需路径和访问令牌。');
  }
  return url.origin;
}

export function originForHost(host, origins) {
  if (typeof host !== 'string' || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return null;
  for (const origin of origins) {
    const protocol = new URL(origin).protocol;
    try { if (new URL(protocol + '//' + host).origin === origin) return origin; }
    catch { return null; }
  }
  return null;
}

export function matchesOrigin(header, origin) {
  if (typeof header !== 'string' || !header || /[\\?#\s]/.test(header)) return false;
  try { return workspaceOrigin(header) === origin; }
  catch { return false; }
}
