import http from 'node:http';
import {readFile} from 'node:fs/promises';
const files=new Map([['/','index.html'],['/index.html','index.html'],['/characters.js','characters.js'],['/animator.js','animator.js'],['/preview.js','preview.js']]);
const server=http.createServer(async(req,res)=>{const name=files.get(new URL(req.url,'http://localhost').pathname);if(!name){res.writeHead(404);res.end('Not found');return;}try{const body=await readFile(new URL(name,import.meta.url));res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(body);}catch{res.writeHead(500);res.end('Unable to load preview');}});
server.listen(58247,'127.0.0.1',()=>console.log(`Little Crew: http://127.0.0.1:${server.address().port}`));
