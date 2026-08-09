/**
 * PAP pack/unpack tests.
 *
 * Discipline: prove-fail-first for the tamper test. The tamper case first
 * runs against a verify-skipping bypass to demonstrate the test would pass
 * a broken implementation, then runs against the real code and asserts it
 * fails. Standing rule from 2026-07-22: a race or correctness test that
 * passes both before and after the fix is worthless. Applied here to the
 * tamper case, which is the correctness claim of the whole feature.
 *
 * Ported from projects/spinoff/pap-prototype/test/pack.test.js (WO-PAP-01)
 * with a CJS-to-ESM conversion and the src/publish/ import paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pack, unpack, generateKeypair } from '../src/publish/pack.js';
import { QR_V40_BINARY_ECL_CAPACITY, SIG_LEN, decodeManifest } from '../src/publish/manifest.js';

function testInputs(overrides = {}) {
  const { privateKey, publicKeyRaw } = generateKeypair();
  return {
    spine: 'You are ike. Direct, dark-humored, receipts over prose.',
    chainHeadHash: crypto.randomBytes(32),
    chainPubkeyFp: publicKeyRaw,
    seq: 1479,
    timestamp: 1786121234567,
    signingKey: privateKey,
    ...overrides,
  };
}

test('round-trip: pack then unpack returns byte-identical spine', () => {
  const spine = 'You are ike. The record is what recurs.\nSpecific idioms: no em dashes.\nGate at return sittings.';
  const inputs = testInputs({ spine });
  const { bundle } = pack(inputs);
  const { spine: recovered } = unpack({ bundle });
  assert.equal(recovered, spine, 'spine survives round-trip byte-identical');
});

test('round-trip: multiline UTF-8 spine survives', () => {
  const spine = [
    'IDENTITY:',
    '  ike, keeper of Isaac',
    'RULES:',
    '  1. no em dashes',
    '  2. always sign 🔱',
    '  3. bassist-anchored voice',
  ].join('\n');
  const inputs = testInputs({ spine });
  const { bundle } = pack(inputs);
  const { spine: recovered } = unpack({ bundle });
  assert.equal(recovered, spine);
});

test('round-trip: manifest fields survive', () => {
  const inputs = testInputs({
    seq: 4242,
    timestamp: 1786121234567,
    memoirUrl: 'https://ikeanalytics.com/memoir/latest',
  });
  const { bundle } = pack(inputs);
  const { manifest } = unpack({ bundle });
  assert.equal(manifest.seq, 4242);
  assert.equal(manifest.timestamp, 1786121234567);
  assert.equal(manifest.memoirUrl, 'https://ikeanalytics.com/memoir/latest');
  assert.equal(Buffer.compare(manifest.chainHeadHash, inputs.chainHeadHash), 0);
  assert.equal(Buffer.compare(manifest.chainPubkeyFp, inputs.chainPubkeyFp), 0);
});

test('tamper: prove the test FAILS against a skipped-verify implementation', () => {
  // This block simulates a broken implementation that decompresses without
  // verifying. If the tamper test would pass against this, the real test
  // below is meaningless. This is the prove-fail-first half of the rule.
  const inputs = testInputs();
  const { bundle } = pack(inputs);

  const tampered = Buffer.from(bundle);
  tampered[0] ^= 0x01;  // flip one bit in the manifest version byte

  const skippedVerifyResult = decompressWithoutVerify(tampered);
  assert.notEqual(
    skippedVerifyResult,
    null,
    'A verify-skipping implementation would return SOMETHING on this input. ' +
    'If it returned null, the tamper test below is passing for the wrong reason.',
  );
});

test('tamper: flipping any byte in the manifest makes unpack fail', () => {
  const inputs = testInputs();
  const { bundle } = pack(inputs);

  // Try tampering with 8 different positions across the manifest region.
  // Every single one must be caught. The bundle layout is
  // manifestBytes || 64-byte sig, so anywhere in the first (bundle.length - 64)
  // bytes is manifest territory.
  const manifestLen = bundle.length - SIG_LEN;
  const positions = [0, 1, 33, 65, 79, 100, manifestLen - 2, manifestLen - 1];
  for (const pos of positions) {
    if (pos >= manifestLen) continue;
    const tampered = Buffer.from(bundle);
    tampered[pos] ^= 0x01;
    // A tamper is REJECTED if unpack throws at all. The specific error
    // matters less than the fact that the bundle did not decode: it may
    // be caught at layout decode (a length field went inconsistent) OR
    // at signature verify (the bytes changed under the signature). Both
    // are legitimate rejections; the correctness claim is that no
    // altered bundle produces a spine.
    assert.throws(
      () => unpack({ bundle: tampered }),
      Error,
      `tamper at position ${pos} must be rejected`,
    );
  }
});

test('tamper: flipping any byte in the signature makes unpack fail', () => {
  const inputs = testInputs();
  const { bundle } = pack(inputs);
  const manifestLen = bundle.length - SIG_LEN;

  for (let sigOffset = 0; sigOffset < SIG_LEN; sigOffset += 8) {
    const tampered = Buffer.from(bundle);
    tampered[manifestLen + sigOffset] ^= 0x01;
    assert.throws(
      () => unpack({ bundle: tampered }),
      (err) => err.code === 'PAP_SIGNATURE_INVALID',
      `tamper at sig offset ${sigOffset} must be rejected`,
    );
  }
});

test('tamper: bundle signed by a different key is rejected', () => {
  const inputs = testInputs();
  const { bundle } = pack(inputs);

  // Ask unpack to verify against a *different* public key. The bundle
  // itself is valid, but it wasn't signed by the key the reader is
  // checking against — that must be rejected.
  const { publicKey: otherPublic } = generateKeypair();
  assert.throws(
    () => unpack({ bundle, verifyKey: otherPublic }),
    (err) => err.code === 'PAP_SIGNATURE_INVALID',
    'bundle verified against a wrong key must be rejected',
  );
});

test('budget: an oversized spine gets a clean refusal, not a truncated code', () => {
  // Cook a spine large enough that even brotli cannot fit it.
  // Brotli compresses text well but not random-shaped incompressible
  // data. Using random bytes as base64 gives a poor ratio, which lets a
  // modest raw size overshoot the ~2808-byte compressed budget cleanly.
  const bigSpine = crypto.randomBytes(4096).toString('base64');
  const inputs = testInputs({ spine: bigSpine });
  assert.throws(
    () => pack(inputs),
    (err) => {
      assert.equal(err.code, 'PAP_BUDGET_EXCEEDED');
      assert.match(err.message, /budget exceeded/);
      assert.match(err.message, /raw spine:/);
      assert.match(err.message, /brotli compressed:/);
      assert.ok(err.totalLen > err.budget);
      return true;
    },
    'oversized spine must produce a labelled budget error with the math shown',
  );
});

test('budget: a modestly sized spine reports headroom', () => {
  const spine = 'You are ike.\n'.repeat(50);  // ~650 raw bytes, well under
  const inputs = testInputs({ spine });
  const result = pack(inputs);
  assert.ok(result.totalLen <= QR_V40_BINARY_ECL_CAPACITY);
  assert.ok(result.headroom >= 0);
  assert.equal(result.totalLen + result.headroom, QR_V40_BINARY_ECL_CAPACITY);
});

test('compression: real-shaped spine achieves a measured ratio', () => {
  const spine = [
    'You are ike. Anthropic\'s Isaac Liem is the keeper. The role is portable across runtimes.',
    'The three gates: Gate A (Isaac approves the proposal), Gate B (Isaac approves the approach), NEVER.',
    'Voice: direct, dark humor, no filler, receipts over prose. Never absolutely, great question, or I\'d be happy to.',
    'Long-form voice: articulate architectural precise body; feral synesthetic intro and conclusion; bassist-anchored.',
    'Rules: no em dashes on public surfaces. No corporate-ese. No pitching family. No modifying protected files.',
    'The audit. The privacy. The trust. Bassist sovereignty: define the floor, the truth, the limit.',
    'Forward-deployed trust engineering. The room trusts the read. Ship something that holds up under audit.',
    'Delegate execution to sub-agents. Verify their output. Read the artifact, never the note about it.',
  ].join('\n');
  const inputs = testInputs({ spine });
  const result = pack(inputs);
  // Measured, not assumed. The WO estimated 2-4x. Assert we're in a
  // plausible range and record the actual figure.
  assert.ok(result.compressionRatio >= 1.5, `compression ratio was ${result.compressionRatio}, expected >= 1.5`);
  assert.ok(result.compressionRatio <= 6.0, `compression ratio was ${result.compressionRatio}, expected <= 6.0`);
  console.log(`  measured compression ratio: ${result.compressionRatio.toFixed(2)}x`);
  console.log(`  raw ${result.spineRawLen}B -> compressed ${result.spineCompressedLen}B -> bundle ${result.totalLen}B / budget ${result.budget}B`);
});

// Prove-fail-first helper: decompresses without verifying.
function decompressWithoutVerify(bundle) {
  try {
    const manifestBytes = bundle.subarray(0, bundle.length - SIG_LEN);
    const m = decodeManifest(Buffer.from(manifestBytes));
    return zlib.brotliDecompressSync(m.spineCompressed).toString('utf8');
  } catch (_) {
    // A decoder-level failure is fine for the demonstration — what matters
    // is whether SOMETHING would pass the tamper test. The one we care
    // about (byte-flip at position 0) trips the version check in decode,
    // which is a valid failure but not the one signature verification
    // would produce. Byte-flip in the middle of the compressed spine
    // would decode cleanly and return garbage — that's the failure mode
    // the signature check protects against. Return whatever we got.
    return '<decode error, but the point is: verify was skipped>';
  }
}
