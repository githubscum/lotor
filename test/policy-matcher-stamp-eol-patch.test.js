/**
 * test/policy-matcher-stamp-eol-patch.test.js
 *
 * STAGED, NOT YET LANDED. KNOWN-LIMITS 77 fix is core (src/policy), queued as
 * proposals/l77-matcherhash-eol.patch for the signing sitting. This file
 * proves the patch on a temp copy.
 *
 * The core half of that queued patch is staged as
 * proposals/l77-policy.part.diff (WO-L77-EOL-2); the test turn-arounds were
 * staged earlier as proposals/l77-matcherhash-eol.tests.part.diff. This
 * rehearsal applies the assembled patch to copies of src/policy under
 * os.tmpdir() -- git runs only there, on scratch space -- and imports the
 * copies, so the module itself does the hashing. Nothing under src/ is
 * written and no git command runs on this repo.
 *
 * The assembled patch must exist at proposals/l77-matcherhash-eol.patch
 * before tests 1, 2 and 3 can pass; until then they fail at the patch read.
 * Once the patch lands in the core tree, the LANDED probe below skips every
 * test here and test/policy-matcher-stamp-eol.test.js (turned around by the
 * queued patch) is the regression guard.
 *
 * Each skip is `return t.skip(...)`: t.skip() only marks the test, it does
 * not stop the function, so without the return a landed tree went on to
 * re-apply the patch and failed with "patch does not apply".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Line endings built structurally (WO-L77-EOL-2): no escape sequences, no
// regex literals anywhere in this file.
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = path.join(repoRoot, 'proposals', 'l77-matcherhash-eol.patch');
const POLICY_DIR = path.join(repoRoot, 'src', 'policy');
const INDEX_PATH = path.join(POLICY_DIR, 'index.js');

// READ ONLY peek at the live core, the same string the patch's hunk 1 adds.
const LANDED = fs.readFileSync(INDEX_PATH, 'utf8').includes(
  'KNOWN-LIMITS 77): the hashed inputs are folded'
);

function toLf(text) {
  return text.split(CRLF).join(LF);
}

function toCrlf(text) {
  return text.split(LF).join(CRLF);
}

/**
 * The stamp and schema the module computes when its files carry `eol` line
 * endings, with the queued patch applied if `patched`. The module is copied
 * (every .js in src/policy, LF-normalized first so the copy's starting shape
 * does not depend on this checkout) into a temp dir marked as an ESM package;
 * if patched, git applies the patch there, the copies are rewritten to the
 * requested shape, and the copy itself computes the stamp when imported. Same
 * idea as stampOfCopy in test/policy-matcher-stamp-eol.test.js.
 */
async function stampOf(eol, patched) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-eol-patch-'));
  try {
    // A bare .js under os.tmpdir() would import as CommonJS.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}' + LF);
    const dest = path.join(tmp, 'src', 'policy');
    fs.mkdirSync(dest, { recursive: true });
    const files = fs.readdirSync(POLICY_DIR).filter((name) => name.endsWith('.js'));
    assert.ok(files.includes('index.js'), 'src/policy/index.js not found to copy');
    for (const name of files) {
      const text = toLf(fs.readFileSync(path.join(POLICY_DIR, name), 'utf8'));
      fs.writeFileSync(path.join(dest, name), text);
    }
    if (patched) {
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'l77.patch'), toLf(fs.readFileSync(PATCH, 'utf8')));
      execFileSync(
        'git',
        ['apply', '--include=src/policy/index.js', 'l77.patch'],
        { cwd: tmp }
      );
    }
    if (eol === 'crlf') {
      for (const name of files) {
        const target = path.join(dest, name);
        fs.writeFileSync(target, toCrlf(fs.readFileSync(target, 'utf8')));
      }
    }
    const mod = await import(pathToFileURL(path.join(dest, 'index.js')).href);
    return { stamp: mod.matcherVersionHash(), schema: mod.MATCHER_SCHEMA };
  } finally {
    // Windows can hold a just-imported file for a moment; retry, then let go.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // scratch space; a leftover dir is not a test failure
    }
  }
}

describe('matcher/3 EOL patch rehearsal (staged; proves the queued patch)', () => {
  it("the patch applies to today's source", async (t) => {
    if (LANDED) return t.skip('patch landed; test/policy-matcher-stamp-eol.test.js is the guard now');
    const result = await stampOf('lf', true);
    assert.equal(result.schema, 'matcher/3');
    assert.equal(result.stamp.length, 16, 'not the expected 16-char digest shape');
  });

  it('patched: LF and CRLF copies stamp the same', async (t) => {
    if (LANDED) return t.skip('patch landed; test/policy-matcher-stamp-eol.test.js is the guard now');
    assert.notEqual(
      (await stampOf('lf', true)).stamp,
      '',
      'the LF patched copy produced no stamp; the CRLF comparison below would be vacuous'
    );
    assert.equal(
      (await stampOf('lf', true)).stamp,
      (await stampOf('crlf', true)).stamp,
      'after the patch, line endings still reach the stamp (KNOWN-LIMITS 77 unfolded)'
    );
  });

  it('patched: an LF checkout stamp does not move', async (t) => {
    if (LANDED) return t.skip('patch landed; test/policy-matcher-stamp-eol.test.js is the guard now');
    assert.equal(
      (await stampOf('lf', true)).stamp,
      (await stampOf('lf', false)).stamp,
      'patching moved the LF stamp: an LF-checkout receipt would be silently restamped'
    );
  });

  it('unpatched control: LF and CRLF differ today', async (t) => {
    if (LANDED) return t.skip('patch landed; test/policy-matcher-stamp-eol.test.js is the guard now');
    assert.notEqual(
      (await stampOf('lf', false)).stamp,
      (await stampOf('crlf', false)).stamp,
      'unpatched copies already agree, so tests 2 and 3 prove nothing (control failed)'
    );
  });
});