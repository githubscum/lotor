/**
 * PAP sealed mode (manifest v2): encrypt-then-sign. WO-CARTRIDGE-SEAL part A.
 *
 * STAGED, NOT YET LANDED. Sealed mode is core (src/publish, bin/), queued as
 * proposals/pap-sealed.patch for the signing sitting. Until it lands, every
 * test here skips with `return t.skip(...)`, unless PAP_SEALED_REQUIRE=1, in
 * which case a missing sealed API is a failure. test/pap-sealed-patch.test.js
 * runs this file with PAP_SEALED_REQUIRE=1 on a temp copy twice: with the
 * patch applied (must pass) and without it (must fail). That is the
 * fail-first proof, and it runs inside every `npm test`.
 *
 * The four tests the WO names are marked WO-1 to WO-4. Each one that
 * claims a defence also runs a control showing the same input is accepted
 * when the defence's precondition is honestly met, so a pass cannot come from
 * a construction that rejects everything.
 *
 * The tests marked R1 to R5 are the wringer review amendments (2026-10-26):
 * trust accounting, the decompression cap and error hygiene, the PBKDF2 floor,
 * the outer domain string, and the un-exported zero-nonce primitives.
 *
 * Hostile bundles are built with test-data/pap-vectors/seal-primitives.mjs, an
 * independent test-only reimplementation: seal.js itself no longer exports
 * anything that encrypts under a caller-supplied key.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRE = process.env.PAP_SEALED_REQUIRE === '1';

const pack = await import('../src/publish/pack.js');
const manifest = await import('../src/publish/manifest.js');
const prim = await import('../test-data/pap-vectors/seal-primitives.mjs');
let seal = null;
try {
  seal = await import('../src/publish/seal.js');
} catch {
  seal = null;
}
const LANDED = seal !== null && typeof pack.inspect === 'function';

function gate(t) {
  if (LANDED) return false;
  if (REQUIRE) assert.fail('sealed mode is not in this tree (src/publish/seal.js or pack.inspect missing)');
  t.skip('sealed mode not landed; proposals/pap-sealed.patch, proved by test/pap-sealed-patch.test.js');
  return true;
}

const SPINE = 'cartridge: predict the next outcome, sign it before it happens.\nstep 1: read the board.';
// The seal-time PBKDF2 floor. Tests seal at the floor, never below it, because
// pack() refuses below it (R3). Hostile low-iteration bundles come from prim.
const FLOOR = 100000;
// The decode-side cap on a decompressed spine (R2): 4 MiB.
const CAP = 4 * 1024 * 1024;

function author() {
  const { privateKey, publicKey, publicKeyRaw } = pack.generateKeypair();
  return { privateKey, publicKey, publicKeyRaw };
}

function base(a, extra = {}) {
  return {
    spine: SPINE,
    chainHeadHash: crypto.createHash('sha256').update('head').digest(),
    chainPubkeyFp: a.publicKeyRaw,
    seq: 77,
    timestamp: 1793000000000,
    signingKey: a.privateKey,
    ...extra,
  };
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code || 'NO_CODE:' + err.message;
  }
  return 'NO_THROW';
}

function brotli(buf, quality = 5) {
  return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } });
}

/**
 * Rebuild a sealed bundle around existing inner bytes, the way an attacker
 * holding a content key would: new content key, new recipients, the SAME
 * inner plaintext (inner signature included), a valid outer signature by
 * `signer`. With freshInnerFrom set, the inner signature is recomputed
 * honestly by that key instead, which is the control.
 */
function reseal({ innerBytes, to, signer, signerRaw, chainHeadHash, seq, timestamp, freshInnerFrom }) {
  const cek = prim.generateContentKey();
  const eph = crypto.generateKeyPairSync('x25519');
  const ephRaw = prim.x25519RawPublic(eph.publicKey);
  const headerBytes = manifest.encodeSealedHeader({
    chainHeadHash, chainPubkeyFp: signerRaw, seq, timestamp,
    keyCommit: prim.keyCommitment(cek),
    ephemeralPub: ephRaw,
    x25519Wrapped: to.map((r) => prim.x25519Wrap(cek, eph.privateKey, ephRaw, r)),
    passphrase: null,
  });
  let inner = innerBytes;
  if (freshInnerFrom) {
    const memoirLen = inner.readUInt16BE(64);
    const memoir = inner.subarray(66, 66 + memoirLen);
    const spineRaw = zlib.brotliDecompressSync(inner.subarray(66 + memoirLen));
    const sig = crypto.sign(null, prim.innerMessage(headerBytes, spineRaw, memoir), freshInnerFrom);
    inner = Buffer.concat([sig, inner.subarray(64)]);
  }
  const ct = prim.aeadSeal(prim.bodyKey(cek), inner, headerBytes);
  const m = manifest.encodeSealedManifest(headerBytes, ct);
  return Buffer.concat([m, prim.signOuter(m, signer)]);
}

/**
 * Build a v2 bundle sealed to one recipient with a caller-chosen compressed
 * spine, so the decode paths can be fed bytes pack() would never produce. The
 * inner signature is honest over `spineRaw`; the outer is honest and carries
 * the domain string unless noDomain is set.
 */
