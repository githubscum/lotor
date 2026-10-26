// WO-CARTRIDGE-SEAL part A: generate proposals/pap-sealed.patch from a script,
// never by hand (KNOWN-LIMITS 80). src/publish and bin/ are core
// (src/grant/core-paths.js CORE_DIRS), so sealed mode lands only at a signing
// sitting, one signature per target.
//
// Run from the repo root:  node proposals/make-pap-sealed-patch.mjs
//   --print-base   print the base hashes instead of checking them
//
// What it does: reads the current core files READ ONLY, LF-normalizes them,
// refuses if any differs from the base this proposal was written against,
// builds old/ and new/ trees in a temp dir (new = originals with the
// replacements below, plus the proposed files kept in proposals/pap-sealed/),
// and writes the output of `git diff --no-index old new` with the tree
// prefixes rewritten. Nothing under src/ or bin/ is written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const ROOT = process.cwd();
const PROP = path.join(ROOT, 'proposals', 'pap-sealed');
const OUT = path.join(ROOT, 'proposals', 'pap-sealed.patch');

// The base each modified file was proposed against (sha256 of LF bytes).
// If main moves under one of these, regenerate the proposal, do not force it.
const BASE = {
  'src/publish/manifest.js': '94d959df456102cea67ea1d61835e41163ffd567a765177fc2d0d05829381652',
  'src/publish/pack.js': 'b13c781e39902ce488a397302082b7129eb636f3fec06cc7b5593f7949a1522d',
  'bin/pap-export.js': 'c1604910257d2bc133caf6b000984eaab23c2ae98f6b4144dde6561182859815',
  'bin/pap-boot.js': '0091649b4fa13b6011347a86133fda4babe3152069c6ad5a41481141f093bfb1',
};

const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8').split(CRLF).join(LF);
const readProp = (name) => fs.readFileSync(path.join(PROP, name), 'utf8').split(CRLF).join(LF);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function replaceOnce(text, label, oldStr, newStr) {
  const count = text.split(oldStr).length - 1;
  if (count !== 1) {
    console.log('assert failed: ' + label + ': old string occurs ' + count + ' times, expected exactly 1');
    process.exit(2);
  }
  return text.split(oldStr).join(newStr);
}

if (process.argv.includes('--print-base')) {
  for (const rel of Object.keys(BASE)) console.log("  '" + rel + "': '" + sha(read(rel)) + "',");
  process.exit(0);
}

for (const [rel, want] of Object.entries(BASE)) {
  const got = sha(read(rel));
  if (got !== want) {
    console.log('base moved: ' + rel + ' is ' + got + ', proposal was written against ' + want);
    process.exit(4);
  }
}

// ---- src/publish/manifest.js: header note + the v2 section before exports
const manifestOld = read('src/publish/manifest.js');
let manifestNew = replaceOnce(manifestOld, 'manifest header',
  [' * version byte, never reinterpret v1.', ' */'].join(LF),
  [
    ' * version byte, never reinterpret v1.',
    ' *',
    ' * v2 (sealed, WO-CARTRIDGE-SEAL 2026-10-26) is a separate layout under its',
    ' * own version byte; see docs/PAP-SEALED.md and the v2 section at the end of',
    ' * this file. decodeManifest() still accepts v1 only, exactly as before.',
    ' */',
  ].join(LF));
const manifestExportsOld = [
  'export {',
  '  VERSION,',
  '  HEADER_FIXED_LEN,',
  '  SPINE_LEN_TAG_BYTES,',
  '  SIG_LEN,',
  '  QR_V40_BINARY_ECL_CAPACITY,',
  '  USEFUL_PAYLOAD_BUDGET,',
  '  encodeManifest,',
  '  decodeManifest,',
  '};',
  '',
].join(LF);
manifestNew = replaceOnce(manifestNew, 'manifest exports', manifestExportsOld, readProp('manifest.v2-block.txt'));

// ---- src/publish/pack.js
const packOld = read('src/publish/pack.js');
let packNew = replaceOnce(packOld, 'pack header',
  ' * module stays testable with synthetic keys.' + LF,
  [
    ' * module stays testable with synthetic keys.',
    ' *',
    ' * Sealed mode (v2, WO-CARTRIDGE-SEAL 2026-10-26): pack() with inputs.seal',
    ' * encrypts, then signs. See the sealed section below and docs/PAP-SEALED.md.',
    ' * Without inputs.seal, pack() and unpack() are the v1 code, byte for byte.',
    '',
  ].join(LF));
