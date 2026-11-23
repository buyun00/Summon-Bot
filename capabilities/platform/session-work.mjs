import { keyOf } from './contract.mjs';

export function workGroup(session) {
  return keyOf(session.origin_room?.id, session.origin_message_id ?? session.id);
}
