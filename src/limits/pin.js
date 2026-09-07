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
 *   1. STATE THE COMMIT THE LOG DESCRIBES. `writePin` maintains one delimited
 *      block at the very top of KNOWN-LIMITS.md naming the commit of the code
 *      the file describes, when it was stamped, and by what. The block is
 *      managed: re-stamping replaces it in place and never duplicates it.
 *      The pin names the last commit that touched `src/` (see bin/limits-pin.js
 *      resolvePinTarget), NOT the current HEAD — because stamping edits only
 *      this log file, so a HEAD-based pin could only ever name its own parent
 *      and would read "diverged" on every reader of main after it landed.
 *
 *   2. TELL A DIVERGENT READER THEY ARE READING SOMEWHERE ELSE. `checkPin`
 *      compares the pin against the running checkout's HEAD and returns a
 *      verdict plus a reader-facing message. `diverged` names BOTH commits,
 *      so the reader knows what they are reading AND where they are.
 *
 * THE THIRD HALF, added 2026-09-07 (KNOWN-LIMITS 65). The pin above binds the
 * code and never the log. A commit that edits only this log does not move the
 * last `src/` commit, so an entry could be appended, deleted, or have its
 * claim reversed and `--check` still said `current` and exited 0. Now the pin
 * also carries `body-sha256`, a digest of the file WITH THE PIN BLOCK REMOVED
 * (so stamping stays stable and limit 29's self-invalidation problem does not
 * return). A pin whose commit matches but whose digest does not is a third
 * status, `edited`: the code is where the log says it is, and the log is not.
 * Exit 1, like divergence. A pin with no digest line (stamped before this
 * change) keeps the old semantics exactly, so old pins are not retroactively
 * failed; re-stamping upgrades them.
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
 *   - The body digest binds the text and says nothing about whether the text
 *     is true. Re-stamping asserts verification that nobody checks, and a liar
 *     re-stamps. The digest converts a silent gap into a prompt to re-verify;
 *     it does not perform the verification (limit 65's own residual).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

export const PIN_BEGIN = '<!-- known-limits:pin v1';
export const PIN_END = 'known-limits:pin end -->';

/**
 * The file with the managed pin block removed, and any blank lines that
 * followed the block trimmed. This is the text `body-sha256` is taken over,
 * on both the write and the check side, so the two always agree. Text with
 * no pin block is returned as-is (leading blank lines trimmed, for the same
 * stability reason).
 * @param {string} text
 * @returns {string}
 */
function stripPinBlock(text) {
  if (typeof text !== 'string') return '';
  const start = text.indexOf(PIN_BEGIN);
  if (start === -1) return text.replace(/^\n+/, '');
  const end = text.indexOf(PIN_END, start);
  const after = end === -1 ? '' : text.slice(end + PIN_END.length);
  return (text.slice(0, start) + after).replace(/^\n+/, '');
}

/**
 * sha256 of the log body, pin block excluded.
 * @param {string} text - full file contents (with or without a pin block)
 * @returns {string} 64 hex characters
 */
function bodyDigest(text) {
  return crypto.createHash('sha256').update(stripPinBlock(text), 'utf8').digest('hex');
}

/**
 * Render the managed pin block.
 * @param {Object} p
 * @param {string} p.commit  - full commit hash the log describes
 * @param {string} p.subject - commit subject line, for a human glance
 * @param {string} p.date    - ISO date the pin was stamped
 * @param {string} [p.bodySha256] - digest of the body the block sits above
 * @returns {string} markdown block ending in a newline
 */
function renderPinBlock({ commit, subject, date, bodySha256 }) {
  const c = String(commit || 'unknown');
  const s = String(subject || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const d = String(date || new Date().toISOString().slice(0, 10));
  const b = typeof bodySha256 === 'string' && /^[0-9a-f]{64}$/i.test(bodySha256)
    ? bodySha256.toLowerCase()
    : null;
  return [
    PIN_BEGIN,
    ` This file describes commit ${c}`,
    ` stamped ${d}`,
    s ? ` subject: ${s}` : null,
    b ? ` body-sha256: ${b}` : null,
    ` Re-stamp after updating this log: npm run limits-pin -- --stamp`,
    ` Divergent checkout? See: npm run limits-pin -- --check`,
    PIN_END
  ].filter(l => l !== null).join('\n') + '\n\n';
}

/**
 * Read the pin from a KNOWN-LIMITS.md body. Returns null when no pin block
 * exists (the pre-fix state) — absence is reported, never guessed around.
 * @param {string} text - full file contents
 * @returns {{commit: string, subject?: string, date?: string, bodySha256?: string} | null}
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
  const b = block.match(/body-sha256: ([0-9a-f]{64})/i);
  if (b) pin.bodySha256 = b[1].toLowerCase();
  return pin;
}

/**
 * Stamp (or replace) the pin block at the top of the file.
 * Idempotent: exactly one block before the title, whatever the previous state.
 * The body digest is taken over the file with the block removed, so stamping
 * the same body twice writes the same digest.
 * @param {string} filePath - path to KNOWN-LIMITS.md
 * @param {Object} pin - { commit, subject?, date? }
 */
function writePin(filePath, pin) {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '';
  const rest = stripPinBlock(existing);
  const fresh = renderPinBlock({ ...pin, bodySha256: bodyDigest(rest) });
  fs.writeFileSync(filePath, fresh + rest);
}

/**
 * Compare a pin against the running checkout.
 * Pure over its inputs: callers resolve HEAD however they like (CLI resolves
 * via git; tests pass literals).
 *
 * @param {Object} a
 * @param {string} a.pinText - full KNOWN-LIMITS.md contents. A pin that carries
 *   a body digest needs the full file to check it; passing just the block
 *   reads as `edited`, which is the honest answer for a body that is missing.
 * @param {?string} a.head   - current checkout's commit hash, or null/'' if unresolvable
 * @param {boolean} [a.dirty] - working-tree dirty flag, informational
 * @returns {{status: 'current'|'edited'|'diverged'|'unpinned'|'unknown', pin?, head?, bodySha256?, message?}}
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
    // The code half matches. Now the log half (KNOWN-LIMITS 65): a pin that
    // recorded a body digest is held to it. A pin without one predates the
    // digest and keeps the old verdict, stated as such rather than upgraded.
    if (pin.bodySha256) {
      const actual = bodyDigest(pinText);
      if (actual !== pin.bodySha256) {
        return {
          status: 'edited',
          pin,
          head,
          bodySha256: actual,
          message:
            `WARNING: KNOWN-LIMITS.md has been edited since it was stamped. The code is where the ` +
            `log says it is (commit ${pin.commit}), but the log body digests to ${actual.slice(0, 16)}... ` +
            `and the pin recorded ${pin.bodySha256.slice(0, 16)}.... Entries may have been added, ` +
            `removed, or had their claims changed without being verified against that commit. ` +
            `Re-verify the entries, then re-stamp: npm run limits-pin -- --stamp`
        };
      }
    }
    return {
      status: 'current',
      pin,
      head,
      message: dirty
        ? `This log describes commit ${pin.commit}, which matches your checkout, but your ` +
          'working tree has uncommitted changes. Entries may not match your working files.'
        : `This log describes commit ${pin.commit}, which matches your checkout.` +
          (pin.bodySha256 ? '' : ' (The pin carries no body digest; the log half is unverified. Re-stamp to add one.)')
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

export { renderPinBlock, readPin, writePin, checkPin, stripPinBlock, bodyDigest };
