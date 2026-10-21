/** Lossless bridge for configured SDK-shaped tools; no business names here. */
export function registerSdkTools(registry, tools) {
  for (const tool of tools) registry.register({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema || tool.parameters,
    effect: tool.effect || 'read', implementation: 'sdk', sdk: tool,
    execute: (args, context) => tool.execute(context.toolCallId, args, context.signal, context.emitProgress),
    classify: result => result?.isError ? 'failed' : 'completed',
  });
  return registry;
}
