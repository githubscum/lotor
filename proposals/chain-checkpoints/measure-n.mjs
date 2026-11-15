// Measure per-entry costs to pick the segment size N (WO-CARTRIDGE-SEAL part B).
// Read-only. Run from the repo root: node proposals/chain-checkpoints/measure-n.mjs
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const chainMod = await import(pathToFileURL(path.join(repo, 'src', 'chain', 'index.js')).href);
const { createChain, verifyChain, generateKeyPair } = chainMod;

const kp = generateKeyPair();
const pub = crypto.createPublicKey(kp.publicKey);
const priv = crypto.createPrivateKey(kp.privateKey);
const chain = createChain({ publicKey: pub, privateKey: priv });
const COUNT = 20000;
let t0 = process.hrtime.bigint();
for (let i = 0; i < COUNT; i++) chain.append({ type: 'gated_action', tool: 'Bash', i, note: 'x'.repeat(200) });
let t1 = process.hrtime.bigint();
console.log('append (sign) per entry us', Number(t1 - t0) / 1000 / COUNT);

t0 = process.hrtime.bigint();
const r = verifyChain(chain.entries, pub);
t1 = process.hrtime.bigint();
console.log('verifyChain ok', r.ok, 'per entry us', Number(t1 - t0) / 1000 / COUNT, 'total ms', Number(t1 - t0) / 1e6);

// Merkle leaf + node hashing cost per entry
t0 = process.hrtime.bigint();
const leaves = chain.entries.map((e) => crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(e.hash, 'hex')])).digest());
let level = leaves;
while (level.length > 1) {
  const next = [];
  for (let i = 0; i + 1 < level.length; i += 2) next.push(crypto.createHash('sha256').update(Buffer.concat([Buffer.from([1]), level[i], level[i + 1]])).digest());
  if (level.length % 2) next.push(level[level.length - 1]);
  level = next;
}
t1 = process.hrtime.bigint();
console.log('merkle leaf+tree per entry us', Number(t1 - t0) / 1000 / COUNT);

// JSON parse cost per line
const lines = chain.entries.map((e) => JSON.stringify(e));
console.log('avg line bytes', Math.round(lines.reduce((a, l) => a + l.length + 1, 0) / COUNT));
t0 = process.hrtime.bigint();
for (const l of lines) JSON.parse(l);
t1 = process.hrtime.bigint();
console.log('parse per entry us', Number(t1 - t0) / 1000 / COUNT);
