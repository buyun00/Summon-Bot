import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { resolve, join } from 'node:path';

const [keyFile, keyId] = process.argv.slice(2);
if (!keyFile || !/^[A-Z0-9]{10}$/.test(keyId || '')) throw new Error('Usage: node scripts/ios/configure-apns.mjs PRIVATE_P8_FILE KEY_ID');
const raw = await readFile(resolve(keyFile));
const key = createPrivateKey(raw);
if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Expected an APNs P-256 private key');
// This does not prove Apple granted APNs access; confirm the key in the Developer portal.
const root = 'D:/Relay-Bot-data/config';
await mkdir(root, { recursive: true });
await writeFile(join(root, 'apns.p8'), raw, { mode: 0o600 });
await writeFile(join(root, 'apns.json'), JSON.stringify({ teamId: '6Y29E7PSVF', keyId, bundleId: 'org.lin0.summon' }, null, 2), { mode: 0o600 });
console.log('APNs configuration saved in the production data root. Restart the existing gateway to activate it.');
