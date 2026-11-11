import { inflateRawSync } from 'node:zlib';

const textLimit = 128 * 1024;
const xmlLimit = 2 * 1024 * 1024;
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const zipError = () => { throw new Error('Unsupported or damaged document archive'); };

// Read just the document body. Do not extract archive paths, resolve XML
// entities, execute macros, or open external relationships.
function wordBody(bytes) {
  if (bytes.length < 22) zipError();
  let end = bytes.length - 22;
  for (const first = Math.max(0, end - 65535); end >= first; end--)
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  if (end < Math.max(0, bytes.length - 22 - 65535) || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) zipError();
  let at = bytes.readUInt32LE(end + 16);
  const directory = at;
  const limit = at + bytes.readUInt32LE(end + 12), count = bytes.readUInt16LE(end + 10);
  if (limit !== end || count > 4096) zipError();
  for (let i = 0; i < count; i++) {
    if (at + 46 > limit || bytes.readUInt32LE(at) !== 0x02014b50) zipError();
    const nameSize = bytes.readUInt16LE(at + 28);
    const next = at + 46 + nameSize + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (next > limit) zipError();
    if (bytes.toString('ascii', at + 46, at + 46 + nameSize) === 'word/document.xml') {
      const method = bytes.readUInt16LE(at + 10), compressed = bytes.readUInt32LE(at + 20);
      const size = bytes.readUInt32LE(at + 24), header = bytes.readUInt32LE(at + 42);
      if (bytes.readUInt16LE(at + 8) & 1 || size > xmlLimit || header + 30 > directory ||
          bytes.readUInt32LE(header) !== 0x04034b50 || ![0, 8].includes(method)) zipError();
      const start = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
      if (start + compressed > directory || method === 0 && compressed !== size) zipError();
      const data = bytes.subarray(start, start + compressed);
      const result = method === 8 ? inflateRawSync(data, { maxOutputLength: xmlLimit }) : data;
      if (result.length !== size) zipError();
      return decode(result);
    }
    at = next;
  }
  zipError();
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function wordText(xml) {
  const pieces = [];
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:(p|tc|tr)>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
    if (match[1] !== undefined) pieces.push(match[1].replace(/&(amp|lt|gt|quot|apos|#x[\da-f]+|#\d+);/gi, (raw, key) => {
      if (Object.hasOwn(entities, key)) return entities[key];
      const value = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ?
        String.fromCodePoint(value) : raw;
    }));
    else pieces.push(match[2] === 'tc' || match[3] === 'tab' ? '\t' : '\n');
  }
  return pieces.join('').replace(/\n\t/g, '\t').replace(/\n{3,}/g, '\n\n').trim();
}

export function publishedText(name, bytes, { office = true } = {}) {
  const text = office && /\.docx$/i.test(name) ? wordText(wordBody(bytes)) :
    /\.(?:md|txt|csv|tsv|json)$/i.test(name) && bytes.length <= textLimit && !bytes.includes(0) ? decode(bytes) : null;
  if (text === null || Buffer.byteLength(text) > textLimit)
    throw new Error('This publication is not a supported bounded text document');
  return text;
}
