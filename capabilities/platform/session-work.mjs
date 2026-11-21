import { keyOf } from './contract.mjs';
import { serviceMethod } from '../services/service-connection.mjs';

export function workGroup(session) {
  return keyOf(session.origin_room?.id, session.origin_message_id ?? session.id);
}

export function unresolvedForward(call) {
  return Boolean(call?.origin?.fast_read_forward && (['prepared', 'unknown'].includes(call.status) ||
    call.status === 'submitted' && !call.result_ref));
}

export function forwardMaterials(message) {
  return [{ kind: 'event', id: message.id }, ...(message.attachments || []).map(file => ({ kind: 'file', id: file.id })),
    ...(message.references || []).filter(ref => ['event', 'file'].includes(ref.kind))];
}

function serviceInputSchema(connection, kind) {
  const lifecycle = connection?.config?.lifecycle;
  const method = lifecycle?.[`${kind}_method`];
  if (!method) return;
  const schema = serviceMethod(connection, method)?.inputSchema;
  const bindings = lifecycle.method_arguments?.[method] ?? { input: 'input' };
  const fields = Object.entries(bindings).filter(([, source]) => source === 'input')
    .map(([name]) => schema?.properties?.[name] ?? schema?.additionalProperties ?? true);
  if (!fields.length) return false;
  return fields.length === 1 ? fields[0] : { allOf: fields };
}

// Describe each native input independently. The adapter validates the submitted value.
export function forwardInputs(targets = [], pending = [], connection) {
  const forwardable = [], nonForwardable = [];
  const requests = new Map(pending.map(request => [request.id, request]));
  for (const { input_target, kinds } of targets) {
    for (const kind of kinds) {
      const request = kind === 'reply' ? requests.get(input_target.request_id) : undefined;
      const schema = input_target.kind === 'service_call' ? serviceInputSchema(connection, kind) : undefined;
      const option = { kind, input_target, ...(request && { question: request.question ?? request.text,
        answer_format: request.answer_format, choices: request.choices, request_kind: request.kind }),
        ...(schema !== undefined && { input_schema: schema }) };
      const nativePrompt = request && (request.kind === 'approval' || request.plain_text === false ||
        request.choices?.length || request.schema || request.has_schema);
      const structured = schema === false || schema?.enum || schema?.const !== undefined ||
        (schema?.type && ![schema.type].flat().includes('string'));
      if (nativePrompt || structured || kind === 'reply' && !request && input_target.kind !== 'service_call') {
        nonForwardable.push({ ...option, reason: request?.kind === 'approval' ? 'approval' : 'structured_input' });
      } else {
        forwardable.push(option);
      }
    }
  }
  return { forwardable, nonForwardable };
}
