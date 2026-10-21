import test from 'node:test';
import assert from 'node:assert/strict';
import { BotStore } from '../src/index.mjs';

test('unfinished maintenance facts include old interrupted work beyond the paginated 10000-task history', () => {
  const store = new BotStore(':memory:');
  try {
    const old = store.acceptMessage({ id: 'old', content: 'unconfirmed' }, 'controller', 'prior-boot').task;
    store.updateTask(old.id, { status: 'interrupted' });
    store.transaction(() => {
      const insert = store.db.prepare('INSERT INTO tasks(id,session_id,status,data) VALUES(?,?,?,?)');
      for (let index = 0; index < 10001; index++) insert.run(`done-${index}`, 'history', 'completed', JSON.stringify({ id: `done-${index}`, status: 'completed' }));
    });
    assert.equal(store.listTasks({ limit: 10000 }).some(task => task.id === old.id), false);
    assert.deepEqual(store.listUnfinishedTasks().map(task => task.id), [old.id]);
  } finally { store.close(); }
});
