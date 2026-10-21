/** Real Codex app-server verification. Never part of the offline unit suite. */
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { RecordStore } from '../capabilities/shared/store.mjs';
import { CodexExecutor } from '../capabilities/codex/executor.mjs';
import { WorkspaceExecutionLock } from '../capabilities/shared/workspace-lock.mjs';

const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const evidence=resolve(option('--output')||join('D:/Relay-Bot-data/verification/refactor-20261021',`codex-live-${new Date().toISOString().replace(/[:.]/g,'-')}`));
const cwd=join(evidence,'workspace');await mkdir(cwd,{recursive:true});
const expected=`relay-capability-codex-${randomUUID()}`;
const store=new RecordStore(join(evidence,'codex.sqlite'));
const configured=option('--codex')||process.env.RELAY_CODEX_PATH;
const executor=new CodexExecutor({store,defaultCwd:cwd,codexPath:configured,executionLock:new WorkspaceExecutionLock(cwd)});
const report={kind:'real-codex-app-server',fixture:false,startedAt:new Date().toISOString(),cwd,checks:[]};
let work;
try {
 await executor.start();
 work=executor.create({botId:'verification-bot',goal:`In the current isolated verification workspace, create a UTF-8 file named proof.txt whose entire content is exactly ${JSON.stringify(expected)} (no newline). Then read it back using an actual file operation and report what you verified.`,constraints:'Only modify proof.txt inside the supplied workspace. Do not access credentials or other projects. Do not commit, push, publish, create background services, install dependencies, or ask other Bots. This is a small local verification.',timeoutSeconds:180,sourceActionId:`real-verification:${expected}`});
 report.workId=work.id;
 const deadline=Date.now()+200000;let previous;
 while(Date.now()<deadline){work=executor.get(work.id);if(work.status!==previous){console.log(JSON.stringify({workId:work.id,status:work.status,threadId:work.threadId||null}));previous=work.status;}if(['completed','failed','cancelled','interrupted'].includes(work.status))break;await new Promise(done=>setTimeout(done,500));}
 if(!['completed','failed','cancelled','interrupted'].includes(work.status)){await executor.cancel(work.id);throw new Error('Real Codex verification timed out');}
 report.threadId=work.threadId;report.turnId=work.turnId;report.status=work.status;report.summary=work.summary;report.error=work.error;report.model=work.model;
 report.checks.push({name:'backend-completed',passed:work.status==='completed'});
 report.checks.push({name:'saved-thread-and-turn',passed:Boolean(work.threadId&&work.turnId)});
 const path=join(cwd,'proof.txt'),bytes=existsSync(path)?await readFile(path):null;
 report.checks.push({name:'actual-file-content',passed:bytes?.toString('utf8')===expected,path,size:bytes?.length||0,sha256:bytes?createHash('sha256').update(bytes).digest('hex'):null});
 report.checks.push({name:'execution-event-evidence',passed:work.events.some(event=>event.type==='item_completed'&&['commandExecution','fileChange','mcpToolCall'].includes(event.data?.item?.type))});
 report.events=work.events;report.passed=report.checks.every(check=>check.passed);
}catch(error){report.passed=false;report.error=error.message;}
finally{await executor.stop();store.close();report.finishedAt=new Date().toISOString();await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({report:join(evidence,'report.json'),passed:report.passed,checks:report.checks}));
if(!report.passed)process.exitCode=1;
