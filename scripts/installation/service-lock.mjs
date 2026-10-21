import net from 'node:net';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const handshakeError = (message, code) => Object.assign(new Error(message), { code });
const retryableHandshake = new Set(['SERVICE_HANDSHAKE_INCOMPLETE', 'ECONNRESET', 'EPIPE']);

async function address(dataRoot,type) {
  const root=await realpath(resolve(dataRoot)),key=createHash('sha256').update(`${process.platform==='win32'?root.toLowerCase():root}:${type}`).digest('hex').slice(0,40);
  return process.platform==='win32'?`\\\\.\\pipe\\relay-service-${key}`:process.platform==='linux'?`\0relay-service-${key}`:{host:'127.0.0.1',port:30000+parseInt(key.slice(0,8),16)%25000};
}
function queryIdentity(endpoint,type,timeoutMs) {
  return new Promise((accept,reject)=>{
    const socket=net.createConnection(endpoint);let text='',bytes=0,finished=false;
    const done=(value,error)=>{
      if(finished)return;finished=true;clearTimeout(timer);socket.destroy();
      if(error&&!['ENOENT','ECONNREFUSED'].includes(error.code))reject(Object.assign(new Error('Service identity could not be verified; stopped state is unknown',{cause:error}),{code:'SERVICE_IDENTITY_UNAVAILABLE'}));
      else accept(value);
    };
    // A trickling peer must not renew an idle timeout indefinitely.
    const timer=setTimeout(()=>done(null,handshakeError('Service identity handshake timed out','SERVICE_HANDSHAKE_TIMEOUT')),timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error',error=>done(null,error));
    socket.on('data',chunk=>{
      text+=chunk;bytes+=Buffer.byteLength(chunk);
      if(bytes>16384)return done(null,handshakeError('Service identity exceeds the size limit','SERVICE_IDENTITY_INVALID'));
      if(!text.includes('\n'))return;
      try {
        const value=JSON.parse(text.split('\n')[0]);
        if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!=='relay-service-v1'||value.type!==type||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.bootId!=='string'||!value.bootId||typeof value.state!=='string'||!value.state)
          throw new Error('Service identity mismatch or incomplete identity');
        done(value);
      } catch(error) {done(null,handshakeError(error.message,'SERVICE_IDENTITY_INVALID'));}
    });
    socket.on('end',()=>done(null,handshakeError('Incomplete service identity','SERVICE_HANDSHAKE_INCOMPLETE')));
    socket.on('close',()=>done(null,handshakeError('Service identity connection closed without a response','SERVICE_HANDSHAKE_INCOMPLETE')));
  });
}
export async function inspectServiceLock(dataRoot,type) {
  // Missing deployment data is not proof that its previous OS owner stopped.
  const endpoint=await address(dataRoot,type),deadline=Date.now()+2000;
  for(let attempt=0;;attempt++) {
    try{return await queryIdentity(endpoint,type,Math.max(1,deadline-Date.now()));}
    catch(error){
      // An EOF/reset during shutdown is inconclusive. Only a fresh OS refusal
      // proves absence, and a replacement owner's identity must be preserved.
      if(attempt>=2||!retryableHandshake.has(error.cause?.code)||Date.now()+25>=deadline)throw error;
      await new Promise(accept=>setTimeout(accept,25));
    }
  }
}
export async function acquireServiceLock(dataRoot,type,getState) {
  const sockets=new Set();let closing;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.end(JSON.stringify({protocol:'relay-service-v1',type,...getState()})+'\n');
  });
  const endpoint=await address(dataRoot,type);
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.removeListener('error',reject);accept();});});
  server.on('error',()=>{});
  return {close:()=>closing||=new Promise(accept=>{
    if(!server.listening)return accept();
    // Stop accepting first; drain accepted replies before forced socket cleanup.
    const timer=setTimeout(()=>{for(const socket of sockets)socket.destroy();},250);timer.unref();
    server.close(()=>{clearTimeout(timer);accept();});
  })};
}
