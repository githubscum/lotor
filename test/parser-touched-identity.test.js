import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSession } from '../src/parser/index.js';

/**
 * Tests for touched-path identity in src/parser/index.js.
 *
 * Claude Code records the SAME edited file twice: Edit/Write tool_use
 * carries `input.file_path` as an ABSOLUTE path, while file-history
 * (snapshot `trackedFileBackups` keys, delta `trackingPath`) records it
 * RELATIVE to the session working directory. One file, two `touched`
 * entries: counts double and a reader reads two files changed.
 *
 * Transcripts carry the session cwd in a top-level `cwd` field. The
 * parser resolves relative file-history paths against it, keyed so the
 * two shapes collide onto ONE entry with `via` = edit/write and the
 * displaced file-history record in `alsoVia`.
 *
 * Transcripts are built in-memory the way test/parser-dedup.test.js
 * builds its split-message fixture: plain objects, JSON.stringify, joined
 * with '\n'.
 */

function assistantToolUse({ cwd, tool, id, filePath }) {
  return JSON.stringify({
    ...(cwd !== undefined ? { cwd } : {}),
    message: {
      role: 'assistant',
      model: 'test-model-v1',
      content: [{ type: 'tool_use', name: tool, id, input: { file_path: filePath } }]
    },
    createdAt: '2026-10-19T10:00:00Z'
  });
}

function snapshotLine({ cwd, tracked }) {
  return JSON.stringify({
    ...(cwd !== undefined ? { cwd } : {}),
    type: 'file-history-snapshot',
    snapshot: { trackedFileBackups: tracked },
    createdAt: '2026-10-19T10:00:01Z'
  });
}

function deltaLine({ cwd, trackingPath }) {
  return JSON.stringify({
    ...(cwd !== undefined ? { cwd } : {}),
    type: 'file-history-delta',
    trackingPath,
    createdAt: '2026-10-19T10:00:02Z'
  });
}

