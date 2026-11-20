import { keyOf } from './contract.mjs';

export function workGroup(session) {
  return keyOf(session.origin_room?.id, session.origin_message_id ?? session.id);
}

export function forwardMaterials(message) {
  return [{ kind: 'event', id: message.id }, ...(message.attachments || []).map(file => ({ kind: 'file', id: file.id })),
    ...(message.references || []).filter(ref => ['event', 'file'].includes(ref.kind))];
}

// The same classification is used for the model's snapshot and at native submission.
export function forwardInputs(targets = [], pending = [], protocol) {
  const forwardable = [], nonForwardable = [];
  const requests = new Map(pending.map(request => [request.id, request]));
  const nativeText = ['pi', 'codex', 'cli'].includes(protocol);
  for (const { input_target, kinds } of targets) {
    for (const kind of kinds) {
      const question = requests.get(input_target.request_id);
      if (kind === 'reply') {
        if (nativeText && question?.plain_text === true && question.kind === 'question' && !question.choices?.length)
          forwardable.push({ kind, input_target, question: question.question ?? question.text });
        else nonForwardable.push({ kind, reason: question?.kind === 'approval' ? 'approval' : 'structured_input',
          question: question?.question ?? question?.text });
      } else if (nativeText && !pending.length && !targets.some(option => option.kinds.includes('reply')) && ['steer', 'next'].includes(kind)) {
        forwardable.push({ kind, input_target });
      } else if (!nativeText) nonForwardable.push({ kind, reason: 'structured_input' });
    }
  }
  return { forwardable, nonForwardable };
}
