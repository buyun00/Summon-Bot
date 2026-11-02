import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContextMaintenance } from '../../bot/src/context/maintenance.mjs';
import { writeKnowledgeDocument } from '../../bot/src/context/knowledge-api.mjs';
import { createRedactor } from '../../bot/src/runtime/config.mjs';

/** The Web memory editor reads/writes the same Markdown used by maintenance. */
export class MemoryManagement {
  constructor({ store, manager, dataRoot, emit = () => {} }) { Object.assign(this, { store, manager, dataRoot, emit }); }
  async list(botId) {
    const scopes = await this.manager.readState(botId, db => db?.listRecords('knowledge_scope') || []);
    return Promise.all(scopes.map(async scope => ({ id: scope.id, title: scope.title, revision: scope.revision, botId,
      workId: scope.workId, status: 'active', text: await readFile(join(this.manager.directory(botId), 'knowledge', scope.file), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }) })));
  }
  async write(botId, input) {
    if (await this.manager.identity(botId)) return this.manager.request(botId, '/knowledge', { method: 'POST', body: JSON.stringify(input) });
    const api = await this.manager.botApi();
    return api.withBotDataLease(this.manager.directory(botId), async () => {
      const config = await this.manager.config(botId), db = new api.BotStore(join(this.manager.directory(botId), 'state.sqlite'));
      try {
        await mkdir(join(config.dataDir, 'knowledge'), { recursive: true });
        const maintenance = new ContextMaintenance({ config, store: db, clean: createRedactor(config), emit: this.emit });
        return await writeKnowledgeDocument(maintenance, db, input);
      } finally { db.close(); }
    }, { botId, purpose: 'write-knowledge' });
  }
}
