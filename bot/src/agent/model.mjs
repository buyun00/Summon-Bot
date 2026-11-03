import { modelConnection, connectionModel } from './connections.mjs';
export function modelFor(config) { return connectionModel(modelConnection(config.model)); }
