/**
 * test/known-limits-pin-live.test.js
 *
 * KNOWN-LIMITS 29's own residual: `bin/limits-pin.js --check` exists but is
 * wired into nothing. `known-limits-commit-pinning.test.js` proves the
 * mechanism works, but both of its "REAL shipped log" cases first mutate the
 * file (stamp it, or force a foreign hash onto it) before checking — so the
 * committed pin, as it actually ships to a reader who never runs the CLI by
 * hand, has never been asserted by `npm test`. This file closes that gap: it
 * reads KNOWN-LIMITS.md exactly as committed, computes the real last commit
 * that touched src/ at HEAD, and asserts they agree. No stamping. No mutation.
 *
 * THIS TEST IS EXPECTED TO FAIL ON AN UNRESTAMPED TREE, AND THAT IS THE
 * FINDING, NOT A BUG IN THE TEST. As of this file landing, the committed pin
 * names 2173d231 (2026-08-23); the real last src/ commit is several merges
 * ahead. Six prior runs on this lane (5, 6, 8, 9, 10, 13) found and re-found
 * this divergence and each declined to `--stamp` unilaterally, because a
 * stamp is a claim that the log's entries were verified against the tree it
 * names, and reading 60+ entries against a moving tree is not something a
 * lane run should assert on its own. This test makes that refusal visible in
 * `npm test` output instead of requiring a reader to know to run the CLI by
 * hand — which is exactly the gap KNOWN-LIMITS 29 exists to close, one level
 * up from itself.
 *
 * When someone (Isaac, or a reviewer with the time to read the log against
 * the tree) runs `npm run limits-pin -- --stamp` after that read, this test
 * goes green and STAYS green until the next unstamped src/ change — which is
 * the actual regression guard rule 13's notes asked for. It was never a test
 * that needed writing so much as a test that needed to stop being silent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkPin } from '../src/limits/pin.js';

const REPO = process.cwd();
const LOG = path.join(REPO, 'KNOWN-LIMITS.md');

function lastSrcCommit() {
  try {
    const hash = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], {
      cwd: REPO,
      encoding: 'utf8'
    }).trim();
    return hash || null;
  } catch {
    return null;
  }
}

describe('L29: the committed pin, read as it ships, not as this suite stamps it', () => {
  it('KNOWN-LIMITS.md exists and carries a pin block', () => {
    assert.ok(fs.existsSync(LOG), 'KNOWN-LIMITS.md must exist at repo root');
    const text = fs.readFileSync(LOG, 'utf8');
    assert.ok(text.includes('known-limits:pin'), 'the shipped file must carry a pin block — an unpinned log is limit 29\'s pre-fix state');
  });

  it('the committed pin names the real current src/ commit (fails when the log is stale, on purpose)', () => {
    const text = fs.readFileSync(LOG, 'utf8');
    const head = lastSrcCommit();
    assert.ok(head, 'could not resolve the last src/ commit from git — run inside the repo with history');

    const verdict = checkPin({ pinText: text, head, dirty: false });

    assert.strictEqual(
      verdict.status,
      'current',
      `KNOWN-LIMITS.md's committed pin is ${verdict.status}, not current.\n` +
      `  pin names:  ${verdict.pin ? verdict.pin.commit : '(none)'}\n` +
      `  real HEAD:  ${head}\n` +
      'This is a live divergence, not a test bug. Fix: after reading the log\'s ' +
      'entries against this tree, run: npm run limits-pin -- --stamp'
    );
  });
});
