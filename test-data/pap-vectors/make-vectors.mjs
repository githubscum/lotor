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
//   negative  appends two v2 bundles with valid outer signatures that a
//           correct reader must still refuse: a re-addressed swap (inner
//           binding) and a split key (key commitment). Needs sealed mode.
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
} else if (mode === 'negative') {
  // Bundles a correct reader must refuse even though the outer signature is
  // valid. Built from the committed sealed vector and keys, so every reader
  // (node and the page) is tested on the same bytes.
  const seal = await import('../../src/publish/seal.js');
  const manifest = await import('../../src/publish/manifest.js');
  const two = fs.readFileSync(path.join(DIR, v.vectors['v2-sealed-two-recipients'].file));
  const r1Priv = v.recipients.r1.privateKeyHex;
  const { contentKey } = packMod.unpack({ bundle: two, recipientKey: r1Priv });
  const m = manifest.decodeSealedManifest(two.subarray(0, two.length - 64));
  const innerBytes = seal.aeadOpen(seal.bodyKey(contentKey), m.ciphertext, m.headerBytes);
  const r2Pub = Buffer.from(v.recipients.r2.publicKeyHex, 'hex');
  const r1Pub = Buffer.from(v.recipients.r1.publicKeyHex, 'hex');

  function sealedBundle(wraps, commitKey, bodyKeyCek, inner) {
    const eph = crypto.generateKeyPairSync('x25519');
    const ephRaw = seal.x25519RawPublic(eph.publicKey);
    const headerBytes = manifest.encodeSealedHeader({
      chainHeadHash: base.chainHeadHash, chainPubkeyFp: base.chainPubkeyFp, seq: base.seq, timestamp: base.timestamp,
      keyCommit: seal.keyCommitment(commitKey),
      ephemeralPub: ephRaw,
      x25519Wrapped: wraps.map(([cek, pub]) => seal.x25519Wrap(cek, eph.privateKey, ephRaw, pub)),
      passphrase: null,
    });
    const body = typeof inner === 'function' ? inner(headerBytes) : inner;
    const mb = manifest.encodeSealedManifest(headerBytes, seal.aeadSeal(seal.bodyKey(bodyKeyCek), body, headerBytes));
    return Buffer.concat([mb, crypto.sign(null, mb, signingKey)]);
  }

  // 1. The same inner bytes (inner signature included) re-addressed to r2
  //    under a valid outer signature by the same key: inner binding fails.
  const k1 = seal.generateContentKey();
  const readdressed = sealedBundle([[k1, r2Pub]], k1, k1, innerBytes);
  // 2. r1's stanza wraps the committed key, r2's stanza a different one:
  //    r1 opens, r2 fails the key commitment.
  const good = seal.generateContentKey();
  const other = seal.generateContentKey();
  const spineRaw = Buffer.from(v.spine, 'utf8');
  const equivocal = sealedBundle([[good, r1Pub], [other, r2Pub]], good, good, (headerBytes) => {
    const sig = crypto.sign(null, seal.innerMessage(headerBytes, spineRaw, Buffer.alloc(0)), signingKey);
    return Buffer.concat([sig, Buffer.from([0, 0]), innerBytes.subarray(64 + 2 + innerBytes.readUInt16BE(64))]);
  });
  for (const [name, bytes, expect] of [
    ['v2-neg-readdressed', readdressed, { r2: 'PAP_INNER_BINDING_INVALID' }],
    ['v2-neg-key-commit', equivocal, { r1: 'opens', r2: 'PAP_KEY_COMMIT_MISMATCH' }],
  ]) {
    fs.writeFileSync(path.join(DIR, name + '.bin'), bytes);
    v.vectors[name] = {
      file: name + '.bin', version: 2, negative: true, expect,
      bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  }
} else {
  throw new Error('mode must be v1, sealed or negative');
}

fs.writeFileSync(JSON_PATH, JSON.stringify(v, null, 2) + '\n');
console.log('wrote ' + Object.keys(v.vectors).join(', '));
