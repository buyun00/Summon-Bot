import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeProbeArgs, reject, validateCliProbe } from '../platform/contract.mjs';
import { inspectNative } from './native-host.mjs';
import { validNativeEncoding } from './windows-native-text.mjs';

export function validateNativeProbe(rules) {
  validateCliProbe(rules);
  if (Object.values(rules.encoding ?? {}).some(value => !validNativeEncoding(value)))
    reject('invalid_probe_encoding', 'Use auto or a supported text encoding for stdout and stderr');
  return { ...rules, encoding: { stdout: 'auto', stderr: 'auto', ...rules.encoding } };
}

function standardProbe(name) {
  if (name === 'ssh') return { version: { args: ['-V'] }, help: { args: ['-?'], exit_codes: [0, 255] } };
  if (['ffmpeg', 'ffprobe', 'ffplay'].includes(name))
    return { version: { args: ['-version'] }, help: { args: ['-h'] } };
  return { version: { args: ['--version'] }, help: { args: ['--help'] } };
}

export function visibleProbe(rules) {
  if (!rules) return undefined;
  const { script, ...config } = rules;
  return script ? { ...config, script: { path: script.path, runner: script.runner, inline: script.source !== undefined } } : config;
}

function outputOf(result, stream) {
  if (stream === 'stdout' || stream === 'stderr') return result[stream] ?? '';
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function readVersion(result, read) {
  const line = outputOf(result, read?.stream).trim().split(/\r?\n/)[read?.line ?? 0]?.trim() ?? '';
  return (read?.word === undefined ? line : line.split(/\s+/)[read.word] ?? '').slice(0, 240);
}

function classify(result, accepted, text) {
  if (result.interrupted) return 'probe_interrupted';
  if (result.timeout) return 'probe_timeout';
  if (result.error || result.exitCode == null) return 'probe_process_failed';
  if (!accepted.includes(result.exitCode)) return 'unexpected_exit';
  return text.trim() ? 'observed' : 'empty_output';
}

function observation(purpose, result, status) {
  return { purpose, status, ...result, stdout: result.stdout.slice(0, 2500), stderr: result.stderr.slice(0, 2500) };
}

async function withScript(script, run) {
  if (script?.source === undefined) return run(script?.path);
  const directory = await mkdtemp(join(tmpdir(), 'summon-cli-probe-'));
  const file = join(directory, 'probe.mjs');
  try {
    await writeFile(file, script.source, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return await run(file);
  } finally {
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
}

export async function observeNativeProbe({ file, name, cwd, rules, source, topic, diagnosticArgs, script, signal, authorize }) {
  const probe = rules ?? standardProbe(name);
  const encoding = { stdout: 'auto', stderr: 'auto', ...probe.encoding };
  if (topic && !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,119}$/.test(topic))
    reject('invalid_help_topic', 'Use a CLI help topic name');
  if (diagnosticArgs !== undefined && !nativeProbeArgs(diagnosticArgs))
    reject('invalid_probe', 'Use a bounded argument array for the diagnostic');
  const inspect = (args, target = file, input) => inspectNative(target, args, cwd, { encoding, signal, input });
  const [version, help, topicHelp, diagnostic] = await withScript(script, async scriptPath => {
    await authorize?.();
    const run = (purpose, args) => scriptPath ?
      inspect([scriptPath], script.file, JSON.stringify({ summonProbe: { executable: file, purpose, args } }) + '\n')
        .then(result => ({ ...result, probe_args: args })) : inspect(args);
    return Promise.all([
      run('version', probe.version.args), run('help', probe.help.args),
      topic && name !== 'ssh' ? inspect([topic, '--help']) : null,
      diagnosticArgs !== undefined ? inspect(diagnosticArgs) : null,
    ]);
  });
  const versionText = readVersion(version, probe.version.read);
  const helpText = outputOf(help, probe.help.stream);
  const main = [
    observation('version', version, classify(version, probe.version.exit_codes ?? [0], versionText)),
    observation('help', help, classify(help, probe.help.exit_codes ?? [0], helpText)),
  ];
  const processFailure = main.find(item => ['probe_interrupted', 'probe_timeout', 'probe_process_failed'].includes(item.status));
  const mismatched = main.filter(item => item.status !== 'observed').map(({ purpose, status }) => ({ purpose, status }));
  const status = processFailure?.status ?? (mismatched.length ? 'probe_rule_mismatch' : 'observed');
  const reason = {
    probe_rule_mismatch: 'The observed exit status or output did not match the version or help rule',
    probe_process_failed: 'The probe process could not launch or complete',
    probe_timeout: 'The probe did not finish before the native process timeout',
    probe_interrupted: 'The probe was interrupted',
  }[status];
  const extra = (purpose, result) => result ? [observation(purpose, result, classify(result, [0], outputOf(result)))] : [];
  return { status, ...(reason ? { reason, issues: mismatched } : {}), cwd,
    probe_source: source ?? 'default', rules: { ...visibleProbe(probe), encoding },
    version: main[0].status === 'observed' ? versionText : '', help: helpText,
    topic, topic_help: topicHelp ? outputOf(topicHelp) : '',
    observations: [...main, ...extra('topic_help', topicHelp), ...extra('diagnostic', diagnostic)] };
}
