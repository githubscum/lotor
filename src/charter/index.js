/**
 * src/charter/index.js
 *
 * Charters: one signature over a reviewed plan, instead of N signatures over
 * the commands that plan implies.
 *
 * WHY THIS EXISTS
 *   A grant is issued per command. That asks the owner to approve a mechanism
 *   they did not choose, at a moment when they have already approved the intent.
 *   On 2026-07-25 that cost roughly twenty-five signatures in one evening,
 *   several of them the same command re-signed after a trivial change, several
 *   more a debug loop. At no point was the owner deciding whether the work
 *   should happen. KNOWN-LIMITS 26 names that as the corrosive failure: every
 *   avoidable signature teaches the operator to sign faster and read less.
 *
 * CHARTER vs GRANT, and the distinction is lifecycle
 *   A grant is SPENT. Its life ends when its ceiling is hit; nothing reads it
 *   again. Its important moment is before the work.
 *
 *   A charter is COMPARED AGAINST. Its important moment is after: the retcon
 *   reads it, measuring what actually happened against what was declared. It is
 *   the intention half of the compass, a role a grant cannot fill because a list
 *   of approved command strings says nothing about what they were for.
 *
 * THE ATTACK THIS DESIGN EXISTS TO STOP
 *   Isaac, 2026-07-26: "I wouldn't want it to start creating a never ending pdlc
 *   doc adding work orders I never declared."
 *
 *   A charter that lives "until the document is done" is unbounded if the
 *   document can grow. Add a work order and the authorization still applies.
 *   Add another and it still applies. The authorization never expires because
 *   the thing it is bound to keeps moving, and every added item is work the
 *   owner never saw. It also fails in the flattering direction: a worker adding
 *   "necessary follow-up" looks like initiative right up until it is unreviewed
 *   scope, and nothing in the mechanism distinguishes the two.
 *
 *   THE FIX, and it is the move that already makes grants safe, one level up:
 *   a charter binds to a HASH OF THE ENUMERATION at signing time, never to the
 *   document as a living file. Adding an item changes the hash, so the item
 *   falls outside the charter and needs its own signature. The document may
 *   grow; the authorization cannot.
 *
 *   The charter is therefore self-limiting BY CONSTRUCTION rather than by the
 *   worker's restraint or the orchestrator's vigilance. Structural, not
 *   behavioural. The governed party cannot extend it, not because it is
 *   forbidden to, but because it has no key.
 *
 * WHAT "DONE" MEANS
 *   Not a claim in the document. Every enumerated item reaching a terminal
 *   state: closed, blocked, or withdrawn. A charter expires when the count of
 *   terminal items equals the count signed, or when its window closes,
 *   whichever comes first. Nothing else closes it — not the worker saying so,
 *   not the document containing the word "complete".
 *
 * WHAT THIS MODULE DOES NOT DO
 *   It does not decide anything at the gate. Wiring a charter into the deny
 *   path is a change to the non-delegable core and is deliberately a separate,
 *   separately-reviewed step. This module is the primitive and its integrity
 *   checks only.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CHARTER_FORMAT = 'lotor-charter/1';

/** Terminal states. An item in any of these is finished for counting purposes. */
export const TERMINAL_STATES = Object.freeze(['closed', 'blocked', 'withdrawn']);

/**
 * JSON.stringify replacer that sorts object keys alphabetically at every level.
 * Copied in shape from src/gate/sign.js rather than imported, so that a change
 * to the gate's canonicalization cannot silently alter what a signed charter
 * hash covers. Two canonicalizers that must agree is a real risk; two that are
 * independent and versioned is the lesser one.
 */
function sortKeysReplacer(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = value[k];
      return acc;
    }, {});
  }
  return value;
}

/**
 * Canonical form of ONE enumerated item, for hashing and for membership tests.
 *
 * Only `action` and `params` participate. Prose fields (`note`, `id`) are
 * deliberately excluded: an owner rewording a note must not invalidate a
 * charter, and a worker rewording one must not smuggle a different command past
 * the hash. What is authorized is the call, not the description of it.
 */
