/**
 * src/views/autograph.js
 *
 * The autograph ratio: how much of the owner's signing was deciding, and how
 * much was confirming something already decided.
 *
 * WHY THIS EXISTS
 *   Isaac, 2026-07-26: "I feel like I'm doing a lot of autographing versus
 *   signing." An autograph is a signature whose content the signer does not
 *   read. A signature is a decision. The gate cannot tell them apart and will
 *   happily collect either, so the only defence is counting them and looking at
 *   the trend.
 *
 *   Receipts already answer what happened. Nothing counted what it cost the
 *   person. This is counting pointed at the operator's own load, which is the
 *   most on-thesis metric available and did not exist in any form.
 *
 * WHY THIS VIEW REPORTS BOTH A WINDOW AND A PER-SIGNATURE COUNT (KNOWN-LIMITS 36)
 *   As of 2026-08-15 (commit 9a934f2) an approved gate receipt also carries
 *   `paramsDigestCanonical`, a SHA-256 digest of the approved params. A
 *   reviewer holding a CANDIDATE (e.g. one enumerated charter item, which
 *   carries the same { action, params } shape) can re-derive that digest and
 *   compare — that IS per-signature attribution against a known candidate,
 *   and it is computed, not guessed (test/limit-36-digest-attribution.test.js
 *   proves it against the real functions, not a description of them).
 *
 *   As of 2026-09-04 (this change) this view uses it: every approved receipt
 *   signed inside a charter's window is tested against that charter's own
 *   declared items (action match plus digest match), and the count of
 *   receipts that actually match a declared item — `signatures.confirmed` —
 *   is reported beside the window split, not instead of it. Two real limits
 *   on what that count can mean, both proven in the same test file rather
 *   than merely asserted here:
 *   (1) it can only ever answer "does this receipt match a candidate I am
 *   holding" — there is no reverse index from a digest back to an item, so
 *   nothing here enumerates a receipt's target from the chain alone, and a
 *   charter with items nobody thought to declare leaves those signatures
 *   correctly counted as unmatched rather than invisible;
 *   (2) a charter item with `params` omitted and a receipt whose action
 *   genuinely took no params digest DIFFERENTLY if the comparison naively
 *   defaults a missing params to `{}` (`digestParamsCanonical(undefined)`
 *   returns the literal `'empty'`, `digestParamsCanonical({})` hashes
 *   `"{}"`) — `matchesItem` below passes `item.params` straight through,
 *   never defaulting it, specifically to avoid that false negative.
 *
 *   The window split is kept because it is still the only thing that can
 *   speak to charters issued without per-item digest candidates worth
 *   testing, and because a signature the matcher counts as unmatched is not
 *   thereby proven unrelated to the charter — only unproven related to any
 *   of its declared items. A charter carries issuedAt and expiresAt.
 *   Signatures spent while a charter was live were, by construction, spent
 *   inside a reviewed plan; signatures spent outside any charter were not. That
 *   is the comparison the complaint was actually about: 33 approvals in one
 *   un-chartered evening against 3 across a charter's whole overnight window.
 *
 *   Reporting the rate per hour rather than the raw count is what makes those
 *   two comparable, since the windows are different lengths.
 *
 * IT PRESENTS, IT DOES NOT JUDGE
 *   There is no target ratio and no score. A high decision rate during a design
 *   session is correct. The same rate during a long build is the thing worth
 *   noticing. The tool shows the trend and leaves the reading to the reader.
 */

import { digestParamsCanonical } from '../parser/index.js';

const HOUR = 60 * 60 * 1000;

/** Charter windows, oldest first, ignoring anything unsigned or malformed. */
function charterWindows(charters, nowMs) {
  return (charters || [])
    .filter(c => c && typeof c.issuedAt === 'number' && c.signature)
    .map(c => ({
      id: c.id,
      title: c.title,
      from: c.issuedAt,
      // A charter with no expiry runs until it completes, which this view
      // cannot observe. Treating it as open-ended to `now` is the honest
      // reading and is stated in the output.
      to: typeof c.expiresAt === 'number' ? c.expiresAt : nowMs,
      openEnded: typeof c.expiresAt !== 'number',
      // Kept for per-signature matching below. Absent or malformed items
      // just mean nothing in this window is matchable, not an error.
      items: Array.isArray(c.items) ? c.items : []
    }))
    .sort((a, b) => a.from - b.from);
}

