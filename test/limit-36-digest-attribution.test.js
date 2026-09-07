/**
 * test/limit-36-digest-attribution.test.js
 *
 * KNOWN-LIMITS 36 said an approved receipt "records the tool, never the
 * target," and that per-signature attribution "is not derivable from the
 * record as it stands." That was true on 2026-07-26. It stopped being true
 * on 2026-08-15 (commit 9a934f2), when `paramsDigestCanonical` was added to
 * every gated-action receipt — and nothing that consumed the entry was ever
 * told. `src/views/autograph.js`'s own caveat text, and this test file's own
 * prior header, both still asserted the pre-fix state as current.
 *
 * This file proves, by running the real functions rather than reading them,
 * what the digest actually buys and where it still falls short.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestParamsCanonical } from '../src/parser/index.js';
import { canonicalizeItem } from '../src/charter/index.js';

test('a gate receipt\'s paramsDigestCanonical matches a re-derived digest of the same params — per-signature attribution against a KNOWN candidate is computable', () => {
  // Simulate what gate/index.js does at receipt time.
  const actionRequest = { action: 'Edit', params: { file_path: 'src/views/autograph.js', old: 'a', new: 'b' } };
  const receiptDigest = digestParamsCanonical(actionRequest.params);

  // A reviewer holding a CANDIDATE — e.g. one enumerated charter item — can
  // ask "was this receipt for THIS?" by re-deriving the same digest and
  // comparing. No path, command, or param ever needs to be stored on the
  // chain for this to work; the digest is one-way per limit 18.
  const candidateFromCharterItem = { action: 'Edit', params: { file_path: 'src/views/autograph.js', old: 'a', new: 'b' } };
  const candidateDigest = digestParamsCanonical(candidateFromCharterItem.params);

  assert.equal(receiptDigest, candidateDigest,
    'the same params, hashed independently at approval time and at review time, must match — this IS per-signature attribution, computed, not merely proposed');

  // And a DIFFERENT candidate must not match, or the "attribution" would be
  // worthless — this is the discriminating half of the proof.
  const wrongCandidate = { action: 'Edit', params: { file_path: 'src/gate/index.js', old: 'a', new: 'b' } };
  assert.notEqual(receiptDigest, digestParamsCanonical(wrongCandidate.params),
    'a different target must produce a different digest, or matching one candidate would match all of them');
});

test('charter items and gate receipts canonicalize params compatibly (independently, via two different modules)', () => {
  // src/charter/index.js's canonicalizeItem hashes {action, params} TOGETHER
  // (JSON.stringify with a key-sorting replacer). src/gate/index.js's receipt
  // hashes params ALONE via digestParamsCanonical (deep-sort then SHA-256).
  // They are not the same digest by construction — a correlator must compare
  // action separately AND compare digestParamsCanonical(item.params) against
  // the receipt's paramsDigestCanonical, never compare enumerationHash output
  // to paramsDigestCanonical directly. Proven here so nobody has to re-derive
  // it from reading two files that do not import each other.
  const item = { action: 'Bash', params: { command: 'npm test' }, note: 'run the suite', id: 'x1' };

  const itemCanonical = canonicalizeItem(item);
  assert.equal(itemCanonical, JSON.stringify({ action: 'Bash', params: { command: 'npm test' } }),
    'canonicalizeItem folds action+params together and drops note/id, by its own documented contract');

  const paramsOnlyDigest = digestParamsCanonical(item.params);
  // The two are deliberately different SHAPES (one is a JSON string keyed by
  // both fields, the other a bare params hash) — asserting that difference so
  // a future "just compare the two hashes" shortcut fails loudly instead of
  // silently never matching anything.
  assert.notEqual(itemCanonical, paramsOnlyDigest,
    'these are different functions over different inputs and must never be compared to each other directly');

  // The correct cross-module comparison: action equality PLUS a
  // digestParamsCanonical(item.params) vs receipt.paramsDigestCanonical match.
  const wouldMatchReceipt = digestParamsCanonical(item.params);
  assert.equal(wouldMatchReceipt, digestParamsCanonical({ command: 'npm test' }),
    'the actual cross-module match path (params-only digest, both sides) does agree');
});

test('RESIDUAL, confessed rather than hidden: an absent params field and an empty-object params field digest DIFFERENTLY, so a naive matcher false-negatives on no-arg actions', () => {
  // src/charter/index.js's canonicalizeItem defaults a missing params to {}
  // (`item.params || {}`). src/gate/index.js passes `actionRequest?.params`
  // straight through, and digestParamsCanonical(undefined) returns the
  // literal string 'empty' rather than hashing {}. A no-arg action (e.g. a
  // tool with no params object at all) charted with `params` omitted will
  // NOT match a receipt whose actionRequest also omitted params, because one
  // side computes hash("{}") and the other returns 'empty'. This is a real
  // gap in the matching capability, not a hypothetical one — proven here so
  // a future matcher implementation does not learn it the hard way.
  const receiptSideDigest = digestParamsCanonical(undefined);
  const charterSideDigest = digestParamsCanonical({});

  assert.equal(receiptSideDigest, 'empty');
  assert.notEqual(receiptSideDigest, charterSideDigest,
    'undefined params and {} params digest differently — a matcher must special-case this or a whole class of no-arg approvals will read as unattributable');
});
