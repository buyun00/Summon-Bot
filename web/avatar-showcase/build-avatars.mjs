import { build } from 'vite';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
await build({configFile:false,root,publicDir:false,build:{emptyOutDir:false,outDir:'../frontend',reportCompressedSize:false,lib:{entry:root+'src/relay/browser.ts',name:'RelayPaperAvatars',formats:['iife'],fileName:()=> 'avatars.js'}}});
await build({configFile:false,root,publicDir:false,build:{emptyOutDir:false,outDir:'generated',reportCompressedSize:false,lib:{entry:root+'src/relay/export.ts',formats:['es'],fileName:()=> 'engine.mjs'}}});
