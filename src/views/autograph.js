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
 * WHY THIS STILL ATTRIBUTES BY WINDOW, NOT PER SIGNATURE (corrected, KNOWN-LIMITS 36)
 *   As of 2026-08-15 (commit 9a934f2) an approved gate receipt also carries
 *   `paramsDigestCanonical`, a SHA-256 digest of the approved params. A
 *   reviewer holding a CANDIDATE (e.g. one enumerated charter item, which
 *   carries the same { action, params } shape) can re-derive that digest and
 *   compare — that IS per-signature attribution against a known candidate,
 *   and it is computed, not guessed (test/limit-36-digest-attribution.test.js
 *   proves it against the real functions, not a description of them). The
 *   claim that a signature "cannot be matched against a charter's declared
 *   items after the fact" was true when this file was written and stopped
 *   being true three weeks before the next line was.
 *
 *   This view was never upgraded to use it. Two real reasons to still prefer
 *   the window split here rather than treat this as done: (1) matching needs
 *   a candidate to test against — it answers "was this receipt FOR item X",
 *   never "list every receipt's target" from the chain alone, so it cannot
 *   replace the window view, only sit beside it; (2) a charter item with
 *   `params` omitted and a receipt whose action genuinely took no params
 *   digest DIFFERENTLY (`digestParamsCanonical(undefined)` returns the
 *   literal `'empty'`, `digestParamsCanonical({})` hashes `"{}"`), so a naive
 *   matcher false-negatives on every no-arg action — proven in the same test
 *   file, not merely asserted here.
 *
 *   What IS derivable, and what this view still reports, is the window. A
 *   charter carries issuedAt and expiresAt.
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
      openEnded: typeof c.expiresAt !== 'number'
    }))
    .sort((a, b) => a.from - b.from);
}

const inAnyWindow = (ts, windows) => windows.some(w => ts >= w.from && ts <= w.to);

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

  for (const e of rows) {
    const p = e.payload;
    const bucket = inAnyWindow(e.timestamp, windows) ? chartered : unchartered;
    if (p.decision === 'approved') bucket.approved++;
    else bucket.denied++;

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
    caveats: [
      'This attributes by WINDOW, not per signature. A digest exists that CAN match a signature to a known candidate (KNOWN-LIMITS 36), but this view has not been upgraded to use it, and it cannot list every receipt\'s target unaided — only confirm or deny one you already suspect.',
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
