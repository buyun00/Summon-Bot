import { readFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { writeJson } from '../build/files.mjs';

const [keyFile, keyId] = process.argv.slice(2);
if (!keyFile || !/^[A-Z0-9]{10}$/.test(keyId || '')) throw new Error('Usage: node scripts/ios/configure-apns.mjs PRIVATE_P8_FILE KEY_ID');
if (process.platform !== 'win32') throw new Error('Run APNs configuration on the Windows production host');
const raw = await readFile(resolve(keyFile));
const key = createPrivateKey(raw);
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Expected an APNs P-256 private key');
// This does not prove Apple granted APNs access; confirm the key in the Developer portal.
const root = 'D:/Relay-Bot-data/config';
await mkdir(root, { recursive: true });
const keyStage = join(root, `.apns-${randomUUID()}.tmp`);
try {
  await writeFile(keyStage, raw, { mode: 0o600, flag: 'wx', flush: true });
  await rename(keyStage, join(root, 'apns.p8'));
  await writeJson(join(root, 'apns.json'), { teamId: '6Y29E7PSVF', keyId, bundleId: 'org.lin0.summon' });
} finally { await unlink(keyStage).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
console.log('APNs configuration saved in the production data root. Restart the existing gateway to activate it.');
