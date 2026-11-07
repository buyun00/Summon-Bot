// Model prose is material. Protocol identities and authority are supplied elsewhere.
export function modelText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  if (Array.isArray(value)) return value.map(item => modelText(item)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    for (const key of ['text', 'markdown', 'context', 'summary', 'content', 'message', 'instruction', 'description'])
      if (value[key] != null) return modelText(value[key], fallback);
    return JSON.stringify(value);
  }
  return String(value);
}
export const modelArgs = value => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch {}
  return { content: modelText(value) };
};
export const boundedNumber = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const number = Number(value);
  return value == null || value === '' || !Number.isFinite(number) ? fallback : Math.max(min, Math.min(max, Math.floor(number)));
};
export function durationSeconds(value) {
  if (value == null || value === '') return NaN;
  if (Number.isFinite(Number(value))) return Number(value);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const number = text => {
    if (text === '半') return 0.5;
    if (Number.isFinite(Number(text))) return Number(text);
    if (text.includes('十')) { const [tens, ones] = text.split('十'); return (tens ? digits[tens] : 1) * 10 + (ones ? digits[ones] : 0); }
    return digits[text];
  };
  let seconds = 0, found = false;
  for (const match of modelText(value).matchAll(/([+-]?\d+(?:\.\d+)?|[零一二两三四五六七八九十半]+)\s*(?:个)?\s*(小时|分钟|秒钟?|天|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|h\b|m\b|s\b)/gi)) {
    const amount = number(match[1]); if (!Number.isFinite(amount)) continue;
    const unit = match[2].toLowerCase();
    seconds += amount * (/^(小时|h)/.test(unit) ? 3600 : /^(分钟|m)/.test(unit) ? 60 : /^(天|d)/.test(unit) ? 86400 : 1); found = true;
  }
  return found ? seconds : NaN;
}
export function looseSchema(schema) {
  return { type: 'object', properties: Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) =>
    [key, { ...(value.description ? { description: value.description } : {}), anyOf: [value, {}] }])), additionalProperties: true };
}
export function maintenanceOutput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { markdown: '', context: '', noChange: false };
  const unchanged = value => /^(?:无需(?:调整|变更|修改|更新)|没有(?:需要的)?变更|no\s+(?:changes?|updates?)(?:\s+(?:are\s+|is\s+)?(?:needed|required))?|unchanged)(?:[。.!，,:：\s]|$)/i.test(String(value).trim());
  let value;
  try { value = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch {
    try { value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {}
  }
  if (value === null || unchanged(text))
    return { markdown: null, context: '', noChange: true };
  if (value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    const body = modelText(value, text); return { markdown: unchanged(body) ? null : body, context: body, noChange: unchanged(body) };
  }
  const body = value.markdown === null ? null : modelText(value.markdown ?? value.context ?? value.summary ?? value.content ?? value.text ?? value.message, '');
  return { ...value, markdown: body, context: modelText(value.context ?? body),
    noChange: value.markdown === null || value.noChange === true || value.unchanged === true || value.status === 'unchanged' || unchanged(body),
    skills: Array.isArray(value.skills) ? value.skills : value.skills && typeof value.skills === 'object' ? [value.skills] : [] };
}
