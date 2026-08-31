/**
 * test/reconcile.test.js
 *
 * KNOWN-LIMITS 38 and 39, fixed and guarded.
 *
 * 38: the retcon built its observed set by calling canonicalizeItem() on a
 *     gated-action receipt's `action`. Charter items are objects; that field is
 *     a bare tool-name string. canonicalizeItem throws on a string, into an
 *     empty catch, so the observed set was ALWAYS EMPTY. A charter of eight
 *     built, tested and committed items reported "declared and never attempted
 *     8" and "attempted and not declared 0". Both directions wrong.
 *
 * 39: the closing caveat printed "items 3 and 7 never ran and four things ran
 *     which were not on the list" as HARDCODED PROSE, regardless of data,
 *     inside the block headed WHAT THIS DOES NOT TELL YOU.
 *
 * The fold is passed in as a LITERAL here rather than built by reconstruct().
 * That is deliberate: reconcile() should be testable without the chain reader,
 * and it keeps these tests independent of the one remaining change to
 * bin/retcon.js, which is core and needs a signature.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { reconcile, deviationNote } from '../src/views/reconcile.js';

/** A retcon fold, only the fields reconcile() reads. */
function fold({ tools = [], touched = [], closedSessions = 1 } = {}) {
  return {
    toolsSeen: new Map(tools),
    touchedPaths: new Set(touched),
    sessions: new Map(
      Array.from({ length: closedSessions }, (_, i) => [`sess-${i}`, { toolCalls: 1 }])
    )
  };
}

const fileItem = (id, p) => ({ id, action: 'Edit', params: { file_path: p } });
const cmdItem = (id, c) => ({ id, action: 'Bash', params: { command: c } });
const charterOf = items => ({ id: 'CHARTER-TEST', title: 't', items, itemCount: items.length });

describe('reconcile: a declared file item against touched paths', () => {
  it('confirms one whose path was touched', () => {
    const out = reconcile(charterOf([fileItem('1', 'src/a.js')]), fold({ touched: ['src/a.js'] }));
    assert.equal(out.confirmed.length, 1);
    assert.equal(out.noEvidence.length, 0);
    assert.equal(out.unreconcilable.length, 0);
    assert.equal(out.undetermined.length, 0);
  });

  it('reports one absent from touched as NO EVIDENCE', () => {
    const out = reconcile(charterOf([fileItem('1', 'src/a.js')]), fold({ touched: ['src/other.js'] }));
    assert.equal(out.confirmed.length, 0);
    assert.equal(out.noEvidence.length, 1);
  });

  it('matches an absolute touched path against a relative charter item', () => {
    // A charter is written by a human in relative form; `touched` carries
    // whatever the harness recorded, which is usually absolute.
    const out = reconcile(
      charterOf([fileItem('1', 'bin/retcon.js')]),
      fold({ touched: ['C:\\Users\\x\\agent-receipts\\bin\\retcon.js'] })
    );
    assert.equal(out.confirmed.length, 1, 'backslashes and an absolute prefix must not defeat the match');
  });

  it('does not match on a bare filename collision', () => {
    const out = reconcile(
      charterOf([fileItem('1', 'src/gate/index.js')]),
      fold({ touched: ['src/policy/index.js'] })
    );
    assert.equal(out.confirmed.length, 0, 'index.js is not index.js');
    assert.equal(out.noEvidence.length, 1);
  });
});

describe('reconcile: a confirmation says which kind of match it rests on', () => {
  // KNOWN-LIMITS 38's residual, narrowed 2026-08-31. Exact and tail-only
  // matches were both printed as the single word "confirmed". The ambiguity
  // cannot be resolved; presenting the two as one thing was the fixable half.

  it('labels an exact match exact, with no tail-match count', () => {
    const out = reconcile(charterOf([fileItem('1', 'src/a.js')]), fold({ touched: ['src/a.js'] }));
    assert.equal(out.confirmed[0].matchKind, 'exact');
    assert.equal(out.confirmed[0].ambiguous, false);
    assert.equal(out.confirmedBySuffixOnly, 0);
  });

  it('labels a relative-against-absolute match as suffix, and still confirms it', () => {
    const out = reconcile(
      charterOf([fileItem('1', 'bin/retcon.js')]),
      fold({ touched: ['C:\\Users\\x\\agent-receipts\\bin\\retcon.js'] })
    );
    assert.equal(out.confirmed.length, 1, 'the ordinary case must still confirm');
    assert.equal(out.confirmed[0].matchKind, 'suffix');
    assert.equal(out.confirmedBySuffixOnly, 1);
  });

  it('prefers the exact match when both kinds are present', () => {
    const out = reconcile(
      charterOf([fileItem('1', 'src/a.js')]),
      fold({ touched: ['/other/checkout/src/a.js', 'src/a.js'] })
    );
    assert.equal(out.confirmed[0].matchKind, 'exact');
    assert.deepEqual(out.confirmed[0].matchedPaths, ['src/a.js']);
    assert.equal(out.confirmedBySuffixOnly, 0);
  });

  it('flags the false confirmation happening in front of it: two checkouts, one tail', () => {
    const out = reconcile(
      charterOf([fileItem('1', 'src/a.js')]),
      fold({ touched: ['/home/a/repo/src/a.js', '/home/b/repo/src/a.js'] })
    );
    assert.equal(out.confirmed.length, 1);
    assert.equal(out.confirmed[0].matchKind, 'suffix');
    assert.equal(out.confirmed[0].ambiguous, true, 'at most one of the two can be the declared file');
    assert.equal(out.ambiguousConfirmations, 1);
  });

  it('does not call a single tail match ambiguous', () => {
    const out = reconcile(
      charterOf([fileItem('1', 'src/a.js')]),
      fold({ touched: ['/home/a/repo/src/a.js'] })
    );
    assert.equal(out.confirmed[0].ambiguous, false);
    assert.equal(out.ambiguousConfirmations, 0);
  });
});

