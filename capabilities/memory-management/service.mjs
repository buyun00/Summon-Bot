import { createHash,randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail,required,now } from '../shared/validation.mjs';
const hash = memory => createHash('sha256').update(JSON.stringify(memory.text??memory.content??'')).digest('hex');
export class MemoryManagement {
  constructor({store,manager,dataRoot,emit=()=>{}}){Object.assign(this,{store,manager,dataRoot,emit});this.pending=new Map();}
  once(key,operation){if(this.pending.has(key))return this.pending.get(key);const work=operation().finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;}
  async list(botId) {return this.manager.readState(botId,db=>db?.listMemories()||[]);}
  async write(botId,input) {
    if(await this.manager.identity(botId)) {const existing=input.id&&(await this.list(botId)).find(memory=>memory.id===input.id);return this.manager.request(botId,existing?`/memories/${encodeURIComponent(input.id)}`:'/memories',{method:existing?'PATCH':'POST',body:JSON.stringify({...input,text:input.text??input.content,...(existing?{expectedRevision:input.expectedRevision??existing.revision}:{})})});}
    const api=await this.manager.botApi(),db=new api.BotStore(join(this.manager.directory(botId),'state.sqlite'));
    try{return db.putMemory({...input,text:input.text??input.content});}finally{db.close();}
  }
  async deliver(input) {
    return this.once(`deliver:${input.requestId}`,()=>this.deliverNow(input));
  }
  async deliverNow(input) {
    const requestId=required(input.requestId,'requestId',200),existing=this.manager.store.get('deliveries',requestId);if(existing){if(existing.childId!==input.childId)fail('Delivery receipt belongs to another Bot',409);return existing;}
    const relation=this.manager.store.list('derivations').find(item=>item.childId===input.childId);if(!relation)fail('No managed derivation found');
    const memories=await this.list(input.childId),baseline=new Map(relation.baseline.map(item=>[item.id,item]));
    const changes=memories.filter(memory=>!baseline.has(memory.id)||hash(memory)!==baseline.get(memory.id).hash).map(memory=>({...memory,baseline:baseline.get(memory.id)||null}));
    const directory=join(this.dataRoot,'capabilities','bot-management','deliveries',createHash('sha256').update(requestId).digest('hex'));await mkdir(directory,{recursive:true});
    if(existsSync(join(directory,'result.json'))){const recovered=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));if(recovered.childId!==input.childId)fail('Delivery receipt belongs to another Bot',409);return this.manager.store.save('deliveries',recovered);}
    const source=join(this.manager.directory(input.childId),'artifacts');if(existsSync(source))await this.manager.copyOwned(source,join(directory,'artifacts'));
    const result={id:requestId,parentId:relation.parentId,childId:input.childId,derivationId:relation.id,status:'delivered',mergeStatus:'pending',result:String(input.result||''),memories:changes,artifactDirectory:join(directory,'artifacts'),deliveredAt:now()};
    await writeFile(join(directory,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
    const record=this.manager.store.save('deliveries',result);this.emit('delivery',record);return record;
  }
  async propose(deliveryId) {
    const delivery=this.manager.store.get('deliveries',deliveryId);if(!delivery)fail('Delivery not found',404);
    const previous=this.store.get('proposals',deliveryId);if(previous)return previous;
    const current=new Map((await this.list(delivery.parentId)).map(memory=>[memory.id,memory]));
    const items=delivery.memories.map(memory=>{const target=current.get(memory.id),same=target&&hash(target)===hash(memory),conflict=!same&&target&&(memory.baseline?target.revision!==memory.baseline.revision:true);return {id:memory.id,source:memory,current:target||null,expectedRevision:target?.revision||0,status:same?'unchanged':conflict?'conflict':'ready'};});
    return this.store.save('proposals',{id:deliveryId,parentId:delivery.parentId,childId:delivery.childId,status:items.some(item=>item.status==='conflict')?'conflict':'ready',items});
  }
  async merge(deliveryId,{resolutions={}}={}) {
    return this.once(`merge:${deliveryId}`,()=>this.mergeNow(deliveryId,{resolutions}));
  }
  async mergeNow(deliveryId,{resolutions={}}={}) {
    let proposal=await this.propose(deliveryId);if(proposal.status==='merged')return proposal;
    const items=[];
    for(const item of proposal.items){
      if(['applied','unchanged','rejected'].includes(item.status)){items.push(item);continue;}
      const resolution=resolutions[item.id];
      if(item.status==='conflict'&&!resolution){items.push(item);continue;}
      if(resolution?.action==='reject'){items.push({...item,status:'rejected',resolution});continue;}
      const current=(await this.list(proposal.parentId)).find(memory=>memory.id===item.id);
      if(current&&hash(current)===hash(item.source)){items.push({...item,status:'applied',appliedRevision:current.revision});continue;}
      if((current?.revision||0)!==item.expectedRevision){items.push({...item,status:'conflict',current:current||null,expectedRevision:current?.revision||0});continue;}
      try{const saved=await this.write(proposal.parentId,{id:item.id,text:resolution?.text??item.source.text??item.source.content,title:item.source.title,tags:item.source.tags,source:{kind:'derived-memory',botId:proposal.childId,deliveryId,original:item.source.source,conflictResolution:resolution||null},expectedRevision:item.expectedRevision});items.push({...item,status:'applied',appliedRevision:saved.revision});}
      catch(error){if(error.status===409||/conflict/i.test(error.message))items.push({...item,status:'conflict',error:error.message});else throw error;}
      // Durable per-item receipt makes a retry after a partial merge idempotent.
      proposal=this.store.save('proposals',{...proposal,items:[...items,...proposal.items.slice(items.length)]});
    }
    const status=items.some(item=>item.status==='conflict')?'conflict':'merged';proposal=this.store.save('proposals',{...proposal,status,items,processedAt:now()});this.manager.store.save('deliveries',{id:deliveryId,mergeStatus:status});this.emit('memory-merge',proposal);return proposal;
  }
}
