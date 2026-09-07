import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Subagent sidecar wiring into ingestSession (WO-INGEST-WIRE).
 *
 * ingestSession now reads opts.transcriptPath and, when a sibling
 * <sessionId>/subagents/ directory exists, binds summarizeSubagents'
 * summary onto receiptSummary.subagents before the append. When the
 * directory is absent (or no transcriptPath was given), the field is
 * OMITTED — never null, never a false zero — mirroring subagents.js.
 *
 * LOTOR_HOME is pointed at a throwaway dir before src/ingest is imported,
 * so nothing here touches the real store. Fixture transcripts are written
 * under a second throwaway dir and referenced by absolute path.
 */

let tempHome;
let tempTranscripts;
let ingestSession;

function line(obj) { return JSON.stringify(obj); }

// Minimal valid session transcript, the same shape used by the thoughts
// sidecar test. One session-start row plus one assistant message is enough
// for parseSession to produce a receipt.
//
// sessionId must be UNIQUE PER TEST: all four tests share one LOTOR_HOME
// store (see `before`, below), and ingestSession's no-change guard skips
// any session whose transcript has not grown since its last receipt. Two
// tests calling ingestSession with the *same* sessionId and *same*-size
// text would see the second call skipped (result.skipped === true), which
// is a real behavior of the store, not a defect in the wiring under test.
// The first version of this file passed one fixed id to every test and
// three of the four failed on exactly this collision.
function buildJsonl(sessionId) {
  const rows = [
    line({ sessionId, version: '2.1.999', type: 'session-start', createdAt: '2026-09-03T11:00:00Z' }),
    line({
      timestamp: '2026-09-03T11:00:01Z',
      message: {
        id: 'msg_0', role: 'assistant', model: 'test-model-v1',
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 2, output_tokens: 4 }
      }
    })
  ];
  return rows.join('\n');
}

// The subagents directory that collectSubagents looks for, relative to a
// parent transcript path: <dir>/<basename without .jsonl>/subagents/.
function subagentsDir(transcriptPath) {
  return path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, '.jsonl'),
    'subagents'
  );
}

describe('ingest: subagent summary wired into ingestSession', () => {
  before(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-wire-home-'));
    tempTranscripts = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-wire-tx-'));
    process.env.LOTOR_HOME = tempHome;
    ({ ingestSession } = await import('../src/ingest/index.js'));
  });

  after(() => {
    delete process.env.LOTOR_HOME;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(tempTranscripts, { recursive: true, force: true }); } catch (_) {}
  });

  it('transcriptPath with no sibling subagents dir -> no subagents field on the receipt', () => {
    const transcriptPath = path.join(tempTranscripts, 'none.jsonl');
    // Deliberately do not create the subagents directory.
    const result = ingestSession(buildJsonl('wiring-test-1'), { transcriptPath });
    assert.strictEqual(result.skipped, false);
    assert.ok(
      !('subagents' in result.entry.payload),
      'payload must not carry a subagents field when no sidecar dir exists (not null, absent)'
    );
    assert.strictEqual(result.entry.payload.subagents, undefined);
  });

  it('sibling subagents dir with one child -> subagents.count 1 and exact token totals', () => {
    const transcriptPath = path.join(tempTranscripts, 'parent.jsonl');
    const dir = subagentsDir(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });
    // One valid child row.
    fs.writeFileSync(
      path.join(dir, 'agent-a1.jsonl'),
      line({
        agentId: 'a1',
        sessionId: 'parent-id',
        message: { model: 'm', usage: { input_tokens: 10, output_tokens: 5 } }
      }) + '\n',
      'utf-8'
    );

    const result = ingestSession(buildJsonl('wiring-test-2'), { transcriptPath });
    assert.strictEqual(result.skipped, false);
    const sub = result.entry.payload.subagents;
    assert.ok(sub, 'payload must carry a subagents summary when a sidecar dir exists');
    assert.strictEqual(sub.schema, 'subagents/1');
    assert.strictEqual(sub.count, 1);
    assert.strictEqual(sub.totals.inputTokens, 10);
    assert.strictEqual(sub.totals.outputTokens, 5);
  });

  it('ingestSession(text) with no opts at all does not throw and omits subagents', () => {
    assert.doesNotThrow(() => {
      const result = ingestSession(buildJsonl('wiring-test-3'));
      assert.strictEqual(result.skipped, false);
      assert.ok(
        !('subagents' in result.entry.payload),
        'single-arg callers must not get a subagents field'
      );
    });
  });

  it('ingestSession(text, { transcriptBytes }) keeps working and omits subagents', () => {
    const text = buildJsonl('wiring-test-4');
    const result = ingestSession(text, { transcriptBytes: Buffer.from(text) });
    assert.strictEqual(result.skipped, false);
    assert.ok(
      !('subagents' in result.entry.payload),
      'existing transcriptBytes callers must not get a subagents field'
    );
  });
});