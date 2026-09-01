import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  computeSourceDigest,
  captureBuildIdentity,
  checkFreshness
} from '../src/mcp/build-identity.js';

/**
 * KNOWN-LIMITS 41. An MCP server is spawned once by the client and persists
 * across sessions, so a change under src/ is invisible to it until the client
 * restarts, and nothing in the response said which build answered. On
 * 2026-07-26 a pre-fix answer from a long-lived process was read as a live
 * defect and reported to the operator as a new finding. It was not a defect.
 *
 * These tests cover the thing that makes that detectable: a digest of the
 * source taken at process start, recomputed on demand, and compared.
 *
 * The tests build their own throwaway tree rather than digesting this
 * repository, so a real source edit does not turn them red for the wrong
 * reason.
 */

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-build-id-'));
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'nested', 'b.js'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(root, 'bin', 'c.js'), 'export const c = 3;\n');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'test-pkg', version: '9.9.9' })
  );
  return root;
}

describe('computeSourceDigest', () => {
  it('digests every .js file under the source dirs, and counts them', () => {
    const root = makeTree();
    const r = computeSourceDigest(root);

    assert.strictEqual(r.fileCount, 3, 'should find a.js, nested/b.js and bin/c.js');
    assert.match(r.digest, /^[0-9a-f]{64}$/, 'digest should be full-length lowercase sha256 hex');
    assert.strictEqual(typeof r.byteCount, 'number');
    assert.ok(r.byteCount > 0, 'byteCount should be the summed file size');
  });

  it('is stable across repeated calls on an unchanged tree', () => {
    const root = makeTree();
    assert.strictEqual(computeSourceDigest(root).digest, computeSourceDigest(root).digest);
  });

  it('changes when a byte of source changes', () => {
    const root = makeTree();
    const before = computeSourceDigest(root).digest;
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 2;\n');
    const after = computeSourceDigest(root).digest;

    assert.notStrictEqual(before, after, 'a content edit must move the digest');
  });

  it('changes when a source file is added, and returns when it is removed', () => {
    const root = makeTree();
    const before = computeSourceDigest(root).digest;

    const added = path.join(root, 'src', 'added.js');
    fs.writeFileSync(added, 'export const d = 4;\n');
    assert.notStrictEqual(computeSourceDigest(root).digest, before, 'a new file must move the digest');

    fs.rmSync(added);
    assert.strictEqual(
      computeSourceDigest(root).digest,
      before,
      'removing the addition must return the digest: content, not mtime, is what is compared'
    );
  });

  it('ignores non-.js files and node_modules', () => {
    const root = makeTree();
    const before = computeSourceDigest(root).digest;

    fs.writeFileSync(path.join(root, 'src', 'README.md'), '# not source\n');
    fs.mkdirSync(path.join(root, 'src', 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'node_modules', 'dep', 'index.js'), 'module.exports=1;\n');

    assert.strictEqual(
      computeSourceDigest(root).digest,
      before,
      'docs and vendored dependencies are not this repository’s source'
    );
  });

  it('returns a null digest rather than throwing when there is no source at all', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-build-id-empty-'));
    const r = computeSourceDigest(empty);

    assert.strictEqual(r.digest, null, 'no files means no digest, never a hash of nothing');
    assert.strictEqual(r.fileCount, 0);
  });
});

describe('captureBuildIdentity', () => {
  it('carries name, version, digest, start time and pid', () => {
    const root = makeTree();
    const id = captureBuildIdentity(root);

    assert.strictEqual(id.name, 'test-pkg');
    assert.strictEqual(id.version, '9.9.9');
    assert.match(id.sourceDigest, /^[0-9a-f]{64}$/);
    assert.strictEqual(id.fileCount, 3);
    assert.strictEqual(id.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(id.startedAt)), 'startedAt should parse as a date');
  });

  it('degrades to nulls rather than throwing when the root is not a package', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-build-id-nopkg-'));
    const id = captureBuildIdentity(empty);

    assert.strictEqual(id.name, null);
    assert.strictEqual(id.version, null);
    assert.strictEqual(id.sourceDigest, null);
    assert.ok(!Number.isNaN(Date.parse(id.startedAt)), 'a failed capture still knows when it happened');
  });
});

describe('checkFreshness', () => {
  it('reads not-stale while the source on disk matches what was captured', () => {
    const root = makeTree();
    const captured = captureBuildIdentity(root);
    const f = checkFreshness(captured, root);

    assert.strictEqual(f.stale, false);
    assert.strictEqual(f.currentDigest, captured.sourceDigest);
    assert.ok(typeof f.reason === 'string' && f.reason.length > 0);
  });

  it('reads STALE once the source changes under a running process', () => {
    const root = makeTree();
    const captured = captureBuildIdentity(root);

    // This is limit 41 in miniature: the process keeps the code it loaded,
    // the disk moves on.
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export const a = 99;\n');

    const f = checkFreshness(captured, root);
    assert.strictEqual(f.stale, true, 'a source change under a live process must read stale');
    assert.notStrictEqual(f.currentDigest, captured.sourceDigest);
    assert.match(f.reason, /restart/i, 'the reason should tell the reader what to do about it');
  });

  it('reads not-stale again if the change is reverted', () => {
    const root = makeTree();
    const captured = captureBuildIdentity(root);
    const file = path.join(root, 'src', 'a.js');
    const original = fs.readFileSync(file);

    fs.writeFileSync(file, 'export const a = 99;\n');
    assert.strictEqual(checkFreshness(captured, root).stale, true);

    fs.writeFileSync(file, original);
    assert.strictEqual(
      checkFreshness(captured, root).stale,
      false,
      'reverting means the loaded code matches disk again, which is not stale'
    );
  });

  it('reports unknown rather than guessing when a digest is missing', () => {
    const root = makeTree();
    const f = checkFreshness({ sourceDigest: null }, root);

    assert.strictEqual(f.stale, null, 'absent is not fresh, and it is not stale either');
    assert.ok(typeof f.reason === 'string' && f.reason.length > 0);
  });

  it('survives a captured value that is missing entirely', () => {
    const root = makeTree();
    assert.strictEqual(checkFreshness(undefined, root).stale, null);
    assert.strictEqual(checkFreshness(null, null).stale, null);
  });
});