function handBuilt({ a, recipientPub, spineRaw, spineCompressed, iterations, passphrase, noDomain }) {
  const cek = prim.generateContentKey();
  const eph = crypto.generateKeyPairSync('x25519');
  const ephRaw = prim.x25519RawPublic(eph.publicKey);
  let pass = null;
  if (passphrase !== undefined) {
    const salt = crypto.randomBytes(16);
    pass = { salt, iterations, wrapped: prim.passphraseWrap(cek, passphrase, salt, iterations) };
  }
  const headerBytes = manifest.encodeSealedHeader({
    chainHeadHash: crypto.createHash('sha256').update('head').digest(),
    chainPubkeyFp: a.publicKeyRaw, seq: 77, timestamp: 1793000000000,
    keyCommit: prim.keyCommitment(cek),
    ephemeralPub: recipientPub ? ephRaw : null,
    x25519Wrapped: recipientPub ? [prim.x25519Wrap(cek, eph.privateKey, ephRaw, recipientPub)] : [],
    passphrase: pass,
  });
  const innerSig = crypto.sign(null, prim.innerMessage(headerBytes, spineRaw, Buffer.alloc(0)), a.privateKey);
  const inner = Buffer.concat([innerSig, Buffer.from([0, 0]), spineCompressed]);
  const m = manifest.encodeSealedManifest(headerBytes, prim.aeadSeal(prim.bodyKey(cek), inner, headerBytes));
  const sig = noDomain ? crypto.sign(null, m, a.privateKey) : prim.signOuter(m, a.privateKey);
  return Buffer.concat([m, sig]);
}

/** A v1 bundle around caller-chosen compressed bytes, signed honestly. */
function handBuiltV1(a, spineCompressed) {
  const m = manifest.encodeManifest({
    chainHeadHash: crypto.createHash('sha256').update('head').digest(),
    chainPubkeyFp: a.publicKeyRaw, seq: 77, timestamp: 1793000000000, memoirUrl: '', spineCompressed,
  });
  return Buffer.concat([m, crypto.sign(null, m, a.privateKey)]);
}

/** Open a sealed bundle as a recipient and return its raw inner plaintext. */
function innerOf(bundle, recipientKey) {
  const { contentKey } = pack.unpack({ bundle, recipientKey });
  const m = manifest.decodeSealedManifest(bundle.subarray(0, bundle.length - 64));
  return prim.aeadOpen(prim.bodyKey(contentKey), m.ciphertext, m.headerBytes);
}

