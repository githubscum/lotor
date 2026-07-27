/**
 * test/bin-risk-classes.test.js
 *
 * EVIDENCE, NOT A BOUNDARY CHANGE.
 *
 * `bin/` is core wholesale and stays that way. This file records what was
 * learned while briefly attempting to grade it on 2026-07-26, so the next
 * person to reach for that idea starts from the findings instead of from
 * scratch. Nothing here exempts anything.
 *
 * WHAT PROMPTED IT
 *   Every self-mod denial printed one sentence: "this path can change the
 *   gate, its policy, its hooks, or the log." For `bin/retcon.js` that is
 *   false, and the operator noticed after signing it repeatedly in one
 *   evening. The fix taken was to make the DENIAL MESSAGE path-specific
 *   (`selfModWhy()` in bin/hook-pre-tool-use.js), which removes the false
 *   claim without weakening anything.
 *
 * WHY GRADING WAS ATTEMPTED AND REVERTED
 *   The attempt exempted `bin/retcon.js` from self-mod on the argument that a
 *   rewritten reporter is recoverable, because the chain is untouched and any
 *   other tool can re-read it, while a rewritten gate is not.
 *
 *   `test/selfmod-bin-coverage.test.js` refused it, and was right. That file
 *   names retcon.js specifically as one of four found editable-unsigned twelve
 *   hours earlier, and records that "an edit to retcon.js the night before had
 *   gone straight through, and nobody noticed it should not have." The
 *   recoverability argument is true but weak: you would have to KNOW to
 *   re-derive, and a doctored retcon that quietly drops a deviation row does
 *   not announce itself. The retcon is what the operator reads to judge
 *   whether work matched its charter, which is the same class of hazard as
 *   bin/charter.js printing an enumeration for signing.
 *
 *   Editing those three tests to match the change would have been rewording
 *   until it passed, which is the drift this project exists to catch.
 *
 * THE FINDING WORTH KEEPING, AND THE REASON THIS FILE SURVIVED THE REVERT
 *   The first design proved "read-only" by grepping a file for fs write APIs.
 *   That is UNSOUND and the counter-example is in this repo:
 *   `bin/hook-session-end.js` contains ZERO direct write calls and appends to
 *   the receipt chain, because it writes through src/store. A grep-based proof
 *   would have certified the file that writes the log as read-only.
 *
 *   Any future attempt at grading anything must therefore reason over the
 *   IMPORT CLOSURE, not the file. That checker is below, with the
 *   counter-example as a live assertion so it cannot rot silently.
 *
 *   Two more corrections from the same attempt, recorded so they are not
 *   rediscovered: `bin/tokens.js` DOES write (`--clear` deletes token files),
 *   and `bin/receipts.js` does not exist (`npm run receipts` renders through
 *   `bin/view.js`). The first draft's exemption list was wrong on two of three
 *   entries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { isSelfMod } from '../src/policy/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-binrisk-'));

const WRITE_API =
  /\b(writeFileSync|appendFileSync|createWriteStream|writeSync|unlinkSync|rmSync|rmdirSync|renameSync|mkdirSync|copyFileSync|truncateSync|execSync|spawnSync|execFileSync)\b/;

/** Resolve a repo-local import specifier to a file path, or null if external. */
function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Every repo-local module reachable from `entry`, including `entry`. */
function importClosure(entry) {
  const seen = new Set();
  const stack = [path.resolve(entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    const specs = [...src.matchAll(/(?:^|\n)\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/g)]
      .map(m => m[1]);
    for (const s of specs) {
      const r = resolveLocal(f, s);
      if (r) stack.push(r);
    }
  }
  return seen;
}

describe('bin/ stays core: the decision, asserted', () => {
  // Enumerated from DISK so a file added to bin/ tomorrow lands here without
  // anyone remembering. This is the property the bin/charter.js finding proved
  // is load-bearing, and it is why bin/ is covered as a directory.
  const binFiles = fs.readdirSync(path.join(REPO, 'bin'))
    .filter(f => /\.(js|mjs|cjs|ps1|sh)$/.test(f))
    .map(f => `bin/${f}`);

  it('finds the real bin/, so the enumeration is doing something', () => {
    assert.ok(binFiles.length >= 10, `expected the real bin/, saw ${binFiles.length}`);
  });

  for (const rel of binFiles) {
    it(`gates an Edit of ${rel}, with no exceptions`, () => {
      assert.strictEqual(isSelfMod('Edit', { file_path: rel }, home), true,
        `${rel} must gate. bin/ is core wholesale and the 2026-07-26 grading attempt was reverted.`);
    });
  }
});

describe('a local grep cannot prove read-only, and here is the proof', () => {
  it('hook-session-end has no DIRECT write call yet writes the chain', () => {
    const src = fs.readFileSync(path.join(REPO, 'bin/hook-session-end.js'), 'utf8');
    assert.strictEqual(WRITE_API.test(src), false,
      'no direct write call — which is exactly why a local grep is not a proof');

    const closure = [...importClosure(path.join(REPO, 'bin/hook-session-end.js'))];
    const writers = closure.filter(f => WRITE_API.test(fs.readFileSync(f, 'utf8')));
    assert.ok(writers.length > 0,
      'and the TRANSITIVE check does see that it writes, through src/store');
  });
});

describe('recorded evidence: bin/retcon.js is genuinely read-only', () => {
  // This is a FACT ABOUT THE FILE, not an argument that it should be exempt.
  // It is asserted so that if retcon.js ever gains a write path, that change
  // is surfaced deliberately rather than discovered during a later debate
  // about grading. Protection does not depend on this staying true.
  it('retcon.js and its whole import closure contain no write API', () => {
    const closure = [...importClosure(path.join(REPO, 'bin/retcon.js'))];
    const writers = closure
      .filter(f => WRITE_API.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(REPO, f).split(path.sep).join('/'));

    assert.deepEqual(writers, [],
      'retcon.js was read-only when this was written. If this fails, it gained a ' +
      `write path through: ${writers.join(', ')} — which is worth knowing on its own.`);
  });

  it('and it still gates anyway, which is the point', () => {
    assert.strictEqual(isSelfMod('Edit', { file_path: 'bin/retcon.js' }, home), true);
    assert.strictEqual(
      isSelfMod('Bash', { command: 'cp /tmp/x bin/retcon.js' }, home), true);
  });
});
