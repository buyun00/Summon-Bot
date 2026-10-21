import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sdkName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/** Standard MCP initialize/listTools/callTool over SDK transports. A stdio
 * server is an explicitly configured external capability, not another Bot.
 * Credentials/environment have already been resolved by the configuration
 * loader; never pass the Bot's entire environment to the child server.
 */
export async function connectMcpTools(definition, {
  botId, workspace, signal, headers = {}, environment = {}, redact = value => String(value),
}) {
  const timeout = definition.timeoutMs ?? 30000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new TypeError('MCP timeoutMs must be an integer from 1 to 300000');
  const options = requestSignal => ({ signal: requestSignal, timeout, maxTotalTimeout: timeout, resetTimeoutOnProgress: false });
  let transport;
  if (definition.transport === 'stdio') {
    if (typeof definition.command !== 'string' || !definition.command.trim() ||
        (definition.args !== undefined && (!Array.isArray(definition.args) || definition.args.some(arg => typeof arg !== 'string')))) {
      throw new TypeError('MCP stdio requires a command and optional string args');
    }
    transport = new StdioClientTransport({ command: definition.command, args: definition.args || [],
      cwd: workspace, env: environment, stderr: 'pipe' });
    // stderr is diagnostics, never JSON-RPC; do not forward potentially secret
    // server diagnostics into public logs or leave its pipe blocked.
    transport.stderr?.resume();
  } else if (definition.transport === 'http') {
    const url = new URL(definition.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new TypeError('MCP HTTP requires an HTTP(S) URL without embedded credentials');
    }
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
  } else throw new TypeError('MCP transport must be stdio or http');

  const client = new Client({ name: `relay-bot-${botId}`, version: '1.0.0' }, { capabilities: {} });
  client.onerror = () => {}; // Individual protocol requests retain their errors.
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await client.close(); } finally { await transport.close(); }
  };
  try {
    signal?.throwIfAborted();
    await client.connect(transport, options(signal));
    const tools = [], cursors = new Set(), names = new Set();
    let cursor;
    do {
      signal?.throwIfAborted();
      const page = await client.listTools(cursor ? { cursor } : undefined, options(signal));
      for (const remote of page.tools) {
        // MCP names may include punctuation which model tool APIs reject.
        // Preserve the original protocol name; aliases must remain unambiguous.
        const name = `${definition.namePrefix || ''}${remote.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        if (!sdkName.test(name) || names.has(name)) throw new Error('MCP tools have invalid or colliding model names');
        if (remote.inputSchema?.type !== 'object') throw new Error(`MCP tool ${name} requires an object input schema`);
        names.add(name);
        tools.push({ name, description: redact(remote.description || `MCP tool ${remote.name}`),
          inputSchema: remote.inputSchema, effect: definition.effect || 'external',
          classify: result => result?.isError ? 'failed' : 'completed',
          async execute(args, context = {}) {
            if (closed) throw new Error('MCP capability is closed');
            context.signal?.throwIfAborted();
            // The SDK validates actual CallToolResult content, structuredContent
            // and isError; image/resource blocks are not flattened to text.
            return client.callTool({ name: remote.name, arguments: args }, undefined, options(context.signal));
          },
        });
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP tool pagination repeated a cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { tools, close };
  } catch (error) {
    await close().catch(() => {});
    // No original cause or server stderr is exposed: either can carry secrets.
    const failure = new Error(redact(error?.message || String(error)));
    failure.name = error?.name || 'Error';
    if (error?.code !== undefined) failure.code = error.code;
    throw failure;
  }
}
