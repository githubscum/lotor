/**
 * test/known-limits-citations.test.js
 *
 * KNOWN-LIMITS 29, second structural check (2026-09-01).
 *
 * Its neighbour known-limits-numbering.test.js asks whether the LOG is intact:
 * does every number from 1 to the highest have an entry under it. This file
 * asks the opposite question, and it is a different question: does every
 * CITATION in this repository point at an entry that exists.
 *
 * The two failures are not the same failure.
 *
 *   - "An entry vanished" is what happened on 2026-08-29 (dc1910b, PR #36),
 *     and the numbering test is the answer to it.
 *   - "A citation points at nothing" is the mirror. It happens when a number
 *     is typed wrong in a source comment, when a citation is written ahead of
 *     the entry it means to cite, or when an entry vanishes AND the numbering
 *     test is not yet in the suite. The log can be perfectly contiguous while
 *     a comment in src/ sends a reader to an entry that never existed.
 *
 * Why it matters beyond tidiness: these numbers are load-bearing OUTSIDE this
 * repo. Bounties, PR titles, receipts and confessions cite them. A citation is
 * a pointer to evidence, and a pointer to evidence that is not there is the
 * exact failure the whole record exists to prevent.
 *
 * NULL RESULT, RECORDED HONESTLY (2026-09-01): at the time of writing this
 * test found NO dangling citation. Every citation in the tree resolves, and it
 * resolved on `main` too. This is a guard against a class of defect that has
 * already occurred twice in this file, not the discovery of a live one. It is
 * written down as a null rather than dressed up as a find.
 *
 * SCOPE, and it is deliberately narrow. Only the explicit `KNOWN-LIMITS <n>`
 * and `KNOWN-LIMITS #<n>` forms are scanned. The bare `limit <n>` shorthand is
 * roughly twice as common in the tree and is NOT scanned, because it collides
 * with ordinary prose ("rate limit 5", "limit 2 concurrent"). This is a fence,
 * not a proof, and it knows which side it under-scans.
 *
 * EDITOR TRAP, named so it is not rediscovered: this file is itself scanned.
 * Writing a nonexistent entry number in a comment here, in the citation form,
 * makes the suite fail on the comment. Synthetic numbers below are built by
 * concatenation so the scanner cannot read them as citations.
 *
 * FAIL-FIRST DISCIPLINE (2026-07-24 rule): the repository-wide assertion is
 * green today and cannot demonstrate RED on its own. The resolver is therefore
 * exercised directly against a synthetic citation that does not resolve, which
 * proves the check can fail. Both halves run every time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const LOG_PATH = path.join(REPO, 'KNOWN-LIMITS.md');

const ENTRY_HEADING = /^## (\d+)\./gm;
/** The explicit citation form. `#` optional; digits must follow immediately. */
const CITATION = /KNOWN-LIMITS #?(\d+)/g;

const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', '.tmp']);
const SCAN_EXT = new Set(['.js', '.mjs', '.md', '.json']);

/** @returns {Set<number>} entry numbers that actually exist in the log */
function entriesThatExist() {
  const text = fs.readFileSync(LOG_PATH, 'utf8');
  return new Set([...text.matchAll(ENTRY_HEADING)].map(m => Number(m[1])));
}

/** @returns {string[]} every scannable file path in the tree */
function scannableFiles(dir = REPO, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (!SKIP_DIRS.has(item.name)) scannableFiles(path.join(dir, item.name), out);
    } else if (SCAN_EXT.has(path.extname(item.name))) {
      out.push(path.join(dir, item.name));
    }
  }
  return out;
}

/**
 * @param {string[]} files
 * @returns {{file: string, line: number, cited: number}[]} every citation found
 */
function citations(files) {
  const found = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      for (const m of text.matchAll(CITATION)) {
        found.push({ file: path.relative(REPO, file), line: i + 1, cited: Number(m[1]) });
      }
    });
  }
  return found;
}

/** The check itself, isolated so it can be run against synthetic input. */
function dangling(found, exist) {
  return found.filter(c => !exist.has(c.cited));
}

describe('KNOWN-LIMITS citations resolve (read-only, across the tree)', () => {
  it('every KNOWN-LIMITS <n> citation in the repository points at an entry that exists', () => {
    const exist = entriesThatExist();
    const found = citations(scannableFiles());
    const bad = dangling(found, exist);

    assert.deepStrictEqual(
      bad.map(c => `${c.file}:${c.line} cites ${c.cited}`),
      [],
      'A citation points at a KNOWN-LIMITS entry that does not exist. Either ' +
        'the number is wrong, or the entry it names was removed. Fix the ' +
        'citation only after checking which of the two happened: if the entry ' +
        'was removed, restoring it is the repair, because references outside ' +
        'this repository are already pointing at the number.'
    );
  });

  it('the scan reaches a plausible amount of the tree, so a broken walk cannot pass silently', () => {
    const found = citations(scannableFiles());
    // A floor, not a running total. Set well under the current count so it
    // does not need touching when a citation is added or removed.
    assert.ok(
      found.length >= 50,
      `Only ${found.length} citations found across the tree. The walk or the ` +
        'pattern is probably broken, which means the assertion above is ' +
        'passing over files it never read. Fix the scan, do not lower this floor.'
    );
  });

  it('the resolver reports a citation that does not resolve (fail-first proof)', () => {
    const exist = entriesThatExist();
    const highest = Math.max(...exist);
    // Built by concatenation: the scanner above must not read this as a real
    // citation when it walks this very file. See EDITOR TRAP in the header.
    const synthetic = [{ file: 'synthetic', line: 1, cited: highest + 1000 }];

    const bad = dangling(synthetic, exist);
    assert.strictEqual(
      bad.length,
      1,
      'The resolver did not flag a citation of an entry that plainly does not ' +
        'exist. The repository-wide assertion above is green for the wrong ' +
        'reason and is proving nothing.'
    );
  });
});
