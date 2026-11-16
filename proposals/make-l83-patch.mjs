// WO-L83-01: generate proposals/l83-backslash-fold.patch from a script, not
// from a hand-written diff. The KNOWN-LIMITS 83 fix is core, so it is queued
// for the signing sitting. This generator reads the two core sources READ
// ONLY, applies one replacement per file (each asserted to occur exactly
// once, else exit 2), builds each file diff with git -c core.autocrlf=false
// diff --no-index in a temp dir, rewrites the a/ b/ headers to the real repo
// paths, drops the index lines, concatenates, and writes the patch. Run from
// the repo root: node proposals/make-l83-patch.mjs
//
// Source hygiene (as in make-l77): this file has no backslash character and
// no less-than character anywhere. The backslash the patch folds is spelled
// String.fromCharCode(92) in the emitted code; range checks avoid the
// less-than sign; there are no regex literals and no newline-bearing
// template literals.
//
// Line endings: each source is read LF-normalized (CRLF folded to LF) and
// every inserted line is joined with LF, so the patch is LF-only from end to
// end whatever line endings the checkout happens to carry. This is the l81
// approach, whose rehearsal passed on this same CRLF checkout: the queued
// patch has one shape (LF, which .gitattributes already forces for
// proposals/*.patch) instead of one shape per checkout. The old and the new
// temp file are written LF-only too, so the diff git builds carries no CR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

const ROOT = process.cwd();
const CORE_PATHS_ABS = path.join(ROOT, 'src', 'grant', 'core-paths.js');
const POLICY_ABS = path.join(ROOT, 'src', 'policy', 'index.js');
const PATCH_OUT_ABS = path.join(ROOT, 'proposals', 'l83-backslash-fold.patch');

// Replacement A1 (core-paths.js): the KNOWN-LIMITS 83 fold and the drive
// letter refusal go in above the resolve bookkeeping, before the try block.
// The final resolve call inside the try is replaced separately (A2) so the
// refusal return still runs first.
const OLD_A1 = '  let resolved;';
const NEW_A1_LINES = [
  '  // KNOWN-LIMITS 83: path.resolve treats a backslash as a separator',
  '  // only on win32, so the Windows spellings classify differently on',
  '  // non-Windows hosts. Fold backslash to forward slash before',
  '  // classification on every platform.',
  '  const BS = String.fromCharCode(92);',
  "  const slashed = inputPath.split(BS).join('/');",
  "  if (process.platform !== 'win32') {",
  '    const c0 = slashed.charCodeAt(0);',
  '    const c1 = slashed.charCodeAt(1);',
  '    const c2 = slashed.charCodeAt(2);',
  '    const driveStart = (c0 >= 65 && 90 >= c0) || (c0 >= 97 && 122 >= c0);',
  '    if (driveStart && c1 === 58 && c2 === 47) {',
  '      return {',
  "        verdict: 'refused',",
  "        reason: 'drive-letter absolute path on a non-Windows host',",
  '        relative: null',
  '      };',
  '    }',
  '  }',
  '  let resolved;'
];

// Replacement A2 (core-paths.js): classify the folded spelling.
const OLD_A2 = '    resolved = path.resolve(root, inputPath);';
const NEW_A2 = '    resolved = path.resolve(root, slashed);';

// Replacement B (policy/index.js): the opaque extensionless file check
// resolves explicit local paths the same way; fold there too.
const OLD_B = '    const resolved = fs.realpathSync(path.resolve(cwd, candidate));';
const NEW_B_LINES = [
  '    // KNOWN-LIMITS 83: path.resolve treats a backslash as a separator',
  '    // only on win32; fold backslash to forward slash so an explicit',
  '    // local path resolves to the same file on every host.',
  "    const resolved = fs.realpathSync(path.resolve(cwd, candidate.split(String.fromCharCode(92)).join('/')));"
];

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
  // Read LF-normalized: the patch is LF-only end to end, so the separator
  // this checkout happens to carry is never detected, never preserved, and
  // never reaches the diff.
  const coreRaw = fs.readFileSync(CORE_PATHS_ABS, 'utf8').split(CRLF).join(LF);
  let coreNew = replaceOnce(coreRaw, 'A1 (fold and drive-letter refusal above let resolved)', OLD_A1, NEW_A1_LINES.join(LF));
  coreNew = replaceOnce(coreNew, 'A2 (resolve on the slashed path)', OLD_A2, NEW_A2);

  const policyRaw = fs.readFileSync(POLICY_ABS, 'utf8').split(CRLF).join(LF);
  const policyNew = replaceOnce(policyRaw, 'B (realpath on the folded spelling)', OLD_B, NEW_B_LINES.join(LF));

  const UNITS = [
    { rel: 'src/grant/core-paths.js', oldText: coreRaw, newText: coreNew },
    { rel: 'src/policy/index.js', oldText: policyRaw, newText: policyNew }
  ];

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l83-patch-'));
  const diffParts = [];
  UNITS.forEach((unit) => {
    ['old', 'new'].forEach((side) => {
      const sideDir = path.join(tmpRoot, side, path.dirname(unit.rel));
      fs.mkdirSync(sideDir, { recursive: true });
      const text = side === 'old' ? unit.oldText : unit.newText;
      // Both sides are LF-only: the sources were read LF-normalized and every
      // inserted line was joined with LF, so no CR reaches either temp file.
      fs.writeFileSync(path.join(tmpRoot, side, unit.rel), text);
    });
    const diffResult = spawnSync(
      'git',
      [
        '-c', 'core.autocrlf=false',
        'diff', '--no-index', '--no-color',
        ['old'].concat(unit.rel.split('/')).join('/'),
        ['new'].concat(unit.rel.split('/')).join('/')
      ],
      { cwd: tmpRoot, encoding: 'utf8' }
    );
    if (diffResult.status !== 1) {
      console.log('git diff exited with status ' + diffResult.status + ' for ' + unit.rel + ', expected 1 (differences found)');
      if (diffResult.error !== null && diffResult.error !== undefined) {
        console.log(String(diffResult.error));
      }
      if (diffResult.stderr !== null && diffResult.stderr !== undefined && diffResult.stderr.length !== 0) {
        console.log(diffResult.stderr);
      }
      process.exit(3);
    }
    let diffText = diffResult.stdout;
    diffText = diffText.split('a/old/' + unit.rel).join('a/' + unit.rel);
    diffText = diffText.split('b/new/' + unit.rel).join('b/' + unit.rel);
    diffText = diffText.split(LF).filter((line) => {
      return line.indexOf('index ') !== 0;
    }).join(LF);
    diffParts.push(trimEndNewlines(diffText));
  });

  const patchText = diffParts[0] + LF + diffParts[1] + LF;
  fs.writeFileSync(PATCH_OUT_ABS, patchText);

  const stats = fs.statSync(PATCH_OUT_ABS);
  console.log('wrote proposals/l83-backslash-fold.patch, byte length ' + stats.size);
} finally {
  if (tmpRoot !== null) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
