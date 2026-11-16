export function usesPromptFile(recipe) {
  return [...recipe.args, ...(recipe.resume_args || [])].some(arg => arg.includes('{{prompt_file}}'));
}

export function recipeAdapter(recipe) {
  const valueAt = (frame, path) => path?.split('.').reduce((value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined, frame);
  const matches = (frame, rule) => rule && valueAt(frame, rule.path) === rule.equals;
  return {
    invocation({ text, sessionId, promptFile }) {
      const parameters = { text, session_id: sessionId ?? '', prompt_file: promptFile };
      const template = sessionId ? recipe.resume_args : recipe.args;
      return { args: template.map(arg => arg.replace(/\{\{(text|session_id|prompt_file)\}\}/g, (_, field) => parameters[field])),
        ...(recipe.stdin ? { stdin: text } : {}) };
    },
    receive(frame) {
      const terminal = recipe.complete_when ? matches(frame, recipe.complete_when) : recipe.output === 'json';
      const successful = !recipe.success_when || matches(frame, recipe.success_when);
      return { terminal, reason: successful ? 'completed' : 'failed', sessionId: valueAt(frame, recipe.session_id),
        progress: valueAt(frame, recipe.progress), text: terminal ? valueAt(frame, recipe.result) : undefined,
        error: valueAt(frame, recipe.error) };
    },
    success: reason => reason === 'completed',
  };
}
