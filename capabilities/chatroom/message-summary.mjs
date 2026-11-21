const words = new Intl.Segmenter('zh', { granularity: 'word' });
const wordList = text => Array.from(words.segment(text), part => part.isWordLike ? part.segment : '').filter(Boolean);
const framing = new Set('用户 成员 对方 表示 说明 提到 补充 告知 询问 请求 要求 确认 建议 提醒 回复 请问 提供 发来 发送 附上 附件 图片 文件 材料 希望 需要 进行 相关 这次 本次 该项 当前 关于'.split(' '));
const negative = /(?:[不未没勿无非禁莫]|尚待)|\b(?:no|not|never|without|pending)\b/iu;
const literal = /[\p{N}零〇一二两三四五六七八九十百千万亿东西南北上下内外里旁侧前后左右]|[a-zA-Z]/u;
const pronoun = /^(?:(?:这|那|上|前|刚才|上述|前述|该|本|同一).{0,12}|它们?|他们?|她们?|此.{0,8}|其|it|they|that|this|those|these)$/iu;
const predicate = /^(?:已经|已|尚未|正在|将要|需要|请|必须|不能|禁止)/u;
const clip = text => Array.from(text).length > 80 ? Array.from(text).slice(0, 80).join('') + '…' : text;

// The previous message may name a referent. Its other assertions do not become evidence for this message.
export function projectFactSummary(message, draft, evidence, visible) {
  const body = (message.content ?? '').trim();
  const names = message.attachments.map(file => `「${file.name}」`);
  const quote = typeof evidence?.quote === 'string' ? evidence.quote.trim() : '';
  const link = evidence?.referent;
  const prior = link && visible?.get(link.message_id);
  const mention = typeof link?.mention === 'string' ? link.mention.trim() : '';
  const name = typeof link?.name === 'string' ? link.name.trim() : '';
  const resolved = Boolean(prior && prior.roomId === message.roomId && prior.sequence < message.sequence &&
    pronoun.test(mention) && quote.includes(mention) && body.includes(quote) && name.length <= 48 &&
    /^[\p{L}\p{N}《》· _-]+$/u.test(name) && !predicate.test(name) &&
    (prior.content.includes(name) || prior.attachments.some(file => file.name === name)));
  const candidate = draft.trim();
  const usesRef = candidate.includes('{ref}') || resolved && candidate.includes(name);
  const local = resolved ? candidate.replaceAll('{ref}', () => mention).replaceAll(name, () => mention) : candidate;
  const tokens = wordList(local);
  // Preserve literal measurements, positions, identifiers and polarity. Detect new claims copied from adjacent inputs.
  const neighbors = Array.from(visible?.values() || []);
  const index = neighbors.findIndex(entry => entry.id === message.id);
  const nearby = index < 0 ? [] : neighbors.slice(Math.max(0, index - 2), index + 3).filter(entry => entry.id !== message.id);
  const unsupported = tokens.filter(token => !framing.has(token) && !body.includes(token));
  const quotedNames = Array.from(local.matchAll(/[《「“]([^》」”]+)[》」”]/gu), match => match[1]);
  const grounded = quote && body.includes(quote) && (!usesRef || resolved) && Array.from(candidate).length <= 80 &&
    tokens.some(token => !framing.has(token) && quote.includes(token)) && negative.test(body) === negative.test(local) &&
    quotedNames.every(value => body.includes(value)) &&
    !unsupported.some(token => literal.test(token) || token.length > 1 && nearby.some(entry => entry.content.includes(token)));
  let summary = '';
  if (body) {
    summary = grounded ? candidate.replaceAll('{ref}', () => name) : clip(resolved ? body.replace(mention, () => name) : body);
  }
  if (names.length) summary += `${summary ? ' ' : ''}附件${names.join('、')}`;
  if (!summary && message.references.length) summary = `附有 ${message.references.length} 项引用`;
  return { summary, evidence: { message_id: message.id, ...(grounded ? { quote } : {}),
    ...(resolved && (usesRef || !grounded) ? { referent: { message_id: prior.id, mention, name } } : {}),
    ...(names.length ? { file_ids: message.attachments.map(file => file.id) } : {}),
    source: grounded ? 'model_summary' : body ? 'original_excerpt' : 'message_materials' } };
}