describe('reconcile: what the record structurally cannot answer', () => {
  it('classifies a COMMAND item as unreconcilable, never as never-attempted', () => {
    // The heart of 38. Gate receipts carry the tool and no command string
    // (limit 36); session receipts carry files and no commands. So no part of
    // the chain can say whether a declared command ran.
    const out = reconcile(
      charterOf([cmdItem('1', 'npm test')]),
      fold({ tools: [['Bash', 3]], touched: ['src/a.js'] })
    );
    assert.equal(out.unreconcilable.length, 1);
    assert.equal(out.noEvidence.length, 0, 'must NOT be reported as never attempted');
    assert.equal(out.confirmed.length, 0);
    assert.match(out.unreconcilable[0].why, /no command strings/);
  });

  it('reports UNDETERMINED, not no-evidence, when no session has closed', () => {
    // "While a session is still running, the retcon is reading an empty room
    // and reporting it as an empty plan."
    const out = reconcile(charterOf([fileItem('1', 'src/a.js')]), fold({ closedSessions: 0 }));
    assert.equal(out.pathEvidenceAvailable, false);
    assert.equal(out.undetermined.length, 1);
    assert.equal(out.noEvidence.length, 0, 'unknown is not the same as never attempted');
  });

  it('treats an item naming neither a file nor a command as unreconcilable', () => {
    const out = reconcile(charterOf([{ id: '1', action: 'WebSearch', params: {} }]), fold());
    assert.equal(out.unreconcilable.length, 1);
    assert.match(out.unreconcilable[0].why, /neither a file nor a command/);
  });
});

describe('reconcile: what ran that nobody declared', () => {
  it('surfaces a tool no declared item names', () => {
    const out = reconcile(
      charterOf([fileItem('1', 'src/a.js')]),
      fold({ tools: [['WebFetch', 2], ['Edit', 5]], touched: ['src/a.js'] })
    );
    assert.deepEqual(out.toolsNotDeclared, [{ tool: 'WebFetch', n: 2 }],
      'Edit is declared by the item; WebFetch is not');
  });

  it('is empty when every tool used is one the charter names', () => {
    const out = reconcile(
      charterOf([fileItem('1', 'src/a.js'), cmdItem('2', 'npm test')]),
      fold({ tools: [['Edit', 1], ['Bash', 1]], touched: ['src/a.js'] })
    );
    assert.deepEqual(out.toolsNotDeclared, []);
  });
});

describe('deviationNote: derived, never invented (KNOWN-LIMITS 39)', () => {
  it('states the real counts and none of the old hardcoded ones', () => {
    const note = deviationNote({
      noEvidence: [1, 2], unreconcilable: [], toolsNotDeclared: [1, 2, 3], undetermined: []
    });
    assert.ok(!/items 3 and 7/i.test(note), 'must not state invented item numbers');
    assert.ok(!/\bfour\b/i.test(note), 'must not state an invented count');
    assert.match(note, /\b2 declared item/);
    assert.match(note, /\b3 tool/);
  });

  it('says nothing numeric when there is nothing counted', () => {
    const note = deviationNote({
      noEvidence: [], unreconcilable: [], toolsNotDeclared: [], undetermined: []
    });
    assert.ok(!/items 3 and 7/i.test(note));
    assert.match(note, /Nothing was counted/);
    assert.ok(note.includes('no intent'), 'the general caveat still stands');
  });

  it('says plainly that uncheckable is not the same as did-not-run', () => {
    const note = deviationNote({
      noEvidence: [], unreconcilable: [1], toolsNotDeclared: [], undetermined: [1]
    });
    assert.match(note, /is NOT an item that did not run/);
  });

  it('counts tail-only confirmations and names the failure direction', () => {
    const note = deviationNote({
      noEvidence: [], unreconcilable: [], toolsNotDeclared: [], undetermined: [],
      confirmedBySuffixOnly: 2, ambiguousConfirmations: 1
    });
    assert.match(note, /\b2 confirmation\(s\) rest on a path-tail match/);
    assert.match(note, /CONSISTENT with the item/);
    assert.match(note, /\b1 of those matched more than one distinct recorded path/);
  });

  it('says nothing about tail matches when every confirmation was exact', () => {
    const note = deviationNote({
      noEvidence: [], unreconcilable: [], toolsNotDeclared: [], undetermined: [],
      confirmedBySuffixOnly: 0, ambiguousConfirmations: 0
    });
    assert.ok(!/tail/i.test(note), 'a caveat that fires when it has nothing to report is limit 39 again');
    assert.match(note, /Nothing was counted/);
  });

  it('never throws on a malformed or empty input', () => {
    assert.doesNotThrow(() => deviationNote({}));
    assert.doesNotThrow(() => deviationNote(null));
  });
});
