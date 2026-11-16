// WO-L81-01: generate proposals/l81-pin-eol.patch from a script, not from a
// hand-written diff. Reads src/limits/pin.js (READ ONLY), applies one
// replacement, builds the diff in a temp dir, writes the patch. Run from the
// repo root: node proposals/make-l81-patch.mjs
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
const PIN_ABS = path.join(ROOT, 'src', 'limits', 'pin.js');
const PATCH_OUT_ABS = path.join(ROOT, 'proposals', 'l81-pin-eol.patch');

const OLD_BODYDIGEST = "  return crypto.createHash('sha256').update(stripPinBlock(text), 'utf8').digest('hex');";

const NEW_BODYDIGEST = [
  '  // A CRLF checkout (core.autocrlf=true) gives the log CR bytes an LF',
  '  // checkout of the same commit does not have, so the body digest moved',
  '  // with the checkout and not the log (KNOWN-LIMITS 81). The fold runs',
  '  // BEFORE the pin block is stripped: stripPinBlock trims blank lines',
  '  // with a bare-LF match, so stripping first would keep the blank lines a',
  '  // CRLF checkout carries in front of the body and an LF digest would',
  '  // still differ. Folding first keeps an LF digest byte-identical before',
  '  // and after this change and moves only CRLF digests onto the LF value.',
  '  const CRLF = String.fromCharCode(13, 10);',
  '  const LF = String.fromCharCode(10);',
  "  return crypto.createHash('sha256').update(",
  "    stripPinBlock(typeof text === 'string' ? text.split(CRLF).join(LF) : text),",
  "    'utf8'",
  "  ).digest('hex');",
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
  const original = fs.readFileSync(PIN_ABS, 'utf8').split(CRLF).join(LF);

  let replaced = replaceOnce(original, 'bodyDigest fold', OLD_BODYDIGEST, NEW_BODYDIGEST);

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'l81-patch-'));
  const oldDir = path.join(tmpRoot, 'old', 'src', 'limits');
  const newDir = path.join(tmpRoot, 'new', 'src', 'limits');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'pin.js'), original);
  fs.writeFileSync(path.join(newDir, 'pin.js'), replaced);

  const diffResult = spawnSync(
    'git',
    [
      '-c', 'core.autocrlf=false',
      'diff', '--no-index', '--no-color',
      'old/src/limits/pin.js', 'new/src/limits/pin.js',
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

  let pinDiff = diffResult.stdout;
  pinDiff = pinDiff.split('a/old/src/limits/pin.js').join('a/src/limits/pin.js');
  pinDiff = pinDiff.split('b/new/src/limits/pin.js').join('b/src/limits/pin.js');
  pinDiff = pinDiff.split(LF).filter(function (line) {
    return line.startsWith('index ') === false;
  }).join(LF);

  const patchText = trimEndNewlines(pinDiff) + LF;
  fs.writeFileSync(PATCH_OUT_ABS, patchText);

  const stats = fs.statSync(PATCH_OUT_ABS);
  console.log('wrote proposals/l81-pin-eol.patch, byte length ' + stats.size);
} finally {
  if (tmpRoot !== null) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
