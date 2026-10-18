/**
 * test/known-limits-committed-pin.test.js
 *
 * KNOWN-LIMITS 29, the leak that stayed open after the 2026-08-23 fix and the
 * 2026-09-07 digest half (limit 65): THE SUITE NEVER READS THE COMMITTED PIN
 * AS SHIPPED. The pin/digest machinery exists, `bin/limits-pin.js --check`
 * reports `edited` or `diverged` and exits 1, but every suite test either
 * works on a tmp fixture or STAMPS THE REAL LOG FIRST and only then checks
 * it (test/known-limits-commit-pinning.test.js, "the REAL shipped log" cases).
 * A committed pin that is stale or whose digest does not match the shipped
 * body is therefore invisible to the suite: main can ship a log its own tool
 * rejects, green throughout.
 *
 * That state is live as this test is written: on a pristine clone of main at
 * 1720aa1 ("limits pin re-stamped after the 2026-09-07 signing sitting"),
 * `npm run limits-pin -- --check` prints the `edited` warning and exits 1 -
 * the shipped pin's body-sha256 (b90d7acf...) does not match the shipped body
 * (6f68e728...) - while `npm test` passes 1044/1047 with the three failures
 * being unrelated Windows-spelling cases. The confusing state entry 29 exists
 * to kill, recurring for the second documented time (first: the 2026-09-01
 * update inside entry 29 itself).
 *
 * FAIL-FIRST DISCIPLINE (2026-07-24 rule):
 *   - RED on unpatched main @1720aa1: the first test fails with
 *     `status: edited` and the second fails because --check exits 1.
 *   - GREEN after the repair commit, which re-stamps the log so the shipped
 *     pin tells the truth, and adds this tripwire so the next stale pin fails
 *     the suite instead of shipping silently.
 *
 * What this test does NOT prove (declared, not hidden): it runs only when the
 * suite runs - it is a tripwire, not CI. It reads git state, so it needs a
 * real worktree. And a re-stamp still asserts verification nobody performed;
 * the pin stays self-reported text, as entry 29's own residual says.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkPin } from '../src/limits/pin.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(REPO, 'KNOWN-LIMITS.md');

/** Same resolution bin/limits-pin.js performs: the last commit that touched src/. */
function resolveLastSrcCommit() {
  try {
    const hash = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], {
      cwd: REPO, encoding: 'utf8'
    }).trim();
    return hash || null;
  } catch {
    return null;
  }
}

describe('L29 tripwire: the COMMITTED pin is read as shipped, never stamped first', () => {
  it('the shipped KNOWN-LIMITS.md reads current on its own checkout', () => {
    const text = fs.readFileSync(LOG, 'utf8');
    const verdict = checkPin({ pinText: text, head: resolveLastSrcCommit(), dirty: false });
    assert.strictEqual(
      verdict.status,
      'current',
      `the shipped log must verify as shipped; got status "${verdict.status}". ` +
      `Reader-facing message: ${verdict.message}`
    );
  });

  it('bin/limits-pin.js --check exits 0 against the shipped log', () => {
    let exitCode = 0;
    let out = '';
    try {
      out = execFileSync('node', ['bin/limits-pin.js', '--check'], { cwd: REPO, encoding: 'utf8' });
    } catch (e) {
      exitCode = e.status ?? 1;
      out = (e.stdout ?? '') + (e.stderr ?? '');
    }
    assert.strictEqual(
      exitCode,
      0,
      `--check on the shipped log must exit 0; got ${exitCode} with: ${out}`
    );
  });
});
