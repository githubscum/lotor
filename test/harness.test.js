/**
 * test/harness.test.js
 *
 * Which harness wrote an entry, and whether the answer says how it knows.
 *
 * WHY THE HONESTY CASES OUTNUMBER THE HAPPY PATH
 *   This field exists to close the second half of KNOWN-LIMITS 13. The easy
 *   version of it — a string reading "claude-code" — would have been worse
 *   than nothing, because a foreign harness would silently inherit that label
 *   and a reader would have no way to tell an unknown harness from a
 *   confidently-identified one.
 *
 *   So most of what is asserted below is not "does it find the right name" but
 *   "does it refuse to claim more than it knows": unknown stays unknown, an
 *   inference is labelled as an inference and ships its evidence, and a single
 *   weak signal is not enough to produce a confident-looking name.
 *
 * THE DEADLINE THIS FIELD HAD
 *   The chain is append-only. An entry written before the field existed can
 *   never acquire it, so every entry a second harness writes without it is
 *   permanently unattributable. That is why this shipped before the second
 *   harness rather than alongside it, and it is asserted here as a schema
 *   marker so a later shape change is visible rather than silent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveHarness, HARNESS_SCHEMA } from '../src/harness.js';

/** No ambient environment leaking into a test about environment precedence. */
const NO_ENV = {};

describe('harness: declaring beats inferring', () => {
  it('takes an explicit LOTOR_HARNESS over anything inferable', () => {
    const payload = { session_id: 's', transcript_path: '/t', source: 'startup' };
    const h = resolveHarness(payload, { LOTOR_HARNESS: 'pi' });
    assert.equal(h.name, 'pi');
    assert.equal(h.basis, 'declared');
    assert.equal(h.via, 'LOTOR_HARNESS');
  });

  it('accepts a declaration from the payload', () => {
    const h = resolveHarness({ harness: 'my-runner' }, NO_ENV);
    assert.equal(h.name, 'my-runner');
    assert.equal(h.basis, 'declared');
    assert.equal(h.via, 'payload.harness');
  });

  it('accepts both spellings, so a naming mismatch is not read as an absent harness', () => {
    for (const key of ['harness', 'harness_name', 'harnessName']) {
      const h = resolveHarness({ [key]: 'x' }, NO_ENV);
      assert.equal(h.basis, 'declared', `${key} should declare`);
      assert.equal(h.name, 'x');
    }
  });

  it('env wins over payload when both are present', () => {
    const h = resolveHarness({ harness: 'from-payload' }, { LOTOR_HARNESS: 'from-env' });
    assert.equal(h.name, 'from-env');
  });
});

describe('harness: a bad declaration falls through rather than being recorded', () => {
  it('ignores blank and whitespace-only names', () => {
    for (const bad of ['', '   ', '\t\n']) {
      const h = resolveHarness({ harness: bad }, NO_ENV);
      assert.notEqual(h.basis, 'declared', `"${JSON.stringify(bad)}" must not declare`);
    }
  });

  it('ignores non-string names', () => {
    for (const bad of [42, true, null, {}, []]) {
      const h = resolveHarness({ harness: bad }, NO_ENV);
      assert.notEqual(h.basis, 'declared');
    }
  });

  it('truncates an absurd name instead of writing it into every entry', () => {
    const h = resolveHarness({ harness: 'z'.repeat(5000) }, NO_ENV);
    assert.equal(h.basis, 'declared');
    assert.ok(h.name.length <= 64, `name was ${h.name.length} chars`);
  });

  it('trims surrounding whitespace', () => {
    const h = resolveHarness({ harness: '  spaced  ' }, NO_ENV);
    assert.equal(h.name, 'spaced');
  });
});

describe('harness: inference is labelled as inference and carries its evidence', () => {
  it('recognises a Claude Code payload and says it GUESSED', () => {
    const h = resolveHarness(
      { session_id: 's', transcript_path: '/t', source: 'startup' },
      NO_ENV
    );
    assert.equal(h.name, 'claude-code');
    assert.equal(h.basis, 'inferred', 'an inference must never present as declared');
    assert.ok(Array.isArray(h.evidence) && h.evidence.length >= 2,
      'an inference must ship the evidence that produced it');
  });

  it('needs two independent signals, not one', () => {
    // A lone session_id is not distinctive; plenty of tools emit one. A single
    // weak match producing a confident name is the failure this module exists
    // to avoid.
    const h = resolveHarness({ session_id: 'only-this' }, NO_ENV);
    assert.equal(h.basis, 'unknown');
    assert.equal(h.name, 'unknown');
  });

  it('does not treat an unrecognised source as a signal', () => {
    const h = resolveHarness({ session_id: 's', source: 'something-else' }, NO_ENV);
    assert.equal(h.basis, 'unknown');
  });
});

describe('harness: unknown stays unknown, which is the whole point', () => {
  it('does NOT default to claude-code on an empty payload', () => {
    const h = resolveHarness({}, NO_ENV);
    assert.equal(h.basis, 'unknown');
    assert.notEqual(h.name, 'claude-code',
      'defaulting an unknown harness to the common one turns missing information ' +
      'into a false statement a reader cannot detect');
  });

  it('handles a missing or malformed payload without throwing', () => {
    for (const bad of [undefined, null, 'a string', 42, []]) {
      const h = resolveHarness(bad, NO_ENV);
      assert.equal(typeof h.name, 'string');
      assert.ok(['declared', 'inferred', 'unknown'].includes(h.basis));
    }
  });
});

describe('harness: the shape itself', () => {
  it('always carries a schema marker, so a later change is visible', () => {
    for (const c of [{}, { harness: 'x' }, { session_id: 's', transcript_path: '/t' }]) {
      assert.equal(resolveHarness(c, NO_ENV).schema, HARNESS_SCHEMA);
    }
  });

  it('never returns a bare name without a basis', () => {
    for (const c of [{}, { harness: 'x' }, { session_id: 's', transcript_path: '/t' }]) {
      const h = resolveHarness(c, NO_ENV);
      assert.ok(h.basis, 'a name with no basis is a claim wearing the clothes of a fact');
    }
  });

  it('only claims `via` when something was actually declared', () => {
    assert.equal(resolveHarness({}, NO_ENV).via, undefined);
    assert.equal(resolveHarness({ session_id: 's', transcript_path: '/t' }, NO_ENV).via, undefined);
    assert.ok(resolveHarness({ harness: 'x' }, NO_ENV).via);
  });
});
