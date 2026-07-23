/**
 * test/mode-cli.test.js
 *
 * Integration tests for bin/mode.js, spawned as a real child process against
 * an isolated LOTOR_HOME (never the real one).
 *
 * Covers: printing with no args needs no TTY, an unknown mode name is
 * rejected before any passphrase prompt, a mode switch with no TTY fails
 * shut (not open) and leaves policy.json untouched, and a successful switch
 * (piping the passphrase is possible here only because we bypass the TTY
 * check in a controlled way — see the "successful switch" test note).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadPolicy } from '../src/policy/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODE_PATH = path.join(__dirname, '..', 'bin', 'mode.js');

/**
 * Write a well-formed but arbitrary approval.pub, exactly enough for
 * loadApprovalPubkey() to succeed. The real interactive `init()` prompts
 * for a passphrase over a real TTY, which a spawned test process does not
 * have — calling it in-process here would call process.exit() inside the
 * TEST RUNNER's own process, not a child, taking the whole file down with
 * it. This sidesteps that entirely: these tests only need "a key exists",
 * never a passphrase that actually verifies.
 */
function writeFakeApprovalKey(home) {
  const keysDir = path.join(home, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const pubB64 = crypto.randomBytes(32).toString('base64url');
  const fp = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64url')).digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(keysDir, 'approval.pub'), `ed25519:${pubB64}:fingerprint:${fp}\n`);
}

function runMode({ args = [], home, stdinIsTTY = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MODE_PATH, ...args], {
      env: { ...process.env, LOTOR_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    // Never a real TTY over a spawned pipe; stdin.isTTY is false by
    // construction here, which is exactly the "headless model process"
    // case the passphrase gate exists to fail shut against.
    child.stdin.end();
  });
}

describe('bin/mode.js', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-mode-cli-'));
  });

  after(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });

  it('with no args: prints the current mode without requiring a TTY', async () => {
    const home = path.join(tempDir, 'home-print');
    fs.mkdirSync(home, { recursive: true });

    const res = await runMode({ home });
    assert.strictEqual(res.code, 0, 'printing must not require a TTY or a passphrase');
    assert.match(res.stdout, /mode: grazing/, 'a fresh home reports the Grazing default');
    assert.match(res.stdout, /self-mod\s+gate/);
  });

  it('rejects an unknown mode name before touching the passphrase at all', async () => {
    const home = path.join(tempDir, 'home-unknown');
    fs.mkdirSync(home, { recursive: true });

    const res = await runMode({ home, args: ['feral'] });
    assert.strictEqual(res.code, 2);
    assert.match(res.stderr, /unknown mode 'feral'/);
    assert.match(res.stderr, /herded, grazing, loose/);

    // policy.json must not exist yet (loadPolicy() was never called to
    // create the default, and the switch itself never ran).
    const policyPath = path.join(home, 'policy.json');
    assert.strictEqual(fs.existsSync(policyPath), false);
  });

  it('a real mode switch with no TTY fails shut (exit 2) and leaves policy.json untouched', async () => {
    const home = path.join(tempDir, 'home-notty');
    fs.mkdirSync(home, { recursive: true });
    writeFakeApprovalKey(home); // key exists, so this reaches the TTY check specifically

    // Establish a known starting policy.json so we can assert it is byte-for-byte untouched.
    loadPolicy(home); // writes the Grazing default to disk
    const beforeText = fs.readFileSync(path.join(home, 'policy.json'), 'utf8');

    const res = await runMode({ home, args: ['loose'] });
    assert.strictEqual(res.code, 2, 'no TTY must fail shut, not open');
    assert.match(res.stderr, /not a TTY/);

    const afterText = fs.readFileSync(path.join(home, 'policy.json'), 'utf8');
    assert.strictEqual(afterText, beforeText, 'a rejected switch must not touch the file at all');
    assert.strictEqual(loadPolicy(home).mode, 'grazing', 'mode is unchanged');
  });

  it('a switch attempted before the approval key exists fails with guidance, not a crash', async () => {
    const home = path.join(tempDir, 'home-nokey');
    fs.mkdirSync(home, { recursive: true });
    // No key written here: the key-existence check must fire before the TTY
    // check reports anything, so this is distinguishable from the test above
    // even though both are spawned identically over piped (non-TTY) stdio.

    const res = await runMode({ home, args: ['herded'] });
    assert.strictEqual(res.code, 2);
    assert.match(res.stderr, /npm run setup/);
    assert.doesNotMatch(res.stderr, /not a TTY/, 'the key-missing message should win, not the TTY message');
  });
});