export function canonicalizeItem(item) {
  if (!item || typeof item !== 'object') throw new Error('charter item is not an object');
  if (typeof item.action !== 'string' || item.action.trim() === '') {
    throw new Error('charter item is missing an action');
  }
  return JSON.stringify({ action: item.action, params: item.params || {} }, sortKeysReplacer);
}

/**
 * The hash the owner actually signs.
 *
 * Order-independent by construction: item canonical forms are sorted before
 * hashing, so reordering a plan does not invalidate its charter while adding to
 * it does. Reordering is presentational; adding is scope.
 *
 * Duplicates collapse. Listing the same command twice authorizes it as one
 * member of the set, because the charter answers "is this call permitted",
 * never "how many times". Counting is what item states are for.
 */
export function enumerationHash(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('charter enumeration must be a non-empty array');
  }
  const canonical = Array.from(new Set(items.map(canonicalizeItem))).sort();
  return crypto.createHash('sha256').update(canonical.join('\n')).digest('hex');
}

/**
 * Build the unsigned charter body. Signing happens in bin/charter.js, at a TTY,
 * with a passphrase this process never sees — the same trust boundary the
 * approval signer already enforces.
 */
export function buildCharter({ id, title, source, items, expiresAt }) {
  if (!id) throw new Error('charter needs an id');
  if (!Array.isArray(items) || items.length === 0) throw new Error('charter needs items');

  return {
    format: CHARTER_FORMAT,
    id,
    title: title || '(untitled charter)',
    source: source || null,
    issuedAt: Date.now(),
    expiresAt: expiresAt || null,
    itemCount: items.length,
    enumerationHash: enumerationHash(items),
    items
  };
}

/**
 * The exact bytes a charter signature covers.
 *
 * NOTE what is NOT in here: `items` itself, `title`, `source`. The signature
 * covers the HASH of the enumeration, not the enumeration as written. That is
 * the point — it means the items array can be re-serialized, reordered or
 * reformatted without breaking the signature, while any change to what is
 * actually authorized breaks it immediately.
 */
export function charterSignData(charter) {
  return {
    format: charter.format,
    id: charter.id,
    issuedAt: charter.issuedAt,
    expiresAt: charter.expiresAt ?? null,
    itemCount: charter.itemCount,
    enumerationHash: charter.enumerationHash
  };
}

export function charterSignBuffer(charter) {
  const d = charterSignData(charter);
  return Buffer.from(JSON.stringify(d, Object.keys(d).sort()), 'utf8');
}

/**
 * Verify a charter's integrity. Three independent checks, and all three matter:
 *
 *   1. The signature is the owner's over the sign-data.
 *   2. The enumeration still hashes to what was signed. This is the one that
 *      catches an added work order.
 *   3. itemCount matches the array length, which catches a truncation that
 *      happens to leave a valid subset.
 *
 * Returns { ok, reason }. Never throws on bad input; a malformed charter is a
 * rejection, not a crash.
 */
export function verifyCharter(charter, approvalPubJwkX) {
  try {
    if (!charter || typeof charter !== 'object') return { ok: false, reason: 'charter is not an object' };
    if (charter.format !== CHARTER_FORMAT) {
      return { ok: false, reason: `unknown charter format ${JSON.stringify(charter.format)}` };
    }
    if (!charter.signature) return { ok: false, reason: 'charter is unsigned' };
    if (!Array.isArray(charter.items) || charter.items.length === 0) {
      return { ok: false, reason: 'charter has no items' };
    }
    if (charter.itemCount !== charter.items.length) {
      return {
        ok: false,
        reason: `itemCount ${charter.itemCount} does not match ${charter.items.length} items present`
      };
    }

    let recomputed;
    try { recomputed = enumerationHash(charter.items); }
    catch (e) { return { ok: false, reason: `enumeration is malformed: ${e.message}` }; }

    if (recomputed !== charter.enumerationHash) {
      return {
        ok: false,
        reason: 'enumeration hash mismatch: the item list changed after signing'
      };
    }

    const pub = crypto.createPublicKey({
      key: { crv: 'Ed25519', x: approvalPubJwkX, kty: 'OKP' },
      format: 'jwk'
    });
    const sigOk = crypto.verify(
      null,
      charterSignBuffer(charter),
      pub,
      Buffer.from(charter.signature, 'hex')
    );
    if (!sigOk) return { ok: false, reason: 'charter signature verification failed' };

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `charter verification error: ${e.message}` };
  }
}

