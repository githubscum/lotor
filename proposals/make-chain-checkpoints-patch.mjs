// WO-CARTRIDGE-SEAL part B: generate proposals/chain-checkpoints.patch from a
// script, never by hand (KNOWN-LIMITS 80). Reads the two core modules READ
// ONLY, applies exact string replacements to copies in a temp dir, places the
// three new core files from proposals/chain-checkpoints/, and emits the diff
// with git diff --no-index. Run from the repo root:
//   node proposals/make-chain-checkpoints-patch.mjs
//
// Nothing here writes under src/. The patch lands only at a signing sitting,
// one target per apply (KNOWN-LIMITS 82), never from a shell in a live install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const ROOT = process.cwd();
const PROPOSAL_DIR = path.join(ROOT, 'proposals', 'chain-checkpoints');
const PATCH_OUT = path.join(ROOT, 'proposals', 'chain-checkpoints.patch');

const CHAIN_REL = ['src', 'chain', 'index.js'];
const STORE_REL = ['src', 'store', 'index.js'];
const NEW_FILES = [
  { from: 'merkle.js', to: ['src', 'chain', 'merkle.js'] },
  { from: 'checkpoint.js', to: ['src', 'chain', 'checkpoint.js'] },
  { from: 'store-checkpoints.js', to: ['src', 'store', 'checkpoints.js'] }
];

function readLF(p) {
  return fs.readFileSync(p, 'utf8').split(CRLF).join(LF);
}

function fail(msg) {
  console.log('make-chain-checkpoints-patch: ' + msg);
  process.exit(2);
}

function replaceOnce(text, label, oldStr, newStr) {
  const count = text.split(oldStr).length - 1;
  if (count !== 1) fail('replacement ' + label + ': old text occurs ' + count + ' times, expected exactly 1');
  return text.split(oldStr).join(newStr);
}

// ---- src/chain/index.js: verifyChain becomes verifyRange from genesis ----

const VERIFY_START = '/**' + LF + ' * Verify a chain of entries.';
const VERIFY_END = LF + '/**' + LF + ' * Generate an Ed25519 keypair for chain signing.';

// Lines the replaced block must contain, so a drifted source fails loudly
// instead of being silently rewritten.
const VERIFY_MUST_CONTAIN = [
  'function verifyChain(entries, publicKey) {',
  '    const expectedHash = computeHash(entry);',
  '        reason: `hash mismatch at entry ${i}: expected ${expectedHash}, got ${entry.hash}`',
  '        reason: `signature verification failed at entry ${i}`',
  '    if (!Number.isSafeInteger(entry.seq) || entry.seq !== i) {',
  '        reason: `seq discontinuity at entry ${i}: expected ${i}, got ${JSON.stringify(entry.seq)}`',
  '          reason: `genesis entry prevHash mismatch at entry ${i}: expected ${GENESIS_PREV_HASH}, got ${entry.prevHash}`',
  '          reason: `prevHash link broken at entry ${i}: expected ${prevEntry.hash}, got ${entry.prevHash}`'
];

