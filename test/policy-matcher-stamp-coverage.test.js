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

import {
  isSelfMod,
  isModeChange,
  isPushForce,
  isPushProtected,
  isPublish,
  isEgressOther,
  isDestructive,
  isScopeEscalation,
  matcherVersionHash,
  MATCHER_SCHEMA
} from '../src/policy/index.js';

/**
 * The hashed inputs this test can reach.
 *
 * `parts` in matcherVersionHash() also names five values this module does not
 * export (isScopeEscalationEdit, isPersistenceArtifactPath, isOpaqueExec,
 * extensionlessLocalFileKind, EXPLICIT_LOCAL_PATH) plus the two rule tables.
 * None of them is a self-mod decider, so the subset below is sufficient to
 * prove ABSENCE: a string missing from the whole hashed text is missing from
 * this subset too, and a string found here would be present in the full text.
 * The asymmetry runs the safe way for what is being asserted.
 */
const hashedText = [
  isSelfMod, isModeChange, isPushForce, isPushProtected,
  isPublish, isEgressOther, isDestructive, isScopeEscalation
].map(fn => fn.toString()).join(' ');

describe('matcher version stamp coverage (KNOWN-LIMITS 63)', () => {
  it('CONTROL: the hashed functions own bodies are in the hashed text', () => {
    // If a rename or a bad import empties `hashedText`, these fail first and
    // the absence assertions below cannot pass vacuously.
    assert.ok(hashedText.length > 1000, 'hashed text is implausibly short');
    assert.ok(hashedText.includes('isSelfModCommand'), 'isSelfMod body missing');
    assert.ok(hashedText.includes('git\\s+push'), 'push matcher body missing');
    assert.ok(hashedText.includes('usesAuthedRemoteClient'), 'egress body missing');
  });

  it('CONTROL: the stamp is a stable 16-hex digest under the declared schema', () => {
    assert.equal(MATCHER_SCHEMA, 'matcher/1');
    const a = matcherVersionHash();
    const b = matcherVersionHash();
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, b, 'the stamp must be stable within a process');
  });

  // --- the defect: the deciders are outside the hash (invert when fixed) ---

  it('the protected-path list is NOT in the hashed text (invert when fixed)', () => {
    // Three live entries of selfModFragmentsForBase(). Adding or removing any
    // of them changes what an Edit is allowed to touch.
    assert.equal(hashedText.includes('src/chain/'), false);
    assert.equal(hashedText.includes('src/limits/'), false);
    assert.equal(hashedText.includes('src/charter/'), false);
  });

  it('the fragment builder is NOT in the hashed text (invert when fixed)', () => {
    assert.equal(hashedText.includes('selfModFragmentsForBase'), false);
  });

  it('the Edit-path matcher body is NOT in the hashed text (invert when fixed)', () => {
    // isSelfMod NAMES isSelfModEdit at its call site, which is why the name
    // appears; the body that decides is the bin regex, and that is absent.
    assert.equal(hashedText.includes('bin\\/[^/]+\\.(js'), false);
  });

  it('the command-path matcher body is NOT in the hashed text (invert when fixed)', () => {
    assert.equal(hashedText.includes('refsLotorHome'), false);
    assert.equal(hashedText.includes('approval-nonces'), false);
  });

  it('the path normalizer is NOT in the hashed text (invert when fixed)', () => {
    // How a path is folded before matching decides whether a spelling gates
    // at all (KNOWN-LIMITS 62). Changing it leaves the stamp identical.
    assert.equal(hashedText.includes('function normalizePath'), false);
    assert.equal(hashedText.includes('function pathContainsFragment'), false);
  });

  it('the brace expander and prose stripper are NOT in the hashed text (invert when fixed)', () => {
    assert.equal(hashedText.includes('function expandBraces'), false);
    assert.equal(hashedText.includes('function stripHeredocBodies'), false);
    assert.equal(hashedText.includes('function stripMessageArgs'), false);
  });
});
