import { isUtf8 } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import iconv from 'iconv-lite';

let oemEncoding;
function windowsOemEncoding() {
  if (oemEncoding !== undefined) return oemEncoding;
  oemEncoding = 'utf8';
  try {
    const registry = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'],
      { encoding: 'utf8', windowsHide: true, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const page = /\bOEMCP[ \t]+REG_SZ[ \t]+(\d+)\b/i.exec(registry)?.[1];
    if (page && page !== '65001' && iconv.encodingExists('cp' + page)) oemEncoding = 'cp' + page;
  } catch { /* Preserve UTF-8 decoding when Windows cannot report a supported page. */ }
  return oemEncoding;
}

function isUtf8Prefix(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch { return false; }
}

const maxBufferedBytes = 256 * 1024;
const preserveBom = { stripBOM: false };

export function validNativeEncoding(encoding) {
  return typeof encoding === 'string' && /^[\w-]{1,40}$/.test(encoding) &&
    (encoding === 'auto' || iconv.encodingExists(encoding));
}

// Decode whole lines before redacting or recording text. Node pipe chunks can
// split UTF-8 and multibyte OEM characters. Keep a streaming decoder for long lines.
export function pipeNativeText(stream, write, requested = 'auto') {
  if (requested !== 'auto' || process.platform !== 'win32') {
    const encoding = requested === 'auto' ? 'utf8' : requested;
    const decoder = iconv.getDecoder(encoding, preserveBom);
    stream.on('data', bytes => write(decoder.write(bytes)));
    stream.on('end', () => write(decoder.end() ?? ''));
    return () => encoding;
  }
  const used = new Set();
  let pending = Buffer.alloc(0), decoder;
  function flush(bytes, complete) {
    if (!decoder && complete) {
      const selected = isUtf8(bytes) ? 'utf8' : windowsOemEncoding();
      if (bytes.length) used.add(selected);
      write(iconv.decode(bytes, selected, preserveBom));
      return;
    }
    if (!decoder) {
      const encoding = isUtf8Prefix(bytes) ? 'utf8' : windowsOemEncoding();
      decoder = iconv.getDecoder(encoding, preserveBom);
      used.add(encoding);
    }
    const text = decoder.write(bytes);
    if (!complete) {
      write(text);
      return;
    }
    const tail = decoder.end() ?? '';
    decoder = undefined;
    write(text + tail);
  }
  stream.on('data', chunk => {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      flush(bytes.subarray(start, end + 1), true);
      start = end + 1;
    }
    pending = bytes.subarray(start);
    if (pending.length >= maxBufferedBytes) {
      flush(pending, false);
      pending = Buffer.alloc(0);
    }
  });
  stream.on('end', () => { if (decoder || pending.length) flush(pending, true); });
  return () => used.size > 1 ? 'mixed' : ([...used][0] ?? 'utf8');
}
