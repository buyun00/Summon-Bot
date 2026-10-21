import { readFile } from 'node:fs/promises';
import { startGateway } from './index.mjs';
const index=process.argv.indexOf('--config');if(index<0)throw new Error('Usage: node bin.mjs --config ABSOLUTE_JSON');
const gateway=await startGateway(JSON.parse(await readFile(process.argv[index+1],'utf8')));
console.log(JSON.stringify({service:'capabilities',url:gateway.url,pid:process.pid}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void gateway.close());
