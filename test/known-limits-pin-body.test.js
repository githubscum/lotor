/**
 * KNOWN-LIMITS 65: the freshness pin binds the code, and never the log it lives in.
 *
 * CLOSED 2026-09-07 at the signing sitting. These were CHARACTERIZATION tests
 * asserting the gap (a log-only edit read `current`). `writePin` now records a
 * `body-sha256` over the file with the pin block removed, and `checkPin` reports
 * a third status, `edited`, when the commit matches and the digest does not.
 * A v1 pin with no digest keeps v1 semantics exactly (see the L29 suite), so
 * old pins are not retroactively failed; re-stamping upgrades them.
 *
 * Each assertion below is the inverted characterization, as its own comment
 * said it should read after the repair.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writePin, readPin, checkPin } from '../src/limits/pin.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC_COMMIT = '2173d2316c1923998d473e2c8351543bce9c1c47';

const BODY = `# Known Limits

## 1. Self-attested capture

Tamper-evidence begins at signing time.

## 2. Outbound message capture

Outbound activity is captured by a hook.
`;

/** Stamp a temp log against SRC_COMMIT and return its path. */
function stampedLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l65-'));
  const file = path.join(dir, 'KNOWN-LIMITS.md');
  fs.writeFileSync(file, BODY);
  writePin(file, { commit: SRC_COMMIT, subject: 'opaque-exec: gate local scripts', date: '2026-08-23' });
  return file;
}

/**
 * The reader's verdict. `head` is the last commit touching src/, which is what
 * bin/limits-pin.js resolves and passes -- NOT HEAD. A log-only commit leaves it
 * unmoved, which is the whole point of these tests.
 */
const verdict = (file) =>
  checkPin({ pinText: fs.readFileSync(file, 'utf8'), head: SRC_COMMIT, dirty: false });

describe('L65: the pin binds the log body (closed 2026-09-07)', () => {
  it('a freshly stamped, unmodified log reads current', () => {
    assert.strictEqual(verdict(stampedLog()).status, 'current');
  });

  it('re-stamping the same body is stable: the digest excludes the pin block itself', () => {
    const file = stampedLog();
    const first = readPin(fs.readFileSync(file, 'utf8')).bodySha256;
    writePin(file, { commit: SRC_COMMIT, subject: 'a different subject line', date: '2026-09-07' });
    const second = readPin(fs.readFileSync(file, 'utf8')).bodySha256;
    assert.strictEqual(first, second, 'the pin must not invalidate itself (limit 29 self-invalidation)');
    assert.strictEqual(verdict(file).status, 'current');
  });

  it('an entry APPENDED after stamping reads edited, exit-1 class', () => {
    const file = stampedLog();
    fs.appendFileSync(file, '\n## 99. A limit never held against any code\n\nAppended after the stamp.\n');

    const v = verdict(file);
    assert.strictEqual(v.status, 'edited', 'the pin must see an appended entry');
    assert.ok(/edited since it was stamped/.test(v.message), 'and say so: ' + v.message);
  });

  it('an entry DELETED and a claim REVERSED read edited, and the message does not reassure', () => {
    const file = stampedLog();
    const mangled = fs
      .readFileSync(file, 'utf8')
      .replace(/## 2\. Outbound message capture\n\nOutbound activity is captured by a hook\.\n/, '')
      .replace('Tamper-evidence begins at signing time.', 'Tamper-evidence is complete and covers capture.');
    fs.writeFileSync(file, mangled);

    const v = verdict(file);
    assert.strictEqual(v.status, 'edited', 'deletion and reversal must both be visible');
    assert.ok(
      !/matches your checkout/.test(v.message),
      'the message must not reassure the reader about a log that moved'
    );
  });

  it('the pin records a commit AND a sha256 of its own body', () => {
    const file = stampedLog();
    const text = fs.readFileSync(file, 'utf8');
    const pin = readPin(text);
    assert.strictEqual(pin.commit, SRC_COMMIT);
    assert.match(pin.bodySha256, /^[0-9a-f]{64}$/, 'the pin block measures the text around it');
    // The digest is over the file with the pin block removed, so a reader can
    // recompute it from the bytes they hold.
    const stripped = text.replace(/<!-- known-limits:pin v1[\s\S]*?known-limits:pin end -->\n*/, '');
    const recomputed = crypto.createHash('sha256').update(stripped, 'utf8').digest('hex');
    assert.strictEqual(pin.bodySha256, recomputed);
  });

  it('a v1 pin with no digest keeps v1 semantics: current, never edited', () => {
    const file = stampedLog();
    const text = fs.readFileSync(file, 'utf8').replace(/^ body-sha256: [0-9a-f]{64}\n/m, '');
    assert.ok(!/body-sha256/.test(text), 'precondition: digest line removed');
    fs.writeFileSync(file, text + '\n## 99. Appended to a v1-pinned log\n');
    assert.strictEqual(verdict(file).status, 'current', 'old pins are not retroactively failed');
  });

  it('CONTROL: a moved src/ commit is still correctly reported as diverged', () => {
    const file = stampedLog();
    const v = checkPin({
      pinText: fs.readFileSync(file, 'utf8'),
      head: '9b8b86216ee0d3c8a99487a8f9a5b610cfbc9fba',
      dirty: false
    });
    assert.strictEqual(v.status, 'diverged', 'the code half of the pin works and must keep working');
  });
});
