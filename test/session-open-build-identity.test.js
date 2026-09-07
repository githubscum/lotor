/**
 * test/session-open-build-identity.test.js
 *
 * KNOWN-LIMITS 64, closed 2026-09-07 at the signing sitting.
 *
 * The whole-tree source digest (computeSourceDigest, every .js under src/ and
 * bin/) used to reach only MCP tool responses, as `_lotorBuild`, on a value
 * that is discarded when the call returns. The permanent record carried only
 * the matcher stamp, which covers one file. Now every session-open receipt
 * carries `observer.build`: the digest in short form and full (per limit 50,
 * the two are not interchangeable and the full one is the evidence binding),
 * plus the file and byte counts it was taken over. Per-action receipts inherit
 * it by session id (limit 35's repair carries the id onto gate receipts).
 *
 * The hook is run as a real child process against a throwaway home, and the
 * digest on the receipt is compared to one computed independently here over
 * the same tree. Residuals stay as entry 64 states them: node_modules, non-.js
 * inputs, and anything loaded from outside the repository are not in it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadChain } from '../src/store/index.js';
import { computeSourceDigest } from '../src/mcp/build-identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HOOK = path.join(ROOT, 'bin', 'hook-session-start.js');

function runStart(home, sessionId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, LOTOR_HARNESS: undefined, LOTOR_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({
      session_id: sessionId, source: 'startup', cwd: '/repo',
      transcript_path: '/tmp/t.jsonl', hook_event_name: 'SessionStart'
    }));
  });
}

describe('session-open carries the whole-tree source digest (KNOWN-LIMITS 64)', () => {
  let home;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-build-id-')); });
  after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ } });

  it('observer.build on the open receipt equals an independent digest of src/ and bin/', async () => {
    const res = await runStart(home, 'sess-build-1');
    assert.equal(res.code, 0, res.stderr);

    const opens = loadChain(home).filter(e => e.payload?.type === 'session-open');
    assert.equal(opens.length, 1);
    const observer = opens[0].payload.observer;
    assert.ok(observer, 'the open receipt carries an observer block (control)');
    assert.equal(typeof observer.matcher?.hash, 'string', 'the matcher stamp is still there (control)');

    const expected = computeSourceDigest(ROOT);
    assert.equal(typeof expected.digest, 'string', 'the tree digests (control)');

    const build = observer.build;
    assert.ok(build, 'observer.build is on the record. Absent means limit 64 is open again.');
    assert.equal(build.schema, 'build/1');
    assert.equal(build.sourceDigest, expected.digest, 'full digest, the evidence binding');
    assert.equal(build.sourceDigestShort, expected.digest.slice(0, 16), 'short form, for a glance');
    assert.equal(build.fileCount, expected.fileCount);
    assert.equal(build.byteCount, expected.byteCount);
    assert.equal(observer.schema, 'observer/2', 'the observer field set changed, so its schema moved');
  });

  it('the digest is per open, not per process: a second open re-digests the tree', async () => {
    const res = await runStart(home, 'sess-build-2');
    assert.equal(res.code, 0, res.stderr);
    const opens = loadChain(home).filter(e => e.payload?.type === 'session-open');
    assert.equal(opens.length, 2);
    assert.equal(opens[1].payload.observer.build.sourceDigest, opens[0].payload.observer.build.sourceDigest,
      'same tree, same digest across two opens');
  });
});
