import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function renderAgentArtifacts('), source.indexOf('function renderAgentContext('));
const context = vm.createContext({
  encodeURIComponent,
  esc: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  icon: () => '<svg></svg>',
  attachmentSize: value => `${value} bytes`,
});
vm.runInContext(code, context);
const artifactId = '12345678-1234-4123-8123-123456789abc';

test('tool artifacts render only scoped download IDs, never stored disk paths or supplied URLs', () => {
  const html = context.renderAgentArtifacts('run-1', { id: 'tool:1/中文', artifacts: [{
    id: artifactId, name: '中文 输出 <img onerror=x>.txt', size: 90000,
    url: 'https://example.invalid/collect', path: 'C:/private/secret.txt',
  }, { id: '../outside', name: 'bad' }] });
  assert.ok(html.includes(`href="/api/agent-runs/run-1/tools/tool%3A1%2F%E4%B8%AD%E6%96%87/artifacts/${artifactId}"`));
  assert.ok(html.includes('90000 bytes'));
  assert.ok(html.includes('中文 输出 &lt;img onerror=x&gt;.txt'));
  for (const forbidden of ['example.invalid', 'C:/private', '../outside', '<img onerror']) assert.ok(!html.includes(forbidden));
});

test('tool artifact rendering tolerates legacy runs and rejects unsafe parent IDs', () => {
  assert.equal(context.renderAgentArtifacts('run-1', { id: 'tool:1' }), '');
  assert.equal(context.renderAgentArtifacts('..', { id: 'tool:1', artifacts: [{ id: artifactId }] }), '');
  assert.equal(context.renderAgentArtifacts('run-1', { id: '\0', artifacts: [{ id: artifactId }] }), '');
  assert.equal(context.renderAgentArtifacts('\ud800', { id: 'tool:1', artifacts: [{ id: artifactId }] }), '');
});

