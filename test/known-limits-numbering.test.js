/**
 * test/known-limits-numbering.test.js
 *
 * KNOWN-LIMITS 29, amendment 2026-09-01: the confession log's entry numbers are
 * cited from outside this repo — in bounties, in PR titles, in receipts — so a
 * number that stops resolving is a broken reference in someone else's record,
 * not a cosmetic defect in ours. That already happened twice:
 *
 *   - 2026-08-22: a bounty cited an entry number that meant something DIFFERENT
 *     on mainline. The pin (src/limits/pin.js) was the answer to that one.
 *   - 2026-08-29 (dc1910b, PR #36): an amendment to entry 24 deleted entry 25's
 *     heading line inside the same hunk. Entry 25's body — three paragraphs on
 *     `gh` as the authenticated vendor CLI the rules could not see — was left
 *     orphaned inside entry 24, and "KNOWN-LIMITS 25" resolved to NOTHING. The
 *     log ran 1..61 with 60 entries in it.
 *
 * The second one survived a code review and 891 green tests. Nothing in the
 * suite had ever read the shipped log as a STRUCTURE. An accidental one-line
 * deletion inside a 230-line documentation diff is precisely what human review
 * misses and precisely what a parser catches for free.
 *
 * WHAT THIS FILE IS, and how it differs from its neighbour:
 * known-limits-commit-pinning.test.js exercises the pin module, and the two
 * cases there advertised as reading "the REAL shipped log" both WRITE the state
 * they then assert (one stamps before checking, the other forces a foreign hash
 * before checking). Each proves half the tool works; neither ever reads the
 * committed value. This file is the read-only complement: it opens the file
 * that ships, asserts, and writes nothing. It needs no pin, no git, and no
 * fixture, so it cannot manufacture the state it is checking for.
 *
 * FAIL-FIRST DISCIPLINE (2026-07-24 rule):
 *   - RED on main at a2ac5e2: 60 entries, highest number 61, entry 25 missing.
 *     The first assertion below fails and names 25.
 *   - GREEN with the heading restored: 61 entries, contiguous 1..61.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(HERE, '..', 'KNOWN-LIMITS.md');

/**
 * Entry headings only. Anchored to line start in multiline mode so a number
 * quoted inside a paragraph, a fenced block, or a deeper heading (### ) is not
 * mistaken for an entry. This is the same shape the file has used since entry 1.
 */
const ENTRY_HEADING = /^## (\d+)\./gm;

/** @returns {number[]} entry numbers in the order they appear in the file */
function entryNumbers() {
  const text = fs.readFileSync(LOG_PATH, 'utf8');
  return [...text.matchAll(ENTRY_HEADING)].map(m => Number(m[1]));
}

describe('KNOWN-LIMITS.md structural integrity (read-only, on the shipped log)', () => {
  it('every entry number from 1 to the highest is present', () => {
    const found = entryNumbers();
    const present = new Set(found);
    const highest = Math.max(...found);

    const missing = [];
    for (let n = 1; n <= highest; n++) {
      if (!present.has(n)) missing.push(n);
    }

    assert.deepStrictEqual(
      missing,
      [],
      `KNOWN-LIMITS.md is missing entry ${missing.join(', ')}. The file runs 1..` +
        `${highest} but ${found.length} entries are present. A citation of a ` +
        'missing number resolves to nothing, and the body that used to sit under ' +
        'it is now attributed to the entry above it. Restore the heading rather ' +
        'than renumbering: external references are already pointing here.'
    );
  });

  it('no entry number appears twice', () => {
    const found = entryNumbers();
    const seen = new Set();
    const duplicates = [];
    for (const n of found) {
      if (seen.has(n) && !duplicates.includes(n)) duplicates.push(n);
      seen.add(n);
    }

    assert.deepStrictEqual(
      duplicates,
      [],
      `KNOWN-LIMITS.md declares entry ${duplicates.join(', ')} more than once. ` +
        'A duplicated number is worse than a missing one: a citation resolves, ' +
        'and resolves to the wrong entry.'
    );
  });

  it('entries appear in ascending order', () => {
    const found = entryNumbers();
    const sorted = [...found].sort((a, b) => a - b);
    assert.deepStrictEqual(
      found,
      sorted,
      'KNOWN-LIMITS.md entries are out of numeric order. Order is how a reader ' +
        'finds an entry by number without searching, and an out-of-order entry ' +
        'is usually the visible half of a bad merge.'
    );
  });

  it('the parse finds a plausible number of entries, so a broken regex cannot pass silently', () => {
    const found = entryNumbers();
    // Deliberately well below the current count: this is a floor against a
    // parse returning zero or a handful, not a running total to maintain.
    assert.ok(
      found.length >= 40,
      `Only ${found.length} entries parsed out of KNOWN-LIMITS.md. The heading ` +
        'format probably changed, which means the two assertions above are ' +
        'passing over a file they can no longer read. Fix the pattern, do not ' +
        'lower this floor.'
    );
  });
});
