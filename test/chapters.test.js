/**
 * test/chapters.test.js
 *
 * The chapters view: one operator prompt, one chapter, across runtimes.
 *
 * WHAT THESE HOLD
 *   - A chapter starts at operator text and nowhere else. Tool results,
 *     harness noise wrapped in <system-reminder>, and sub-agent prompts
 *     (isSidechain) never start one.
 *   - Counts inside chapters add up to the counts the session receipt
 *     carries, because the receipt is what the chain witnesses and a chapter
 *     list that disagreed with it would be two stories about one session.
 *   - Codex rollouts chapter on the harness's own `user.*` content kinds, so
 *     injected AGENTS.md / plugin text does not masquerade as a prompt.
 *   - The report says which sessions are witnessed and which are not, and a
 *     Codex session is never witnessed.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  chaptersFromClaudeTranscript,
  chaptersFromCodexRollout,
  codexRolloutMeta,
  chaptersReport,
  renderChapters,
  chaptersCanonical,
  chaptersBinding,
  CHAPTERS_SCHEMA
} from '../src/views/chapters.js';
import { parseSession } from '../src/parser/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURE = path.join(HERE, '..', 'test-data', 'sample-session-chapters.jsonl');
const CODEX_FIXTURE = path.join(HERE, '..', 'test-data', 'sample-codex-rollout.jsonl');

const claudeText = () => fs.readFileSync(CLAUDE_FIXTURE, 'utf8');
const codexText = () => fs.readFileSync(CODEX_FIXTURE, 'utf8');

describe('chaptersFromClaudeTranscript', () => {
  it('opens a chapter at each operator prompt and nowhere else', () => {
    const ch = chaptersFromClaudeTranscript(claudeText());
    assert.equal(ch.length, 2, 'tool_result-only, noise-only and sidechain user lines do not start chapters');
    assert.equal(ch[0].index, 1);
    assert.equal(ch[1].index, 2);
    assert.equal(ch[0].title, 'Please fix the config flag and clean the temp dir');
    assert.equal(ch[1].title, 'Now read the README and summarise', 'whitespace collapsed');
  });

  it('attributes turns, tool calls, touched paths and failures to the open chapter', () => {
    const [a, b] = chaptersFromClaudeTranscript(claudeText());
    assert.equal(a.turns, 3);
    assert.equal(a.toolCalls, 2);
    assert.deepEqual(a.tools, { Edit: 1, Bash: 1 });
    assert.deepEqual(a.touched, ['/home/demo/project/config.js']);
    assert.equal(a.failures, 1);
    assert.equal(a.startedAt, '2026-09-06T10:00:01.000Z');
    assert.equal(a.endedAt, '2026-09-06T10:00:06.000Z');

    // Sub-agent work lands in the chapter that was open, not in a chapter of
    // its own: the operator asked once.
    assert.equal(b.turns, 2);
    assert.deepEqual(b.tools, { Read: 1, Write: 1 });
    assert.deepEqual(b.touched, ['/home/demo/project/notes.md']);
    assert.equal(b.failures, 0);
  });

  it('chapter counts sum to the receipt counts the chain witnesses', () => {
    const ch = chaptersFromClaudeTranscript(claudeText());
    const receipt = parseSession(claudeText());
    const sum = k => ch.reduce((n, c) => n + c[k], 0);
    assert.equal(sum('turns'), receipt.counts.turns);
    assert.equal(sum('toolCalls'), receipt.counts.toolCalls);
    assert.equal(sum('failures'), receipt.counts.failures);
  });

  it('carries no text other than the title', () => {
    for (const c of chaptersFromClaudeTranscript(claudeText())) {
      const keys = Object.keys(c).sort();
      assert.deepEqual(keys, ['endedAt', 'failures', 'index', 'startedAt', 'title', 'toolCalls', 'tools', 'touched', 'turns']);
      const blob = JSON.stringify({ ...c, title: '' });
      assert.ok(!blob.includes('const DEBUG'), 'tool params must not leak');
      assert.ok(!blob.includes('On it.'), 'assistant text must not leak');
    }
  });

  it('cuts titles at about 80 characters', () => {
    const long = 'x'.repeat(300);
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: long }, timestamp: '2026-09-06T10:00:00.000Z' });
    const [c] = chaptersFromClaudeTranscript(line + '\n');
    assert.ok(c.title.length <= 80, `title length ${c.title.length}`);
  });

  it('activity before any prompt gets an untitled chapter rather than being dropped', () => {
    const lines = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: 'r', input: { file_path: '/x' } }] }, timestamp: '2026-09-06T10:00:00.000Z' },
      { type: 'user', message: { role: 'user', content: 'now do the thing' }, timestamp: '2026-09-06T10:00:01.000Z' }
    ].map(l => JSON.stringify(l)).join('\n');
    const ch = chaptersFromClaudeTranscript(lines);
    assert.equal(ch.length, 2);
    assert.equal(ch[0].title, null);
    assert.equal(ch[0].toolCalls, 1);
    assert.equal(ch[1].title, 'now do the thing');
  });

  it('handles the repo fixture shape (createdAt, no type field) and empty input', () => {
    const legacy = fs.readFileSync(path.join(HERE, '..', 'test-data', 'sample-session.jsonl'), 'utf8');
    const ch = chaptersFromClaudeTranscript(legacy);
    assert.equal(ch.length, 1, 'no operator text in that fixture: one untitled chapter holds the work');
    assert.equal(ch[0].title, null);
    assert.equal(ch[0].toolCalls, 4);
    assert.deepEqual(chaptersFromClaudeTranscript(''), []);
    assert.deepEqual(chaptersFromClaudeTranscript('not json\n'), []);
  });
});

describe('chaptersFromCodexRollout', () => {
  it('chapters on user.* content kinds, not on injected harness text', () => {
    const ch = chaptersFromCodexRollout(codexText());
    assert.equal(ch.length, 2, 'the AGENTS.md injection and the developer message are not chapters');
    assert.equal(ch[0].title, 'Patch the readme title');
    assert.equal(ch[1].title, 'Look at this screenshot');
  });

  it('counts calls, patch-header paths and non-zero exit codes', () => {
    const [a, b] = chaptersFromCodexRollout(codexText());
    assert.equal(a.turns, 1);
    assert.equal(a.toolCalls, 2);
    assert.deepEqual(a.tools, { apply_patch: 1, exec_command: 1 });
    assert.deepEqual(a.touched, ['/work/README.md']);
    assert.equal(a.failures, 1, 'Exit code: 1 is a failure');
    assert.equal(a.startedAt, '2026-09-06T12:00:01.000Z');
    assert.equal(a.endedAt, '2026-09-06T12:00:06.000Z');
    assert.equal(b.turns, 1);
    assert.equal(b.toolCalls, 0);
  });

  it('finds patch paths inside a JSON-escaped function_call arguments string', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-06T12:00:00.000Z', type: 'response_item',
      payload: { type: 'function_call', name: 'apply_patch', call_id: 'c',
        arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: /work/new.txt\n+hi\n*** End Patch' }) }
    });
    const [c] = chaptersFromCodexRollout(line);
    assert.deepEqual(c.touched, ['/work/new.txt']);
  });

  it('falls back on text shape when the kinds array is absent', () => {
    const mk = (text) => JSON.stringify({
      timestamp: '2026-09-06T12:00:00.000Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    });
    assert.equal(chaptersFromCodexRollout(mk('<environment_context>x</environment_context>')).length, 0);
    assert.equal(chaptersFromCodexRollout(mk('# AGENTS.md instructions for /w')).length, 0);
    assert.equal(chaptersFromCodexRollout(mk('do the thing')).length, 1);
  });

  it('reads session metadata without content', () => {
    const m = codexRolloutMeta(codexText());
    assert.equal(m.sessionId, 'codex-001');
    assert.equal(m.cwd, '/work');
    assert.equal(m.model, 'gpt-5.3-codex-spark');
    assert.equal(m.threadSource, 'cli');
    assert.equal(m.startedAt, '2026-09-06T12:00:00.000Z');
    assert.equal(m.endedAt, '2026-09-06T12:10:02.000Z');
  });
});

describe('chaptersBinding (what the queued proposal would put on the receipt)', () => {
  it('binds the chapter list with titles removed, so no operator text reaches the chain', () => {
    const ch = chaptersFromClaudeTranscript(claudeText());
    const text = chaptersCanonical(ch);
    assert.ok(!text.includes('Please fix'), 'title must not be in the canonical text');
    assert.ok(!text.includes('"title"'), 'title key must not be in the canonical text');
    assert.ok(text.includes('/home/demo/project/config.js'), 'paths are already on receipts and stay');
    const b = chaptersBinding(ch);
    assert.equal(b.schema, CHAPTERS_SCHEMA);
    assert.equal(b.count, 2);
    assert.match(b.digest, /^[0-9a-f]{64}$/);
  });

  it('is stable under key order and changes when a count changes', () => {
    const ch = chaptersFromClaudeTranscript(claudeText());
    const reordered = ch.map(c => {
      const { title, turns, ...rest } = c;
      return { ...rest, turns, title: 'renamed' };
    });
    assert.equal(chaptersBinding(reordered).digest, chaptersBinding(ch).digest, 'titles and key order do not move the digest');
    const bumped = ch.map((c, i) => i === 0 ? { ...c, toolCalls: c.toolCalls + 1 } : c);
    assert.notEqual(chaptersBinding(bumped).digest, chaptersBinding(ch).digest);
    assert.equal(chaptersBinding([]).count, 0);
    assert.equal(chaptersBinding(null).count, 0);
  });
});

describe('chaptersReport', () => {
  let tmp;
  let transcript;
  let hash;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-chapters-'));
    transcript = path.join(tmp, 'chap-001.jsonl');
    fs.copyFileSync(CLAUDE_FIXTURE, transcript);
    hash = crypto.createHash('sha256').update(fs.readFileSync(transcript)).digest('hex');
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const at = (ms, payload, seq) => ({ seq, timestamp: ms, hash: 'h', payload });
  const T0 = Date.parse('2026-09-06T10:00:00.000Z');

  function chain() {
    return [
      at(T0, { type: 'session-open', sessionId: 'chap-001', source: 'startup', cwd: '/home/demo/project', transcriptPath: transcript }, 1),
      at(T0 + 1000, { type: 'session-open', sessionId: 'gone-002', source: 'startup', cwd: '/x', transcriptPath: path.join(tmp, 'does-not-exist.jsonl') }, 2),
      at(T0 + 2000, { type: 'session-open', sessionId: 'nopath-003', source: 'startup', cwd: '/y' }, 3),
      at(T0 + 3000, { type: 'gated-action', decision: 'denied', action: 'Bash', reason: 'no token' }, 4),
      at(T0 + 600000, {
        session: { id: 'chap-001', model: 'claude-sonnet-5' },
        counts: { turns: 5, toolCalls: 4, failures: 1 },
        touched: [{ path: '/home/demo/project/config.js' }],
        transcriptHash: hash
      }, 5),
      at(T0 + 700000, { type: 'session-open', sessionId: 'late-004', source: 'startup', cwd: '/z', transcriptPath: transcript }, 6)
    ];
  }

  it('locates the transcript through session-open and marks the receipted session witnessed', () => {
    const r = chaptersReport(chain());
    const s = r.sessions.find(x => x.sessionId === 'chap-001');
    assert.ok(s);
    assert.equal(s.runtime, 'claude-code');
    assert.equal(s.witnessed, true);
    assert.equal(s.receiptSeq, 5);
    assert.equal(s.model, 'claude-sonnet-5');
    assert.equal(s.transcriptHashMatches, true);
    assert.equal(s.chapters.length, 2);
    assert.equal(s.reason, null);
  });

  it('reports a session whose transcript is missing, with a reason and no chapters', () => {
    const r = chaptersReport(chain());
    const gone = r.sessions.find(x => x.sessionId === 'gone-002');
    assert.equal(gone.chapters, null);
    assert.match(gone.reason, /not found/);
    const nopath = r.sessions.find(x => x.sessionId === 'nopath-003');
    assert.equal(nopath.chapters, null);
    assert.match(nopath.reason, /transcriptPath/);
  });

  it('a session with a transcript but no receipt is unwitnessed and says so', () => {
    const r = chaptersReport(chain());
    const late = r.sessions.find(x => x.sessionId === 'late-004');
    assert.equal(late.witnessed, false);
    assert.equal(late.transcriptHashMatches, null, 'no receipt, no hash to compare');
    assert.ok(late.chapters.length > 0);
    assert.ok(late.caveats.some(c => /unwitnessed/.test(c)));
  });

  it('flags a transcript that no longer matches the receipt hash', () => {
    const rows = chain();
    rows[4].payload.transcriptHash = 'f'.repeat(64);
    const r = chaptersReport(rows);
    const s = r.sessions.find(x => x.sessionId === 'chap-001');
    assert.equal(s.witnessed, true);
    assert.equal(s.transcriptHashMatches, false);
    assert.ok(s.caveats.some(c => /differ/.test(c)));
  });

  it('verifies a chapters binding on the receipt when one is present (none is written today)', () => {
    const rows = chain();
    const expected = chaptersBinding(chaptersFromClaudeTranscript(claudeText()));
    rows[4].payload.chapters = expected;
    let s = chaptersReport(rows).sessions.find(x => x.sessionId === 'chap-001');
    assert.equal(s.chaptersDigestMatches, true);
    assert.match(renderChapters(chaptersReport(rows)), /chapter digest matches/);

    rows[4].payload.chapters = { ...expected, digest: '0'.repeat(64) };
    s = chaptersReport(rows).sessions.find(x => x.sessionId === 'chap-001');
    assert.equal(s.chaptersDigestMatches, false);

    const plain = chaptersReport(chain()).sessions.find(x => x.sessionId === 'chap-001');
    assert.equal(plain.chaptersDigestMatches, null, 'absent is absent, not false');
    assert.match(renderChapters(chaptersReport(chain())), /binds the session, not the chapter list/);
  });

  it('since narrows by chain row time, and sessionId narrows to one', () => {
    const r = chaptersReport(chain(), { since: T0 + 650000 });
    assert.deepEqual(r.sessions.map(s => s.sessionId), ['late-004']);
    const one = chaptersReport(chain(), { sessionId: 'chap-001' });
    assert.deepEqual(one.sessions.map(s => s.sessionId), ['chap-001']);
    const iso = chaptersReport(chain(), { since: '2026-09-06T10:11:40.000Z' });
    assert.deepEqual(iso.sessions.map(s => s.sessionId), ['late-004']);
  });

  it('extra Codex transcripts are reported unwitnessed with the caveat spelled out', () => {
    const r = chaptersReport(chain(), { extraTranscripts: [{ runtime: 'codex', path: CODEX_FIXTURE }] });
    const c = r.sessions.find(x => x.runtime === 'codex');
    assert.ok(c, 'codex session present');
    assert.equal(c.sessionId, 'codex-001');
    assert.equal(c.witnessed, false);
    assert.equal(c.receiptSeq, null);
    assert.equal(c.model, 'gpt-5.3-codex-spark');
    assert.equal(c.chapters.length, 2);
    assert.ok(c.caveats.some(t => /not attested by the chain/.test(t)));
    assert.ok(r.caveats.some(t => /Codex/.test(t)), 'report-level caveat names Codex');
  });

  it('a missing extra transcript is a reason, not a throw', () => {
    const r = chaptersReport([], { extraTranscripts: [{ runtime: 'codex', path: path.join(tmp, 'nope.jsonl') }] });
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].chapters, null);
    assert.match(r.sessions[0].reason, /not found/);
  });

  it('renders one line per chapter and ends with what it cannot tell you', () => {
    const r = chaptersReport(chain(), { extraTranscripts: [{ runtime: 'codex', path: CODEX_FIXTURE }] });
    const text = renderChapters(r);
    assert.match(text, /#1 {3}\d\d:\d\d {2}"Please fix the config flag and clean the temp dir" {2}\(2 tool calls, 1 file, 1 failed\)/);
    assert.match(text, /"Now read the README and summarise" {2}\(2 tool calls, 1 file\)/);
    assert.match(text, /"Patch the readme title"/);
    assert.match(text, /witnessed {3}yes {2}\(receipt seq 5\), transcript hash matches/);
    assert.match(text, /witnessed {3}NO/);
    assert.match(text, /chapters {4}none: transcript not found on disk/);
    assert.match(text, /not attested by the chain/);
    assert.match(text, /WHAT THIS DOES NOT TELL YOU/);
    assert.match(text, /Intent is not recorded/);
    assert.match(text, /operator's own words, quoted/);
    assert.match(text, /Codex sessions are not on the chain/);
    assert.match(text, /self-attested/);
    assert.ok(!text.includes('On it.'), 'assistant text never renders');
  });
});
