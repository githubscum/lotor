/**
 * test/selfmod-covers-core.test.js
 *
 * Drift guard. The self-mod rule (src/policy/index.js) and the non-delegable
 * core list (src/grant/core-paths.js) are two descriptions of the same idea:
 * source that decides what the gate permits, which must never change without a
 * human signature. They are maintained as separate lists, and on 2026-07-24
 * they had drifted: core-paths protected src/chain, src/store and src/grant;
 * self-mod did not, so the grant verifier and the hash chain could be rewritten
 * unsigned (KNOWN-LIMITS 21, finding 10).
 *
 * This test asserts that self-mod fires for a representative file in every
 * directory core-paths treats as core. If someone adds a core directory to one
 * list and forgets the other, this goes red. It reads the real CORE_DIRS
 * export rather than a hardcoded copy, so the copy cannot drift either.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isSelfMod } from '../src/policy/index.js';
import { CORE_DIRS, CORE_FILES } from '../src/grant/core-paths.js';
import { resolveHome } from '../src/home.js';

const home = resolveHome();

// The two lists live in different frames: core-paths anchors on the repo root
// and resolves paths, so it can treat the whole `bin/` as core without matching
// `/usr/bin`. self-mod matches path fragments and cannot resolve, so matching a
// bare `bin/` fragment would sweep in `/usr/bin/node` and `node_modules/.bin`.
// self-mod therefore gates `src/` core dirs by DIRECTORY and `bin` by the exact
// filenames of its core scripts. That is complete for the current bin/ (those
// five files are its entire contents), and a bin script only becomes dangerous
// once wired in via package.json or a hook registration, both of which are
// gated. RESIDUAL, stated honestly: a NEW file added under bin/ is non-delegable
// per core-paths but not gated by self-mod until its name is added to
// selfModFragmentsForBase. See KNOWN-LIMITS 21.
const BIN_CORE_FILES = ['approve.js', 'setup.js', 'mode.js', 'gate.js', 'view.js', 'hook-pre-tool-use.js'];

describe('self-mod covers every core-paths source directory', () => {
  for (const dir of CORE_DIRS) {
    if (dir === 'bin') {
      for (const f of BIN_CORE_FILES) {
        it(`gates writes to bin/${f} (by-name, see comment)`, () => {
          assert.strictEqual(isSelfMod('Edit', { file_path: `bin/${f}` }, home), true, `Edit bin/${f}`);
          assert.strictEqual(isSelfMod('PowerShell', { command: `Set-Content bin/${f} -Value x` }, home), true, `PS bin/${f}`);
        });
      }
      continue;
    }
    it(`gates an Edit inside ${dir}`, () => {
      const fp = `${dir}/some-file.js`;
      assert.strictEqual(isSelfMod('Edit', { file_path: fp }, home), true,
        `${fp} is core per core-paths but self-mod does not gate it`);
    });
    it(`gates a Bash write into ${dir}`, () => {
      const cmd = `echo x > ${dir}/some-file.js`;
      assert.strictEqual(isSelfMod('Bash', { command: cmd }, home), true,
        `a write into ${dir} is not gated by self-mod`);
    });
    it(`gates a PowerShell write into ${dir}`, () => {
      const cmd = `Set-Content ${dir}/some-file.js -Value x`;
      assert.strictEqual(isSelfMod('PowerShell', { command: cmd }, home), true,
        `a PowerShell write into ${dir} is not gated by self-mod`);
    });
  }
});

describe('self-mod covers every core-paths source file', () => {
  for (const file of CORE_FILES) {
    it(`gates an Edit of ${file}`, () => {
      assert.strictEqual(isSelfMod('Edit', { file_path: file }, home), true,
        `${file} is core per core-paths but self-mod does not gate it`);
    });
    it(`gates a write into ${file}`, () => {
      assert.strictEqual(isSelfMod('PowerShell', { command: `Set-Content ${file} -Value x` }, home), true,
        `a write into ${file} is not gated by self-mod`);
    });
  }
});

describe('self-mod does not sweep in look-alike paths', () => {
  // The fix added exact bin filenames rather than the whole bin/ directory, so
  // system binaries and dependency bins stay ungated. These must NOT match.
  for (const fp of [
    '/usr/bin/node',
    'node_modules/.bin/astro',
    'src/mcp/server.js',
    'src/views/index.js',
    'test/policy.test.js'
  ]) {
    it(`does not gate ${fp}`, () => {
      assert.strictEqual(isSelfMod('Edit', { file_path: fp }, home), false, fp);
      assert.strictEqual(isSelfMod('Bash', { command: `cat ${fp}` }, home) === true, false, `cat ${fp}`);
    });
  }
});
