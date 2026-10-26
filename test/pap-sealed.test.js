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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRE = process.env.PAP_SEALED_REQUIRE === '1';

const pack = await import('../src/publish/pack.js');
const manifest = await import('../src/publish/manifest.js');
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

function author() {
  const { privateKey, publicKeyRaw } = pack.generateKeypair();
  return { privateKey, publicKeyRaw };
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

/**
 * Rebuild a sealed bundle around existing inner bytes, the way an attacker
 * holding a content key would: new content key, new recipients, the SAME
 * inner plaintext (inner signature included), a valid outer signature by
 * `signer`. With freshInnerFrom set, the inner signature is recomputed
 * honestly by that key instead, which is the control.
 */
function reseal({ innerBytes, to, signer, signerRaw, chainHeadHash, seq, timestamp, freshInnerFrom }) {
  const cek = seal.generateContentKey();
  const eph = crypto.generateKeyPairSync('x25519');
  const ephRaw = seal.x25519RawPublic(eph.publicKey);
  const headerBytes = manifest.encodeSealedHeader({
    chainHeadHash, chainPubkeyFp: signerRaw, seq, timestamp,
    keyCommit: seal.keyCommitment(cek),
    ephemeralPub: ephRaw,
    x25519Wrapped: to.map((r) => seal.x25519Wrap(cek, eph.privateKey, ephRaw, r)),
    passphrase: null,
  });
  let inner = innerBytes;
  if (freshInnerFrom) {
    const memoirLen = inner.readUInt16BE(64);
    const memoir = inner.subarray(66, 66 + memoirLen);
    const spineRaw = zlibDecompress(inner.subarray(66 + memoirLen));
    const sig = crypto.sign(null, seal.innerMessage(headerBytes, spineRaw, memoir), freshInnerFrom);
    inner = Buffer.concat([sig, inner.subarray(64)]);
  }
  const ct = seal.aeadSeal(seal.bodyKey(cek), inner, headerBytes);
  const m = manifest.encodeSealedManifest(headerBytes, ct);
  return Buffer.concat([m, crypto.sign(null, m, signer)]);
}

import zlib from 'node:zlib';
function zlibDecompress(b) {
  return zlib.brotliDecompressSync(b);
}

/** Open a sealed bundle as a recipient and return its raw inner plaintext. */
function innerOf(bundle, recipientKey) {
  const { contentKey } = pack.unpack({ bundle, recipientKey });
  const m = manifest.decodeSealedManifest(bundle.subarray(0, bundle.length - 64));
  return seal.aeadOpen(seal.bodyKey(contentKey), m.ciphertext, m.headerBytes);
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
    const { bundle, recipients } = pack.pack(base(a, { seal: { passphrase: 'pass words here', iterations: 1000 } }));
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
    const cek1 = seal.generateContentKey();
    const cek2 = seal.generateContentKey();
    const eph = crypto.generateKeyPairSync('x25519');
    const ephRaw = seal.x25519RawPublic(eph.publicKey);
    const inputs = base(a);
    const headerBytes = manifest.encodeSealedHeader({
      chainHeadHash: inputs.chainHeadHash, chainPubkeyFp: a.publicKeyRaw, seq: 77, timestamp: inputs.timestamp,
      keyCommit: seal.keyCommitment(cek1),
      ephemeralPub: ephRaw,
      x25519Wrapped: [seal.x25519Wrap(cek1, eph.privateKey, ephRaw, r1.publicKeyRaw), seal.x25519Wrap(cek2, eph.privateKey, ephRaw, r2.publicKeyRaw)],
      passphrase: null,
    });
    const spineRaw = Buffer.from(SPINE, 'utf8');
    const innerSig = crypto.sign(null, seal.innerMessage(headerBytes, spineRaw, Buffer.alloc(0)), a.privateKey);
    const inner = Buffer.concat([innerSig, Buffer.from([0, 0]), zlib.brotliCompressSync(spineRaw)]);
    const m = manifest.encodeSealedManifest(headerBytes, seal.aeadSeal(seal.bodyKey(cek1), inner, headerBytes));
    const bundle = Buffer.concat([m, crypto.sign(null, m, a.privateKey)]);
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

  it('budget: overhead is measured and pinned (194 B for one key, +48 B per extra key, 182 B for a passphrase)', (t) => {
    if (gate(t)) return;
    const a = author();
    const keys = Array.from({ length: 5 }, () => pack.generateRecipientKeypair().publicKeyRaw);
    const plain = pack.pack(base(a));
    for (let n = 1; n <= 5; n++) {
      const res = pack.pack(base(a, { seal: { to: keys.slice(0, n) } }));
      assert.equal(res.sealOverhead, 194 + 48 * (n - 1), `overhead for ${n} recipient(s)`);
      assert.equal(res.totalLen, plain.totalLen + res.sealOverhead);
    }
    const pass = pack.pack(base(a, { seal: { passphrase: 'x', iterations: 1 } }));
    assert.equal(pass.sealOverhead, 182);
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
  });

  it('shared negative vectors: valid outer signature, refused on the inner binding and the key commitment', (t) => {
    if (gate(t)) return;
    const dir = path.join(repoRoot, 'test-data', 'pap-vectors');
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'vectors.json'), 'utf8'));
    for (const name of ['v2-neg-readdressed', 'v2-neg-key-commit']) {
      const vec = v.vectors[name];
      const bundle = fs.readFileSync(path.join(dir, vec.file));
      assert.equal(crypto.createHash('sha256').update(bundle).digest('hex'), vec.sha256, name + ' file changed');
      assert.equal(pack.inspect({ bundle }).info.sealed, true, name + ': the outer signature must verify');
      for (const [who, want] of Object.entries(vec.expect)) {
        const key = v.recipients[who].privateKeyHex;
        if (want === 'opens') assert.equal(pack.unpack({ bundle, recipientKey: key }).spine, v.spine);
        else assert.equal(codeOf(() => pack.unpack({ bundle, recipientKey: key })), want, `${name} as ${who}`);
      }
    }
  });
});