describe('PAP sealed mode (v2)', () => {
  it('round trip: one recipient opens it, byte-identical spine and fields', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const res = pack.pack(base(a, { memoirUrl: 'https://example.invalid/m', seal: { to: [r.publicKeyRaw] } }));
    assert.equal(res.sealed, true);
    assert.equal(res.bundle[0], 0x02, 'sealed bundles carry manifest version 2');
    const out = pack.unpack({ bundle: res.bundle, recipientKey: r.privateKey });
    assert.equal(out.spine, SPINE);
    assert.equal(out.manifest.memoirUrl, 'https://example.invalid/m');
    assert.equal(out.manifest.seq, 77);
    assert.equal(out.manifest.timestamp, 1793000000000);
    assert.deepEqual(out.manifest.recipients, { x25519: 1, passphrase: false });
    assert.equal(Buffer.compare(out.manifest.chainPubkeyFp, a.publicKeyRaw), 0);
  });

  it('the spine is not in the bundle in the clear, compressed or raw', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const spine = 'a distinctive marker string that brotli will keep recognisable '.repeat(4);
    const plain = pack.pack(base(a, { spine }));
    const sealed = pack.pack(base(a, { spine, seal: { to: [r.publicKeyRaw] } }));
    const compressed = plain.bundle.subarray(81 + 0, plain.bundle.length - 64);
    assert.equal(sealed.bundle.includes(Buffer.from('distinctive marker')), false);
    assert.equal(sealed.bundle.includes(compressed.subarray(0, 24)), false, 'brotli bytes of the spine leaked');
  });

  it('outer verify needs no key: inspect() reports "sealed to N" before any key is given', (t) => {
    if (gate(t)) return;
    const a = author();
    const r1 = pack.generateRecipientKeypair();
    const r2 = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r1.publicKeyRaw, r2.publicKeyRaw] } }));
    const { info } = pack.inspect({ bundle });
    assert.equal(info.sealed, true);
    assert.deepEqual(info.recipients, { x25519: 2, passphrase: false });
    assert.equal(info.seq, 77);
    assert.throws(() => pack.unpack({ bundle }), (err) => {
      assert.equal(err.code, 'PAP_SEALED_NEEDS_KEY');
      assert.match(err.message, /verified, sealed to 2 recipient keys/);
      assert.equal(err.info.recipients.x25519, 2);
      return true;
    });
  });

  it('WO-1: flipping ANY byte of a sealed bundle fails the outer verify, with no key', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r.publicKeyRaw] } }));
    // Control: the untouched bundle verifies.
    assert.equal(pack.inspect({ bundle }).info.sealed, true);
    const m = manifest.decodeSealedManifest(bundle.subarray(0, bundle.length - 64));
    const ctStart = m.headerBytes.length + 2;
    let ciphertextFlips = 0;
    for (let pos = 0; pos < bundle.length; pos++) {
      const tampered = Buffer.from(bundle);
      tampered[pos] ^= 0x01;
      assert.throws(() => pack.inspect({ bundle: tampered }), Error, `flip at ${pos} must be rejected`);
      if (pos >= ctStart && pos < bundle.length - 64) {
        assert.equal(codeOf(() => pack.inspect({ bundle: tampered })), 'PAP_SIGNATURE_INVALID',
          `ciphertext flip at ${pos} must fail the signature, not some later check`);
        ciphertextFlips++;
      }
    }
    assert.equal(ciphertextFlips, m.ciphertext.length);
  });

  it('WO-2: the same plaintext re-encrypted to another recipient under a valid outer signature is rejected on the inner binding', (t) => {
    if (gate(t)) return;
    const alice = author();
    const mallory = author();
    const bob = pack.generateRecipientKeypair();
    const carol = pack.generateRecipientKeypair();
    const inputs = base(alice, { memoirUrl: 'https://example.invalid/m', seal: { to: [bob.publicKeyRaw] } });
    const { bundle } = pack.pack(inputs);
    const innerBytes = innerOf(bundle, bob.privateKey);
    const common = { innerBytes, to: [carol.publicKeyRaw], chainHeadHash: inputs.chainHeadHash, seq: 77, timestamp: inputs.timestamp };

    // Bob re-addresses Alice's plaintext to Carol and signs the outer as himself (Mallory's key).
    const resignedByOther = reseal({ ...common, signer: mallory.privateKey, signerRaw: mallory.publicKeyRaw });
    assert.equal(pack.inspect({ bundle: resignedByOther }).info.sealed, true, 'outer signature must be valid for the test to mean anything');
    assert.equal(codeOf(() => pack.unpack({ bundle: resignedByOther, recipientKey: carol.privateKey })), 'PAP_INNER_BINDING_INVALID');

    // A holder of Alice's chain key re-addresses it under Alice's own outer signature.
    const readdressed = reseal({ ...common, signer: alice.privateKey, signerRaw: alice.publicKeyRaw });
    assert.equal(pack.inspect({ bundle: readdressed }).info.sealed, true);
    assert.equal(codeOf(() => pack.unpack({ bundle: readdressed, recipientKey: carol.privateKey })), 'PAP_INNER_BINDING_INVALID');

    // A different chain head under the same key and recipients is a swap too.
    const otherHead = reseal({ ...common, chainHeadHash: crypto.randomBytes(32), to: [bob.publicKeyRaw], signer: alice.privateKey, signerRaw: alice.publicKeyRaw });
    assert.equal(codeOf(() => pack.unpack({ bundle: otherHead, recipientKey: bob.privateKey })), 'PAP_INNER_BINDING_INVALID');

    // Control: the same rebuild with an honest inner signature opens. So the
    // rejections above come from the inner binding, not from reseal().
    const honest = reseal({ ...common, signer: alice.privateKey, signerRaw: alice.publicKeyRaw, freshInnerFrom: alice.privateKey });
    assert.equal(pack.unpack({ bundle: honest, recipientKey: carol.privateKey }).spine, SPINE);
  });

  it('WO-3: a wrong recipient key gets a clean, coded failure, never a crash', (t) => {
    if (gate(t)) return;
    const a = author();
    const r1 = pack.generateRecipientKeypair();
    const r2 = pack.generateRecipientKeypair();
    const outsider = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r1.publicKeyRaw, r2.publicKeyRaw] } }));
    assert.equal(pack.unpack({ bundle, recipientKey: r1.privateKey }).spine, SPINE);
    assert.equal(pack.unpack({ bundle, recipientKey: r2.privateKeyRaw.toString('hex') }).spine, SPINE);
    assert.equal(codeOf(() => pack.unpack({ bundle, recipientKey: outsider.privateKey })), 'PAP_NOT_A_RECIPIENT');
    assert.equal(codeOf(() => pack.unpack({ bundle, recipientKey: outsider.privateKeyRaw })), 'PAP_NOT_A_RECIPIENT');
    assert.equal(codeOf(() => pack.unpack({ bundle, passphrase: 'not sealed to any passphrase' })), 'PAP_NOT_A_RECIPIENT');
    // An Ed25519 key in the X25519 slot is refused by type, not by crashing.
    assert.throws(() => pack.unpack({ bundle, recipientKey: a.privateKey }), /expected x25519/);
  });

  it('passphrase: right one opens, wrong one is a clean PAP_NOT_A_RECIPIENT', (t) => {
    if (gate(t)) return;
    const a = author();
    const { bundle, recipients } = pack.pack(base(a, { seal: { passphrase: 'pass words here', iterations: FLOOR } }));
    assert.deepEqual(recipients, { x25519: 0, passphrase: true });
    assert.equal(pack.unpack({ bundle, passphrase: 'pass words here' }).spine, SPINE);
    assert.equal(codeOf(() => pack.unpack({ bundle, passphrase: 'pass words HERE' })), 'PAP_NOT_A_RECIPIENT');
  });

  it('key commitment: an author cannot show two recipients two different plaintexts', (t) => {
    if (gate(t)) return;
    // Build the attack by hand: r1's stanza wraps the committed key, r2's
    // stanza wraps a different key. Without the commitment check r2 would
    // either fail opaquely or (with a crafted GCM body) read something else.
    const a = author();
    const r1 = pack.generateRecipientKeypair();
    const r2 = pack.generateRecipientKeypair();
    const cek1 = prim.generateContentKey();
    const cek2 = prim.generateContentKey();
    const eph = crypto.generateKeyPairSync('x25519');
    const ephRaw = prim.x25519RawPublic(eph.publicKey);
    const inputs = base(a);
    const headerBytes = manifest.encodeSealedHeader({
      chainHeadHash: inputs.chainHeadHash, chainPubkeyFp: a.publicKeyRaw, seq: 77, timestamp: inputs.timestamp,
      keyCommit: prim.keyCommitment(cek1),
      ephemeralPub: ephRaw,
      x25519Wrapped: [prim.x25519Wrap(cek1, eph.privateKey, ephRaw, r1.publicKeyRaw), prim.x25519Wrap(cek2, eph.privateKey, ephRaw, r2.publicKeyRaw)],
      passphrase: null,
    });
    const spineRaw = Buffer.from(SPINE, 'utf8');
    const innerSig = crypto.sign(null, prim.innerMessage(headerBytes, spineRaw, Buffer.alloc(0)), a.privateKey);
    const inner = Buffer.concat([innerSig, Buffer.from([0, 0]), zlib.brotliCompressSync(spineRaw)]);
    const m = manifest.encodeSealedManifest(headerBytes, prim.aeadSeal(prim.bodyKey(cek1), inner, headerBytes));
    const bundle = Buffer.concat([m, prim.signOuter(m, a.privateKey)]);
    assert.equal(pack.unpack({ bundle, recipientKey: r1.privateKey }).spine, SPINE, 'control: the committed key opens');
    assert.equal(codeOf(() => pack.unpack({ bundle, recipientKey: r2.privateKey })), 'PAP_KEY_COMMIT_MISMATCH');
  });

  it('reveal: the content key opens the bundle for anyone, and a wrong key fails the commitment', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r.publicKeyRaw] } }));
    const { contentKey } = pack.unpack({ bundle, recipientKey: r.privateKey });
    assert.equal(pack.unpack({ bundle, contentKey: contentKey.toString('hex') }).spine, SPINE);
    assert.equal(codeOf(() => pack.unpack({ bundle, contentKey: crypto.randomBytes(32) })), 'PAP_KEY_COMMIT_MISMATCH');
  });

  it('refuses a seal with no recipients or a duplicated recipient', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    assert.throws(() => pack.pack(base(a, { seal: {} })), /at least one recipient/);
    assert.throws(() => pack.pack(base(a, { seal: { to: [r.publicKeyRaw, r.publicKeyRaw.toString('hex')] } })), /same recipient twice/);
  });

  it('budget: overhead is measured and pinned (194 B for one key, +48 B per extra key, 182 B for a passphrase, 262 B for both)', (t) => {
    if (gate(t)) return;
    const a = author();
    const keys = Array.from({ length: 5 }, () => pack.generateRecipientKeypair().publicKeyRaw);
    const plain = pack.pack(base(a));
    for (let n = 1; n <= 5; n++) {
      const res = pack.pack(base(a, { seal: { to: keys.slice(0, n) } }));
      assert.equal(res.sealOverhead, 194 + 48 * (n - 1), `overhead for ${n} recipient(s)`);
      assert.equal(res.totalLen, plain.totalLen + res.sealOverhead);
    }
    const pass = pack.pack(base(a, { seal: { passphrase: 'x', iterations: FLOOR } }));
    assert.equal(pass.sealOverhead, 182);
    const both = pack.pack(base(a, { seal: { to: [keys[0]], passphrase: 'x', iterations: FLOOR } }));
    assert.equal(both.sealOverhead, 262);
  });

  it('budget: pack() still refuses over the 2,953 B cap, and says what sealing cost', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    // Find a spine that fits plain but not sealed: the refusal must come from sealing.
    // Random base64 compresses to about 3/4 of its length, so each step adds
    // roughly 30 B: from over 100 B of headroom it cannot overshoot the cap.
    let spine = crypto.randomBytes(1500).toString('base64');
    while (pack.pack(base(a, { spine })).headroom > 100) spine += crypto.randomBytes(30).toString('base64');
    assert.ok(pack.pack(base(a, { spine })).totalLen <= manifest.QR_V40_BINARY_ECL_CAPACITY);
    assert.throws(() => pack.pack(base(a, { spine, seal: { to: [r.publicKeyRaw] } })), (err) => {
      assert.equal(err.code, 'PAP_BUDGET_EXCEEDED');
      assert.equal(err.sealOverhead, 194);
      assert.ok(err.totalLen > err.budget);
      assert.match(err.message, /sealing costs 194 bytes/);
      return true;
    });
  });

  it('WO-4: a plaintext v1 bundle made before this change still verifies, and pack() still makes it byte for byte', (t) => {
    if (gate(t)) return;
    const v = JSON.parse(fs.readFileSync(path.join(repoRoot, 'test-data', 'pap-vectors', 'vectors.json'), 'utf8'));
    const vec = v.vectors['v1-plain'];
    const bytes = fs.readFileSync(path.join(repoRoot, 'test-data', 'pap-vectors', vec.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), vec.sha256, 'vector file changed');
    const out = pack.unpack({ bundle: bytes });
    assert.equal(out.spine, v.spine);
    assert.equal(out.manifest.memoirUrl, vec.memoirUrl);
    assert.equal(pack.inspect({ bundle: bytes }).info.sealed, false);
    const again = pack.pack({
      spine: v.spine,
      chainHeadHash: Buffer.from(v.chainHeadHex, 'hex'),
      chainPubkeyFp: Buffer.from(v.signer.publicKeyHex, 'hex'),
      seq: v.seq,
      timestamp: v.timestamp,
      memoirUrl: vec.memoirUrl,
      signingKey: crypto.createPrivateKey(v.signer.privateKeyPem),
    });
    assert.equal(Buffer.compare(again.bundle, bytes), 0, 'v1 pack() output moved');
  });

  it('shared vectors: the committed sealed bundles open with their keys and refuse an outsider', (t) => {
    if (gate(t)) return;
    const dir = path.join(repoRoot, 'test-data', 'pap-vectors');
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
    const two = fs.readFileSync(path.join(dir, v.vectors['v2-sealed-two-recipients'].file));
    for (const who of ['r1', 'r2']) {
      assert.equal(pack.unpack({ bundle: two, recipientKey: v.recipients[who].privateKeyHex }).spine, v.spine);
    }
    assert.equal(codeOf(() => pack.unpack({ bundle: two, recipientKey: v.recipients.outsider.privateKeyHex })), 'PAP_NOT_A_RECIPIENT');
    const pass = fs.readFileSync(path.join(dir, v.vectors['v2-sealed-passphrase'].file));
    assert.equal(pack.unpack({ bundle: pass, passphrase: v.passphrase }).spine, v.spine);
    assert.ok(v.passphraseIterations >= FLOOR, 'the passphrase vector must be sealed at or above the floor');
  });

  it('shared negative vectors: valid outer signature, refused on the inner binding and the key commitment; an outer signature without the domain string is refused outright', (t) => {
    if (gate(t)) return;
    const dir = path.join(repoRoot, 'test-data', 'pap-vectors');
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
    for (const name of ['v2-neg-readdressed', 'v2-neg-key-commit', 'v2-neg-outer-no-domain']) {
      const vec = v.vectors[name];
      const bundle = fs.readFileSync(path.join(dir, vec.file));
      assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), vec.sha256, name + ' file changed');
      if (vec.outerInvalid) {
        assert.equal(codeOf(() => pack.inspect({ bundle })), 'PAP_SIGNATURE_INVALID', name + ': the outer signature must be refused');
        continue;
      }
      assert.equal(pack.inspect({ bundle }).info.sealed, true, name + ': the outer signature must verify');
      for (const [who, want] of Object.entries(vec.expect)) {
        const key = v.recipients[who].privateKeyHex;
        if (want === 'opens') assert.equal(pack.unpack({ bundle, recipientKey: key }).spine, v.spine);
        else assert.equal(codeOf(() => pack.unpack({ bundle, recipientKey: key })), want, `${name} as ${who}`);
      }
    }
  });
});

