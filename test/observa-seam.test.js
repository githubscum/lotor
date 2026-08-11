/**
 * Observa interop seam wiring (option 2), 2026-08-10.
 *
 * Spec: brain projects/spinoff/OBSERVA-INTEROP-SEAM-SPEC-2026-08-07.md §4/§9.
 * The seam's correctness claim is content-addressing: an authorising system
 * canonicalises tool params at decision time, Lotor canonicalises the SAME
 * params at call time, and equality of the two full-length digests binds
 * intent to execution. These tests hold the Lotor half of that claim:
 *
 *   1. every ran[] item carries paramsDigestCanonical, full 64-hex,
 *      equal to sha256 of the canonical (recursively key-sorted) params;
 *   2. key order does NOT change the canonical digest (the whole point),
 *      while the LEGACY short digest DOES change - which proves the old
 *      field alone could never have closed the seam, i.e. the fail case
 *      the wiring exists to fix is demonstrated, not assumed;
 *   3. the opaque correlation echo passes through verbatim, and its
 *      bounds (string, 1..64 chars) refuse hostile or malformed values;
 *   4. the payload carries receiptSchema 'receipt/2' so a reader can tell
 *      wired receipts from pre-seam receipts by presence, not guesswork.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { parseSession, digestParamsCanonical } from '../src/parser/index.js';

function transcriptWith(input, { model = 'test-model-v1' } = {}) {
  return JSON.stringify({
    sessionId: 'seam-test-001',
    version: '2.1.999',
    createdAt: '2026-08-10T10:00:00Z',
    type: 'session-start'
  }) + '\n' + JSON.stringify({
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', name: 'PaymentAPI.refund', id: 'tu-1', input }],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    },
    createdAt: '2026-08-10T10:01:00Z'
  }) + '\n';
}

function canonicalSha256(value) {
  const sort = v => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sort);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
    return out;
  };
  return crypto.createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}

describe('observa seam: canonical digest on ran[]', () => {
  it('every ran item carries a full 64-hex paramsDigestCanonical matching the canonical sha256', () => {
    const input = { amount_cents: 5000, reason: 'returned item', customer: 'C' };
    const r = parseSession(transcriptWith(input));
    assert.strictEqual(r.ran.length, 1);
    const item = r.ran[0];
    assert.match(item.paramsDigestCanonical, /^[0-9a-f]{64}$/);
    assert.strictEqual(item.paramsDigestCanonical, canonicalSha256(input));
    // legacy field still present and still short - option 2 adds, never replaces
    assert.match(item.paramsDigest, /^[0-9a-f]{16}$/);
  });

  it('key order does not change the canonical digest, and DOES change the legacy one (the seam-closing property, proven not assumed)', () => {
    const a = { amount_cents: 5000, reason: 'returned item' };
    const b = { reason: 'returned item', amount_cents: 5000 };
    const ra = parseSession(transcriptWith(a)).ran[0];
    const rb = parseSession(transcriptWith(b)).ran[0];
    assert.strictEqual(ra.paramsDigestCanonical, rb.paramsDigestCanonical,
      'canonical digests must be key-order invariant');
    // The legacy digest is over insertion-order JSON. If this assertion ever
    // fails (i.e. the short digests match), the prove-fail half is broken and
    // the canonical field would be redundant rather than load-bearing.
    assert.notStrictEqual(ra.paramsDigest, rb.paramsDigest,
      'legacy short digest is expected to differ under key reorder; if it matches, re-examine this suite');
  });

  it('digestParamsCanonical export agrees with the wired field', () => {
    const input = { z: 1, a: { d: [3, { y: 2, x: 1 }], c: 'v' } };
    const r = parseSession(transcriptWith(input));
    assert.strictEqual(r.ran[0].paramsDigestCanonical, digestParamsCanonical(input));
  });
});

describe('observa seam: correlationId echo', () => {
  it('echoes a valid _observaCorrelationId verbatim', () => {
    const corr = 'obs_refund_2026-08-07T18:00Z_a3f9c1';
    const r = parseSession(transcriptWith({ amount_cents: 5000, _observaCorrelationId: corr }));
    assert.strictEqual(r.ran[0].correlationIdEcho, corr);
  });

  it('omits the echo when the key is absent', () => {
    const r = parseSession(transcriptWith({ amount_cents: 5000 }));
    assert.strictEqual(r.ran[0].correlationIdEcho, undefined);
  });

  it('refuses an over-length correlation id (bound 64)', () => {
    const r = parseSession(transcriptWith({ _observaCorrelationId: 'x'.repeat(65) }));
    assert.strictEqual(r.ran[0].correlationIdEcho, undefined);
  });

  it('refuses non-string correlation values', () => {
    const r = parseSession(transcriptWith({ _observaCorrelationId: { sneak: true } }));
    assert.strictEqual(r.ran[0].correlationIdEcho, undefined);
    const r2 = parseSession(transcriptWith({ _observaCorrelationId: '' }));
    assert.strictEqual(r2.ran[0].correlationIdEcho, undefined);
  });

  it('the echo participates in the canonical digest like any other input key (the witness does not edit the record)', () => {
    // The correlation key is part of the tool input as observed; stripping it
    // from the digest would mean the witness alters what it attests. Verify
    // the digest covers the input verbatim, echo key included.
    const input = { amount_cents: 5000, _observaCorrelationId: 'obs_x_1' };
    const r = parseSession(transcriptWith(input));
    assert.strictEqual(r.ran[0].paramsDigestCanonical, canonicalSha256(input));
  });
});

describe('observa seam: receipt schema marker', () => {
  it('payload carries receiptSchema receipt/2', () => {
    const r = parseSession(transcriptWith({ a: 1 }));
    assert.strictEqual(r.receiptSchema, 'receipt/2');
  });
});
