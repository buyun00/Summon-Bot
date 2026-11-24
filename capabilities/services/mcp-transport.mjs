import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

const effects = new Set(['read', 'write', 'process', 'external']);

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
  if (definition.toolEffects !== undefined && (!definition.toolEffects || Array.isArray(definition.toolEffects) || typeof definition.toolEffects !== 'object' ||
      Object.values(definition.toolEffects).some(effect => !effects.has(effect)))) throw new TypeError('MCP toolEffects must map remote tool names to effects');
  const options = (requestSignal, onprogress) => ({ signal: requestSignal, timeout, maxTotalTimeout: timeout,
    resetTimeoutOnProgress: false, ...(onprogress ? { onprogress } : {}) });
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
      requestInit: { headers, redirect: 'follow' },
      fetch: (input, init) => fetch(input, { ...init, redirect: 'follow' }),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
  } else throw new TypeError('MCP transport must be stdio or http');

  const client = new Client({ name: `summon-bot-${botId}`, version: '1.0.0' }, { capabilities: {} });
  client.onerror = () => {}; // Individual protocol requests retain their errors.
  let closed = false, connected = false, closing;
  client.onclose = () => { connected = false; };
  const close = () => closing ??= (async () => {
    closed = true; connected = false;
    try { await client.close(); } finally { await transport.close(); }
  })();
  const abortDiscovery = () => { void close().catch(() => {}); };
  async function listTools() {
    if (closed || !connected) throw Object.assign(new Error('MCP capability is disconnected'), { code: 'CAPABILITY_UNAVAILABLE' });
    const tools = [], remoteTools = new Map(), ambiguous = new Set(), cursors = new Set();
    let cursor;
    do {
      signal?.throwIfAborted();
      const page = await client.listTools(cursor ? { cursor } : undefined, options(signal));
      for (const remote of page.tools) {
        if (remoteTools.has(remote.name)) ambiguous.add(remote.name);
        else remoteTools.set(remote.name, remote);
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP tool pagination repeated a cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const validated = [];
    for (const [name, remote] of remoteTools) {
      if (ambiguous.has(name) || remote.inputSchema?.type !== 'object') {
        tools.push({ name, unavailable: ambiguous.has(name) ? 'MCP server reported duplicate method names' :
          'MCP method requires an object input schema' });
        continue;
      }
      validated.push(remote);
      const effect = definition.toolEffects?.[remote.name] || definition.effect || (remote.annotations?.readOnlyHint === true ? 'read' : 'external');
      const requiresTasks = remote.execution?.taskSupport === 'required';
      tools.push({ name, description: redact(remote.description || `MCP tool ${remote.name}`),
        inputSchema: remote.inputSchema, effect, requiresTasks,
        async execute(args, context = {}) {
          if (closed || !connected) throw Object.assign(new Error('MCP capability is disconnected; refresh the connection before use'), { code: 'CAPABILITY_UNAVAILABLE' });
          context.signal?.throwIfAborted();
          await context.beforeSubmit?.();
          // The SDK validates actual CallToolResult content, structuredContent
          // and isError; image/resource blocks are not flattened to text.
          try { return await client.callTool({ name: remote.name, arguments: args }, undefined, options(context.signal, context.onProgress)); }
          catch (error) {
            // Explicit tool isError results remain ordinary failed receipts.
            // A lost/invalid reply, timeout or disconnect after dispatch cannot
            // establish whether a remote mutation happened. Do not reconnect
            // and resend it. Only definite transport/protocol rejections are
            // known failures here; malformed successful replies stay unknown.
            const rejection = (Number.isInteger(error.code) && error.code >= 400 && error.code < 500) ||
              (error instanceof McpError && ![ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout].includes(error.code) &&
                !/output schema|structured content/i.test(error.message));
            if (effect !== 'read' && !rejection) {
              throw Object.assign(new Error(`${error?.message || String(error)}. The remote outcome is unknown; query the original operation or external state before another write. This request was not retried.`),
                { name: error?.name || 'Error', outcomeUnknown: true, code: 'REMOTE_OUTCOME_UNKNOWN' });
            }
            throw error;
          }
        },
      });
    }
    // The SDK refreshes its output-schema cache for each listTools page. Retain
    // validation for every tool, including those returned before the last page.
    client.cacheToolMetadata(validated);
    return tools;
  }

  try {
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abortDiscovery, { once: true });
    await client.connect(transport, options(signal));
    signal?.throwIfAborted();
    connected = true;
    let tools = await listTools(), refreshing;
    return {
      get tools() { return tools; },
      refresh: () => refreshing ??= listTools().then(next => { tools = next; }).finally(() => { refreshing = null; }),
      connected: () => !closed && connected,
      close,
      serverInfo: client.getServerVersion(),
    };
  } catch (error) {
    await close().catch(() => {});
    // No original cause or server stderr is exposed: either can carry secrets.
    const failure = new Error(redact(error?.message || String(error)));
    failure.name = error?.name || 'Error';
    if (error?.code !== undefined) failure.code = error.code;
    throw failure;
  } finally { signal?.removeEventListener('abort', abortDiscovery); }
}
