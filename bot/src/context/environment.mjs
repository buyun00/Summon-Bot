export const environmentScopeId = 'environment:local';

export function isEnvironmentInitializationSource(source) {
  return source?.source === 'controller' && source.actor === 'system' &&
    source.metadata?.sourceType === 'workspace-onboarding';
}
