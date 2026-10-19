import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.mjs';

// Uses the configured real DeepSeek endpoint. All conversations and files are isolated.
const evidence = resolve('.relay', 'evidence', `pi-agent-${new Date().toISOString().replaceAll(':', '-')}`);
const project = await mkdtemp(join(tmpdir(), 'relay-pi-live-'));
const dataDir = join(evidence, 'data');
await mkdir(dataDir, { recursive: true });
const config = { dataDir, database: join(dataDir, 'relay.sqlite'), defaultCwd: project, port: 0 };
let app = await startServer({ config });
const report = { startedAt: new Date().toISOString(), evidence, project, provider: 'real configured deepseek-flash', bots: [], checks: {} };
const pause = ms => new Promise(resolveDone => setTimeout(resolveDone, ms));
const call = async (path, body) => {
  const response = await fetch(app.url + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
};
console.log(JSON.stringify({ liveUrl: app.url, evidence }));
try {
  for (const botId of ['bot-engineer', 'bot-components', 'bot-qa']) {
    const marker = randomUUID();
    const source = join(project, `${botId}.txt`);
    await writeFile(source, `验证资料\n验证标记：${marker}\n组件名称：真实文件组件\n`, 'utf8');
    const room = await call('/api/rooms', { kind: 'dm', name: `${botId} 真实工具验收`, members: ['user', botId] });
    const prompt = `请你亲自完成一个文件操作验收，不委托 Codex，不联系其他同事。已授权本任务目录内操作。按顺序使用：
1. list_files 列出共享目录 ${project}。
2. search_files 在该目录搜索“验证标记”。
3. read_file 读取 ${source}，从实际文件取得验证标记，不能猜测。
4. write_file 在你的个人工作目录写 result.md，包含本文件的验证标记、组件名称和独立一行“状态：初稿”。
5. edit_file 将 result.md 的唯一“状态：初稿”改成“状态：完成”。
6. run_command 在个人工作目录用 PowerShell Get-Content -LiteralPath 'result.md' -Raw 实际读取该文件。
7. read_file 再读回 result.md，确认标记和完成状态。
8. relay_action 保存一条professional记忆，记录这次读回的结果文件路径和实际验证标记。
完成后报告真实结果、完整文件路径和命令退出码。不要把待执行动作写进最终 actions。`;
    const message = await call(`/api/rooms/${room.id}/messages`, { content: prompt });
    let run;
    for (let attempt = 0; attempt < 720; attempt++) {
      run = app.agentRuntime.list().find(item => item.roomId === room.id);
      if (run && run.status !== 'running') break;
      await pause(500);
    }
    assert.equal(run?.status, 'completed', JSON.stringify(run));
    const detail = await call(`/api/agent-runs/${run.id}`);
    const required = ['list_files', 'search_files', 'read_file', 'write_file', 'edit_file', 'run_command', 'relay_action'];
    for (const name of required) assert.ok(detail.tools.some(tool => tool.name === name && tool.status === 'completed'), `${botId} missing successful ${name}`);
    const outputPath = join(run.workspace, 'result.md');
    const output = await readFile(outputPath, 'utf8');
    assert.ok(output.includes(marker)); assert.ok(output.includes('状态：完成')); assert.ok(!output.includes('状态：初稿'));
    const command = detail.tools.find(tool => tool.name === 'run_command' && tool.status === 'completed');
    assert.equal(command.result.details.exitCode, 0); assert.ok(command.result.details.stdout.includes(marker));
    assert.ok(app.store.list('memories').some(memory => memory.botId === botId && memory.content.includes(marker)));
    assert.equal(app.executor.list().length, 0, 'Basic operation unexpectedly delegated to Codex');
    const result = { botId, roomId: room.id, messageId: message.id, runId: run.id, toolCount: detail.tools.length, turns: run.turns,
      marker, outputPath, output, sha256: createHash('sha256').update(output).digest('hex'), commandExitCode: command.result.details.exitCode,
      commandOutputMatches: true, independentReadbackMatches: true };
    report.bots.push(result);
    await writeFile(join(evidence, `${botId}-run.json`), JSON.stringify(detail, null, 2));
    await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ botId, status: 'verified', toolCount: result.toolCount, outputPath }));
  }
  for (let i = 0; i < 40 && app.social.running.size; i++) await pause(50);
  const before = { bots: app.store.list('bots').map(item => item.id), rooms: app.store.list('rooms').map(item => item.id),
    messages: app.store.list('messages').map(item => item.id), tools: app.store.list('toolRuns').length, runs: app.agentRuntime.list().map(item => item.id) };
  await app.close(); app = await startServer({ config });
  const after = { bots: app.store.list('bots').map(item => item.id), rooms: app.store.list('rooms').map(item => item.id),
    messages: app.store.list('messages').map(item => item.id), tools: app.store.list('toolRuns').length, runs: app.agentRuntime.list().map(item => item.id) };
  assert.deepEqual(after, before); assert.equal(app.agentRuntime.active.size, 0);
  report.checks = { allThreeBots: true, realModelToolLoop: true, fileReadWriteSearchEditCommand: true, memory: true, noCodexDelegation: true, restartPersistence: true };
  report.finishedAt = new Date().toISOString(); report.liveUrl = app.url;
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: 'passed', evidence, liveUrl: app.url }));
  if (process.argv.includes('--serve')) {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } else await app.close();
} catch (error) {
  report.error = error.message; report.runs = app.agentRuntime.list();
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify({ status: 'failed', error: error.message, evidence }));
  await app.close(); process.exitCode = 1;
}