describe('PAP sealed mode: wringer review amendments (R1 to R5)', () => {
  it('R1: trust is a distinct field; a supplied key must equal the embedded fingerprint (v1 and v2)', (t) => {
    if (gate(t)) return;
    const a = author();
    const other = author();
    const r = pack.generateRecipientKeypair();
    const cases = [
      ['v1', pack.pack(base(a)).bundle, {}],
      ['v2', pack.pack(base(a, { seal: { to: [r.publicKeyRaw] } })).bundle, { recipientKey: r.privateKey }],
    ];
    for (const [label, bundle, open] of cases) {
      assert.equal(pack.inspect({ bundle }).info.trust, 'self-consistent', label + ' inspect, no key');
      assert.equal(pack.inspect({ bundle, verifyKey: a.publicKey }).info.trust, 'verified-against-supplied-key', label + ' inspect, key');
      assert.equal(pack.unpack({ bundle, ...open }).trust, 'self-consistent', label + ' unpack, no key');
      assert.equal(pack.unpack({ bundle, verifyKey: a.publicKey, ...open }).trust, 'verified-against-supplied-key', label + ' unpack, key');

      // A supplied key that is not the embedded fingerprint is refused as a
      // signer mismatch, not as a signature failure.
      assert.equal(codeOf(() => pack.inspect({ bundle, verifyKey: other.publicKey })), 'PAP_SIGNER_MISMATCH', label + ' inspect');
      assert.equal(codeOf(() => pack.unpack({ bundle, verifyKey: other.publicKey, ...open })), 'PAP_SIGNER_MISMATCH', label + ' unpack');
      // It is checked BEFORE any signature work: a damaged signature plus a
      // wrong key reports the mismatch, while the damaged bundle alone reports the signature.
      const damaged = Buffer.from(bundle);
      damaged[damaged.length - 1] ^= 1;
      assert.equal(codeOf(() => pack.inspect({ bundle: damaged, verifyKey: other.publicKey })), 'PAP_SIGNER_MISMATCH', label + ' order');
      assert.equal(codeOf(() => pack.inspect({ bundle: damaged })), 'PAP_SIGNATURE_INVALID', label + ' control');
      // A key of another type can never equal an Ed25519 fingerprint.
      assert.equal(codeOf(() => pack.inspect({ bundle, verifyKey: r.publicKey })), 'PAP_SIGNER_MISMATCH', label + ' x25519 key');
    }
  });

  it('R1: "signed by someone else but carrying my fingerprint" is refused, and the message claims only what the check can know', (t) => {
    if (gate(t)) return;
    const a = author();
    const b = author();
    const r = pack.generateRecipientKeypair();
    for (const extra of [{}, { seal: { to: [r.publicKeyRaw] } }]) {
      // B signs a bundle whose fingerprint field says A.
      const forged = pack.pack(base(a, { ...extra, signingKey: b.privateKey })).bundle;
      assert.throws(() => pack.inspect({ bundle: forged }), (err) => {
        assert.equal(err.code, 'PAP_SIGNATURE_INVALID');
        assert.match(err.message, /does not verify under the key whose fingerprint it carries/);
        assert.doesNotMatch(err.message, /different key/);
        return true;
      });
      // Control: B signing as B is self-consistent, and says nothing about A.
      const asB = pack.pack(base(b, { ...extra, signingKey: b.privateKey })).bundle;
      const { info } = pack.inspect({ bundle: asB });
      assert.equal(info.trust, 'self-consistent');
      assert.equal(Buffer.compare(info.chainPubkeyFp, b.publicKeyRaw), 0);
    }
  });

  it('R2: a brotli bomb is refused with PAP_SPINE_TOO_LARGE, malformed brotli with PAP_DECOMPRESS_FAILED (v1 and v2)', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const bombRaw = Buffer.alloc(2 * CAP);
    const bomb = brotli(bombRaw);
    assert.ok(bomb.length < 1024, 'the bomb must be tiny on the wire, got ' + bomb.length);
    const garbage = Buffer.alloc(48, 0xff);

    // v1: valid signature, hostile payload.
    assert.equal(codeOf(() => pack.unpack({ bundle: handBuiltV1(a, bomb) })), 'PAP_SPINE_TOO_LARGE', 'v1 bomb');
    assert.equal(codeOf(() => pack.unpack({ bundle: handBuiltV1(a, garbage) })), 'PAP_DECOMPRESS_FAILED', 'v1 garbage');
    const okRaw = Buffer.alloc(CAP / 4, 0x61);
    const okV1 = pack.unpack({ bundle: handBuiltV1(a, brotli(okRaw)) });
    assert.equal(okV1.spineRawLen, okRaw.length, 'control: a large spine under the cap still opens');

    // v2: valid outer and inner signatures, hostile payload, opened by the recipient.
    const v2 = (spineRaw, spineCompressed) => handBuilt({ a, recipientPub: r.publicKeyRaw, spineRaw, spineCompressed });
    assert.equal(codeOf(() => pack.unpack({ bundle: v2(bombRaw, bomb), recipientKey: r.privateKey })), 'PAP_SPINE_TOO_LARGE', 'v2 bomb');
    assert.equal(codeOf(() => pack.unpack({ bundle: v2(Buffer.from('x'), garbage), recipientKey: r.privateKey })), 'PAP_DECOMPRESS_FAILED', 'v2 garbage');
    const okV2 = pack.unpack({ bundle: v2(okRaw, brotli(okRaw)), recipientKey: r.privateKey });
    assert.equal(okV2.spineRawLen, okRaw.length, 'control: the hand-built v2 bundle opens when the payload is sane');
    assert.equal(pack.MAX_SPINE_RAW_BYTES, CAP, 'the cap is the named 4 MiB constant');
  });

  it('R2: x25519Unwrap returns null only for the low-order refusal; anything else is a coded PAP_BAD_KEY', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r.publicKeyRaw] } }));
    const m = manifest.decodeSealedManifest(bundle.subarray(0, bundle.length - 64));
    const w = m.x25519Wrapped[0];
    const cek = seal.x25519Unwrap(w, r.privateKey, m.ephemeralPub);
    assert.equal(cek.length, 32, 'control: the right key unwraps');
    const other = pack.generateRecipientKeypair();
    assert.equal(seal.x25519Unwrap(w, other.privateKey, m.ephemeralPub), null, 'a stanza for someone else is null');
    // A low-order ephemeral key makes an all-zero shared secret: refused, so "not this stanza".
    assert.equal(seal.x25519Unwrap(w, r.privateKey, Buffer.alloc(32)), null, 'low-order peer is null');
    // A malformed ephemeral key is a bad key, not a quiet "not a recipient".
    assert.equal(codeOf(() => seal.x25519Unwrap(w, r.privateKey, Buffer.alloc(31, 1))), 'PAP_BAD_KEY', 'short ephemeral key');
    // A private key of the wrong type is a bad key.
    assert.equal(codeOf(() => seal.x25519Unwrap(w, a.privateKey, m.ephemeralPub)), 'PAP_BAD_KEY', 'ed25519 key in the x25519 slot');
  });

  it('R2: a content key that is not 32 bytes / 64 hex chars is PAP_BAD_CONTENT_KEY, not a commitment mismatch', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r.publicKeyRaw] } }));
    for (const bad of ['zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), '', Buffer.alloc(31), Buffer.alloc(33)]) {
      assert.equal(codeOf(() => pack.unpack({ bundle, contentKey: bad })), 'PAP_BAD_CONTENT_KEY', JSON.stringify(String(bad)).slice(0, 20));
    }
    // A well-formed but wrong key is still the commitment failure.
    assert.equal(codeOf(() => pack.unpack({ bundle, contentKey: 'ab'.repeat(32) })), 'PAP_KEY_COMMIT_MISMATCH');
  });

  it('R2: a malformed recipient key is a coded PAP_BAD_KEY', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r.publicKeyRaw] } }));
    assert.equal(codeOf(() => pack.unpack({ bundle, recipientKey: 'not a key at all' })), 'PAP_BAD_KEY');
    assert.equal(codeOf(() => pack.unpack({ bundle, recipientKey: Buffer.alloc(7) })), 'PAP_BAD_KEY');
    assert.equal(codeOf(() => pack.pack(base(a, { seal: { to: ['definitely not a public key'] } }))), 'PAP_BAD_KEY');
  });

  it('R3: sealing below the PBKDF2 floor is refused; the default stays 600000; the decode side still opens older counts', (t) => {
    if (gate(t)) return;
    const a = author();
    for (const iterations of [1, 1000, FLOOR - 1]) {
      assert.equal(codeOf(() => pack.pack(base(a, { seal: { passphrase: 'pw', iterations } }))), 'PAP_KDF_TOO_WEAK', 'iterations ' + iterations);
    }
    const atFloor = pack.pack(base(a, { seal: { passphrase: 'pw', iterations: FLOOR } }));
    const dec = manifest.decodeSealedManifest(atFloor.bundle.subarray(0, atFloor.bundle.length - 64));
    assert.equal(dec.passphrase.iterations, FLOOR, 'control: the floor itself is allowed');
    const dflt = pack.pack(base(a, { seal: { passphrase: 'pw' } }));
    assert.equal(manifest.decodeSealedManifest(dflt.bundle.subarray(0, dflt.bundle.length - 64)).passphrase.iterations, 600000);

    // Opening is not floored: a bundle some other writer sealed at 1000 rounds
    // is still readable by the holder of the passphrase (the test-only
    // primitives have no floor). The reader's cap on the high side is separate.
    const weak = handBuilt({
      a, spineRaw: Buffer.from(SPINE), spineCompressed: brotli(Buffer.from(SPINE)), iterations: 1000, passphrase: 'old pw',
    });
    assert.equal(pack.unpack({ bundle: weak, passphrase: 'old pw' }).spine, SPINE);
    assert.equal(seal.MIN_PBKDF2_ITERATIONS, FLOOR, 'the floor is the named 100000 constant');
    assert.equal(seal.DEFAULT_PBKDF2_ITERATIONS, 600000);
  });

  it('R4: the v2 outer signature covers "lotor/pap/v2/outer" 0x00 || manifest, and a raw-manifest signature is refused', (t) => {
    if (gate(t)) return;
    const a = author();
    const r = pack.generateRecipientKeypair();
    const { bundle } = pack.pack(base(a, { seal: { to: [r.publicKeyRaw] } }));
    const manifestBytes = bundle.subarray(0, bundle.length - 64);
    const sig = bundle.subarray(bundle.length - 64);
    const domain = Buffer.concat([Buffer.from('lotor/pap/v2/outer', 'utf8'), Buffer.from([0]), manifestBytes]);
    assert.equal(crypto.verify(null, domain, a.publicKey, sig), true, 'signed over the domain-separated message');
    assert.equal(crypto.verify(null, manifestBytes, a.publicKey, sig), false, 'not over the raw manifest');
    assert.equal(Buffer.compare(domain, prim.outerMessage(manifestBytes)), 0, 'the independent primitive agrees');

    // The old construction (outer signature over the bare manifest) no longer verifies.
    const oldStyle = handBuilt({
      a, recipientPub: r.publicKeyRaw, spineRaw: Buffer.from(SPINE), spineCompressed: brotli(Buffer.from(SPINE)), noDomain: true,
    });
    assert.equal(codeOf(() => pack.inspect({ bundle: oldStyle })), 'PAP_SIGNATURE_INVALID');
    // Control: the same hand-built bundle with the domain string verifies and opens.
    const withDomain = handBuilt({
      a, recipientPub: r.publicKeyRaw, spineRaw: Buffer.from(SPINE), spineCompressed: brotli(Buffer.from(SPINE)),
    });
    assert.equal(pack.unpack({ bundle: withDomain, recipientKey: r.privateKey }).spine, SPINE);
    // A v1 decoder never misreads a v2 manifest: it stops on the version byte.
    assert.throws(() => manifest.decodeManifest(Buffer.from(manifestBytes)), /unknown manifest version: 0x2/);
  });

  it('R5: nothing importable encrypts under a caller-supplied key with the zero nonce', (t) => {
    if (gate(t)) return;
    const forbidden = ['aeadSeal', 'bodyKey', 'generateContentKey', 'x25519Wrap', 'x25519Kek', 'passphraseWrap'];
    for (const [file, mod] of [['seal.js', seal], ['pack.js', pack]]) {
      for (const name of forbidden) assert.equal(name in mod, false, `${file} must not export ${name}`);
    }
    // The exact surfaces, so a new export is a conscious change.
    assert.deepEqual(Object.keys(seal).sort(), [
      'CEK_LEN', 'DEFAULT_PBKDF2_ITERATIONS', 'GCM_TAG_LEN', 'MAX_PBKDF2_ITERATIONS', 'MIN_PBKDF2_ITERATIONS',
      'aeadOpen', 'commitmentMatches', 'createSealer', 'generateRecipientKeypair', 'innerMessage',
      'openBody', 'outerMessage', 'parseRecipientPrivateKey', 'parseRecipientPublicKey', 'passphraseKek',
      'x25519RawPublic', 'x25519Unwrap',
    ].sort());
    assert.deepEqual(Object.keys(pack).sort(), [
      'MAX_SPINE_RAW_BYTES', 'generateKeypair', 'generateRecipientKeypair', 'inspect', 'pack', 'unpack',
    ]);
  });

  it('R5: the single-use sealer keeps the content key inside, and refuses a second body', (t) => {
    if (gate(t)) return;
    const r = pack.generateRecipientKeypair();
    const sealer = seal.createSealer({ to: [r.publicKeyRaw], passphrase: 'pw', iterations: FLOOR });
    assert.deepEqual(Object.keys(sealer).sort(), ['encryptBody', 'ephemeralPub', 'keyCommit', 'passphrase', 'x25519Wrapped']);
    for (const v of Object.values(sealer)) {
      assert.notEqual(Buffer.isBuffer(v) && v.length === 32 && prim.keyCommitment(v).equals(sealer.keyCommit), true, 'the content key must not be a property');
    }
    const header = Buffer.from('header bytes');
    const body = Buffer.from('inner bytes');
    const ct = sealer.encryptBody(body, header);
    assert.equal(codeOf(() => sealer.encryptBody(body, header)), 'PAP_SEALER_REUSED');
    assert.equal(codeOf(() => sealer.encryptBody(Buffer.from('another'), header)), 'PAP_SEALER_REUSED');
    // Cross-check against the independent primitives: the stanza unwraps to a
    // key that matches the commitment and opens the body.
    const cek = seal.x25519Unwrap(sealer.x25519Wrapped[0], r.privateKey, sealer.ephemeralPub);
    assert.equal(Buffer.compare(prim.keyCommitment(cek), sealer.keyCommit), 0);
    assert.equal(Buffer.compare(prim.aeadOpen(prim.bodyKey(cek), ct, header), body), 0);
    // And a second sealer makes a different key, so the zero nonce is never shared.
    const sealer2 = seal.createSealer({ to: [r.publicKeyRaw] });
    assert.notEqual(Buffer.compare(sealer2.keyCommit, sealer.keyCommit), 0);
  });
});

