/**
 * The offline PAP reader (web/reader/), WO-CARTRIDGE-SEAL part C.
 *
 * The page's verify and open logic is web/reader/pap-reader.js, run here in
 * node with node's WebCrypto and the same vendored brotli decoder and
 * Ed25519 fallback the page inlines. It is checked against the shared vectors
 * in test-data/pap-vectors/, which the node signer produced: the same bundles
 * verify (or are refused) in node and in the page.
 *
 * Fail-first: on main there is no web/reader/, so every test here fails at
 * import. Beyond that, each defence is shown to matter by a negative: tampered
 * bytes, a re-addressed swap and a split key all have valid-looking structure
 * and must be refused.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import * as reader from '../web/reader/pap-reader.js';
import { BrotliDecode } from '../web/reader/vendor/brotli-decode.js';
import * as noble from '../web/reader/vendor/noble-ed25519.js';
import { build, VENDOR } from '../web/reader/build.mjs';
import { unpack } from '../src/publish/pack.js';
import { bundleToPng } from '../src/publish/qr.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VEC_DIR = path.join(repoRoot, 'test-data', 'pap-vectors');
const V = JSON.parse(fs.readFileSync(path.join(VEC_DIR, 'vectors.json'), 'utf8'));
const vec = (name) => new Uint8Array(fs.readFileSync(path.join(VEC_DIR, V.vectors[name].file)));
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const deps = {
  subtle: globalThis.crypto.subtle,
  brotliDecode: (u8) => {
    const out = BrotliDecode(new Int8Array(u8.buffer, u8.byteOffset, u8.length));
    return new Uint8Array(out.buffer, out.byteOffset, out.length);
  },
  ed25519Fallback: noble,
};
const fallbackDeps = { ...deps, forceFallback: true };

async function codeOf(p) {
  try {
    await p;
  } catch (err) {
    return err.code || 'NO_CODE:' + err.message;
  }
  return 'NO_THROW';
}

describe('PAP reader: shared vectors', () => {
  it('the vector files are the ones vectors.json describes', () => {
    for (const [name, meta] of Object.entries(V.vectors)) {
      assert.equal(crypto.createHash('sha256').update(vec(name)).digest('hex'), meta.sha256, name);
    }
  });

  it('v1: verifies with the fields the signer wrote, and opens to the same spine node unpack() gives', async () => {
    const b = vec('v1-plain');
    const v = await reader.verify(b, deps);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.sealed, false);
    assert.equal(v.signerFingerprint, V.signer.publicKeyHex);
    assert.equal(v.chainHead, V.chainHeadHex);
    assert.equal(v.seq, V.seq);
    assert.equal(v.timestamp, V.timestamp);
    assert.equal(v.bytes, 297);
    assert.equal(v.cap, 2953);
    assert.equal(v.verifiedVia, 'WebCrypto');
    const o = await reader.open(b, {}, deps);
    assert.equal(o.spine, V.spine);
    assert.equal(o.spine, unpack({ bundle: Buffer.from(b) }).spine, 'page and node disagree on the v1 spine');
    assert.equal(o.memoirUrl, V.vectors['v1-plain'].memoirUrl);
  });

  it('v2: verifies with no key and reports "sealed to N" before any key is given', async () => {
    const v = await reader.verify(vec('v2-sealed-two-recipients'), deps);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.sealed, true);
    assert.deepEqual(v.recipients, { x25519: 2, passphrase: false });
    assert.equal(v.signerFingerprint, V.signer.publicKeyHex);
    const p = await reader.verify(vec('v2-sealed-passphrase'), deps);
    assert.deepEqual(p.recipients, { x25519: 0, passphrase: true });
    assert.equal(await codeOf(reader.open(vec('v2-sealed-two-recipients'), {}, deps)), 'PAP_SEALED_NEEDS_KEY');
  });

  it('v2: each recipient opens it; an outsider and a wrong passphrase get clean coded failures', async () => {
    const b = vec('v2-sealed-two-recipients');
    for (const who of ['r1', 'r2']) {
      const o = await reader.open(b, { recipientKey: V.recipients[who].privateKeyHex }, deps);
      assert.equal(o.spine, V.spine, who);
      assert.equal(o.memoirUrl, 'https://example.invalid/memoir');
    }
    assert.equal(await codeOf(reader.open(b, { recipientKey: V.recipients.outsider.privateKeyHex }, deps)), 'PAP_NOT_A_RECIPIENT');
    const pass = vec('v2-sealed-passphrase');
    assert.equal((await reader.open(pass, { passphrase: V.passphrase }, deps)).spine, V.spine);
    assert.equal(await codeOf(reader.open(pass, { passphrase: V.passphrase + 'x' }, deps)), 'PAP_NOT_A_RECIPIENT');
    assert.equal(await codeOf(reader.open(b, { recipientKey: 'not a key' }, deps)), 'PAP_BAD_KEY');
  });

  it('v2: a recipient key in PKCS8 PEM form opens it too', async () => {
    const raw = Buffer.from(V.recipients.r1.privateKeyHex, 'hex');
    const pem = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8',
    }).export({ format: 'pem', type: 'pkcs8' });
    assert.equal((await reader.open(vec('v2-sealed-two-recipients'), { recipientKey: pem }, deps)).spine, V.spine);
  });

  it('reveal: the content key opens it for anyone, a random one fails the commitment', async () => {
    const b = vec('v2-sealed-two-recipients');
    const { contentKey } = await reader.open(b, { recipientKey: V.recipients.r1.privateKeyHex }, deps);
    assert.equal((await reader.open(b, { contentKey }, deps)).spine, V.spine);
    assert.equal(await codeOf(reader.open(b, { contentKey: crypto.randomBytes(32).toString('hex') }, deps)), 'PAP_KEY_COMMIT_MISMATCH');
  });

  it('negative vectors: a valid outer signature is not enough (inner binding, key commitment)', async () => {
    for (const name of ['v2-neg-readdressed', 'v2-neg-key-commit']) {
      const b = vec(name);
      assert.equal((await reader.verify(b, deps)).ok, true, name + ': outer signature must verify for the test to mean anything');
      for (const [who, want] of Object.entries(V.vectors[name].expect)) {
        const res = reader.open(b, { recipientKey: V.recipients[who].privateKeyHex }, deps);
        if (want === 'opens') assert.equal((await res).spine, V.spine, `${name} as ${who}`);
        else assert.equal(await codeOf(res), want, `${name} as ${who}`);
      }
    }
  });

  it('every single-bit flip of every vector fails verification, and verify() never throws', async () => {
    for (const name of ['v1-plain', 'v2-sealed-two-recipients', 'v2-sealed-passphrase']) {
      const b = vec(name);
      for (let pos = 0; pos < b.length; pos++) {
        const t = Uint8Array.from(b);
        t[pos] ^= 0x01;
        const v = await reader.verify(t, deps);
        assert.equal(v.ok, false, `${name}: flip at ${pos} verified`);
        assert.equal(await codeOf(reader.open(t, { recipientKey: V.recipients.r1.privateKeyHex, passphrase: V.passphrase }, deps)) === 'NO_THROW', false);
      }
    }
  });

  it('Ed25519 fallback (pinned noble) agrees with WebCrypto on good and tampered bundles', async () => {
    for (const name of ['v1-plain', 'v2-sealed-two-recipients']) {
      const v = await reader.verify(vec(name), fallbackDeps);
      assert.equal(v.ok, true, name);
      assert.equal(v.verifiedVia, 'noble-ed25519 fallback');
      const t = vec(name);
      t[t.length - 1] ^= 0x80;
      assert.equal((await reader.verify(t, fallbackDeps)).ok, false);
      // Flipped public-key bytes often decode to no curve point at all, so
      // noble throws instead of returning false: that must read as a failure.
      for (let pos = 33; pos < 65; pos++) {
        const k = vec(name);
        k[pos] ^= 0x01;
        assert.equal((await reader.verify(k, fallbackDeps)).ok, false, `${name}: key flip at ${pos} verified on the fallback`);
      }
    }
    const o = await reader.open(vec('v2-sealed-two-recipients'), { recipientKey: V.recipients.r2.privateKeyHex }, fallbackDeps);
    assert.equal(o.spine, V.spine);
    const neg = reader.open(vec('v2-neg-readdressed'), { recipientKey: V.recipients.r2.privateKeyHex }, fallbackDeps);
    assert.equal(await codeOf(neg), 'PAP_INNER_BINDING_INVALID');
  });

  it('garbage and truncated input is a coded not-verified result, not a crash', async () => {
    for (const b of [new Uint8Array(0), new Uint8Array(10), vec('v1-plain').subarray(0, 100), Uint8Array.from([9, ...vec('v1-plain').subarray(1)])]) {
      const v = await reader.verify(b, deps);
      assert.equal(v.ok, false);
      assert.match(v.code, /^PAP_/);
    }
  });
});

describe('PAP reader: QR byte mode end to end', () => {
  it('a v40 QR of the sealed vector, rendered by src/publish/qr.js, decodes through the pinned jsQR to the exact bytes', async () => {
    const ctx = { self: {} };
    vm.runInNewContext(fs.readFileSync(path.join(repoRoot, 'web', 'reader', 'vendor', 'jsQR.js'), 'utf8'), ctx);
    const jsQR = ctx.self.jsQR;
    assert.equal(typeof jsQR, 'function');
    const bundle = vec('v2-sealed-two-recipients');
    const png = PNG.sync.read(await bundleToPng(Buffer.from(bundle)));
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.ok(code, 'jsQR found no code');
    const bytes = Uint8Array.from(code.binaryData);
    assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(bundle)), 0, 'decoded bytes differ from the bundle');
    assert.equal((await reader.verify(bytes, deps)).ok, true);
  });
});

describe('PAP reader: the page', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'web', 'reader', 'index.html'), 'utf8').split(CRLF).join(LF);

  it('index.html is exactly the build of the committed sources and pinned vendor files', () => {
    assert.equal(html, build(), 'stale: run node web/reader/build.mjs');
  });

  it('vendor files match their pins and ship with their licenses', () => {
    for (const [name, pin] of Object.entries(VENDOR)) {
      const text = fs.readFileSync(path.join(repoRoot, 'web', 'reader', 'vendor', name), 'utf8').split(CRLF).join(LF);
      assert.equal(crypto.createHash('sha256').update(text, 'utf8').digest('hex'), pin.sha256, name);
    }
    for (const lic of ['jsQR.LICENSE', 'brotli.LICENSE', 'noble-ed25519.LICENSE']) {
      assert.ok(fs.statSync(path.join(repoRoot, 'web', 'reader', 'vendor', lic)).size > 500, lic);
    }
  });

  it('no network: the CSP forbids connections, and nothing loads from outside the file', () => {
    // Checked on the committed page and on a fresh build of the sources, so a
    // source change fails here and not only as "stale".
    for (const page of [html, build()]) checkNoNetwork(page);
  });

  function checkNoNetwork(html) {
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(csp, 'no CSP meta');
    const head = html.slice(0, html.indexOf('<script'));
    assert.ok(head.includes(csp[0]), 'the CSP must come before every script');
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
      assert.ok(csp[1].includes(directive), 'CSP lacks ' + directive);
    }
    assert.equal(/<script[^>]+src=/i.test(html), false, 'external script');
    assert.equal(/<link[^>]+href=/i.test(html), false, 'external stylesheet');
    assert.equal(/@import/i.test(html), false, 'CSS import');
    for (const f of ['pap-reader.js', 'view.js', 'scan.js', 'index.src.html']) {
      const src = fs.readFileSync(path.join(repoRoot, 'web', 'reader', f), 'utf8');
      for (const api of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'import(']) {
        assert.equal(src.includes(api), false, `${f} uses ${api}`);
      }
    }
  }

  it('every inline script parses', () => {
    const bodies = [...html.matchAll(/<script(?: type="module")?>\n([\s\S]*?)\n<\/script>/g)].map((m) => m[1]);
    assert.equal(bodies.length, 4);
    for (const body of bodies) new vm.Script(body);
  });

  it('the view takes "verified" only from reader.verify() and reader.open()', () => {
    const view = fs.readFileSync(path.join(repoRoot, 'web', 'reader', 'view.js'), 'utf8');
    assert.ok(view.includes('await reader.verify(bytes, deps)'));
    assert.match(view, /setText\('status', v\.ok\s*\?\s*\(v\.sealed \? 'Verified\./);
    assert.equal(/crypto\.subtle|\bsubtle\b|importKey|\.verify\(\s*\{/.test(view), false, 'the view must not do crypto of its own');
  });
});
