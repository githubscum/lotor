import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSession } from '../src/parser/index.js';

/**
 * Synthetic JSONL fixture for testing the parser.
 * Contains:
 * - Session start metadata
 * - One Edit tool call (success)
 * - One Bash tool call (failure) with is_error: true
 * - One Read tool call (should NOT appear in touched)
 * - One WebFetch call (network-capable)
 * - Token usage across turns
 */
const syntheticJsonl = JSON.stringify({
  sessionId: 'test-session-001',
  version: '2.1.999',
  createdAt: '2026-07-21T10:00:00Z',
  type: 'session-start'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'assistant',
    model: 'test-model-v1',
    content: [
      {
        type: 'tool_use',
        name: 'Edit',
        id: 'edit-001',
        input: { file_path: '/home/user/project/src/app.js', old_string: 'foo', new_string: 'bar' }
      }
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  },
  createdAt: '2026-07-21T10:01:00Z'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'edit-001',
        content: 'success'
      }
    ]
  },
  createdAt: '2026-07-21T10:01:01Z'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'assistant',
    model: 'test-model-v1',
    content: [
      {
        type: 'tool_use',
        name: 'Bash',
        id: 'bash-002',
        input: { command: 'curl -s https://example.com/data' }
      }
    ],
    usage: {
      input_tokens: 50,
      output_tokens: 30,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5
    }
  },
  createdAt: '2026-07-21T10:02:00Z'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'bash-002',
        is_error: true,
        content: '<tool_use_error>curl: (6) Could not resolve host</tool_use_error>'
      }
    ]
  },
  createdAt: '2026-07-21T10:02:01Z'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'assistant',
    model: 'test-model-v1',
    content: [
      {
        type: 'tool_use',
        name: 'Read',
        id: 'read-003',
        input: { file_path: '/home/user/project/README.md' }
      }
    ],
    usage: {
      input_tokens: 25,
      output_tokens: 15,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  },
  createdAt: '2026-07-21T10:03:00Z'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'read-003',
        // No is_error field = success (per spec: absent = success)
        content: '# Project README'
      }
    ]
  },
  createdAt: '2026-07-21T10:03:01Z'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'assistant',
    model: 'test-model-v1',
    content: [
      {
        type: 'tool_use',
        name: 'WebFetch',
        id: 'webfetch-004',
        input: { url: 'https://api.example.com/data' }
      }
    ],
    usage: {
      input_tokens: 40,
      output_tokens: 60,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  },
  createdAt: '2026-07-21T10:04:00Z'
}) + '\n' +
JSON.stringify({
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'webfetch-004',
        // No is_error = success
        content: '{"data": "fetched"}'
      }
    ]
  },
  createdAt: '2026-07-21T10:04:01Z'
}) + '\n' +
// File history snapshot (additional touch record)
JSON.stringify({
  type: 'file-history-snapshot',
  snapshot: {
    trackedFileBackups: {
      '/home/user/project/config.json': { version: 1 }
    }
  },
  createdAt: '2026-07-21T10:05:00Z'
});

describe('parseSession', () => {
  it('should parse session metadata', () => {
    const result = parseSession(syntheticJsonl);

    assert.strictEqual(result.session.id, 'test-session-001');
    assert.strictEqual(result.session.version, '2.1.999');
    assert.strictEqual(result.session.model, 'test-model-v1');
    assert.strictEqual(result.session.startedAt, '2026-07-21T10:00:00Z');
    assert.strictEqual(result.session.endedAt, '2026-07-21T10:05:00Z');
  });

  it('should extract tool invocations into ran array', () => {
    const result = parseSession(syntheticJsonl);

    assert.strictEqual(result.ran.length, 4);
    assert.strictEqual(result.ran[0].tool, 'Edit');
    assert.strictEqual(result.ran[0].id, 'edit-001');
    assert.ok(result.ran[0].paramsDigest, 'paramsDigest should exist');
    assert.strictEqual(result.ran[1].tool, 'Bash');
    assert.strictEqual(result.ran[1].id, 'bash-002');
  });

  it('should track file mutations in touched (Edit/Write only, not Read)', () => {
    const result = parseSession(syntheticJsonl);

    // Should include Edit and file-history paths
    const paths = result.touched.map(t => t.path);
    assert.ok(paths.includes('/home/user/project/src/app.js'), 'Edit file should be touched');
    assert.ok(paths.includes('/home/user/project/config.json'), 'file-history should be touched');

    // Read file should NOT be in touched
    assert.ok(!paths.includes('/home/user/project/README.md'), 'Read file should NOT be touched');

    // Verify via labels
    const appTouch = result.touched.find(t => t.path === '/home/user/project/src/app.js');
    assert.strictEqual(appTouch.via, 'edit');

    const configTouch = result.touched.find(t => t.path === '/home/user/project/config.json');
    assert.strictEqual(configTouch.via, 'file-history');
  });

  it('should classify failed tool_results with is_error:true', () => {
    const result = parseSession(syntheticJsonl);

    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].tool, 'Bash');
    assert.strictEqual(result.failed[0].id, 'bash-002');
    assert.ok(result.failed[0].errorDigest, 'errorDigest should exist');
  });

  it('should sum token usage across turns', () => {
    const result = parseSession(syntheticJsonl);

    // 100 + 50 + 25 + 40 = 215 input
    assert.strictEqual(result.cost.inputTokens, 215);
    // 50 + 30 + 15 + 60 = 155 output
    assert.strictEqual(result.cost.outputTokens, 155);
    // 0 + 10 + 0 + 0 = 10 cache creation
    assert.strictEqual(result.cost.cacheCreationTokens, 10);
    // 0 + 5 + 0 + 0 = 5 cache read
    assert.strictEqual(result.cost.cacheReadTokens, 5);
    assert.strictEqual(result.cost.note, 'tokens only; no USD in source');
  });

  it('should track network-capable tool invocations in sent (best-effort)', () => {
    const result = parseSession(syntheticJsonl);

    // Should capture Bash with curl and WebFetch
    assert.strictEqual(result.sent.items.length, 2);
    assert.ok(result.sent.items.find(i => i.tool === 'Bash' && i.target.includes('curl')));
    assert.ok(result.sent.items.find(i => i.tool === 'WebFetch'));

    assert.ok(result.sent.captureNote.includes('not fully derivable'));
  });

  it('should provide accurate counts', () => {
    const result = parseSession(syntheticJsonl);

    // 4 assistant turns with tool_use
    assert.strictEqual(result.counts.turns, 4);
    // 4 tool invocations
    assert.strictEqual(result.counts.toolCalls, 4);
    // 1 failure (the Bash with is_error:true)
    assert.strictEqual(result.counts.failures, 1);
  });

  it('should not include full file contents or params', () => {
    const result = parseSession(syntheticJsonl);

    // Check that paramsDigest is a hash, not the full content
    const editParams = result.ran.find(r => r.tool === 'Edit');
    assert.strictEqual(editParams.paramsDigest.length, 16); // SHA-256 first 16 hex chars

    // No full content should be in the output
    const jsonStr = JSON.stringify(result);
    assert.ok(!jsonStr.includes('foo'), 'Original params should not appear');
    assert.ok(!jsonStr.includes('bar'), 'New params should not appear');
  });
});