describe('PAP sealed mode: the CLIs', () => {
  function run(script, args, env = {}) {
    return spawnSync(process.execPath, [path.join(repoRoot, 'bin', script), ...args], {
      encoding: 'utf8', env: { ...process.env, ...env },
    });
  }

  function fixture(tmp) {
    const a = crypto.generateKeyPairSync('ed25519');
    const keyPem = path.join(tmp, 'author.pem');
    fs.writeFileSync(keyPem, a.privateKey.export({ format: 'pem', type: 'pkcs8' }));
    const pubPem = path.join(tmp, 'author.pub.pem');
    fs.writeFileSync(pubPem, a.publicKey.export({ format: 'pem', type: 'spki' }));
    const fp = a.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const spineFile = path.join(tmp, 'spine.txt');
    fs.writeFileSync(spineFile, SPINE);
    assert.equal(run('pap-keygen.js', ['--out', path.join(tmp, 'bob')]).status, 0);
    return { a, keyPem, pubPem, fp, spineFile };
  }

  function exportArgs(f, tmp, extra = []) {
    return [
      '--spine', f.spineFile, '--public', '--seal', '--to', path.join(tmp, 'bob.pub'),
      '--key', f.keyPem, '--chain-head', 'ab'.repeat(32), '--chain-pubkey-fp', f.fp, '--seq', '9', '--timestamp', '1793000000000',
      '--out', path.join(tmp, 'c'), ...extra,
    ];
  }

  it('pap-keygen, pap-export --seal, pap-boot: exit codes 5 (no key), 0 (key), 6 (wrong key)', (t) => {
    if (gate(t)) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pap-sealed-cli-'));
    try {
      const f = fixture(tmp);
      assert.equal(run('pap-keygen.js', ['--out', path.join(tmp, 'eve')]).status, 0);
      assert.notEqual(run('pap-keygen.js', ['--out', path.join(tmp, 'bob')]).status, 0, 'keygen must not overwrite');

      const exp = run('pap-export.js', exportArgs(f, tmp));
      assert.equal(exp.status, 0, exp.stderr);
      assert.match(exp.stdout, /sealed to 1 recipient key\(s\) \(sealing cost 194 B\)/);

      const noKey = run('pap-boot.js', ['--bundle', path.join(tmp, 'c.bin')]);
      assert.equal(noKey.status, 5, noKey.stderr);
      assert.equal(noKey.stdout, '');
      assert.match(noKey.stderr, /verified, sealed to 1 recipient key/);

      const ok = run('pap-boot.js', ['--bundle', path.join(tmp, 'c.bin'), '--recipient-key', path.join(tmp, 'bob.key')]);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(ok.stdout, SPINE);

      const wrong = run('pap-boot.js', ['--bundle', path.join(tmp, 'c.bin'), '--recipient-key', path.join(tmp, 'eve.key')]);
      assert.equal(wrong.status, 6, wrong.stderr);
      assert.equal(wrong.stdout, '');

      const tampered = fs.readFileSync(path.join(tmp, 'c.bin'));
      tampered[tampered.length - 100] ^= 1;
      fs.writeFileSync(path.join(tmp, 'bad.bin'), tampered);
      assert.equal(run('pap-boot.js', ['--bundle', path.join(tmp, 'bad.bin')]).status, 4);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('R1: pap-boot prints its trust basis, and a --verify-key that is not the embedded signer exits 4', (t) => {
    if (gate(t)) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pap-sealed-cli-'));
    try {
      const f = fixture(tmp);
      assert.equal(run('pap-export.js', exportArgs(f, tmp)).status, 0);
      const bundle = path.join(tmp, 'c.bin');
      const bob = path.join(tmp, 'bob.key');

      const self = run('pap-boot.js', ['--bundle', bundle, '--recipient-key', bob]);
      assert.equal(self.status, 0, self.stderr);
      assert.match(self.stderr, /trust self-consistent/);
      assert.match(self.stderr, /compare the fingerprint/);

      const noKey = run('pap-boot.js', ['--bundle', bundle]);
      assert.equal(noKey.status, 5);
      assert.match(noKey.stderr, /trust self-consistent/);

      const supplied = run('pap-boot.js', ['--bundle', bundle, '--recipient-key', bob, '--verify-key', f.pubPem]);
      assert.equal(supplied.status, 0, supplied.stderr);
      assert.match(supplied.stderr, /trust verified-against-supplied-key/);

      const stranger = crypto.generateKeyPairSync('ed25519');
      const otherPem = path.join(tmp, 'other.pub.pem');
      fs.writeFileSync(otherPem, stranger.publicKey.export({ format: 'pem', type: 'spki' }));
      const mismatch = run('pap-boot.js', ['--bundle', bundle, '--recipient-key', bob, '--verify-key', otherPem]);
      assert.equal(mismatch.status, 4, mismatch.stderr);
      assert.equal(mismatch.stdout, '');
      assert.match(mismatch.stderr, /not the key this bundle carries|signer mismatch/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('R2: pap-boot maps a malformed recipient key to exit 2, not a stack trace', (t) => {
    if (gate(t)) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pap-sealed-cli-'));
    try {
      const f = fixture(tmp);
      assert.equal(run('pap-export.js', exportArgs(f, tmp)).status, 0);
      const junk = path.join(tmp, 'junk.key');
      fs.writeFileSync(junk, 'this is not a key\n');
      const r = run('pap-boot.js', ['--bundle', path.join(tmp, 'c.bin'), '--recipient-key', junk]);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(r.stdout, '');
      assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('pap-export --help states the chain-key caveat (KNOWN-LIMITS 8, 48) and what sealing leaves public', (t) => {
    if (gate(t)) return;
    const help = run('pap-export.js', ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /stored unencrypted/);
    assert.match(help.stdout, /anyone who can read the key file can sign bundles in your name/);
    assert.match(help.stdout, /recipient count, signer, chain head, seq and time are public/);
  });
});
