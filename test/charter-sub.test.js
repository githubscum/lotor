/**
 * test/charter-sub.test.js
 *
 * Sub-charters: delegation without escalation.
 *
 * The load-bearing property is that a sub-charter carries NO SIGNATURE and is
 * still safe, because it authorizes nothing new — it is a restriction of an
 * authority the owner already signed, and a restriction proves itself by being
 * provably narrower. The tests that matter are the ones where someone tries to
 * widen it anyway.
 *
 * PROVE-FAIL-FIRST: written against functions that did not exist, so every
 * assertion failed on the first run by construction.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  buildCharter,
  charterSignBuffer,
  deriveSubCharter,
  verifySubCharter,
  enumerationHash
} from '../src/charter/index.js';

let keyPair;
let pubX;
let parent;

const RUN_TESTS = { id: 'a', action: 'Bash', params: { command: 'npm test' } };
const RUN_ONE   = { id: 'b', action: 'Bash', params: { command: 'node --test test/parser.test.js' } };
const EDIT_SRC  = { id: 'c', action: 'Edit', params: { file_path: '/repo/src/parser/index.js' } };
const PUSH      = { id: 'd', action: 'Bash', params: { command: 'git push origin main' } };

const PARENT_ITEMS = [RUN_TESTS, RUN_ONE, EDIT_SRC];

function sign(charter) {
  return {
    ...charter,
    signature: crypto.sign(null, charterSignBuffer(charter), keyPair.privateKey).toString('hex')
  };
}

before(() => {
  keyPair = crypto.generateKeyPairSync('ed25519');
  pubX = keyPair.publicKey.export({ format: 'jwk' }).x;
  parent = sign(buildCharter({ id: 'parent-1', title: 'PDLC A', items: PARENT_ITEMS }));
});

describe('carving a sub-charter', () => {
  it('carves a strict subset and verifies without any signature of its own', () => {
    const sub = deriveSubCharter(parent, [RUN_TESTS, EDIT_SRC], { id: 'sub-1' });
    assert.equal(sub.signature, undefined, 'a sub-charter must carry no signature');

    const r = verifySubCharter(sub, parent, pubX);
    assert.equal(r.ok, true, `subset should verify, got: ${r.reason}`);
  });

  it('REFUSES to carve an item the parent does not hold', () => {
    // The escalation attempt, at carve time. Hard throw rather than a filtered
    // result, so a caller cannot get less than it asked for and not notice.
    assert.throws(
      () => deriveSubCharter(parent, [RUN_TESTS, PUSH], { id: 'sub-2' }),
      /would widen its parent/
    );
  });

  it('names the offending item, so the refusal is actionable', () => {
    try {
      deriveSubCharter(parent, [PUSH], { id: 'sub-3' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.match(e.message, /git push origin main/);
    }
  });

  it('cannot outlive its parent, even when a longer window is requested', () => {
    const bounded = sign(buildCharter({
      id: 'parent-2', items: PARENT_ITEMS, expiresAt: Date.now() + 60_000
    }));
    const sub = deriveSubCharter(bounded, [RUN_TESTS], {
      id: 'sub-4', expiresAt: Date.now() + 10 * 60_000
    });
    assert.equal(sub.expiresAt, bounded.expiresAt, 'the parent bound must win');
  });

  it('takes the tighter window when the request is shorter', () => {
    const bounded = sign(buildCharter({
      id: 'parent-3', items: PARENT_ITEMS, expiresAt: Date.now() + 60 * 60_000
    }));
    const soon = Date.now() + 5 * 60_000;
    const sub = deriveSubCharter(bounded, [RUN_TESTS], { id: 'sub-5', expiresAt: soon });
    assert.equal(sub.expiresAt, soon);
  });
});

describe('an unsigned sub-charter is still tamper-evident', () => {
  it('REJECTS a sub-charter that had an item appended after carving', () => {
    // This is the whole reason no signature is needed. Adding PUSH forges
    // nothing; it just stops being a subset, and the hash stops matching too.
    const sub = deriveSubCharter(parent, [RUN_TESTS], { id: 'sub-6' });
    sub.items = [...sub.items, PUSH];
    sub.itemCount = sub.items.length;

    const r = verifySubCharter(sub, parent, pubX);
    assert.equal(r.ok, false, 'an appended item must not verify');
    assert.match(r.reason, /hash mismatch|not a subset/i);
  });

  it('REJECTS an appended item even when the hash is recomputed to match', () => {
    // The thorough attack: fix up the hash and count so the sub is internally
    // consistent. The subset check is what stops it.
    const widened = deriveSubCharter(parent, [RUN_TESTS], { id: 'sub-7' });
    widened.items = [RUN_TESTS, PUSH];
    widened.itemCount = 2;
    // Recompute the hash so checks 2 and 3 pass and ONLY the subset check can
    // catch it. Uses the module's own function rather than a reimplementation:
    // a test that hashes differently from the code proves nothing about the
    // code, and this module's header warns about exactly that.
    widened.enumerationHash = enumerationHash(widened.items);

    const r = verifySubCharter(widened, parent, pubX);
    assert.equal(r.ok, false, 'a self-consistent widened sub must still be rejected');
    assert.match(r.reason, /not a subset/i);
  });

  it('REJECTS a sub-charter whose parent enumeration changed since carving', () => {
    const sub = deriveSubCharter(parent, [RUN_TESTS], { id: 'sub-8' });
    const grownParent = sign(buildCharter({ id: 'parent-1', items: [...PARENT_ITEMS, PUSH] }));

    const r = verifySubCharter(sub, grownParent, pubX);
    assert.equal(r.ok, false, 'a delegate must not survive its mandate being rewritten');
    assert.match(r.reason, /parent enumeration changed/i);
  });

  it('REJECTS when the parent itself does not verify', () => {
    // A subset of an unsigned set authorizes nothing, and the parent check runs
    // before anything about the child is trusted.
    const unsignedParent = buildCharter({ id: 'parent-4', items: PARENT_ITEMS });
    const sub = deriveSubCharter(unsignedParent, [RUN_TESTS], { id: 'sub-9' });

    const r = verifySubCharter(sub, unsignedParent, pubX);
    assert.equal(r.ok, false);
    assert.match(r.reason, /parent charter does not verify/i);
  });

  it('REJECTS a sub-charter pointed at a different parent', () => {
    const sub = deriveSubCharter(parent, [RUN_TESTS], { id: 'sub-10' });
    const other = sign(buildCharter({ id: 'parent-5', items: PARENT_ITEMS }));

    const r = verifySubCharter(sub, other, pubX);
    assert.equal(r.ok, false);
    assert.match(r.reason, /names parent/i);
  });
});

describe('sub-charters of sub-charters', () => {
  it('narrows again, and still cannot widen', () => {
    const mid = deriveSubCharter(parent, [RUN_TESTS, RUN_ONE], { id: 'mid' });
    const leaf = deriveSubCharter(mid, [RUN_TESTS], { id: 'leaf' });

    assert.equal(leaf.items.length, 1);

    // KNOWN LIMITATION, asserted so it is documented rather than assumed:
    // verification does not walk a chain. `verifySubCharter` requires a SIGNED
    // parent, so an intermediate sub-charter cannot verify a leaf on its own.
    // Depth beyond one level therefore needs either transitive verification or
    // a convention that every sub verifies against the signed root. Not built.
    assert.equal(verifySubCharter(leaf, mid, pubX).ok, false,
      'mid is unsigned, so it cannot act as a verifying parent on its own');

    // And the escalation attempt one level down is refused at carve time.
    assert.throws(
      () => deriveSubCharter(mid, [EDIT_SRC], { id: 'leaf-2' }),
      /would widen its parent/
    );
  });
});

describe('expiry', () => {
  it('REJECTS when the parent window has closed', () => {
    const expiredParent = sign(buildCharter({
      id: 'parent-6', items: PARENT_ITEMS, expiresAt: Date.now() - 1000
    }));
    const sub = { ...deriveSubCharter(
      sign(buildCharter({ id: 'parent-6', items: PARENT_ITEMS })), [RUN_TESTS], { id: 'sub-11' }
    ) };
    sub.parentEnumerationHash = expiredParent.enumerationHash;

    const r = verifySubCharter(sub, expiredParent, pubX);
    assert.equal(r.ok, false);
    assert.match(r.reason, /expired/i);
  });
});

