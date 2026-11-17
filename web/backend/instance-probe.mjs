import { createHmac } from 'node:crypto';

export const instanceProof = (token, challenge) => createHmac('sha256', token)
  .update('summon-instance-probe:' + challenge).digest('base64url');
