import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Thought sidecar reader (KNOWN-LIMITS 60, reader half).
 *
 * src/views/thoughts.js reads back what src/ingest/index.js bound: each
 * receipt's cost.thoughts { schema, count, digest } is checked against the
 * sidecar file under <home>/thoughts/, and the directory is checked against
 * the receipts for orphans. A mismatch means the file's bytes changed; a
 * missing file deliberately does not guess between a crash between the
 * chain append and the sidecar write and a later deletion, because the
 * chain cannot tell them apart.
 *
 * LOTOR_HOME is pointed at a throwaway dir before src/ingest is imported,
 * so nothing here touches the real store.
 */

let tempHome;
let ingestSession;
let checkThoughtSidecars;

// Entries collected across the scenario steps, in work-order order.
const collected = [];
const thoughtless = [];

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

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

describe('views: thought sidecar check', () => {
  before(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-thoughts-read-'));
    process.env.LOTOR_HOME = tempHome;
    ({ ingestSession } = await import('../src/ingest/index.js'));
    ({ checkThoughtSidecars } = await import('../src/views/thoughts.js'));
  });

  after(() => {
    delete process.env.LOTOR_HOME;
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch (_) {}
  });

  it('a fresh sidecar reads back as match', () => {
    const { entry } = ingestSession(buildJsonl(3));
    assert.strictEqual(entry.payload.session.subsession, 0);
    collected.push(entry);

    const { rows, summary } = checkThoughtSidecars([entry], tempHome);
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(r.status, 'match');
    assert.strictEqual(r.sessionId, 'sidecar-test');
    assert.strictEqual(r.subsession, 0);
    assert.strictEqual(r.count, 3);
    assert.strictEqual(r.digest, entry.payload.cost.thoughts.digest);
    assert.strictEqual(r.file, path.join(tempHome, 'thoughts', 'sidecar-test-s0.jsonl'));
    assert.strictEqual(r.actualDigest, r.digest);
    assert.deepStrictEqual(summary, {
      match: 1, mismatch: 0, missing: 0, 'none-expected': 0, orphan: 0, malformed: 0
    });
  });

  it('an edited sidecar reads back as mismatch with the hash found', () => {
    const sidecar = path.join(tempHome, 'thoughts', 'sidecar-test-s0.jsonl');
    fs.appendFileSync(sidecar, 'X');

    const { rows, summary } = checkThoughtSidecars(collected, tempHome);
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(r.status, 'mismatch');
    assert.notStrictEqual(r.actualDigest, r.digest);
    // The hash reported is over the raw bytes now on disk.
    assert.strictEqual(r.actualDigest, sha256(fs.readFileSync(sidecar)));
    assert.deepStrictEqual(summary, {
      match: 0, mismatch: 1, missing: 0, 'none-expected': 0, orphan: 0, malformed: 0
    });
  });

  it('a deleted sidecar reads back as missing, without guessing the cause', () => {
    fs.rmSync(path.join(tempHome, 'thoughts', 'sidecar-test-s0.jsonl'));

    const { rows, summary } = checkThoughtSidecars(collected, tempHome);
    assert.strictEqual(rows.length, 1);
    const r = rows[0];
    assert.strictEqual(r.status, 'missing');
    assert.strictEqual(r.actualDigest, null);
    assert.strictEqual(r.error, undefined, 'a plain absence carries no error message');
    assert.deepStrictEqual(summary, {
      match: 0, mismatch: 0, missing: 1, 'none-expected': 0, orphan: 0, malformed: 0
    });
  });

  it('an entry with count 0 reads back as none-expected, file null', () => {
    const entry0 = {
      seq: 999,
      timestamp: Date.now(),
      payload: {
        session: { id: 'empty-session', subsession: 0 },
        cost: { thoughts: { schema: 'thoughts/1', count: 0, digest: sha256('') } }
      }
    };
    collected.push(entry0);

    const { rows, summary } = checkThoughtSidecars(collected, tempHome);
    assert.strictEqual(rows.length, 2);
    const r = rows[1];
    assert.strictEqual(r.status, 'none-expected');
    assert.strictEqual(r.file, null);
    assert.strictEqual(r.actualDigest, null);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.sessionId, 'empty-session');
    assert.deepStrictEqual(summary, {
      match: 0, mismatch: 0, missing: 1, 'none-expected': 1, orphan: 0, malformed: 0
    });
  });

  it('a stray file in thoughts/ is reported as one orphan', () => {
    const stray = path.join(tempHome, 'thoughts', 'stray-s7.jsonl');
    fs.writeFileSync(stray, 'hello\n', 'utf-8');

    const { rows, summary } = checkThoughtSidecars(collected, tempHome);
    const orphans = rows.filter(r => r.status === 'orphan');
    assert.strictEqual(orphans.length, 1);
    const o = orphans[0];
    assert.strictEqual(o.sessionId, null);
    assert.strictEqual(o.subsession, null);
    assert.strictEqual(o.count, null);
    assert.strictEqual(o.digest, null);
    assert.strictEqual(o.file, stray);
    assert.strictEqual(o.actualDigest, null);
    assert.deepStrictEqual(summary, {
      match: 0, mismatch: 0, missing: 1, 'none-expected': 1, orphan: 1, malformed: 0
    });
  });

  it('entries without cost.thoughts are skipped entirely', () => {
    thoughtless.push(
      { payload: { session: { id: 'bare-session', subsession: 0 } } },
      { payload: { session: { id: 'cost-only', subsession: 0 }, cost: { usd: 0 } } }
    );

    const before = checkThoughtSidecars(collected, tempHome);
    const after = checkThoughtSidecars([...collected, ...thoughtless], tempHome);
    assert.strictEqual(after.rows.length, before.rows.length);
    assert.deepStrictEqual(after.summary, before.summary);
  });

  it('a home with no thoughts dir: rows [] and all summary counts 0, no throw', () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-nothoughts-'));
    try {
      const bare = checkThoughtSidecars([], emptyHome);
      assert.deepStrictEqual(bare.rows, []);
      assert.deepStrictEqual(bare.summary, {
        match: 0, mismatch: 0, missing: 0, 'none-expected': 0, orphan: 0, malformed: 0
      });

      // Entries with no thought binding against the same empty home.
      const withEntries = checkThoughtSidecars(thoughtless, emptyHome);
      assert.deepStrictEqual(withEntries.rows, []);
      assert.deepStrictEqual(withEntries.summary, {
        match: 0, mismatch: 0, missing: 0, 'none-expected': 0, orphan: 0, malformed: 0
      });
    } finally {
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('a hostile sessionId resolves inside <home>/thoughts/', () => {
    const hostile = {
      payload: {
        session: { id: '../x', subsession: 0 },
        cost: { thoughts: { schema: 'thoughts/1', count: 1, digest: sha256('hostile\n') } }
      }
    };

    const { rows } = checkThoughtSidecars([hostile], tempHome);
    // The shared tempHome still holds stray-s7.jsonl from the orphan test,
    // so one orphan row is in here too; the assertions below are about the
    // hostile receipt's own row only.
    const nonOrphans = rows.filter(r => r.status !== 'orphan');
    assert.strictEqual(nonOrphans.length, 1);
    const r = nonOrphans[0];
    assert.strictEqual(r.file, path.join(tempHome, 'thoughts', '___x-s0.jsonl'));
    const rel = path.relative(path.join(tempHome, 'thoughts'), r.file);
    assert.ok(!rel.startsWith('..'), 'the hostile id must not traverse out of thoughts/');
    assert.strictEqual(path.isAbsolute(rel), false);
  });

  it('a binding with a malformed count or digest reads back as malformed, file null', () => {
    // Each of these bindings was well-formed enough to carry the schema
    // string, but its count or digest cannot point at any real sidecar:
    // there was nothing expected at any path, so file is null and a stray
    // file on disk stays an orphan, not a match.
    const malformed = [
      { payload: { session: { id: 'mal-undef', subsession: 0 }, cost: { thoughts: { schema: 'thoughts/1', count: undefined, digest: sha256('m1\n') } } } },
      { payload: { session: { id: 'mal-neg', subsession: 0 }, cost: { thoughts: { schema: 'thoughts/1', count: -1, digest: sha256('m2\n') } } } },
      { payload: { session: { id: 'mal-nothex', subsession: 0 }, cost: { thoughts: { schema: 'thoughts/1', count: 1, digest: 'nothex' } } } }
    ];

    const { rows, summary } = checkThoughtSidecars(malformed, tempHome);
    // The shared tempHome still carries stray-s7.jsonl from the orphan
    // test, which surfaces here as one orphan row; the assertions below
    // are about the three malformed bindings themselves.
    const nonOrphans = rows.filter(r => r.status !== 'orphan');
    assert.strictEqual(nonOrphans.length, 3);
    for (const r of nonOrphans) {
      assert.strictEqual(r.status, 'malformed');
      assert.strictEqual(r.file, null);
      assert.strictEqual(r.actualDigest, null);
    }
    assert.strictEqual(summary.malformed, 3);
  });
});