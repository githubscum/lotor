/**
 * test/bin-grading.test.js
 *
 * Grades bin/ instead of treating it as one flat bucket.
 *
 * WHY THIS EXISTS
 *   `bin/` is core wholesale. That is right for the hooks, for approve/setup/
 *   mode/gate, and for charter.js (which prints the enumeration the owner reads
 *   immediately before typing their passphrase). It is wrong for a pure
 *   reporter: `bin/retcon.js` does readFileSync, existsSync, statSync and
 *   stdout.write, and has no write path of any kind. Editing it costs a HIGH
 *   signature whose stated reason — "this path can change the gate, its policy,
 *   its hooks, or the log" — is simply false for that file.
 *
 *   That is the corrosion limit 26 names. An operator who learns the risk line
 *   overstates will discount it everywhere, including where it is true.
 *
 *   core-paths.js already grades by exactly this principle and already applies
 *   it to `src/views/`: "Rendering. It can mislead a human reader, which is a
 *   real risk, but it cannot change what is permitted." The same reasoning has
 *   simply never been applied to bin/, which that file itself flags as
 *   over-inclusion.
 *
 * THE PROPERTY THAT MUST SURVIVE, AND DOES
 *   A file added to bin/ later must be protected the day it is created. That is
 *   not theoretical: it is the bin/charter.js finding, where a by-name list
 *   failed open on four new files. So this is NOT an allowlist of what gates.
 *   It is a tiny deny-list exception, and the first test below asserts that
 *   every OTHER file in bin/ still gates, enumerated from disk rather than from
 *   a list someone maintains.
 *
 * WHY THE OBVIOUS PROOF DOES NOT WORK, RECORDED BECAUSE IT WAS NEARLY SHIPPED
 *   The first design proved "read-only" by grepping the file for fs write APIs.
 *   That is unsound, and the counter-example is in this repo:
 *   `bin/hook-session-end.js` contains ZERO direct write calls and appends to
 *   the receipt chain, because it writes through src/store. A grep-based proof
 *   would have certified the file that writes the log as read-only.
 *
 *   So the check here is TRANSITIVE: an exempt file is read-only only if it,
 *   and every repo-local module it imports, transitively, contain no write API.
 *   Still static, and stated as such: it cannot see a dynamic import or a
 *   computed property access. It is a floor, not a proof.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { isSelfMod } from '../src/policy/index.js';
import * as corePaths from '../src/grant/core-paths.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-grading-'));

/**
 * The exemption, stated here so the test is readable on its own, and asserted
 * below to equal what core-paths actually exports. Two lists that must agree
 * are how the bin/charter.js gap happened, so they are compared, not trusted.
 *
 * ONE ENTRY on purpose. Not a "reporters" category. `bin/inflight.js` is
 * probably also pure, and `bin/view.js` is named in core-paths as core only by
 * over-inclusion, but each deserves its own argument rather than riding in on a
 * plural noun. Minimum blast radius.
 */
const EXPECTED_EXEMPT = ['bin/retcon.js'];

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

describe('bin/ grading: the exemption is what core-paths says it is', () => {
  it('exports BIN_REPORTERS and it matches this test\'s expectation', () => {
    assert.ok(Array.isArray(corePaths.BIN_REPORTERS),
      'core-paths must export BIN_REPORTERS so policy and grant share ONE list');
    assert.deepEqual([...corePaths.BIN_REPORTERS].sort(), [...EXPECTED_EXEMPT].sort());
  });

  it('every exempt file actually exists', () => {
    for (const rel of EXPECTED_EXEMPT) {
      assert.ok(fs.existsSync(path.join(REPO, rel)), `${rel} is exempt but missing`);
    }
  });
});

describe('bin/ grading: default-deny survives', () => {
  // Enumerated from DISK, not from a list. A new file in bin/ lands here
  // automatically and must gate, which is the property the bin/charter.js
  // finding proved is load-bearing.
  const binFiles = fs.readdirSync(path.join(REPO, 'bin'))
    .filter(f => /\.(js|mjs|cjs|ps1|sh)$/.test(f))
    .map(f => `bin/${f}`);

  it('finds a realistic number of bin scripts (the enumeration is working)', () => {
    assert.ok(binFiles.length >= 10, `expected the real bin/, saw ${binFiles.length}`);
  });

  for (const rel of binFiles) {
    const exempt = EXPECTED_EXEMPT.includes(rel);
    it(`${exempt ? 'does NOT gate' : 'gates'} an Edit of ${rel}`, () => {
      assert.strictEqual(
        isSelfMod('Edit', { file_path: rel }, home), !exempt,
        exempt
          ? `${rel} is an exempt reporter and must not cost a signature`
          : `${rel} must still gate; default-deny in bin/ is load-bearing`
      );
    });
  }
});

describe('bin/ grading: the exemption is earned, transitively', () => {
  // THE COUNTER-EXAMPLE THAT MAKES THIS TEST TRANSITIVE RATHER THAN LOCAL.
  // If this ever goes green, the check has stopped being able to see through
  // an import and the whole exemption is unsafe.
  it('a local-only grep would wrongly certify hook-session-end as read-only', () => {
    const src = fs.readFileSync(path.join(REPO, 'bin/hook-session-end.js'), 'utf8');
    assert.strictEqual(WRITE_API.test(src), false,
      'hook-session-end has no DIRECT write call, which is exactly why a local grep is not a proof');

    const closure = [...importClosure(path.join(REPO, 'bin/hook-session-end.js'))];
    const writers = closure.filter(f => WRITE_API.test(fs.readFileSync(f, 'utf8')));
    assert.ok(writers.length > 0,
      'and the transitive check DOES see that it writes, through src/store');
  });

  for (const rel of EXPECTED_EXEMPT) {
    it(`${rel} and everything it imports are free of write APIs`, () => {
      const closure = [...importClosure(path.join(REPO, rel))];
      const writers = closure
        .filter(f => WRITE_API.test(fs.readFileSync(f, 'utf8')))
        .map(f => path.relative(REPO, f).split(path.sep).join('/'));

      assert.deepEqual(writers, [],
        `${rel} is exempt from the core only while it cannot write. ` +
        `These modules in its import closure can: ${writers.join(', ')}`);
    });
  }
});
