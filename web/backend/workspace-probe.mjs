import { createHmac } from 'node:crypto';

export const workspaceProof = (token, challenge) => createHmac('sha256', token)
  .update('summon-workspace-probe:' + challenge).digest('base64url');
