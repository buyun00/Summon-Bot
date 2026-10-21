import net from 'node:net';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

async function address(dataRoot,type) {
  const root=await realpath(resolve(dataRoot)),key=createHash('sha256').update(`${process.platform==='win32'?root.toLowerCase():root}:${type}`).digest('hex').slice(0,40);
  return process.platform==='win32'?`\\\\.\\pipe\\relay-service-${key}`:process.platform==='linux'?`\0relay-service-${key}`:{host:'127.0.0.1',port:30000+parseInt(key.slice(0,8),16)%25000};
}
export async function inspectServiceLock(dataRoot,type) {
  let endpoint;try{endpoint=await address(dataRoot,type);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  return new Promise((accept,reject)=>{
    const socket=net.createConnection(endpoint);let text='',finished=false;
    const done=(value,error)=>{if(finished)return;finished=true;socket.destroy();error?reject(error):accept(value);};
    socket.setTimeout(2000,()=>done(null,new Error('Service identity handshake timed out')));
    socket.on('error',error=>done(null,['ENOENT','ECONNREFUSED'].includes(error.code)?null:error));
    socket.on('data',chunk=>{text+=chunk;if(text.length>16384)return done(null,new Error('Invalid service identity'));if(text.includes('\n'))try{const value=JSON.parse(text.split('\n')[0]);if(value.protocol!=='relay-service-v1'||value.type!==type)throw new Error('Service identity mismatch');done(value);}catch(error){done(null,error);}});
    socket.on('end',()=>{if(!finished)done(null,new Error('Incomplete service identity'));});
  });
}
export async function acquireServiceLock(dataRoot,type,getState) {
  const server=net.createServer(socket=>{socket.on('error',()=>{});socket.end(JSON.stringify({protocol:'relay-service-v1',type,...getState()})+'\n');});
  const endpoint=await address(dataRoot,type);
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.removeListener('error',reject);accept();});});
  return {close:()=>new Promise(accept=>server.close(accept))};
}
