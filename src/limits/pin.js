/**
 * src/limits/pin.js
 *
 * KNOWN-LIMITS 29: the confession log documents `main`, but lives in the tree
 * of branches that change it. Nothing told a reader WHICH commit the file
 * describes, so on any feature branch it was simultaneously accurate for
 * mainline and false for the checkout being read. This already caused a real
 * error (2026-08-22): a bounty cited an entry number that meant something
 * different on main.
 *
 * THE FIX has two halves, matching the listing's two requirements:
 *
 *   1. STATE THE COMMIT AT STAMP TIME. `writePin` maintains one delimited
 *      block at the very top of KNOWN-LIMITS.md naming the exact commit of
 *      the code the file describes, when it was stamped, and by what. The
 *      block is managed: re-stamping replaces it in place and never
 *      duplicates it.
 *
 *   2. TELL A DIVERGENT READER THEY ARE READING SOMEWHERE ELSE. `checkPin`
 *      compares the pin against the running checkout's HEAD and returns a
 *      verdict plus a reader-facing message. `diverged` names BOTH commits,
 *      so the reader knows what they are reading AND where they are.
 *
 * WHAT THE PIN MEANS, stated because the alternative is drift: the pin names
 * the commit whose tree the entries were last verified against. The intended
 * workflow is stamp-on-main: entries describe released behaviour, so the pin
 * advances when the log is updated on main. A feature branch that edits the
 * log re-stamps with its own commit, which is honest too: the pin then says
 * exactly which tree those edits describe, and mainline readers see the
 * divergence instead of missing it.
 *
 * RESIDUALS, declared rather than hidden:
 *   - The pin is self-reported text inside the same file it describes. It is
 *     evidence for a human reader, not cryptographic binding; nothing stops a
 *     commit from carrying a false pin. What stops that is review, the same
 *     thing that stops any lie in a markdown file.
 *   - Stamping is a deliberate act (`bin/limits-pin.js`), not automatic. A
 *     commit that touches code without re-stamping leaves a stale pin, which
 *     `--check` surfaces honestly as divergence rather than silently passing.
 *     Closing that fully needs CI, which limit 29 already named as a candidate.
 */

import fs from 'node:fs';

export const PIN_BEGIN = '<!-- known-limits:pin v1';
export const PIN_END = 'known-limits:pin end -->';

/**
 * Render the managed pin block.
 * @param {Object} p
 * @param {string} p.commit  - full commit hash the log describes
 * @param {string} p.subject - commit subject line, for a human glance
 * @param {string} p.date    - ISO date the pin was stamped
 * @returns {string} markdown block ending in a newline
 */
function renderPinBlock({ commit, subject, date }) {
  const c = String(commit || 'unknown');
  const s = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const d = String(date || new Date().toISOString().slice(0, 10));
  return [
    PIN_BEGIN,
    ` This file describes commit ${c}`,
    ` stamped ${d}`,
    s ? ` subject: ${s}` : null,
    ` Re-stamp after updating this log: npm run limits-pin -- --stamp`,
    ` Divergent checkout? See: npm run limits-pin -- --check`,
    PIN_END
  ].filter(l => l !== null).join('\n') + '\n\n';
}

/**
 * Read the pin from a KNOWN-LIMITS.md body. Returns null when no pin block
 * exists (the pre-fix state) — absence is reported, never guessed around.
 * @param {string} text - full file contents
 * @returns {{commit: string, subject?: string, date?: string} | null}
 */
function readPin(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(PIN_BEGIN);
  if (start === -1) return null;
  const end = text.indexOf(PIN_END, start);
  if (end === -1) return null;

  const block = text.slice(start, end + PIN_END.length);
  const m = block.match(/describes commit ([0-9a-f]{7,64})/i);
  if (!m) return null;

  const pin = { commit: m[1].toLowerCase() };
  const d = block.match(/stamped (\d{4}-\d{2}-\d{2})/);
  if (d) pin.date = d[1];
  const s = block.match(/subject: (.+)/);
  if (s) pin.subject = s[1].trim();
  return pin;
}

/**
 * Stamp (or replace) the pin block at the top of the file.
 * Idempotent: exactly one block before the title, whatever the previous state.
 * @param {string} filePath - path to KNOWN-LIMITS.md
 * @param {Object} pin - { commit, subject?, date? }
 */
function writePin(filePath, pin) {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
  const fresh = renderPinBlock(pin);

  const start = existing.indexOf(PIN_BEGIN);
  let body = existing;
  if (start !== -1) {
    // Replace through the end of the block line, leaving the rest untouched.
    const end = existing.indexOf(PIN_END, start);
    const after = end === -1 ? '' : existing.slice(end + PIN_END.length);
    body = existing.slice(0, start) + fresh.trimEnd() + '\n\n' + after.replace(/^\n+/, '');
  } else {
    body = fresh + existing;
  }
  fs.writeFileSync(filePath, body);
}

/**
 * Compare a pin against the running checkout.
 * Pure over its inputs: callers resolve HEAD however they like (CLI resolves
 * via git; tests pass literals).
 *
 * @param {Object} a
 * @param {string} a.pinText - full KNOWN-LIMITS.md contents (or just the block)
 * @param {?string} a.head   - current checkout's commit hash, or null/'' if unresolvable
 * @param {boolean} [a.dirty] - working-tree dirty flag, informational
 * @returns {{status: 'current'|'diverged'|'unpinned'|'unknown', pin?, head?, message?}}
 */
function checkPin({ pinText, head, dirty = false }) {
  const pin = readPin(pinText);

  if (!pin) {
    return {
      status: 'unpinned',
      message:
        'KNOWN-LIMITS.md states no commit. It cannot tell you which version of the code ' +
        'it describes. Treat every entry as unverified until the log is pinned ' +
        '(npm run limits-pin -- --stamp).'
    };
  }

  if (head == null || head === '') {
    return {
      status: 'unknown',
      pin,
      message:
        `This log describes commit ${pin.commit}, but the current checkout could not be ` +
        'resolved (not a git worktree?). The entries may or may not match what you are running.'
    };
  }

  if (head.toLowerCase() === pin.commit.toLowerCase()) {
    return {
      status: 'current',
      pin,
      head,
      message: dirty
        ? `This log describes commit ${pin.commit}, which matches your checkout, but your ` +
          'working tree has uncommitted changes. Entries may not match your working files.'
        : `This log describes commit ${pin.commit}, which matches your checkout.`
    };
  }

  return {
    status: 'diverged',
    pin,
    head,
    message:
      `WARNING: you are reading a description of somewhere else. This KNOWN-LIMITS.md was ` +
      `verified against commit ${pin.commit}${pin.subject ? ` ("${pin.subject}")` : ''}, but your ` +
      `checkout is at ${head}. Entry numbering, entry presence, and every claim in the log are ` +
      `guaranteed only for the pinned commit. Verify against git history before citing an entry.`
  };
}

export { renderPinBlock, readPin, writePin, checkPin };
