import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Resvg } from '@resvg/resvg-js';

// Derive native artwork and matching rules from the same local web catalogue.
const root = fileURLToPath(new URL('../../', import.meta.url));
const web = join(root, 'web/frontend');
const android = join(root, 'android/app/src/main');
const ios = join(root, 'ios/Relay');
const context = vm.createContext({ URL });
const source = (await readFile(join(web, 'model-icons.js'), 'utf8')).replace('return { brand, svg, name:', 'return { aliases, models, hosts, brand, svg, name:');
vm.runInContext(source, context);
const { aliases, models, hosts } = context.SummonModelIcons;
const manifest = JSON.stringify({ aliases, models: models.map(([pattern, id]) => [pattern.source, id]), hosts }, null, 2) + '\n';
for (const target of [join(android, 'assets'), join(ios, 'Resources')]) {
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'ai-brands.json'), manifest);
  await copyFile(join(web, 'icons/ai-brands-LICENSE.txt'), join(target, 'ai-brands-LICENSE.txt'));
}
await mkdir(join(android, 'res/drawable-nodpi'), { recursive: true });
const sprite = await readFile(join(web, 'icons/ai-brands.svg'), 'utf8');
for (const [, id, attributes, body] of sprite.matchAll(/<symbol id="ai-([^"]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)) {
  const png = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" color="#000" ${attributes}>${body}</svg>`).render().asPng();
  await writeFile(join(android, `res/drawable-nodpi/ai_${id}.png`), png);
  const assets = join(ios, `Assets.xcassets/AI-${id}.imageset`);
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'icon.png'), png);
  await writeFile(join(assets, 'Contents.json'), JSON.stringify({ images: [{ filename: 'icon.png', idiom: 'universal' }], info: { author: 'xcode', version: 1 }, properties: { 'template-rendering-intent': 'template' } }, null, 2) + '\n');
}
await copyFile(join(web, 'icons/user-avatar.jpg'), join(android, 'res/drawable-nodpi/owner_avatar.jpg'));
const owner = join(ios, 'Assets.xcassets/OwnerAvatar.imageset');
await mkdir(owner, { recursive: true });
await copyFile(join(web, 'icons/user-avatar.jpg'), join(owner, 'avatar.jpg'));
await writeFile(join(owner, 'Contents.json'), JSON.stringify({ images: [{ filename: 'avatar.jpg', idiom: 'universal' }], info: { author: 'xcode', version: 1 } }, null, 2) + '\n');
console.log('Native model icons and brand matching catalogue updated.');