/**
 * Is this action inside the charter?
 *
 * Byte equality over the canonical item form — the same discipline that makes a
 * grant immune to KNOWN-LIMITS 11. There is no pattern here to evade, because
 * nothing pattern-matches. An action either canonicalizes to a member of the
 * signed set or it does not.
 *
 * Deliberately does NOT verify the signature. Callers must verify first; this
 * answers membership only, and conflating the two would let a caller skip the
 * check that matters.
 */
export function charterCovers(charter, actionRequest) {
  try {
    const want = canonicalizeItem(actionRequest);
    return charter.items.some(i => {
      try { return canonicalizeItem(i) === want; } catch (e) { return false; }
    });
  } catch (e) {
    return false;
  }
}

/**
 * Has the charter's window closed? Clock-dependent, exactly as grant expiry is
 * (KNOWN-LIMITS 20), so moving the clock backward extends it. The clock-proof
 * bound is completion: a charter whose items are all terminal is done whatever
 * the clock says.
 */
export function isExpired(charter, now = Date.now()) {
  return !!(charter.expiresAt && now > charter.expiresAt);
}

/**
 * Completion arithmetic, which is what the retcon reads.
 *
 * States live in a sidecar rather than on the chain in v1. That is a real
 * weakness and is recorded rather than hidden: a sidecar can be edited to mark
 * an item closed that never ran. Deriving state from `charter-use` chain
 * entries, the way grants derive their ceiling, is the correct design and needs
 * a core change.
 */
export function completion(charter, states = {}) {
  const counts = { closed: 0, blocked: 0, withdrawn: 0, open: 0 };
  for (const item of charter.items) {
    const s = states[item.id];
    if (TERMINAL_STATES.includes(s)) counts[s] += 1;
    else counts.open += 1;
  }
  const terminal = counts.closed + counts.blocked + counts.withdrawn;
  return { ...counts, terminal, total: charter.items.length, done: terminal === charter.items.length };
}

// ---------------------------------------------------------------------------
// Sub-charters: delegation without escalation.
// ---------------------------------------------------------------------------
//
// WHY THESE EXIST
//   A charter authorizes a plan. A pack of workers executing that plan should
//   each hold only the slice they need, not the whole thing. Isaac's framing:
//   "when you have things that need to be let out in intervals then count them
//   when they return with what you set them to do."
//
// THE DESIGN DECISION THAT MATTERS: A SUB-CHARTER IS NOT SIGNED.
//
//   The obvious approach is to have the orchestrator sign sub-charters with its
//   own key. That is wrong, and expensively so: it would mean a process the
//   owner does not control holds signing authority, which is the polarity the
//   whole architecture exists to prevent. An orchestrator that can sign can
//   eventually sign something nobody asked for.
//
//   A sub-charter needs no signature because it grants nothing new. It is a
//   RESTRICTION of an authority the owner already signed, and a restriction
//   carries its own proof: it is valid exactly when it is provably narrower
//   than its parent.
//
//   NARROWING NEVER NEEDS A SIGNATURE. ONLY WIDENING DOES.
//
//   The same reasoning already appears in KNOWN-LIMITS 19: deleting a grant
//   requires no signature, because removing capability can only ever reduce
//   what is possible. This is that principle applied to delegation.
//
//   So the orchestrator holds no key at all. It can carve, and it cannot mint.
//   Tampering is caught without one: adding an item to a sub-charter makes it
//   stop being a subset, and the subset check runs on every verification.

/**
 * Carve a sub-charter from a parent. Throws if any item is not already in the
 * parent — the refusal is the point, and it is a hard failure rather than a
 * filtered result so a caller cannot quietly proceed with less than it asked
 * for and believe it got everything.
 *
 * The sub-charter cannot outlive its parent. If the caller asks for a longer
 * window it silently gets the parent's, because a delegate outliving its
 * mandate is the same escalation by a slower route.
 */