describe('PAP sealed mode: the CLIs', () => {
  function run(script, args, env = {}) {
    return spawnSync(process.execPath, [path.join(repoRoot, 'bin', script), ...args], {
      encoding: 'utf8', env: { ...process.env, ...env },
    });
  }

  it('pap-keygen, pap-export --seal, pap-boot: exit codes 5 (no key), 0 (key), 6 (wrong key)', (t) => {
    if (gate(t)) return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pap-sealed-cli-'));
    try {
      const a = crypto.generateKeyPairSync('ed25519');
      const keyPem = path.join(tmp, 'author.pem');
      fs.writeFileSync(keyPem, a.privateKey.export({ format: 'pem', type: 'pkcs8' }));
      const fp = a.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
      const spineFile = path.join(tmp, 'spine.txt');
      fs.writeFileSync(spineFile, SPINE);
      assert.equal(run('pap-keygen.js', ['--out', path.join(tmp, 'bob')]).status, 0);
      assert.equal(run('pap-keygen.js', ['--out', path.join(tmp, 'eve')]).status, 0);
      assert.notEqual(run('pap-keygen.js', ['--out', path.join(tmp, 'bob')]).status, 0, 'keygen must not overwrite');

      const exp = run('pap-export.js', [
        '--spine', spineFile, '--public', '--seal', '--to', path.join(tmp, 'bob.pub'),
        '--key', keyPem, '--chain-head', 'ab'.repeat(32), '--chain-pubkey-fp', fp, '--seq', '9', '--timestamp', '1793000000000',
        '--out', path.join(tmp, 'c'),
      ]);
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

  it('pap-export --help states the chain-key caveat (KNOWN-LIMITS 8, 48) and what sealing leaves public', (t) => {
    if (gate(t)) return;
    const help = run('pap-export.js', ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /stored unencrypted/);
    assert.match(help.stdout, /anyone who can read the key file can sign bundles in your name/);
    assert.match(help.stdout, /recipient count, signer, chain head, seq and time are public/);
  });
});
