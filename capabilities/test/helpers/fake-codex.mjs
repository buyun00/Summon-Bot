// Explicit protocol test double. This is never used by the application.
import { createInterface } from 'node:readline';
let threadId = 'test-thread';
let turnId = 'test-turn';
let pending = false;
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
function finish(text = 'Protocol fixture complete') {
  const item = { id: 'answer', type: 'agentMessage', phase: 'final_answer', text };
  notify('item/completed', { threadId, turnId, item });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [item] } });
}
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (!method && pending && id === 900) { pending = false; finish(message.result.contentItems?.[0]?.text || JSON.stringify(message.result.answers)); }
  else if (method === 'initialize') reply(id, { userAgent: 'test-double' });
  else if (method === 'thread/start') reply(id, { thread: { id: threadId }, model: 'TEST_DOUBLE', reasoningEffort: 'low' });
  else if (method === 'thread/resume') { threadId = params.threadId; reply(id, { thread: { id: threadId }, model: 'TEST_DOUBLE', reasoningEffort: 'low' }); }
  else if (method === 'turn/start') {
    const text = params.input?.[0]?.text || '';
    reply(id, { turn: { id: turnId, status: 'inProgress', items: [] } });
    notify('turn/started', { threadId, turn: { id: turnId } });
    if (text.includes('REQUEST_USER_INPUT')) {
      pending = true;
      send({ id: 900, method: 'item/tool/requestUserInput', params: { threadId, turnId, questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Blue' }] }] } });
    } else if (text.includes('CONSULT')) {
      pending = true;
      send({ id: 900, method: 'item/tool/call', params: { threadId, turnId, callId: 'test-call', tool: 'summon_consult', arguments: { question: 'What is the project fact?', targetBotId: 'expert' } } });
    } else if (!text.includes('HOLD')) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: 'Protocol fixture' });
      setTimeout(() => finish(), 10);
    }
  } else if (method === 'turn/interrupt') {
    reply(id, {});
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } });
  } else if (method === 'turn/steer') { reply(id, { turnId }); finish(params.input[0].text); }
}