export function deriveSubCharter(parent, items, { id, title, expiresAt } = {}) {
  if (!parent || parent.format !== CHARTER_FORMAT) throw new Error('parent is not a charter');
  if (!Array.isArray(items) || items.length === 0) throw new Error('sub-charter needs items');
  if (!id) throw new Error('sub-charter needs an id');

  const parentSet = new Set(parent.items.map(canonicalizeItem));
  const outside = items.filter(i => !parentSet.has(canonicalizeItem(i)));
  if (outside.length > 0) {
    const first = canonicalizeItem(outside[0]);
    throw new Error(
      `sub-charter would widen its parent: ${outside.length} item(s) not in charter ${parent.id}. First: ${first}`
    );
  }

  // min(requested, parent). A null parent window means unbounded, so the
  // request stands; otherwise the parent's bound wins whenever it is tighter.
  let bound = parent.expiresAt ?? null;
  if (expiresAt && bound) bound = Math.min(expiresAt, bound);
  else if (expiresAt && !bound) bound = expiresAt;

  return {
    format: CHARTER_FORMAT,
    kind: 'sub',
    id,
    title: title || `(sub-charter of ${parent.id})`,
    parentId: parent.id,
    // Pinning the parent's hash means a sub-charter is void the moment the
    // parent's enumeration changes. A delegate cannot survive a mandate being
    // rewritten underneath it.
    parentEnumerationHash: parent.enumerationHash,
    issuedAt: Date.now(),
    expiresAt: bound,
    itemCount: items.length,
    enumerationHash: enumerationHash(items),
    items
  };
}

/**
 * Verify a sub-charter. Four checks, and the ORDER matters: the parent's
 * signature is established before anything about the child is trusted, because
 * a subset of an unsigned set authorizes nothing.
 *
 *   1. The parent verifies against the owner's key.
 *   2. The parent is the one this sub was carved from (hash pin).
 *   3. The sub's own enumeration still hashes to what it claims, so its item
 *      list has not been edited since derivation.
 *   4. Every sub item is still in the parent.
 *
 * Check 4 is what makes an unsigned sub-charter safe. Adding an item to the
 * file does not forge anything; it just stops being a subset.
 */
export function verifySubCharter(sub, parent, approvalPubJwkX, now = Date.now()) {
  try {
    if (!sub || sub.kind !== 'sub') return { ok: false, reason: 'not a sub-charter' };

    const p = verifyCharter(parent, approvalPubJwkX);
    if (!p.ok) return { ok: false, reason: `parent charter does not verify: ${p.reason}` };

    if (sub.parentId !== parent.id) {
      return { ok: false, reason: `sub-charter names parent ${sub.parentId}, got ${parent.id}` };
    }
    if (sub.parentEnumerationHash !== parent.enumerationHash) {
      return { ok: false, reason: 'parent enumeration changed since this sub-charter was carved' };
    }
    if (!Array.isArray(sub.items) || sub.items.length === 0) {
      return { ok: false, reason: 'sub-charter has no items' };
    }
    if (sub.itemCount !== sub.items.length) {
      return { ok: false, reason: `itemCount ${sub.itemCount} does not match ${sub.items.length} items` };
    }

    let recomputed;
    try { recomputed = enumerationHash(sub.items); }
    catch (e) { return { ok: false, reason: `sub-charter enumeration malformed: ${e.message}` }; }
    if (recomputed !== sub.enumerationHash) {
      return { ok: false, reason: 'sub-charter enumeration hash mismatch: its item list changed' };
    }

    const parentSet = new Set(parent.items.map(canonicalizeItem));
    const outside = sub.items.filter(i => {
      try { return !parentSet.has(canonicalizeItem(i)); } catch (e) { return true; }
    });
    if (outside.length > 0) {
      return { ok: false, reason: `sub-charter is not a subset: ${outside.length} item(s) outside the parent` };
    }

    if (isExpired(parent, now)) return { ok: false, reason: 'parent charter has expired' };
    if (isExpired(sub, now)) return { ok: false, reason: 'sub-charter has expired' };

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `sub-charter verification error: ${e.message}` };
  }
}

/** Read every charter file in <home>/charters. Unreadable files are skipped. */
export function loadCharters(home) {
  const dir = path.join(home, 'charters');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch (e) { return null; }
    })
    .filter(Boolean);
}
