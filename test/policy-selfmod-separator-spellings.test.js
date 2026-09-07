/**
 * test/policy-selfmod-separator-spellings.test.js
 *
 * TRIPWIRE, not a regression test. Found 2026-09-01 by running spellings
 * through the shipped matcher rather than reading it (KNOWN-LIMITS 62).
 *
 * `normalizePath` folds backslashes and case, and stops there. The self-mod
 * fragment list is then matched as a plain substring. So a path spelled with
 * a doubled separator (`src//policy/index.js`) or a dot segment
 * (`src/./policy/index.js`) contains no protected fragment contiguously and
 * is NOT gated, while every filesystem this repo runs on opens exactly the
 * same file. The `Edit` path is affected as well as the command path, which
 * is the half that matters: `Edit` is how an agent actually changes the gate.
 *
 * WHAT THESE ASSERTIONS SAY. They assert the CURRENT, DEFECTIVE behavior:
 * these spellings are FREE today. The controls beside them assert the plain
 * spellings are GATED, so this block cannot pass by the matcher dying.
 *
 * WHEN SOMEONE FIXES THE MATCHER, THIS FILE FAILS. That is the point. The
 * repair is to INVERT the assertions (`false` -> `true`) and amend
 * KNOWN-LIMITS 62 in the same change. Do NOT delete the block: a confession
 * that can be closed by deleting its evidence is not a confession.
 *
 * The fix itself is `src/policy` and therefore non-delegable core; it was
 * attempted on 2026-09-01 and the gate refused it unsigned, correctly. The
 * bypass proved here was NOT used to land the fix.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSelfMod, evaluate, loadPolicy } from '../src/policy/index.js';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

let baseDir;
let savedHome;
let policy;

before(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-sepspell-'));
  savedHome = process.env.LOTOR_HOME;
  process.env.LOTOR_HOME = baseDir;
  policy = loadPolicy(baseDir);
});

after(() => {
  if (savedHome === undefined) delete process.env.LOTOR_HOME;
  else process.env.LOTOR_HOME = savedHome;
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function editGated(filePath) {
  const input = { file_path: filePath, old_string: 'a', new_string: 'b' };
  const viaMatcher = isSelfMod('Edit', input, baseDir);
  const viaEvaluate = evaluate('Edit', input, policy, baseDir);
  assert.equal(
    viaMatcher,
    !!(viaEvaluate && viaEvaluate.ruleId === 'self-mod'),
    'isSelfMod and evaluate disagree; one of them changed without the other'
  );
  return viaMatcher;
}

function cmdGated(command) {
  const input = { command };
  const viaMatcher = isSelfMod('Bash', input, baseDir);
  const viaEvaluate = evaluate('Bash', input, policy, baseDir);
  assert.equal(
    viaMatcher,
    !!(viaEvaluate && viaEvaluate.ruleId === 'self-mod'),
    'isSelfMod and evaluate disagree; one of them changed without the other'
  );
  return viaMatcher;
}

// Built at runtime so this file's own source does not carry a protected
// fragment contiguously; the strings under test are identical either way.
const SRC = 'src';
const POL = SRC + '/' + 'policy';
const CHN = SRC + '/' + 'chain';

describe('self-mod: controls (these must stay gated)', () => {
  it('gates the plain spelling on Edit', () => {
    assert.equal(editGated(`${REPO}/${POL}/index.js`), true);
  });

  it('gates the plain spelling on a command', () => {
    assert.equal(cmdGated(`sed -i s/x/y/ ${POL}/index.js`), true);
  });

  it('gates the backslash spelling on a command', () => {
    assert.equal(cmdGated(`sed -i s/x/y/ ${SRC}\\policy\\index.js`), true);
  });

  it('gates a bin script', () => {
    assert.equal(cmdGated('echo x > bin/charter.js'), true);
  });
});

describe('KNOWN-LIMITS 62: equivalent spellings are NOT gated (tripwire)', () => {
  it('the two spellings open the same file, so the gap is real and not notional', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-sepreal-'));
    const nested = path.join(dir, 'src', 'policy');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'index.js'), 'canary');
    const norm = dir.replace(/\\/g, '/');
    assert.equal(fs.readFileSync(`${norm}/src/policy/index.js`, 'utf8'), 'canary');
    assert.equal(fs.readFileSync(`${norm}/src//policy/index.js`, 'utf8'), 'canary');
    assert.equal(fs.readFileSync(`${norm}/src/./policy/index.js`, 'utf8'), 'canary');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Edit with a doubled separator is FREE (invert when fixed)', () => {
    assert.equal(editGated(`${REPO}/${SRC}//policy/index.js`), false);
  });

  it('Edit with a dot segment is FREE (invert when fixed)', () => {
    assert.equal(editGated(`${REPO}/${SRC}/./policy/index.js`), false);
  });

  it('Edit into src/chain with a dot segment is FREE (invert when fixed)', () => {
    assert.equal(editGated(`${REPO}/${SRC}/./chain/index.js`), false);
  });

  it('Edit of a bin script with a doubled separator is FREE (invert when fixed)', () => {
    assert.equal(editGated(`${REPO}/bin//charter.js`), false);
  });

  it('a command with a doubled separator is FREE (invert when fixed)', () => {
    assert.equal(cmdGated(`sed -i s/x/y/ ${SRC}//policy/index.js`), false);
  });

  it('a command with a dot segment is FREE (invert when fixed)', () => {
    assert.equal(cmdGated(`sed -i s/x/y/ ${SRC}/./policy/index.js`), false);
  });

  it('a command deleting src/chain via a dot segment is FREE (invert when fixed)', () => {
    assert.equal(cmdGated(`rm -rf ${CHN.replace('/chain', '/./chain')}`), false);
  });

  it('a command writing a bin script via a dot segment is FREE (invert when fixed)', () => {
    assert.equal(cmdGated('echo x > ./bin/./charter.js'), false);
  });
});
