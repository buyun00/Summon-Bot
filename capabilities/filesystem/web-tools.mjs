import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { validateToolArguments } from '@earendil-works/pi-ai';

const decode = text => String(text).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, value => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
  if (named[value.toLowerCase()]) return named[value.toLowerCase()];
  const point = value[2]?.toLowerCase() === 'x' ? parseInt(value.slice(3, -1), 16) : Number(value.slice(2, -1));
  return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : value;
});
const plain = html => decode(html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<\/(?:p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '))
  .replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
function privateAddress(address) {
  const ip = address.toLowerCase();
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224;
  }
  return ip === '::' || ip === '::1' || /^(?:fc|fd|fe[89ab])/.test(ip) || ip.startsWith('::ffff:');
}
async function readPublic(url, signal) {
  let current = new URL(url);
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25000)]);
  for (let redirect = 0; redirect <= 5; redirect++) {
    if (!['https:', 'http:'].includes(current.protocol) || current.username || current.password || current.port && !['80', '443'].includes(current.port)) throw new Error('Use a public HTTP(S) page without credentials or custom ports');
    const hostname = current.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error('Web reading only accesses public internet addresses');
    const response = await fetch(current, { method: 'GET', redirect: 'manual', signal: combined,
      headers: { Accept: 'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/plain,application/json', 'User-Agent': 'SummonBot/1.0 (read-only research)' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) throw new Error('Redirect has no destination'); current = new URL(location, current); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Web request returned HTTP ${response.status}`); }
    const type = response.headers.get('content-type') || '';
    if (!/text\/|html|xml|json/i.test(type)) { await response.body?.cancel(); throw new Error('This tool reads text pages; use independent work for binary files'); }
    const reader = response.body.getReader(), chunks = []; let bytes = 0, truncated = false;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; const remaining = 1024 * 1024 - bytes;
        chunks.push(value.subarray(0, remaining)); bytes += Math.min(value.length, remaining);
        if (value.length > remaining || bytes >= 1024 * 1024) { truncated = true; await reader.cancel(); break; } }
    } finally { reader.releaseLock(); }
    return { url: current.href, html: Buffer.concat(chunks).toString('utf8'), truncated };
  }
  throw new Error('Too many redirects');
}
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const tool = (name, description, parameters, execute) => ({ name, label: name, description, parameters,
  async execute(_id, args, signal) { const checked = validateToolArguments({ name, parameters }, { name, id: _id, arguments: args });
    const details = await execute(checked, signal); return { content: [{ type: 'text', text: JSON.stringify(details) }], details }; } });

export function createWebTools() {
  return [
    tool('web_search', 'Search the public web without shell commands. Returns titles, URLs and short snippets; read relevant pages with web_read.',
      { ...schema({ query: { type: 'string', minLength: 1, maxLength: 2000 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }), required: ['query'] }, async (args, signal) => {
        const url = new URL('https://www.bing.com/search'); url.searchParams.set('format', 'rss'); url.searchParams.set('q', args.query);
        const page = await readPublic(url, signal), items = [...page.html.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
        const field = (xml, name) => plain(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '');
        const results = items.slice(0, args.limit || 5).map(item => ({ title: field(item[1], 'title'), url: field(item[1], 'link'), snippet: field(item[1], 'description').slice(0, 600) }));
        if (!results.length && !/<rss\b/i.test(page.html)) throw new Error('Search provider did not return a result feed');
        return { query: args.query, results };
      }),
    tool('web_read', 'Read a bounded part of a public text webpage. This tool only sends GET requests, executes no scripts and submits no forms.',
      { ...schema({ url: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 16000 } }), required: ['url'] }, async (args, signal) => {
        const page = await readPublic(args.url, signal), text = plain(page.html), offset = args.offset || 0, length = args.length || 8000;
        return { url: page.url, title: plain(page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''), content: text.slice(offset, offset + length),
          offset, nextOffset: offset + length < text.length ? offset + length : null, truncated: page.truncated || offset + length < text.length };
      }),
  ];
}