describe('parseSession touched-path identity', () => {
  it('posix: Edit absolute + snapshot relative with cwd collapse to ONE entry (edit first)', () => {
    const jsonl = [
      assistantToolUse({ cwd: '/home/u/repo', tool: 'Edit', id: 't1', filePath: '/home/u/repo/src/a.js' }),
      snapshotLine({ cwd: '/home/u/repo', tracked: { 'src/a.js': { version: 1 } } })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.strictEqual(result.touched.length, 1, 'one file, not two entries');
    assert.strictEqual(result.touched[0].path, '/home/u/repo/src/a.js');
    assert.strictEqual(result.touched[0].via, 'edit');
    assert.deepEqual(result.touched[0].alsoVia, ['file-history']);
  });

  it('posix: snapshot BEFORE the Edit collapses to the same ONE entry', () => {
    // The parser may meet the file-history record first: the Edit/Write
    // arrival must still overwrite `via` and move file-history to alsoVia.
    const jsonl = [
      snapshotLine({ cwd: '/home/u/repo', tracked: { 'src/a.js': { version: 1 } } }),
      assistantToolUse({ cwd: '/home/u/repo', tool: 'Edit', id: 't1', filePath: '/home/u/repo/src/a.js' })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.strictEqual(result.touched.length, 1, 'one file, not two entries');
    assert.strictEqual(result.touched[0].path, '/home/u/repo/src/a.js');
    assert.strictEqual(result.touched[0].via, 'edit');
    assert.deepEqual(result.touched[0].alsoVia, ['file-history']);
  });

  it('windows: Write absolute + delta trackingPath with cwd collapse to ONE entry', () => {
    const jsonl = [
      assistantToolUse({ cwd: 'C:\\Users\\u\\repo', tool: 'Write', id: 't1', filePath: 'C:\\Users\\u\\repo\\src\\b.js' }),
      deltaLine({ cwd: 'C:\\Users\\u\\repo', trackingPath: 'src/b.js' })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.strictEqual(result.touched.length, 1, 'one file, not two entries');
    assert.strictEqual(result.touched[0].path, 'C:\\Users\\u\\repo\\src\\b.js');
    assert.strictEqual(result.touched[0].via, 'write');
    assert.deepEqual(result.touched[0].alsoVia, ['file-history']);
  });

  it('windows: case difference collapses (`c:\\users\\...\\x.js` vs snapshot `X.js`)', () => {
    // Windows keys are compared case-insensitively and
    // separator-insensitively; the stored display path keeps the Edit
    // form while the map key is folded.
    const jsonl = [
      assistantToolUse({ cwd: 'C:\\Users\\u\\repo', tool: 'Edit', id: 't1', filePath: 'c:\\users\\u\\repo\\x.js' }),
      snapshotLine({ cwd: 'C:\\Users\\u\\repo', tracked: { 'X.js': { version: 1 } } })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.strictEqual(result.touched.length, 1, 'same file modulo case, not two entries');
    assert.strictEqual(result.touched[0].path, 'c:\\users\\u\\repo\\x.js');
    assert.strictEqual(result.touched[0].via, 'edit');
    assert.deepEqual(result.touched[0].alsoVia, ['file-history']);
  });

  it('two different files stay two touched entries', () => {
    const jsonl = [
      assistantToolUse({ cwd: '/home/u/repo', tool: 'Edit', id: 't1', filePath: '/home/u/repo/src/a.js' }),
      snapshotLine({ cwd: '/home/u/repo', tracked: { 'src/a.js': { version: 1 } } }),
      assistantToolUse({ cwd: '/home/u/repo', tool: 'Write', id: 't2', filePath: '/home/u/repo/src/b.js' }),
      snapshotLine({ cwd: '/home/u/repo', tracked: { 'src/b.js': { version: 1 } } })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.strictEqual(result.touched.length, 2, 'two distinct files');
    const paths = result.touched.map(t => t.path);
    assert.ok(paths.includes('/home/u/repo/src/a.js'));
    assert.ok(paths.includes('/home/u/repo/src/b.js'));
  });

  it('no cwd in transcript: relative file-history stays its own entry (no guessing)', () => {
    // Without a cwd there is nothing to resolve `a.js` against, so it
    // CANNOT be proven the same file as /abs/a.js. Two entries: no guess.
    const jsonl = [
      assistantToolUse({ tool: 'Edit', id: 't1', filePath: '/abs/a.js' }),
      snapshotLine({ tracked: { 'a.js': { version: 1 } } })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.strictEqual(result.touched.length, 2, 'no cwd: no resolution, no merge');
    const absEntry = result.touched.find(t => t.path === '/abs/a.js');
    const relEntry = result.touched.find(t => t.path === 'a.js');
    assert.ok(absEntry, 'absolute Edit entry present');
    assert.ok(relEntry, 'relative file-history entry present, unchanged');
    assert.strictEqual(absEntry.via, 'edit');
    assert.strictEqual(relEntry.via, 'file-history');
    assert.strictEqual(relEntry.alsoVia, undefined, 'distinct entries, no merge artefacts');
  });

  it('file-history-only relative path with cwd is reported resolved to absolute', () => {
    const jsonl = [
      snapshotLine({ cwd: '/home/u/repo', tracked: { 'src/c.js': { version: 1 } } }),
      deltaLine({ cwd: '/home/u/repo', trackingPath: 'src/d.js' })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.strictEqual(result.touched.length, 2);
    const c = result.touched.find(t => t.path === '/home/u/repo/src/c.js');
    const d = result.touched.find(t => t.path === '/home/u/repo/src/d.js');
    assert.ok(c, 'snapshot key resolved against cwd');
    assert.ok(d, 'delta trackingPath resolved against cwd');
    assert.strictEqual(c.via, 'file-history');
    assert.strictEqual(d.via, 'file-history');
  });

  it('output order keeps first-seen order of the canonical key', () => {
    const jsonl = [
      snapshotLine({ cwd: '/home/u/repo', tracked: { 'src/first.js': { version: 1 } } }),
      assistantToolUse({ cwd: '/home/u/repo', tool: 'Edit', id: 't1', filePath: '/home/u/repo/src/second.js' })
    ].join('\n');
    const result = parseSession(jsonl);

    assert.deepEqual(
      result.touched.map(t => t.path),
      ['/home/u/repo/src/first.js', '/home/u/repo/src/second.js']
    );
  });
});