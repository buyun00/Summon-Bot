import { required, fail, pick, now } from '../shared/validation.mjs';
export class KnowledgeService {
  constructor({store,emit=()=>{}}) { Object.assign(this,{store,emit}); }
  expire() { for (const node of this.store.list('nodes')) if (node.status !== 'expired' && node.expiresAt && new Date(node.expiresAt) <= new Date()) this.saveNode({...node,status:'expired'}); }
  saveNode(input) {
    const previous = input.id && this.store.get('nodes',input.id);
    if (previous && input.workspaceProfileId !== undefined && (previous.workspaceProfileId || null) !== input.workspaceProfileId) fail('Knowledge belongs to another workspace', 403);
    if (input.expectedRevision !== undefined && (previous?.revision || 0) !== input.expectedRevision) fail('Knowledge revision conflict',409);
    const type = input.type || input.knowledgeType || previous?.type || 'unverified', status = input.status || previous?.status || 'active';
    if (!['fact','hypothesis','opinion','unverified'].includes(type) || !['active','disputed','expired'].includes(status)) fail('Invalid knowledge type/status');
    const record = this.store.save('nodes',{...previous,...pick(input,['id','source','version','expiresAt','workspaceProfileId']),title:required(input.title ?? previous?.title,'title',300),content:required(input.content ?? previous?.content),type,status,revision:(previous?.revision||0)+1,history:previous?[...(previous.history||[]),{...previous,history:undefined}]:[]});
    this.emit('knowledge',record); return record;
  }
  saveEdge(input) {
    const from=this.store.get('nodes',input.from),to=this.store.get('nodes',input.to);
    if (!from || !to || input.from===input.to || (from.workspaceProfileId||null)!==(to.workspaceProfileId||null) ||
        input.workspaceProfileId!==undefined&&(from.workspaceProfileId||null)!==input.workspaceProfileId) fail('Invalid knowledge endpoints');
    const relation=required(input.relation,'relation',200), previous=this.store.list('edges').find(edge=>edge.from===input.from && edge.to===input.to && edge.relation===relation);
    const record=this.store.save('edges',{...previous,...pick(input,['id','from','to','source','version']),relation,status:input.status||'active'}); this.emit('knowledge',record); return record;
  }
  search(query='',workspaceProfileId=null) {
    this.expire(); const terms=String(query).toLowerCase().split(/[\s，。！？、,;:：!?]+/).filter(Boolean);
    const nodes=this.store.list('nodes').filter(node=>(node.workspaceProfileId||null)===workspaceProfileId && node.status!=='expired' && (!terms.length || terms.some(term=>`${node.title} ${node.content}`.toLowerCase().includes(term))));
    return {nodes,edges:this.store.list('edges').filter(edge=>nodes.some(node=>node.id===edge.from||node.id===edge.to))};
  }
  graph(id,depth=1,workspaceProfileId=null) { const nodes=this.store.list('nodes').filter(node=>(node.workspaceProfileId||null)===workspaceProfileId),nodeIds=new Set(nodes.map(node=>node.id)),edges=this.store.list('edges').filter(edge=>nodeIds.has(edge.from)&&nodeIds.has(edge.to)); if (!id) return {nodes,edges}; if (!nodeIds.has(id)) fail('Knowledge not found',404); const selected=new Set([id]); for(let i=0;i<Math.max(0,Math.min(3,Number(depth)));i++) for(const edge of edges) if(selected.has(edge.from)||selected.has(edge.to)){selected.add(edge.from);selected.add(edge.to);} return {nodes:nodes.filter(node=>selected.has(node.id)),edges:edges.filter(edge=>selected.has(edge.from)&&selected.has(edge.to))}; }
}