/**
 * Does an approved receipt match one charter item's own declared params?
 * Action must agree, and the receipt's stored digest must equal an
 * independently re-derived digest of the item's params.
 *
 * Deliberately does NOT reuse `canonicalizeItem`'s `item.params || {}`
 * default (src/charter/index.js). That default is correct for the
 * enumeration hash, which needs every item to canonicalize to *something*.
 * It is wrong here: an item that never declared a `params` field at all
 * must digest as `'empty'`, matching a receipt whose action genuinely took
 * no params — collapsing it to `{}` would digest it as `hash("{}")`
 * instead, which is a DIFFERENT candidate, and the match would silently
 * fail on every no-arg action. Passing `item.params` straight through
 * keeps the two cases apart. Proven in
 * test/limit-36-digest-attribution.test.js.
 */
function matchesItem(receipt, item) {
  return !!receipt && !!item
    && receipt.action === item.action
    && typeof receipt.paramsDigestCanonical === 'string'
    && receipt.paramsDigestCanonical === digestParamsCanonical(item.params);
}

/**
 * Every (charter, item) pair a receipt matches, across only the windows
 * active at its own timestamp. Zero hits means the signature was spent
 * during a charter's window but is not one of that charter's declared
 * items — an incidental action, or a charter that did not enumerate
 * everything it should have. More than one hit means the digest alone
 * cannot tell two candidates apart (two items sharing the same action and
 * params) — a real ambiguity KNOWN-LIMITS 36 already names, not a defect in
 * this function.
 */
function matchingItems(receipt, activeWindows) {
  const hits = [];
  for (const w of activeWindows) {
    for (const item of w.items) {
      if (matchesItem(receipt, item)) hits.push({ charterId: w.id, itemId: item.id });
    }
  }
  return hits;
}

/**
 * Sum the hours covered by the windows, merging overlaps so two concurrent
 * charters do not double-count the same clock time.
 */
function coveredHours(windows, from, to) {
  if (!windows.length) return 0;
  const clipped = windows
    .map(w => ({ from: Math.max(w.from, from), to: Math.min(w.to, to) }))
    .filter(w => w.to > w.from)
    .sort((a, b) => a.from - b.from);

  let total = 0;
  let cur = null;
  for (const w of clipped) {
    if (!cur) { cur = { ...w }; continue; }
    if (w.from <= cur.to) cur.to = Math.max(cur.to, w.to);
    else { total += cur.to - cur.from; cur = { ...w }; }
  }
  if (cur) total += cur.to - cur.from;
  return total / HOUR;
}

/**
 * @param {Array} entries   chain entries, oldest first
 * @param {Array} charters  signed charters from the store
 * @param {object} opts     { since, now }
 */