packNew = replaceOnce(packNew, 'pack imports',
  [
    'import {',
    '  encodeManifest,',
    '  decodeManifest,',
    '  SIG_LEN,',
    '  QR_V40_BINARY_ECL_CAPACITY,',
    "} from './manifest.js';",
  ].join(LF),
  [
    'import {',
    '  encodeManifest,',
    '  decodeManifest,',
    '  encodeSealedHeader,',
    '  encodeSealedManifest,',
    '  decodeSealedManifest,',
    '  SIG_LEN,',
    '  QR_V40_BINARY_ECL_CAPACITY,',
    '  HEADER_FIXED_LEN,',
    '  SPINE_LEN_TAG_BYTES,',
    '  VERSION_SEALED,',
    '  PASSPHRASE_SALT_LEN,',
    "} from './manifest.js';",
    'import {',
    '  DEFAULT_PBKDF2_ITERATIONS,',
    '  generateContentKey,',
    '  keyCommitment,',
    '  commitmentMatches,',
    '  bodyKey,',
    '  aeadSeal,',
    '  aeadOpen,',
    '  x25519RawPublic,',
    '  generateRecipientKeypair,',
    '  parseRecipientPublicKey,',
    '  parseRecipientPrivateKey,',
    '  x25519Wrap,',
    '  x25519Unwrap,',
    '  passphraseKek,',
    '  innerMessage,',
    "} from './seal.js';",
  ].join(LF));
packNew = replaceOnce(packNew, 'pack dispatch',
  ['function pack(inputs) {', '  if (typeof inputs.spine'].join(LF),
  ['function pack(inputs) {', '  if (inputs.seal) return packSealed(inputs);', '  if (typeof inputs.spine'].join(LF));
packNew = replaceOnce(packNew, 'unpack dispatch',
  ['    throw new Error(`bundle too short: ${inputs.bundle.length} bytes`);', '  }', '  const manifestBytes'].join(LF),
  [
    '    throw new Error(`bundle too short: ${inputs.bundle.length} bytes`);',
    '  }',
    '  if (inputs.bundle[0] === VERSION_SEALED) return unpackSealed(inputs);',
    '  const manifestBytes',
  ].join(LF));
packNew = replaceOnce(packNew, 'sealed block',
  '// ---------- internal ----------' + LF,
  readProp('pack.sealed-block.txt') + '// ---------- internal ----------' + LF);
packNew = replaceOnce(packNew, 'pack exports',
  ['export {', '  pack,', '  unpack,', '  generateKeypair,', '};'].join(LF),
  ['export {', '  pack,', '  unpack,', '  inspect,', '  generateKeypair,', '  generateRecipientKeypair,', '};'].join(LF));

// ---- whole-file proposals (base-hash guarded above, or new)
const files = {
  'src/publish/manifest.js': [manifestOld, manifestNew],
  'src/publish/pack.js': [packOld, packNew],
  'src/publish/seal.js': [null, readProp('src.publish.seal.js')],
  'bin/pap-export.js': [read('bin/pap-export.js'), readProp('bin.pap-export.js')],
  'bin/pap-boot.js': [read('bin/pap-boot.js'), readProp('bin.pap-boot.js')],
  'bin/pap-keygen.js': [null, readProp('bin.pap-keygen.js')],
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-sealed-patch-'));
try {
  for (const [rel, [oldText, newText]] of Object.entries(files)) {
    for (const [side, text] of [['old', oldText], ['new', newText]]) {
      if (text === null) continue;
      const p = path.join(tmp, side, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
  }
  fs.mkdirSync(path.join(tmp, 'old'), { recursive: true });
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', 'old', 'new'],
    { cwd: tmp, encoding: 'utf8' });
  if (r.status !== 1) {
    console.log('git diff exited ' + r.status + ', expected 1. ' + (r.stderr || '') + (r.error ? String(r.error) : ''));
    process.exit(3);
  }
  const patch = r.stdout.split(LF)
    .filter((line) => !line.startsWith('index '))
    .map((line) => line
      .split(' a/old/').join(' a/').split(' b/new/').join(' b/')
      .split(' a/new/').join(' a/')
      .split('--- a/old/').join('--- a/').split('+++ b/new/').join('+++ b/'))
    .join(LF);
  fs.writeFileSync(OUT, patch);
  console.log('wrote proposals/pap-sealed.patch, ' + fs.statSync(OUT).size + ' bytes, ' +
    Object.keys(files).length + ' files');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