const VERIFY_NEW = [
  '/**',
  ' * Verify a chain of entries.',
  ' * @param {Array} entries - Array of entry objects',
  ' * @param {crypto.KeyObject} publicKey - Ed25519 public key',
  ' * @returns {Object} { ok: boolean, brokenAt?: number, reason?: string }',
  ' */',
  'function verifyChain(entries, publicKey) {',
  '  if (!entries || entries.length === 0) {',
  '    return { ok: true };',
  '  }',
  '',
  '  return verifyRange(entries, publicKey, { startSeq: 0, prevHash: GENESIS_PREV_HASH });',
  '}',
  '',
  '/**',
  ' * Verify a contiguous range of entries: the first carries seq startSeq and',
  ' * links to prevHash (the hash of entry startSeq - 1, or the genesis constant',
  ' * when startSeq is 0). Same checks, same order and same reasons as a full',
  ' * verifyChain; entry numbers in brokenAt and in the reasons are absolute seqs,',
  ' * so from startSeq 0 the result is exactly what verifyChain returned before',
  ' * this function existed. A caller that already trusts the chain up to',
  ' * startSeq (a verified checkpoint, src/store/checkpoints.js) verifies only',
  ' * what came after it.',
  ' * @param {Array} entries - Array of entry objects, in seq order',
  ' * @param {crypto.KeyObject} publicKey - Ed25519 public key',
  ' * @param {Object} [from] - { startSeq = 0, prevHash = GENESIS_PREV_HASH }',
  ' * @returns {Object} { ok: boolean, brokenAt?: number, reason?: string }',
  ' */',
  'function verifyRange(entries, publicKey, from = {}) {',
  '  const startSeq = from.startSeq === undefined ? 0 : from.startSeq;',
  '  const startPrevHash = from.prevHash === undefined ? GENESIS_PREV_HASH : from.prevHash;',
  '  if (!Number.isSafeInteger(startSeq) || startSeq < 0) {',
  '    throw new Error(`verifyRange: startSeq must be a non-negative safe integer, got ${startSeq}`);',
  '  }',
  '  if (!entries || entries.length === 0) {',
  '    return { ok: true };',
  '  }',
  '',
  '  for (let i = 0; i < entries.length; i++) {',
  '    const entry = entries[i];',
  '    const at = startSeq + i;',
  '',
  '    // Verify hash recomputation',
  '    const expectedHash = computeHash(entry);',
  '    if (expectedHash !== entry.hash) {',
  '      return {',
  '        ok: false,',
  '        brokenAt: at,',
  '        reason: `hash mismatch at entry ${at}: expected ${expectedHash}, got ${entry.hash}`',
  '      };',
  '    }',
  '',
  '    // Verify signature',
  "    const sigBuf = Buffer.from(entry.sig, 'hex');",
  "    const hashBuf = Buffer.from(entry.hash, 'hex');",
  '    const sigOk = crypto.verify(null, hashBuf, publicKey, sigBuf);',
  '',
  '    if (!sigOk) {',
  '      return {',
  '        ok: false,',
  '        brokenAt: at,',
  '        reason: `signature verification failed at entry ${at}`',
  '      };',
  '    }',
  '',
  '    // Verify seq continuity. Entry i of a range that starts at startSeq must',
  '    // carry seq startSeq + i (seq i for a full chain from genesis). The hash',
  '    // covers seq, so a wrong seq can only be signed in at write time; this is',
  '    // where it is caught.',
  '    if (!Number.isSafeInteger(entry.seq) || entry.seq !== at) {',
  '      return {',
  '        ok: false,',
  '        brokenAt: at,',
  '        reason: `seq discontinuity at entry ${at}: expected ${at}, got ${JSON.stringify(entry.seq)}`',
  '      };',
  '    }',
  '',
  '    // Verify prevHash linkage',
  '    if (at === 0) {',
  '      // Genesis entry: prevHash must be genesis constant',
  '      if (entry.prevHash !== GENESIS_PREV_HASH) {',
  '        return {',
  '          ok: false,',
  '          brokenAt: at,',
  '          reason: `genesis entry prevHash mismatch at entry ${at}: expected ${GENESIS_PREV_HASH}, got ${entry.prevHash}`',
  '        };',
  '      }',
  '    } else {',
  '      const expectedPrev = i > 0 ? entries[i - 1].hash : startPrevHash;',
  '      if (entry.prevHash !== expectedPrev) {',
  '        return {',
  '          ok: false,',
  '          brokenAt: at,',
  '          reason: `prevHash link broken at entry ${at}: expected ${expectedPrev}, got ${entry.prevHash}`',
  '        };',
  '      }',
  '    }',
  '  }',
  '',
  '  return { ok: true };',
  '}',
  ''
].join(LF);

function patchChain(src) {
  const start = src.indexOf(VERIFY_START);
  const end = src.indexOf(VERIFY_END);
  if (start < 0 || end < 0 || end < start) fail('chain: verifyChain block markers not found');
  if (src.indexOf(VERIFY_START, start + 1) >= 0) fail('chain: verifyChain start marker occurs twice');
  const block = src.slice(start, end + 1);
  for (const line of VERIFY_MUST_CONTAIN) {
    if (block.split(line).length - 1 !== 1) fail('chain: expected line not found exactly once in verifyChain: ' + line);
  }
  let out = src.slice(0, start) + VERIFY_NEW + src.slice(end + 1);
  out = replaceOnce(out, 'chain exports',
    '  verifyChain,' + LF + '  generateKeyPair,',
    '  verifyChain,' + LF + '  verifyRange,' + LF + '  generateKeyPair,');
  return out;
}

// ---- src/store/index.js: expose the checkpoint operations on the store ----

