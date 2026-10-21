import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, jsonToolResult } from '../src/capabilities/registry.mjs';

test('side effect with a failed durable completion receipt is unknown and never automatically retried', async () => {
  let executed = 0; const records = [];
  const registry = new ToolRegistry({ record: record => { if (record.status === 'completed') throw new Error('fixture receipt storage failed'); records.push(record); } });
  registry.register({ name: 'mutate', description: 'fixture mutation', inputSchema: { type: 'object', properties: {} }, effect: 'write',
    execute: async () => { executed++; return jsonToolResult({ applied: true }); } });
  await assert.rejects(registry.invoke('mutate', {}), /receipt storage failed/);
  assert.equal(executed, 1); assert.deepEqual(records.map(record => record.status), ['running', 'unknown']);
});
