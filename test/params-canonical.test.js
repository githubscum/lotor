/**
 * test/params-canonical.test.js
 *
 * Regression tests for digestParamsCanonical() in src/parser/index.js.
 *
 * WHY THIS FILE EXISTS
 *   A byte-stable canonical digest is the whole point of the function: once a
 *   receipt records a params/1 digest, every later version of the function
 *   MUST hash the same input to the same 64 chars, or every previously signed
 *   digest becomes orphaned and the signature layer loses its authority over
 *   that tool call. The pin in test #1 below is the audit point that catches
 *   a silent change to the canonicalization rule before it ships.
 *
 *   The pin was derived by hand-tracing the canonicalizer against the
 *   fixture:
 *
 *     input         : {"b":1,"a":{"d":4,"c":3}}
 *     sort top keys : {"a":{...},"b":1}
 *     sort inner    : {"a":{"c":3,"d":4},"b":1}
 *     JSON.stringify: {"a":{"c":3,"d":4},"b":1}
 *     SHA-256 hex   : 943d56ce0b02b80a8afcd12d849426226b68f2d8cd2840af8f6f93067f14c360
 *
 *   Verified out-of-band via `printf '%s' '<canonical>' | sha256sum` against
 *   the same canonical bytes; see commit message for the trace.
 *
 *   Tests #2-#6 exercise the contract: key order does not change the digest,
 *   array order DOES, different content diverges, output shape is fixed, and
 *   nested sorting is recursive. None of these alone prevents a silent
 *   regression; only #1 does, and the rest are here so a future reader can
 *   tell WHY the pin matters.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { digestParamsCanonical } from '../src/parser/index.js';

/**
 * Pinned literal for the byte-compat test below.
 *
 * MUST remain byte-for-byte compatible with digests persisted by previous
 * versions — if this test fails, every previously signed params/1 digest is
 * orphaned.
 */
const PINNED_FIXTURE_INPUT = { b: 1, a: { d: 4, c: 3 } };
const PINNED_DIGEST = '943d56ce0b02b80a8afcd12d849426226b68f2d8cd2840af8f6f93067f14c360';

describe('digestParamsCanonical', () => {
  it('produces the pinned byte-compat digest for the canonical fixture', () => {
    // The single source of truth for "this is the right digest." Any change
    // to canonicalize() or the hashing path MUST surface here first.
    const got = digestParamsCanonical(PINNED_FIXTURE_INPUT);
    assert.strictEqual(got, PINNED_DIGEST,
      `expected pinned digest ${PINNED_DIGEST} but got ${got}. ` +
      'If you changed the canonicalizer, every previously signed params/1 ' +
      'digest is now orphaned. Re-pin intentionally and document why.');
  });

  it('treats two object orderings of the same content as identical', () => {
    // Key order at every depth is the whole reason this function exists;
    // a plain SHA-256 over JSON.stringify would not give us this property.
    const a = { a: 1, b: 2, c: 3 };
    const b = { c: 3, b: 2, a: 1 };
    assert.strictEqual(
      digestParamsCanonical(a),
      digestParamsCanonical(b),
      'object key order at the top level must not change the digest'
    );

    // And inside a nested object, too.
    const nested1 = { outer: { x: 1, y: 2 }, tag: 'v1' };
    const nested2 = { tag: 'v1', outer: { y: 2, x: 1 } };
    assert.strictEqual(
      digestParamsCanonical(nested1),
      digestParamsCanonical(nested2),
      'object key order at nested depths must not change the digest'
    );
  });

  it('treats two array orderings as different', () => {
    // Arrays are kept in order: reordering an array is a content change, not
    // a key-ordering change, and the digest has to reflect that. This is the
    // boundary that lets "tool was called with these args in this sequence"
    // survive canonicalization.
    const a = { items: [1, 2, 3] };
    const b = { items: [3, 2, 1] };
    assert.notStrictEqual(
      digestParamsCanonical(a),
      digestParamsCanonical(b),
      'array order MUST change the digest'
    );

    // Array of objects also reorders with content.
    const c = { rows: [{ id: 'x' }, { id: 'y' }] };
    const d = { rows: [{ id: 'y' }, { id: 'x' }] };
    assert.notStrictEqual(
      digestParamsCanonical(c),
      digestParamsCanonical(d),
      'array of objects order MUST change the digest'
    );
  });

  it('produces different digests for different content', () => {
    // Sanity: the function is not a constant. Different scalar values, and
    // different string bodies, must diverge.
    assert.notStrictEqual(
      digestParamsCanonical({ a: 1 }),
      digestParamsCanonical({ a: 2 })
    );
    assert.notStrictEqual(
      digestParamsCanonical('hello'),
      digestParamsCanonical('hellp')
    );
    assert.notStrictEqual(
      digestParamsCanonical({ a: 'hello' }),
      digestParamsCanonical({ a: 'Hello' }) // case difference
    );
  });

  it('returns a 64-character lowercase hex digest and never embeds the raw value', () => {
    const value = { command: 'rm -rf /tmp/something', file_path: '/etc/passwd' };
    const digest = digestParamsCanonical(value);

    // Shape: SHA-256 hex is exactly 64 lowercase chars.
    assert.strictEqual(digest.length, 64,
      `expected 64 hex chars, got ${digest.length}`);
    assert.match(digest, /^[0-9a-f]{64}$/,
      `digest must be lowercase hex, got: ${digest}`);

    // No part of the input survives into the digest. A truncated digest
    // would not catch this; the full 64-char digest must not contain the
    // raw values either, because raw input in a digest is a leak surface.
    const serialized = JSON.stringify(value);
    assert.ok(!digest.includes('rm -rf'),
      'digest must not contain the raw command');
    assert.ok(!digest.includes('/etc/passwd'),
      'digest must not contain the raw file_path');
    assert.ok(!digest.includes(serialized),
      'digest must not contain the serialized JSON');
  });

  it('sorts keys recursively at every depth, including three levels deep', () => {
    // Construct an object where only the THIRD-level key order differs.
    // If sorting is shallow, the digests will differ; if it is recursive
    // (which it must be for nested tool inputs to be order-stable), they
    // will match.
    const a = {
      l1_a: {
        l2_x: {
          l3_b: 1,
          l3_a: 2
        },
        l2_b: 'outer-b'
      },
      l1_b: 'sibling'
    };
    const b = {
      l1_b: 'sibling',
      l1_a: {
        l2_b: 'outer-b',
        l2_x: {
          l3_a: 2,
          l3_b: 1
        }
      }
    };

    // Pre-condition: the two objects really do differ in raw form.
    assert.notStrictEqual(JSON.stringify(a), JSON.stringify(b),
      'test fixture must produce non-identical raw JSON');

    // Post-condition: the canonicalizer flattens that difference.
    assert.strictEqual(
      digestParamsCanonical(a),
      digestParamsCanonical(b),
      'key sorting must be recursive at every depth, not just the top'
    );

    // And a known-different value at the deepest level still diverges —
    // the recursion did not accidentally collapse to a constant.
    const c = JSON.parse(JSON.stringify(b));
    c.l1_a.l2_x.l3_a = 999;
    assert.notStrictEqual(
      digestParamsCanonical(b),
      digestParamsCanonical(c),
      'three-level-deep value changes must still affect the digest'
    );
  });
});