function patchStore(src) {
  let out = replaceOnce(src, 'store import',
    "import { withLock } from './lock.js';",
    "import { withLock } from './lock.js';" + LF + "import * as checkpoints from './checkpoints.js';");
  const OLD_TAIL = [
    '      const publicKey = crypto.createPublicKey(keyPair.publicKey);',
    '      return verifyChain(materialize(), publicKey);',
    '    }',
    '  };',
    '}'
  ].join(LF);
  const NEW_TAIL = [
    '      const publicKey = crypto.createPublicKey(keyPair.publicKey);',
    '      return verifyChain(materialize(), publicKey);',
    '    },',
    '',
    '    /**',
    '     * Seal every complete segment of the chain into a signed C2SP',
    '     * checkpoint. Writes receipts/checkpoints.jsonl only; chain.jsonl is',
    '     * never rewritten. On a chain with no checkpoints this is the',
    '     * migration. See src/store/checkpoints.js.',
    '     * @param {Object} [options] - { segmentSize, maxSegments }',
    '     * @returns {Object} { sealed, size }',
    '     */',
    '    seal(options) {',
    '      return checkpoints.sealCheckpoints(baseDir, keyPair, options);',
    '    },',
    '',
    '    /**',
    '     * Verify forward from the newest checkpoint, or from one the caller',
    '     * trusts ({ trusted: <signed note> }), reading only what came after it.',
    '     * @returns {Object} { ok, mode, from, size } or { ok: false, reason }',
    '     */',
    '    verifyIncremental(options) {',
    '      return checkpoints.verifyIncremental(baseDir, keyPair.publicKey, options);',
    '    },',
    '',
    '    /**',
    '     * Verify the whole chain and every checkpoint from genesis.',
    '     * @returns {Object} { ok, mode, from, size, checkpoints } or { ok: false, reason }',
    '     */',
    '    verifySealed() {',
    '      return checkpoints.verifySealed(baseDir, keyPair.publicKey);',
    '    },',
    '',
    '    /**',
    '     * RFC 9162 inclusion proof for the entry at seq, against the newest',
    '     * checkpoint (or { size }). Verify it with verifyInclusionProof() from',
    '     * src/chain/checkpoint.js, which needs only the proof and the public key.',
    '     */',
    '    proveInclusion(seq, options) {',
    '      return checkpoints.proveInclusion(baseDir, keyPair.publicKey, seq, options);',
    '    },',
    '',
    '    /**',
    '     * RFC 9162 consistency proof that the newest checkpoint (or { to })',
    '     * extends the one at fromSize.',
    '     */',
    '    proveConsistency(fromSize, options) {',
    '      return checkpoints.proveConsistency(baseDir, keyPair.publicKey, fromSize, options);',
    '    }',
    '  };',
    '}'
  ].join(LF);
  out = replaceOnce(out, 'store methods', OLD_TAIL, NEW_TAIL);
  return out;
}

let tmp = null;
try {
  const chainOld = readLF(path.join(ROOT, ...CHAIN_REL));
  const storeOld = readLF(path.join(ROOT, ...STORE_REL));
  const chainNew = patchChain(chainOld);
  const storeNew = patchStore(storeOld);

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-checkpoints-patch-'));
  const put = (side, rel, text) => {
    const p = path.join(tmp, side, ...rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  put('old', CHAIN_REL, chainOld);
  put('old', STORE_REL, storeOld);
  put('new', CHAIN_REL, chainNew);
  put('new', STORE_REL, storeNew);
  for (const f of NEW_FILES) {
    const text = readLF(path.join(PROPOSAL_DIR, f.from));
    if (text.indexOf(String.fromCharCode(0x2014)) >= 0) fail(f.from + ' contains U+2014; build it with String.fromCharCode');
    put('new', f.to, text);
  }

  const r = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--no-renames', 'old', 'new'],
    { cwd: tmp, encoding: 'utf8' });
  if (r.status !== 1) {
    fail('git diff exited ' + r.status + ' (expected 1): ' + (r.stderr || r.error));
  }
  // Only header lines carry the temp-dir prefixes; body lines stay
  // byte-exact. Headers are recognised only between a 'diff --git' line and
  // its first '@@', so a removed body line that starts '-- ' (or an added one
  // that starts '++ ') is never mistaken for a header and rewritten.
  const lines = r.stdout.split(LF).filter((l) => !l.startsWith('index '));
  let inHeader = false;
  const rewritten = lines.map((l) => {
    if (l.startsWith('diff --git ')) {
      inHeader = true;
      // A new file's header names the new side twice (a/new/... b/new/...).
      return l.split(' a/old/').join(' a/').split(' a/new/').join(' a/').split(' b/new/').join(' b/');
    }
    if (l.startsWith('@@')) inHeader = false;
    if (inHeader && (l.startsWith('--- ') || l.startsWith('+++ '))) {
      return l.split('--- a/old/').join('--- a/').split('+++ b/new/').join('+++ b/');
    }
    return l;
  }).join(LF);
  fs.writeFileSync(PATCH_OUT, rewritten.endsWith(LF) ? rewritten : rewritten + LF);
  console.log('wrote proposals/chain-checkpoints.patch, ' + fs.statSync(PATCH_OUT).size + ' bytes');
} finally {
  if (tmp !== null) fs.rmSync(tmp, { recursive: true, force: true });
}
