const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
export async function createCapability({ version }) {
  let pending = 0;
  return {
    tools: [{ name: 'echo', description: 'Explicit independent service protocol fixture', inputSchema: { type: 'object' }, effect: 'read' },
      { name: 'background', description: 'Start fixture work owned by this process', inputSchema: { type: 'object' }, effect: 'write' }],
    async callTool(name, args, context, signal) {
      if (name === 'background') { pending++; setTimeout(() => { pending--; }, args.ms || 250); return { accepted: true, version }; }
      if (args.ms) await sleep(args.ms, signal);
      return { version, pid: process.pid, text: args.text, actor: context.actor };
    },
    operations: { echo: async value => ({ value, version }) },
    pendingWork: () => pending,
  };
}
