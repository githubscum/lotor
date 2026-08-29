import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Thought sidecar at ingest (2026-08-29).
 *
 * The parser emits cost.thoughts as an array (one row per distinct
 * assistant message). Embedding that array in the chain payload would grow
 * a heavy session's receipt by two orders of magnitude, so ingest follows
 * the transcriptHash precedent instead: the DETAIL goes to a sidecar file
 * under <home>/thoughts/, and the RECEIPT carries a binding summary —
 * { schema: 'thoughts/1', count, digest } — where digest is SHA-256 over
 * the exact sidecar bytes. The chain stays slim; the detail is
 * tamper-evident through the digest it is bound by.
 *
 * LOTOR_HOME is pointed at a throwaway dir before src/ingest is imported,
 * so nothing here touches the real store.
 */

let tempHome;
let ingestSession;

function line(obj) { return JSON.stringify(obj); }

function buildJsonl(nMessages) {
  const rows = [
    line({ sessionId: 'sidecar-test', version: '2.1.999', type: 'session-start', createdAt: '2026-08-29T11:00:00Z' })
  ];
  for (let i = 0; i < nMessages; i++) {
    rows.push(line({
      timestamp: `2026-08-29T11:00:0${1 + i}Z`,
      message: {
        id: `msg_${i}`, role: 'assistant', model: 'test-model-v1',
        content: [{ type: 'text', text: 'x' }],
        usage: {
          input_tokens: 2 + i, output_tokens: 10 * (i + 1),
          cache_read_input_tokens: 500, cache_creation_input_tokens: 50
        }
      }
    }));
  }
  return rows.join('\n');
}

describe('ingest: thought sidecar bound to the receipt by digest', () => {
  before(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-thoughts-'));
    process.env.LOTOR_HOME = tempHome;
    ({ ingestSession } = await import('../src/ingest/index.js'));
  });

  after(() => {
    delete process.env.LOTOR_HOME;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (_) {}
  });

  it('receipt carries {schema, count, digest}; sidecar bytes hash to the digest', () => {
    const result = ingestSession(buildJsonl(3));
    assert.strictEqual(result.skipped, false);

    const t = result.entry.payload.cost.thoughts;
    assert.ok(!Array.isArray(t), 'chain payload must not carry the row array');
    assert.strictEqual(t.schema, 'thoughts/1');
    assert.strictEqual(t.count, 3);
    assert.match(t.digest, /^[0-9a-f]{64}$/);

    const sidecar = path.join(tempHome, 'thoughts', 'sidecar-test-s0.jsonl');
    assert.ok(fs.existsSync(sidecar), 'sidecar file written under <home>/thoughts/');
    const bytes = fs.readFileSync(sidecar);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(digest, t.digest, 'digest binds the exact sidecar bytes');

    const rows = bytes.toString('utf-8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].id, 'msg_0');
    assert.strictEqual(rows[2].output, 30);
  });

  it('a grown transcript appends subsession 1 with its own sidecar', () => {
    const result = ingestSession(buildJsonl(5));
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.subsession, 1);
    const t = result.entry.payload.cost.thoughts;
    assert.strictEqual(t.count, 5);
    const sidecar = path.join(tempHome, 'thoughts', 'sidecar-test-s1.jsonl');
    assert.ok(fs.existsSync(sidecar));
  });

  it('a no-change ingest skips and writes no new sidecar', () => {
    const beforeFiles = fs.readdirSync(path.join(tempHome, 'thoughts'));
    const result = ingestSession(buildJsonl(5));
    assert.strictEqual(result.skipped, true);
    const afterFiles = fs.readdirSync(path.join(tempHome, 'thoughts'));
    assert.deepStrictEqual(afterFiles, beforeFiles);
  });
});
