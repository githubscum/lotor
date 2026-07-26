/**
 * test/selfmod-bin-coverage.test.js
 *
 * Every script in bin/ is self-mod, not just the ones someone remembered.
 *
 * THE INCIDENT
 *   2026-07-26. Writing a new file at `bin/charter.js` succeeded with NO
 *   SIGNATURE. `core-paths.js` treats all of `bin/` as core, but the self-mod
 *   matcher gated it by exact filename — approve, setup, mode, gate, view — plus
 *   a `hook-*` regex. Anything else in `bin/` was unprotected.
 *
 *   Four files shipped in the two days before that were editable unsigned:
 *   `tokens.js`, `inflight.js`, `retcon.js`, `export-chain.js`. An edit to
 *   `retcon.js` the night before had gone straight through, and nobody noticed
 *   it should not have.
 *
 * WHY IT WAS WORSE THAN FOUR FILES
 *   The file being created was `bin/charter.js`, which prints a charter for the
 *   owner to read **immediately before they type their passphrase**. Editable
 *   unsigned, an agent could change what the owner READS without changing what
 *   they SIGN — a valid signature over an enumeration they were shown a doctored
 *   version of. The signing ceremony compromised at its strongest point.
 *
 * WHY THE EXISTING DRIFT GUARD MISSED IT
 *   `selfmod-covers-core.test.js` iterates CORE_DIRS and, for `bin`, checks a
 *   hardcoded list of representative filenames. Every name on that list was
 *   already in the matcher, so the test passed. **It tested the names someone
 *   remembered against the names someone remembered.** The residual was even
 *   written down in that file's own comments and judged low-risk when bin/ held
 *   five stable files. It stopped being low-risk when bin/ started growing.
 *
 * WHAT THIS ASSERTS INSTEAD
 *   Not a list. Every file actually on disk in bin/, read at test time, so a
 *   file added tomorrow is covered by this test the day it appears rather than
 *   the day someone remembers to add it here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSelfMod } from '../src/policy/index.js';
import { resolveHome } from '../src/home.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, '..', 'bin');
const home = resolveHome();

const SCRIPTS = fs.readdirSync(BIN_DIR)
  .filter(n => /\.(js|mjs|cjs|ps1|sh)$/.test(n))
  .sort();

describe('self-mod covers every script actually present in bin/', () => {
  it('finds scripts to test, so the suite is not vacuously green', () => {
    assert.ok(SCRIPTS.length >= 5, `expected several scripts in bin/, found ${SCRIPTS.length}`);
  });

  for (const name of SCRIPTS) {
    it(`gates an Edit to bin/${name}`, () => {
      assert.strictEqual(isSelfMod('Edit', { file_path: `bin/${name}` }, home), true,
        `bin/${name} is core per core-paths but self-mod does not gate an Edit to it`);
    });

    it(`gates a Write creating bin/${name}`, () => {
      // The incident was a Write of a NEW file, not an Edit of an existing one.
      assert.strictEqual(isSelfMod('Write', { file_path: `bin/${name}` }, home), true,
        `creating bin/${name} is ungated`);
    });
  }

  it('gates a file that does not exist yet, which is the actual incident', () => {
    // bin/charter.js did not exist when it was written unsigned. A matcher that
    // only covers what is already on disk would not have stopped it.
    for (const invented of ['bin/charter.js', 'bin/anything-new.js', 'bin/future.mjs']) {
      assert.strictEqual(isSelfMod('Write', { file_path: invented }, home), true,
        `${invented} does not exist yet and must still be gated`);
    }
  });

  it('gates an absolute path into bin/, not just a relative one', () => {
    assert.strictEqual(
      isSelfMod('Edit', { file_path: 'C:/Users/someone/agent-receipts/bin/charter.js' }, home),
      true
    );
    assert.strictEqual(
      isSelfMod('Edit', { file_path: '/home/someone/agent-receipts/bin/charter.js' }, home),
      true
    );
  });
});

describe('the command path is closed too, which is the half that makes it real', () => {
  // Closing only the Edit path would have been the more dangerous half-fix: the
  // tool layer refusing while a shell redirect walks past, with the visible
  // refusal reading as coverage. Both shells, because gating on toolName ===
  // 'Bash' is exactly the defect that produced KNOWN-LIMITS 21 on a machine
  // where PowerShell is the primary shell.
  const WRITES = [
    ['Bash', 'echo x > bin/charter.js'],
    ['Bash', 'cat evil.js > bin/tokens.js'],
    ['Bash', 'cp /tmp/x bin/retcon.js'],
    ['PowerShell', 'Set-Content bin/charter.js -Value x'],
    ['PowerShell', 'Remove-Item bin/inflight.js'],
    ['PowerShell', 'Out-File -FilePath bin/export-chain.js']
  ];

  for (const [tool, cmd] of WRITES) {
    it(`gates ${tool}: ${cmd}`, () => {
      assert.strictEqual(isSelfMod(tool, { command: cmd }, home), true,
        `a shell write to a bin/ script must be gated: ${cmd}`);
    });
  }

  it('catches the Windows trailing-dot spelling', () => {
    // Windows strips a trailing dot from a path's last component, so this
    // resolves to the real file. KNOWN-LIMITS 22.
    assert.strictEqual(
      isSelfMod('PowerShell', { command: 'Remove-Item bin/charter.js.' }, home), true);
  });

  it('does not match a longer extension that merely starts with a known one', () => {
    // The terminator handling is a negative assertion (is the extension
    // followed by more filename?), not an enumeration of what ends a token.
    // That is the 2026-07-24 lesson: enumerating terminators leaked once per
    // round; the negative assertion closed the class.
    assert.strictEqual(isSelfMod('Bash', { command: 'cat bin/charter.jsx' }, home), false);
  });

  it('does not sweep in node_modules binaries from a command', () => {
    assert.strictEqual(
      isSelfMod('Bash', { command: 'node node_modules/.bin/mocha.js' }, home), false);
  });
});

describe('prove-fail-first: the pre-fix matcher genuinely missed these', () => {
  // The standing rule since 2026-07-24 is that a fix's test must be shown to
  // fail against the unfixed code, because a test that passes before and after
  // is worse than none — it manufactures confidence.
  //
  // Reverting the matcher to demonstrate that costs a signature on a core file,
  // which is a poor trade for a one-line proof. So the OLD pattern is pinned
  // here verbatim and asserted to miss. If someone claims this fix was
  // unnecessary, this is the evidence, and it stays true forever because the
  // string is frozen rather than imported.
  const PRE_FIX = /(\/|^)bin\/hook-[^/]+\.js$/;

  const MISSED = ['bin/tokens.js', 'bin/inflight.js', 'bin/retcon.js', 'bin/export-chain.js', 'bin/charter.js'];

  for (const p of MISSED) {
    it(`old pattern missed ${p}; new matcher catches it`, () => {
      assert.strictEqual(PRE_FIX.test(p), false, `the old pattern should NOT have matched ${p}`);
      assert.strictEqual(isSelfMod('Edit', { file_path: p }, home), true,
        `the new matcher must catch ${p}`);
    });
  }

  it('the old pattern did catch the hooks, which is why nobody noticed', () => {
    assert.strictEqual(PRE_FIX.test('bin/hook-pre-tool-use.js'), true);
    assert.strictEqual(isSelfMod('Edit', { file_path: 'bin/hook-pre-tool-use.js' }, home), true,
      'and the new matcher must not have lost that coverage');
  });
});

describe('the bin/ matcher does not sweep in things that merely end in bin', () => {
  // A bare 'bin/' substring would match all of these, which is why the matcher
  // uses a lookbehind refusing a preceding '.' or word character. Over-gating is
  // the cheap failure in this file, but sweeping in every node_modules binary
  // would make the gate fire constantly, and a gate that fires constantly
  // teaches the operator to stop reading (KNOWN-LIMITS 26).
  const NOT_OURS = [
    'node_modules/.bin/mocha.js',
    'some/path/sbin/tool.js',
    'vendor/libbin/thing.js'
  ];

  for (const p of NOT_OURS) {
    it(`does not gate ${p}`, () => {
      assert.strictEqual(isSelfMod('Edit', { file_path: p }, home), false,
        `${p} is not our bin/ and should not be gated by this rule`);
    });
  }

  it('does not gate a non-script file dropped in bin/', () => {
    // Extensions are enumerated rather than left open, so a data file in bin/
    // is not gated as code. Stated as a deliberate choice, not an oversight.
    assert.strictEqual(isSelfMod('Edit', { file_path: 'bin/notes.txt' }, home), false);
  });
});
