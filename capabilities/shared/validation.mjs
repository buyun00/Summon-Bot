import { resolve, relative, isAbsolute, sep } from 'node:path';
import { normalizePaperAvatar, paperShapes } from './avatar-style.mjs';
export const fail = (message,status=400) => { throw Object.assign(new Error(message), { status }); };
export const required = (value,name='value',limit=16000) => { const text = String(value ?? '').trim(); if (!text || text.length > limit) fail(`${name} must contain 1–${limit} characters`); return text; };
export const safeId = value => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(String(value)) || ['.','..'].includes(value)) fail('Invalid managed identity'); return value; };
export const within = (root,path) => { const rel = relative(resolve(root),resolve(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
export const pick = (value,keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key,value[key]]));
export const now = () => new Date().toISOString();
export function avatarOf(value, previous={}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('头像设置必须是对象');
  const shape = value.shape ?? previous.shape ?? 'cercle', color = value.color ?? previous.color ?? '#7D824B', image = Object.hasOwn(value,'image') ? value.image || '' : previous.image || '';
  if (![...paperShapes.map(item=>item.id),'dev','art','music','plan','qa','write','ops','research','data','lead','translate','knowledge','circle','cloud','square','star4','clover','heart','flower','drop','pill','triangle','pentagon','star6','hexagon'].includes(shape)) fail('头像形状无效');
  if (!/^#[0-9a-f]{6}$/i.test(color) || typeof image !== 'string' || image.length > 400000 || image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('头像内容无效');
  const palette={};
  for(const key of ['secondary','ink','paper']){const field=value[key]??previous[key];if(field!=null){if(typeof field!=='string'||!/^#[0-9a-f]{6}$/i.test(field))fail('头像配色无效');palette[key]=field.toUpperCase();}}
  return { ...normalizePaperAvatar({shape,color,image,...palette}),image };
}
