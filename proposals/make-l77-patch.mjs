// WO-L77-EOL-3: generate proposals/l77-matcherhash-eol.patch from a script,
// not from a hand-written diff. Reads src/policy/index.js (READ ONLY), applies
// three replacements, builds the diff in a temp dir, concatenates the tests
// part diff, writes the patch. Run from the repo root: node proposals/make-l77-patch.mjs
//
// Source hygiene (per the work order's HARD RULE): this file has no backslash
// and no less-than character anywhere. Newline is built with
// String.fromCharCode, comparisons avoid the less-than sign, and there are no
// regex literals and no newline-bearing template literals.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const ROOT = process.cwd();
const POLICY_ABS = path.join(ROOT, 'src', 'policy', 'index.js');
const TESTS_PART_ABS = path.join(ROOT, 'proposals', 'l77-matcherhash-eol.tests.part.diff');
const PATCH_OUT_ABS = path.join(ROOT, 'proposals', 'l77-matcherhash-eol.patch');

// Replacement A: the matcher/3 KNOWN-LIMITS comment inside the module header.
const OLD_A = [
  ' * points only, and stay honest about what they meant.',
  ' */',
].join(LF);
const NEW_A = [
  ' * points only, and stay honest about what they meant.',
  ' *',
  ' * matcher/3 (2026-10-25, KNOWN-LIMITS 77): the hashed inputs are folded',
  ' * CRLF to LF before hashing. LF-checkout stamps are unchanged; CRLF-checkout',
  ' * stamps move onto the LF value. A matcher/2 stamp from a CRLF checkout has',
  ' * no matcher/3 equal for the same commit.',
  ' */',
].join(LF);

// Replacement B: bump the declared schema stamp.
const OLD_B = "export const MATCHER_SCHEMA = 'matcher/2';";
const NEW_B = "export const MATCHER_SCHEMA = 'matcher/3';";

// Replacement C: fold CRLF to LF before caching the hashed inputs.
const OLD_C = "  cachedMatcherInputs = parts.join(' ');";
const NEW_C = [
  '  // A CRLF checkout (core.autocrlf=true) hands toString() CR bytes an LF',
  '  // checkout of the same commit does not have, so the stamp moved with the',
  '  // checkout and not the rules (KNOWN-LIMITS 77). Fold CRLF to LF here, in the',
  "  // one function that is not itself hashed, so an LF checkout's stamp is",
  '  // byte-identical before and after this change and only CRLF stamps move.',
  '  const CRLF = String.fromCharCode(13, 10);',
  '  const LF = String.fromCharCode(10);',
  "  cachedMatcherInputs = parts.join(' ').split(CRLF).join(LF);",
].join(LF);

function replaceOnce(currentText, label, oldStr, newStr) {
  const count = currentText.split(oldStr).length - 1;
  if (count !== 1) {
    console.log('assert failed: replacement ' + label + ': the old string occurs ' + count + ' times, expected exactly 1');
    process.exit(2);
  }
  return currentText.split(oldStr).join(newStr);
}

function trimEndNewlines(s) {
  let t = s;
  while (t.endsWith(LF) === true || t.endsWith(String.fromCharCode(13)) === true) {
    t = t.slice(0, t.length - 1);
  }
  return t;
}

let tmpRoot = null;
try {
  const original = fs.readFileSync(POLICY_ABS, 'utf8').split(CRLF).join(LF);

  let replaced = replaceOnce(original, 'A (module header comment)', OLD_A, NEW_A);
  replaced = replaceOnce(replaced, 'B (MATCHER_SCHEMA stamp)', OLD_B, NEW_B);
  replaced = replaceOnce(replaced, 'C (cachedMatcherInputs fold)', OLD_C, NEW_C);

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l77-patch-'));
  const oldDir = path.join(tmpRoot, 'old', 'src', 'policy');
  const newDir = path.join(tmpRoot, 'new', 'src', 'policy');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'index.js'), original);
  fs.writeFileSync(path.join(newDir, 'index.js'), replaced);

  const diffResult = spawnSync(
    'git',
    [
      '-c', 'core.autocrlf=false',
      'diff', '--no-index', '--no-color',
      'old/src/policy/index.js', 'new/src/policy/index.js',
    ],
    { cwd: tmpRoot, encoding: 'utf8' }
  );
  if (diffResult.status !== 1) {
    console.log('git diff exited with status ' + diffResult.status + ', expected 1 (differences found)');
    if (diffResult.error !== null && diffResult.error !== undefined) {
      console.log(String(diffResult.error));
    }
    if (diffResult.stderr !== null && diffResult.stderr !== undefined && diffResult.stderr.length !== 0) {
      console.log(diffResult.stderr);
    }
    process.exit(3);
  }

  let policyDiff = diffResult.stdout;
  policyDiff = policyDiff.split('a/old/src/policy/index.js').join('a/src/policy/index.js');
  policyDiff = policyDiff.split('b/new/src/policy/index.js').join('b/src/policy/index.js');
  policyDiff = policyDiff.split(LF).filter(function (line) {
    return line.startsWith('index ') === false;
  }).join(LF);

  const testsPart = fs.readFileSync(TESTS_PART_ABS, 'utf8').split(CRLF).join(LF);

  const patchText = trimEndNewlines(policyDiff) + LF + trimEndNewlines(testsPart) + LF;
  fs.writeFileSync(PATCH_OUT_ABS, patchText);

  const stats = fs.statSync(PATCH_OUT_ABS);
  console.log('wrote proposals/l77-matcherhash-eol.patch, byte length ' + stats.size);
} finally {
  if (tmpRoot !== null) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}