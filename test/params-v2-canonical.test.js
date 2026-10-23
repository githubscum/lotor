/**
 * test/params-v2-canonical.test.js
 *
 * Tests for digestParamsCanonicalV2 and PARAMS_V2_SCHEMA in src/parser/index.js.
 *
 * WHY THIS FILE EXISTS
 *   params/1 (digestParamsCanonical + canonicalize) has a known hole: an
 *   input object with an OWN key named "__proto__" has that key swallowed
 *   by the prototype setter during canonicalization (JSON.parse creates the
 *   key as an own data property, and Object.keys does list it, but assigning
 *   onto a plain {} target silently mutates the prototype instead). The
 *   result is a real collision:
 *
 *     digestParamsCanonical(JSON.parse('{"__proto__":{"a":1},"b":2}'))
 *   equals
 *     digestParamsCanonical({ b: 2 })
 *
 *   params/2 fixes the mechanics WITHOUT touching params/1: canonicalizeV2
 *   builds every object with Object.create(null) so plain assignment can
 *   never hit an inherited setter, and the own "__proto__" key survives,
 *   serializing as the literal key "__proto__".
 *
 *   IMPORTANT CONSTRAINT. params/1 digests are already recorded on chains
 *   and must not move. Nothing in this file (or in the params/2 code) is
 *   wired into receipt emission. Which marker receipts carry is the
 *   owner's decision.
 *
 *   Test map:
 *     #1  pins the params/1 collision, documenting the hole rather than
 *         fixing it (fixing it would orphan existing digests).
 *     #2  shows params/2 separates the same two inputs.
 *     #3  shows the separation holds for a NESTED own "__proto__" too.
 *     #4  byte-identity guarantee: over proto-free inputs of varied shape,
 *         v2 output === v1 output, because that is the migration property.
 *     #5  key order invariance carries over to v2.
 *     #6  'empty' for undefined/null, fixed output shape otherwise.
 *     #7  the schema marker is exactly 'params/2'.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  digestParamsCanonical,
  digestParamsCanonicalV2,
  PARAMS_V2_SCHEMA
} from '../src/parser/index.js';

/**
 * The collision fixture. JSON.parse gives the object an OWN "__proto__"
 * data property (JSON.parse uses DefineOwnProperty, it does not set the
 * prototype). Written via JSON.parse rather than object literal so the
 * key is actually own: a literal like { __proto__: x } would go through
 * the setter and not be the shape real transcripts carry.
 */
const PROTO_INPUT = JSON.parse('{"__proto__":{"a":1},"b":2}');
const PROTOFREE_TWIN = { b: 2 };

describe('digestParamsCanonical (params/1) known hole', () => {
  it('collides on an input with an own __proto__ key: this is the documented, unfixed hole', () => {
    // This pin documents the hole. It is a KNOWN-LIMITS item, not fixed
    // here: repairing params/1 would change digests already recorded on
    // chains and orphan them. If this test ever fails because params/1
    // stopped dropping own __proto__ keys, params/1 has been changed and
    // existing digests have moved. Re-pin only with owner sign-off.
    assert.strictEqual(
      digestParamsCanonical(PROTO_INPUT),
      digestParamsCanonical(PROTOFREE_TWIN),
      'params/1 must still swallow an own __proto__ key. A change here ' +
      'alters digests already recorded on chains.'
    );
  });
});

describe('digestParamsCanonicalV2', () => {
  it('separates the inputs params/1 collides on', () => {
    // Pre-condition sanity: the two inputs are not the same JSON text, so
    // the divergence below must come from v2 keeping the __proto__ key.
    assert.notStrictEqual(JSON.stringify(PROTO_INPUT), JSON.stringify(PROTOFREE_TWIN));

    assert.notStrictEqual(
      digestParamsCanonicalV2(PROTO_INPUT),
      digestParamsCanonicalV2(PROTOFREE_TWIN),
      'params/2 must keep an own __proto__ key, so these must differ'
    );
    // And the divergence is a change from v1's collision, not a new
    // constant: v2 of one of them still differs from v1 of the same input.
    assert.notStrictEqual(
      digestParamsCanonicalV2(PROTO_INPUT),
      digestParamsCanonical(PROTO_INPUT),
      'params/2 must not reproduce the params/1 digest for a __proto__ input'
    );
  });

  it('separates a NESTED own __proto__ key as well', () => {
    const nested = { x: JSON.parse('{"__proto__":1}') };
    const twin = { x: {} };
    assert.notStrictEqual(
      digestParamsCanonicalV2(nested),
      digestParamsCanonicalV2(twin),
      'the fix must be recursive: a __proto__ key at any depth must survive'
    );
  });

  it('is byte-identical to params/1 on every input without a __proto__ key at any depth', () => {
    // THE MIGRATION PROPERTY. Unless v2 === v1 over proto-free input,
    // moving receipts from params/1 to params/2 would change the meaning
    // of every existing digest. At least 8 varied shapes follow: nested
    // objects, arrays, unicode strings, numbers, booleans, null leaves,
    // key-reordered pairs. None may carry an own "__proto__" key anywhere.
    const protoFreeInputs = [
      { b: 1, a: { d: 4, c: 3 } },
      { items: [1, 2, 3], tags: ['x', 'y', 'z'] },
      { note: 'unicode: ünïcødé ✨ 中文 🌱', plain: 'ascii only' },
      { count: 0, big: 123456789, neg: -17, frac: 3.75 },
      { on: true, off: false },
      { empty: null, nested: { deeper: { deepest: null } } },
      { first: 1, second: { z: 26, y: 25 } },
      { second: { y: 25, z: 26 }, first: 1 },
      { mixed: [{ q: null, p: true, o: 0 }, 'leaf', 42, false, null] },
      { deep: { a: { b: { c: { d: [1, { e: 'f' }] } } } } },
      'a bare string is a valid tool input',
      127,
      true
    ];

    for (const input of protoFreeInputs) {
      assert.strictEqual(
        digestParamsCanonicalV2(input),
        digestParamsCanonical(input),
        `v2 must be byte-identical to v1 for: ${JSON.stringify(input)}`
      );
    }
  });

  it('keeps params/1 key order invariance: key ordering does not affect the v2 digest', () => {
    const a = { a: 1, b: { x: 'inner', y: [1, 2] } };
    const bb = { b: { y: [1, 2], x: 'inner' }, a: 1 };
    assert.strictEqual(
      digestParamsCanonicalV2(a),
      digestParamsCanonicalV2(bb),
      'key order at every depth must not change the v2 digest'
    );
  });

  it("returns 'empty' for undefined and null, and 64 lowercase hex chars otherwise", () => {
    assert.strictEqual(digestParamsCanonicalV2(undefined), 'empty');
    assert.strictEqual(digestParamsCanonicalV2(null), 'empty');

    for (const input of [PROTO_INPUT, PROTOFREE_TWIN, 's', 5, false, [], {}]) {
      const got = digestParamsCanonicalV2(input);
      assert.match(got, /^[0-9a-f]{64}$/,
        `expected 64 lowercase hex chars, got: ${got}`);
    }
  });

  it('exposes the schema marker PARAMS_V2_SCHEMA === "params/2"', () => {
    assert.strictEqual(PARAMS_V2_SCHEMA, 'params/2');
  });
});