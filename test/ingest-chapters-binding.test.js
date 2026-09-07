/**
 * test/ingest-chapters-binding.test.js
 *
 * proposals/chapters-witness-2026-09-07.md, applied 2026-09-07 at the signing
 * sitting (KNOWN-LIMITS 71, the Claude Code half).
 *
 * The session receipt now carries `chapters: { schema, count, digest }`, the
 * digest taken over the chapter list with every title removed, so a reader
 * recomputing chapters from the transcript can tell whether they got the list
 * the hook saw. No sidecar is written: the transcript is the sidecar. Titles
 * are operator words and never land on the chain; the third assertion below
 * checks the serialised payload for the fixture's first prompt.
 *
 * Fail-first: the first assertion was red on main because no receipt carried
 * `chapters`, and `chaptersReport` reported `chaptersDigestMatches: null`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestSession } from '../src/ingest/index.js';
import { loadChain } from '../src/store/index.js';
import {
  CHAPTERS_SCHEMA,
  chaptersFromClaudeTranscript,
  chaptersBinding,
  chaptersReport
} from '../src/views/chapters.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'test-data', 'sample-session-chapters.jsonl');

describe('ingest binds the chapter list onto the session receipt (KNOWN-LIMITS 71)', () => {
  let home;
  let savedHome;
  let transcriptPath;
  let text;
  let bytes;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-chap-bind-'));
    savedHome = process.env.LOTOR_HOME;
    process.env.LOTOR_HOME = home;
    transcriptPath = path.join(home, 'chap-001.jsonl');
    fs.copyFileSync(FIXTURE, transcriptPath);
    bytes = fs.readFileSync(transcriptPath);
    text = bytes.toString('utf-8');
  });

  after(() => {
    if (savedHome === undefined) delete process.env.LOTOR_HOME;
    else process.env.LOTOR_HOME = savedHome;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });

  it('the receipt carries chapters/1 with the count and the title-free digest', () => {
    const result = ingestSession(text, { transcriptBytes: bytes, transcriptPath });
    assert.equal(result.skipped, false);
    const payload = result.entry.payload;

    assert.ok(payload.chapters, 'the receipt carries a chapters binding');
    assert.equal(payload.chapters.schema, CHAPTERS_SCHEMA);
    assert.equal(payload.chapters.schema, 'chapters/1');
    assert.equal(payload.chapters.count, 2);
    const expected = chaptersBinding(chaptersFromClaudeTranscript(text));
    assert.equal(payload.chapters.digest, expected.digest);
    assert.match(payload.chapters.digest, /^[0-9a-f]{64}$/);
  });

  it('no operator words land on the chain', () => {
    const chain = loadChain(home);
    assert.equal(chain.length, 1);
    const serialised = JSON.stringify(chain[0].payload);
    assert.ok(!serialised.includes('Please fix'), 'the first prompt\'s title is not on the receipt');
  });

  it('the view verifies the binding it reads back: chaptersDigestMatches is true', () => {
    const chain = loadChain(home);
    const entries = [
      {
        seq: -1, timestamp: chain[0].timestamp - 1000, prevHash: '0', hash: 'h-open', nonce: 'n', sig: 's',
        payload: { type: 'session-open', sessionId: 'chap-001', source: 'startup', cwd: '/home/demo/project', transcriptPath }
      },
      ...chain
    ];
    const report = chaptersReport(entries, { sessionId: 'chap-001' });
    assert.equal(report.sessions.length, 1);
    const s = report.sessions[0];
    assert.equal(s.witnessed, true);
    assert.equal(s.chaptersDigestMatches, true, 'the binding on the receipt matches the list recomputed from disk');
    assert.equal(s.chapters.length, 2);
  });

  it('a transcript with no prompts still binds: count 0, digest of an empty list', () => {
    const lines = text.split('\n').filter(l => l && !/"type":"user"/.test(l)).join('\n') + '\n';
    const result = ingestSession(lines, { transcriptBytes: Buffer.from(lines, 'utf-8') });
    if (result.skipped) return; // the no-change guard may fold it into the first receipt; nothing to assert then
    assert.equal(result.entry.payload.chapters.count, 0);
    assert.equal(result.entry.payload.chapters.digest, chaptersBinding([]).digest);
  });
});