export function autographReport(entries, charters, opts = {}) {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? null;
  const rows = (entries || []).filter(e =>
    e?.payload?.type === 'gated-action' && (since === null || e.timestamp >= since)
  );

  const from = since ?? (rows.length ? rows[0].timestamp : now);
  const to = rows.length ? rows[rows.length - 1].timestamp : now;

  const windows = charterWindows(charters, now);
  const chartered = { approved: 0, denied: 0 };
  const unchartered = { approved: 0, denied: 0 };
  const byAction = {};
  const signatures = { confirmed: 0, ambiguous: 0, unmatched: 0 };

  for (const e of rows) {
    const p = e.payload;
    const activeWindows = windows.filter(w => e.timestamp >= w.from && e.timestamp <= w.to);
    const bucket = activeWindows.length ? chartered : unchartered;
    if (p.decision === 'approved') {
      bucket.approved++;
      if (activeWindows.length) {
        const hits = matchingItems(p, activeWindows);
        if (hits.length === 0) signatures.unmatched++;
        else {
          signatures.confirmed++;
          if (hits.length > 1) signatures.ambiguous++;
        }
      }
    } else bucket.denied++;

    const key = p.action || '?';
    byAction[key] = byAction[key] || { approved: 0, denied: 0 };
    if (p.decision === 'approved') byAction[key].approved++;
    else byAction[key].denied++;
  }

  const spanHours = Math.max((to - from) / HOUR, 0);
  const charteredHours = coveredHours(windows, from, to);
  const uncharteredHours = Math.max(spanHours - charteredHours, 0);

  const rate = (n, h) => (h > 0 ? +(n / h).toFixed(2) : null);

  return {
    window: { from, to, spanHours: +spanHours.toFixed(2) },
    totals: {
      approved: chartered.approved + unchartered.approved,
      denied: chartered.denied + unchartered.denied
    },
    confirmations: {
      label: 'signed while a charter was live',
      approved: chartered.approved,
      denied: chartered.denied,
      hours: +charteredHours.toFixed(2),
      perHour: rate(chartered.approved, charteredHours)
    },
    decisions: {
      label: 'signed outside any charter',
      approved: unchartered.approved,
      denied: unchartered.denied,
      hours: +uncharteredHours.toFixed(2),
      perHour: rate(unchartered.approved, uncharteredHours)
    },
    byAction,
    charters: windows.map(w => ({
      id: w.id, title: w.title, from: w.from, to: w.to, openEnded: w.openEnded
    })),
    signatures: {
      label: 'approved signatures signed inside a charter window, matched against that charter\'s own declared items by paramsDigestCanonical',
      confirmed: signatures.confirmed,
      ambiguous: signatures.ambiguous,
      unmatched: signatures.unmatched
    },
    caveats: [
      'Per-signature matching (KNOWN-LIMITS 36) can only confirm or deny a candidate you already hold — an item a charter never declared cannot be found this way, so an "unmatched" signature is not proven unrelated to the charter, only unproven against what it enumerated.',
      `${signatures.ambiguous} confirmed match(es) hit more than one declared item with the same action and params — the digest alone cannot tell those apart.`,
      'Charters issued as markdown rather than through the signing tool leave no record here and their windows cannot be counted.',
      'There is no target ratio. A high decision rate in a design session is correct; the same rate through a long build is the thing worth noticing.'
    ]
  };
}

const stamp = ms => (ms == null ? '—' : new Date(ms).toLocaleString());

export function renderAutograph(r) {
  const L = [];
  L.push('');
  L.push('AUTOGRAPH RATIO   deciding vs confirming');
  L.push('='.repeat(66));
  L.push(`  window        ${stamp(r.window.from)}  ->  ${stamp(r.window.to)}`);
  L.push(`  span          ${r.window.spanHours} h`);
  L.push(`  approvals     ${r.totals.approved}`);
  L.push(`  denials       ${r.totals.denied}`);
  L.push('');

  const row = (name, b) => {
    L.push(`  ${name}`);
    L.push(`    approvals   ${b.approved}`);
    L.push(`    hours       ${b.hours}`);
    L.push(`    per hour    ${b.perHour === null ? '—' : b.perHour}`);
    L.push('');
  };
  row('DECISIONS   signed outside any charter', r.decisions);
  row('CONFIRMATIONS   signed while a charter was live', r.confirmations);

  L.push('  PER-SIGNATURE MATCH   confirmed against a declared charter item, by digest');
  L.push(`    confirmed     ${r.signatures.confirmed}`);
  L.push(`    ambiguous     ${r.signatures.ambiguous}  (matched more than one declared item)`);
  L.push(`    unmatched     ${r.signatures.unmatched}  (signed in-window, matches no declared item)`);
  L.push('');

  if (r.charters.length) {
    L.push('  CHARTERS IN WINDOW');
    for (const c of r.charters) {
      L.push(`    ${c.id}  ${stamp(c.from)} -> ${c.openEnded ? 'open-ended' : stamp(c.to)}`);
    }
    L.push('');
  } else {
    L.push('  No signed charters in this window, so every signature counts as a decision.');
    L.push('');
  }

  const actions = Object.entries(r.byAction).sort((a, b) => b[1].approved - a[1].approved);
  if (actions.length) {
    L.push('  BY TOOL');
    for (const [name, c] of actions) {
      L.push(`    ${String(name).padEnd(12)} ${String(c.approved).padStart(4)} approved   ${String(c.denied).padStart(4)} denied`);
    }
    L.push('');
  }

  L.push('  WHAT THIS DOES NOT TELL YOU');
  for (const c of r.caveats) L.push(`    - ${c}`);
  L.push('');
  return L.join('\n');
}
