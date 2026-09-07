/**
 * KNOWN-LIMITS 65: the freshness pin binds the code, and never the log it lives in.
 *
 * These are CHARACTERIZATION tests. They assert the behaviour as it ships today,
 * which is the gap, so that the gap is visible in the suite instead of only in the
 * confession log. They are written to FAIL once the `body-sha256` repair lands,
 * which is deliberate: the failure is the prompt to rewrite them as the assertions
 * for the fixed behaviour. Each one names what it should say after the repair.
 *
 * The repair itself edits `src/limits/pin.js` and was refused by the self-mod gate,
 * so it queues for a signing sitting. This file does not need the gate: it only
 * reads the shipped functions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writePin, readPin, checkPin } from '../src/limits/pin.js';
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

describe('L65: the pin does not bind the log body', () => {
  it('a freshly stamped, unmodified log reads current', () => {
    assert.strictEqual(verdict(stampedLog()).status, 'current');
  });

  it('GAP: an entry APPENDED after stamping still reads current', () => {
    const file = stampedLog();
    fs.appendFileSync(file, '\n## 99. A limit never held against any code\n\nAppended after the stamp.\n');

    // After the repair this must be 'edited'.
    assert.strictEqual(
      verdict(file).status,
      'current',
      'characterization: the shipped pin cannot see an appended entry'
    );
  });

  it('GAP: an entry DELETED and a claim REVERSED still read current', () => {
    const file = stampedLog();
    const mangled = fs
      .readFileSync(file, 'utf8')
      .replace(/## 2\. Outbound message capture\n\nOutbound activity is captured by a hook\.\n/, '')
      .replace('Tamper-evidence begins at signing time.', 'Tamper-evidence is complete and covers capture.');
    fs.writeFileSync(file, mangled);

    const v = verdict(file);
    // After the repair this must be 'edited'.
    assert.strictEqual(v.status, 'current', 'characterization: deletion and reversal are both invisible');
    assert.ok(
      /matches your checkout/.test(v.message),
      'and the message actively reassures the reader, which is the sharp end of this limit'
    );
  });

  it('the pin records a commit and carries no digest of its own body', () => {
    const file = stampedLog();
    const pin = readPin(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(pin.commit, SRC_COMMIT);
    // After the repair: assert pin.bodySha256 is a 64-char hex string.
    assert.strictEqual(
      pin.bodySha256,
      undefined,
      'characterization: nothing in the pin block measures the text around it'
    );
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
