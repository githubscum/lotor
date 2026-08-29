/**
 * test/known-limits-commit-pinning.test.js
 *
 * KNOWN-LIMITS 29: this file documents `main`, but lives in the tree of
 * branches that change it. Nothing in the file said WHICH commit it describes,
 * so on any feature branch it was simultaneously accurate for mainline and
 * false for the checkout being read, and a reader could not tell. This already
 * caused a real error: on 2026-08-22 a bounty was published citing an entry
 * number that meant something different on the mainline.
 *
 * THE FIX: a managed pin block stating, in the file itself, the exact commit
 * of the code it describes (stamped at generation time), plus a reader-side
 * check that compares the pin against the running checkout and TELLS the
 * reader they are reading a description of somewhere else when they differ.
 *
 * FAIL-FIRST DISCIPLINE (2026-07-24 rule):
 *   - RED on unpatched main (2173d23): every test below fails because the
 *     module does not exist AND the file carries no statement of provenance.
 *     The absence IS the defect: the confusing state (a log with no declared
 *     commit) existed and was undetectable.
 *   - GREEN on the patch: all pass.
 *
 * Rule of this file (inherited from grant-core-paths.test.js): inputs that
 * matter are literal. Pin/head hashes below are fixed strings, so a checker
 * that derives one from the other would fail these tests rather than agree
 * with itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PIN_BEGIN,
  PIN_END,
  renderPinBlock,
  writePin,
  readPin,
  checkPin
} from '../src/limits/pin.js';

const SAMPLE_LOG = [
  '# Known Limits',
  '',
  'This document lists the v1 limitations of the receipt layer.',
  '',
  '## 1. Self-attested capture',
  '',
  'Body text.'
].join('\n');

// Literal fixtures. Not derived from process.cwd(), git, or each other.
const PINNED_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-l29-'));
  const file = path.join(dir, 'KNOWN-LIMITS.md');
  fs.writeFileSync(file, content);
  return file;
}

describe('L29: the log states which commit it describes', () => {
  it('an unpinned log reads as unpinned (the pre-fix state)', () => {
    const file = tmpFile(SAMPLE_LOG);
    const pin = readPin(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(pin, null, 'no pin block yet: readPin must say so, not guess');
    const status = checkPin({ pinText: fs.readFileSync(file, 'utf8'), head: PINNED_HASH }).status;
    assert.strictEqual(status, 'unpinned');
  });

  it('renderPinBlock names the exact commit, subject, and date', () => {
    const block = renderPinBlock({
      commit: PINNED_HASH,
      subject: 'opaque-exec: gate local scripts handed to a script interpreter (#28)',
      date: '2026-08-23'
    });
    assert.ok(block.includes(PINNED_HASH), 'block must carry the full commit hash');
    assert.ok(block.includes('2026-08-23'), 'block must carry the stamp date');
    assert.ok(block.startsWith(PIN_BEGIN) && block.trimEnd().endsWith(PIN_END),
      'block must be delimited so tooling can find and replace it');
  });

  it('writePin stamps the file once and re-stamps in place (never duplicates)', () => {
    const file = tmpFile(SAMPLE_LOG);
    writePin(file, { commit: PINNED_HASH, subject: 'first subject', date: '2026-08-23' });
    let text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text.split(PIN_BEGIN).length - 1, 1, 'exactly one pin block after first stamp');

    // Re-stamp with a newer pin: replaced in place, body untouched.
    writePin(file, { commit: OTHER_HASH, subject: 'second subject', date: '2026-08-24' });
    text = fs.readFileSync(file, 'utf8');
    assert.strictEqual(text.split(PIN_BEGIN).length - 1, 1, 're-stamping must not duplicate the block');
    assert.ok(!text.includes(PINNED_HASH), 'old pin fully replaced');
    assert.ok(readPin(text).commit === OTHER_HASH);
    assert.ok(text.includes('## 1. Self-attested capture'), 'log body must survive re-stamping');
    assert.ok(text.indexOf(PIN_BEGIN) < text.indexOf('# Known Limits'),
      'pin sits above the title so a reader meets it first');
  });

  it('a reader in a divergent checkout is TOLD they are reading elsewhere', () => {
    const pinned = renderPinBlock({
      commit: PINNED_HASH,
      subject: 'main',
      date: '2026-08-23'
    });
    const text = pinned + '\n\n' + SAMPLE_LOG;

    // Same commit: current.
    assert.strictEqual(
      checkPin({ pinText: text, head: PINNED_HASH }).status, 'current'
    );

    // Different commit: diverged, naming BOTH sides.
    const verdict = checkPin({ pinText: text, head: OTHER_HASH });
    assert.strictEqual(verdict.status, 'diverged');
    assert.strictEqual(verdict.pin.commit, PINNED_HASH);
    assert.strictEqual(verdict.head, OTHER_HASH);
    assert.ok(typeof verdict.message === 'string' && verdict.message.includes(OTHER_HASH),
      'the reader-facing message must name the checkout they are actually in');
    assert.ok(verdict.message.includes(PINNED_HASH),
      'and the commit the log actually describes');
  });

  it('an unknown or dirty HEAD reads as unknown, never silently current', () => {
    const text = renderPinBlock({ commit: PINNED_HASH, subject: 'main', date: '2026-08-23' });
    assert.strictEqual(checkPin({ pinText: text, head: null }).status, 'unknown');
    assert.strictEqual(checkPin({ pinText: text, head: '' }).status, 'unknown');
    assert.strictEqual(
      checkPin({ pinText: text, head: 'not-a-real-state' }).status, 'diverged',
      'a hash-like value that simply differs is divergence, not unknown'
    );
  });

  it('the REAL shipped log: stamping it reports current, never permanent divergence', () => {
    // Exercises the actual repo file (the gap the reviewer flagged: nothing in
    // the suite touched the real KNOWN-LIMITS.md). Stamping pins the last src/
    // commit; --check against the same checkout must be GREEN (exit 0), not the
    // permanent exit-1 the HEAD-based pin produced on its own submission.
    const repoLog = path.join(process.cwd(), 'KNOWN-LIMITS.md');
    const restore = fs.readFileSync(repoLog, 'utf8');

    try {
      // Re-stamp the real log (writes the current src-commit as the pin).
      execFileSync('node', ['bin/limits-pin.js', '--stamp'], { encoding: 'utf8' });

      // --check must exit 0 (current) on the same checkout.
      const out = execFileSync('node', ['bin/limits-pin.js', '--check'], { encoding: 'utf8' });
      // execFileSync throws on non-zero exit, so reaching here means exit 0.
      assert.ok(/matches your checkout/.test(out),
        'after stamping, --check must report current, not diverged: ' + out);
    } finally {
      fs.writeFileSync(repoLog, restore);
    }
  });

  it('the REAL shipped log: a stale/divered pin is caught by --check (exit 1)', () => {
    // Proves the suite now notices if the shipped log were unpinned, stale, or
    // diverged — the exact gap the reviewer named. We pin the real log to a
    // foreign hash and assert --check exits 1 with a divergence message.
    const repoLog = path.join(process.cwd(), 'KNOWN-LIMITS.md');
    const restore = fs.readFileSync(repoLog, 'utf8');

    try {
      // Force a stale pin onto the real log.
      writePin(repoLog, { commit: OTHER_HASH, subject: 'some other tree', date: '2026-08-23' });

      let exitCode = 0;
      let out = '';
      try {
        out = execFileSync('node', ['bin/limits-pin.js', '--check'], { encoding: 'utf8' });
      } catch (e) {
        exitCode = e.status ?? 1;
        out = e.stdout ?? '';
      }
      assert.strictEqual(exitCode, 1, '--check must exit 1 on a diverged real log');
      assert.ok(/reading a description of somewhere else/i.test(out),
        'diverged real log must name both commits: ' + out);
    } finally {
      fs.writeFileSync(repoLog, restore);
    }
  });
});
