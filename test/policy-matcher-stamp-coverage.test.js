/**
 * test/policy-matcher-stamp-coverage.test.js
 *
 * TRIPWIRE, not a regression test. Found 2026-09-02 (KNOWN-LIMITS 63).
 *
 * `matcherVersionHash()` documents itself as the "content hash of the matcher
 * logic in force right now", and every gate, warn, grant and egress receipt
 * carries it. It is the field a reader uses to answer "were these two
 * decisions made by the same rules?".
 *
 * It hashes the source text of THIRTEEN TOP-LEVEL FUNCTIONS plus RULE_TABLE
 * and RULE_INFO (src/policy/index.js, the `parts` array). `Function.toString()`
 * returns only that function's own source, so a helper is included only if it
 * is named in the array itself. The self-mod deciders are not:
 * `selfModFragmentsForBase` (the protected-path list), `isSelfModEdit`,
 * `selfModCommandHit`, `normalizePath`, `pathContainsFragment`,
 * `expandBraces`, `stripHeredocBodies`. `isSelfMod` IS hashed, but its body
 * is a three-line dispatcher that only NAMES the two matchers it calls.
 *
 * THE CONSEQUENCE. Adding a directory to the protected list, or changing how
 * a path is normalized before it is matched, changes what the gate stops and
 * leaves the stamp byte-identical. Two receipts written either side of that
 * change agree on the matcher version and disagree on the behavior, and the
 * record cannot tell you which one you got. The failure is silent in the
 * direction that matters: a matcher WEAKENED between two runs still stamps
 * the old, stronger version.
 *
 * WHAT THESE ASSERTIONS SAY. They assert the CURRENT, DEFECTIVE behavior: the
 * decider text is ABSENT from the hashed inputs today. The controls beside
 * them assert that the hashed functions' own bodies ARE present, so this block
 * cannot pass by the export surface dying or a rename emptying the strings.
 *
 * WHEN SOMEONE FIXES THE STAMP, THIS FILE FAILS. That is the point. The repair
 * is to add the helpers to `parts`, bump MATCHER_SCHEMA (the hashing METHOD
 * changes, which is exactly what that marker is for), invert the assertions
 * below, and amend KNOWN-LIMITS 63 in the same change. Do NOT delete the
 * block: a confession that can be closed by deleting its evidence is not a
 * confession.
 *
 * The fix is `src/policy` and therefore non-delegable core. It is not
 * attempted here; it queues for a signing sitting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import crypto from 'node:crypto';
import {
  matcherVersionHash,
  matcherHashInputs,
  MATCHER_SCHEMA
} from '../src/policy/index.js';

/**
 * CLOSED 2026-09-07 at the signing sitting. `parts` now names the self-mod
 * deciders (selfModFragmentsForBase, isSelfModEdit, selfModCommandHit,
 * normalizePath, pathContainsFragment, expandBraces, stripHeredocBodies,
 * stripMessageArgs) and MATCHER_SCHEMA is `matcher/2`, because the hashing
 * METHOD changed. The joined text is exported as `matcherHashInputs()` so this
 * file asserts PRESENCE against the exact bytes that are hashed, not against
 * a subset reconstructed from exports. Every "NOT in the hashed text" below
 * became "IS in the hashed text"; the controls are unchanged.
 *
 * Residual, still open and stated in entry 63: the hash covers THIS module.
 * Behaviour that reaches a decision from outside it (git-context.js resolving
 * a push target) remains unstamped; KNOWN-LIMITS 64 carries the whole-tree
 * digest for that.
 */
const hashedText = matcherHashInputs();

describe('matcher version stamp coverage (KNOWN-LIMITS 63, closed 2026-09-07)', () => {
  it('CONTROL: the hashed functions own bodies are in the hashed text', () => {
    // If a rename or a bad import empties `hashedText`, these fail first and
    // the presence assertions below cannot pass vacuously.
    assert.ok(hashedText.length > 1000, 'hashed text is implausibly short');
    assert.ok(hashedText.includes('isSelfModCommand'), 'isSelfMod body missing');
    assert.ok(hashedText.includes('git\\s+push'), 'push matcher body missing');
    assert.ok(hashedText.includes('usesAuthedRemoteClient'), 'egress body missing');
  });

  it('CONTROL: the stamp is a stable 16-hex digest under the declared schema', () => {
    assert.equal(MATCHER_SCHEMA, 'matcher/2');
    const a = matcherVersionHash();
    const b = matcherVersionHash();
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b, 'the stamp must be stable within a process');
  });

  it('CONTROL: the stamp IS the digest of the exported inputs, so the inputs are what is asserted on', () => {
    const expected = crypto.createHash('sha256').update(hashedText).digest('hex').slice(0, 16);
    assert.equal(matcherVersionHash(), expected);
  });

  // --- the repair: the deciders are inside the hash ---

  it('the protected-path list IS in the hashed text', () => {
    // Three live entries of selfModFragmentsForBase(). Adding or removing any
    // of them changes what an Edit is allowed to touch, and now moves the stamp.
    assert.equal(hashedText.includes('src/chain/'), true);
    assert.equal(hashedText.includes('src/limits/'), true);
    assert.equal(hashedText.includes('src/charter/'), true);
  });

  it('the fragment builder IS in the hashed text', () => {
    assert.equal(hashedText.includes('function selfModFragmentsForBase'), true);
  });

  it('the Edit-path matcher body IS in the hashed text', () => {
    assert.equal(hashedText.includes('function isSelfModEdit'), true);
    assert.equal(hashedText.includes('bin\\/[^/]+\\.(js'), true);
  });

  it('the command-path matcher body IS in the hashed text', () => {
    assert.equal(hashedText.includes('function selfModCommandHit'), true);
    assert.equal(hashedText.includes('refsLotorHome'), true);
    assert.equal(hashedText.includes('approval-nonces'), true);
  });

  it('the path normalizer IS in the hashed text', () => {
    // How a path is folded before matching decides whether a spelling gates
    // at all (KNOWN-LIMITS 62). Changing it now moves the stamp.
    assert.equal(hashedText.includes('function normalizePath'), true);
    assert.equal(hashedText.includes('function pathContainsFragment'), true);
  });

  it('the brace expander and prose strippers ARE in the hashed text', () => {
    assert.equal(hashedText.includes('function expandBraces'), true);
    assert.equal(hashedText.includes('function stripHeredocBodies'), true);
    assert.equal(hashedText.includes('function stripMessageArgs'), true);
  });
});
