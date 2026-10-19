// Real Flash regression: ask a colleague, then report back to the original conversation.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startServer } from '../src/server.mjs';

const directory = resolve('.relay/evidence', `dm-return-${Date.now()}`);
await mkdir(directory, { recursive: true });
const app = await startServer({ config: { port: 0, dataDir: directory, database: join(directory, 'relay.sqlite') } });
const report = { startedAt: new Date().toISOString(), checks: [] };
const until = async predicate => {
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const value = predicate();
    if (value) return value;
    const failed = app.store.list('jobs').find(job => job.status === 'failed');
    if (failed) throw new Error(failed.error);
    await new Promise(done => setTimeout(done, 300));
  }
  throw new Error('No return message after 90 seconds');
};
try {
  const room = app.social.createRoom({ kind: 'dm', name: '真实回传验证', members: ['user', 'bot-engineer'] });
  for (const content of ['请私聊组件伙伴，问它用什么模型和执行器，收到实际答复后回来回复我。不要创建其他工作。', '再私聊组件伙伴问它的职责是什么，收到后回来简短回复我。不要创建其他工作。']) {
    const request = app.social.postMessage(room.id, { content });
    const returned = await until(() => app.social.roomMessages(room.id).find(message => message.replyTo === request.id && message.peerReplyId));
    const colleague = app.store.get('messages', returned.peerReplyId);
    assert.equal(colleague.senderId, 'bot-components');
    assert.equal(returned.senderId, 'bot-engineer');
    assert.equal(returned.rootId, request.id);
    report.checks.push({ requestId: request.id, peerReplyId: colleague.id, returnedMessageId: returned.id, colleagueReply: colleague.content, returnedReply: returned.content });
    console.log(`PASS source return: ${returned.content}`);
  }
  assert.equal(app.store.list('rooms').filter(r => r.kind === 'dm' && r.members.includes('bot-components')).length, 1);
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; console.error(error); }
finally {
  report.provider = app.provider.status;
  await app.close();
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${join(directory, 'report.json')}`);
}
