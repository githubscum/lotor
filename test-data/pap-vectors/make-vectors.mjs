// Generate the shared PAP test vectors: the same bundle bytes are checked by
// node (test/pap-sealed.test.js) and by the offline reader (web/reader/).
//
// Run from the repo root:  node test-data/pap-vectors/make-vectors.mjs [v1|sealed]
//
//   v1      writes v1-plain.bin with the pack() that is on main. It was run
//           once, before sealed mode existed, so the committed bytes are a
//           bundle "from before this change". Re-running it must reproduce
//           them byte for byte (Ed25519 and brotli are both deterministic).
//   sealed  writes the v2 sealed vectors with the current pack(). Sealing
//           draws fresh randomness, so these are generated once and committed.
//
// Every key in vectors.json is a throwaway test key. None signs anything real.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as packMod from '../../src/publish/pack.js';

const DIR = path.join(process.cwd(), 'test-data', 'pap-vectors');
const JSON_PATH = path.join(DIR, 'vectors.json');
const mode = process.argv[2] || 'v1';

const SPINE = [
  'cartridge: test vector, not a real workflow',
  'step 1: read the board',
  'step 2: predict the next outcome before it happens',
  'step 3: sign the prediction, seal it, print the QR',
  'no em dashes, no secrets, nothing here is private',
].join('\n');

function rawPub(keyObj) {
  return keyObj.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function loadOrInit() {
  if (fs.existsSync(JSON_PATH)) return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    note: 'Throwaway test keys. Shared by test/pap-sealed.test.js and the reader tests.',
    signer: {
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      publicKeyHex: rawPub(publicKey).toString('hex'),
    },
    spine: SPINE,
    chainHeadHex: crypto.createHash('sha256').update('pap-vectors chain head').digest('hex'),
    seq: 4242,
    timestamp: 1793000000000,
    vectors: {},
  };
}

const v = loadOrInit();
const signingKey = crypto.createPrivateKey(v.signer.privateKeyPem);
const base = {
  spine: v.spine,
  chainHeadHash: Buffer.from(v.chainHeadHex, 'hex'),
  chainPubkeyFp: Buffer.from(v.signer.publicKeyHex, 'hex'),
  seq: v.seq,
  timestamp: v.timestamp,
  signingKey,
};

if (mode === 'v1') {
  const { bundle } = packMod.pack({ ...base, memoirUrl: 'https://example.invalid/memoir' });
  fs.writeFileSync(path.join(DIR, 'v1-plain.bin'), bundle);
  v.vectors['v1-plain'] = {
    file: 'v1-plain.bin',
    version: 1,
    memoirUrl: 'https://example.invalid/memoir',
    bytes: bundle.length,
    sha256: crypto.createHash('sha256').update(bundle).digest('hex'),
  };
} else if (mode === 'sealed') {
  if (typeof packMod.generateRecipientKeypair !== 'function') {
    throw new Error('sealed mode is not in this checkout');
  }
  const r1 = packMod.generateRecipientKeypair();
  const r2 = packMod.generateRecipientKeypair();
  const outsider = packMod.generateRecipientKeypair();
  v.recipients = {
    r1: { privateKeyHex: r1.privateKeyRaw.toString('hex'), publicKeyHex: r1.publicKeyRaw.toString('hex') },
    r2: { privateKeyHex: r2.privateKeyRaw.toString('hex'), publicKeyHex: r2.publicKeyRaw.toString('hex') },
    outsider: { privateKeyHex: outsider.privateKeyRaw.toString('hex'), publicKeyHex: outsider.publicKeyRaw.toString('hex') },
  };
  v.passphrase = 'correct horse battery staple, test only';
  // Low iteration count keeps the vector fast to open in tests; real exports
  // use the default. The count is carried in the bundle, so readers honour it.
  v.passphraseIterations = 1000;

  const sealedTwo = packMod.pack({
    ...base,
    memoirUrl: 'https://example.invalid/memoir',
    seal: { to: [r1.publicKeyRaw, r2.publicKeyRaw] },
  });
  const sealedPass = packMod.pack({
    ...base,
    seal: { passphrase: v.passphrase, iterations: v.passphraseIterations },
  });
  for (const [name, res, extra] of [
    ['v2-sealed-two-recipients', sealedTwo, { recipients: ['r1', 'r2'], memoirUrl: 'https://example.invalid/memoir' }],
    ['v2-sealed-passphrase', sealedPass, { passphrase: true, memoirUrl: '' }],
  ]) {
    fs.writeFileSync(path.join(DIR, name + '.bin'), res.bundle);
    v.vectors[name] = {
      file: name + '.bin',
      version: 2,
      ...extra,
      bytes: res.bundle.length,
      sha256: crypto.createHash('sha256').update(res.bundle).digest('hex'),
    };
  }
} else {
  throw new Error('mode must be v1 or sealed');
}

fs.writeFileSync(JSON_PATH, JSON.stringify(v, null, 2) + '\n');
console.log('wrote ' + Object.keys(v.vectors).join(', '));
