import { resolve, relative, isAbsolute, sep } from 'node:path';
export const fail = (message,status=400) => { throw Object.assign(new Error(message), { status }); };
export const required = (value,name='value',limit=16000) => { const text = String(value ?? '').trim(); if (!text || text.length > limit) fail(`${name} must contain 1–${limit} characters`); return text; };
export const safeId = value => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(String(value)) || ['.','..'].includes(value)) fail('Invalid managed identity'); return value; };
export const within = (root,path) => { const rel = relative(resolve(root),resolve(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
export const pick = (value,keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key,value[key]]));
export const now = () => new Date().toISOString();
export function avatarOf(value, previous={}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('头像设置必须是对象');
  const shape = value.shape ?? previous.shape ?? 'circle', color = value.color ?? previous.color ?? '#8F59F9', image = value.image ?? previous.image ?? '';
  if (!['circle','cloud','square','star4','clover','heart','flower','drop','pill','triangle','pentagon','star6','hexagon'].includes(shape)) fail('头像形状无效');
  if (!/^#[0-9a-f]{6}$/i.test(color) || typeof image !== 'string' || image.length > 400000 || image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('头像内容无效');
  return { shape,color:color.toUpperCase(),image };
}
