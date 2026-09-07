/**
 * src/views/chapters.js
 *
 * The chapters view: what happened, grouped the way a reader thinks.
 * Session first, then chapter, where a chapter is one operator prompt and
 * everything the agent did in response to it.
 *
 * WHY THIS EXISTS
 *   The chain answers "which sessions ran and what did each touch". It has
 *   no per-turn rows at all, so it cannot answer "what was the third thing I
 *   asked for, and what did that one touch". The Codex app shows exactly that
 *   list per turn. Lotor, as the witness, should be the thing that produces it
 *   across runtimes, and should say plainly which parts of it are witnessed.
 *
 * WHERE THE DATA COMES FROM, AND WHAT THAT MEANS
 *   Chapters are derived from TRANSCRIPTS on disk, not from the chain. For a
 *   Claude Code session the chain's `session-open` row carries the transcript
 *   path and the session receipt carries `transcriptHash`, so the transcript
 *   can be located and checked against what the receipt bound. For a Codex
 *   session there is no chain row at all: the rollout file is read from disk
 *   and nothing attests it. Both facts are printed in the report's own output.
 *
 * WHAT IS DELIBERATELY NOT CARRIED
 *   A chapter title is the first ~80 characters of the operator's own prompt.
 *   Nothing else textual crosses into this view: no assistant text, no tool
 *   parameters beyond the file paths that Edit/Write already put in `touched`.
 *   Receipts carry digests, not content, and this view keeps that discipline
 *   even though it is reading the raw transcript.
 *
 * CLAUDE CODE TRANSCRIPT SHAPE (read 2026-09-07 from a live
 * ~/.claude/projects/<project>/<session>.jsonl, first 30 lines)
 *   - Operator prompts: `type: "user"`, `message.role: "user"`, and
 *     `message.content` is either a string or an array of `{type:"text"}`.
 *   - Tool results: also `message.role: "user"`, but `message.content` is an
 *     array of `{type:"tool_result"}` items. Not a prompt.
 *   - `attachment` rows (hook output, environment, instructions) have no
 *     `message` at all. `queue-operation`, `last-prompt`, `custom-title`,
 *     `atis-latch` rows likewise. All skipped.
 *   - Sub-agent lines carry `isSidechain: true`. Their "user" messages are the
 *     agent prompting itself, not the operator, so they never start a chapter.
 *     Their tool calls are counted into the chapter that was open.
 *   - Timestamps are `timestamp` on real transcripts, `createdAt` on the
 *     repo's fixtures. Either is accepted, `createdAt` first (same rule as
 *     src/parser/index.js entryTimestamp).
 *
 * CODEX ROLLOUT SHAPE (read 2026-09-07 from
 * memory/imports/codex/2026/09/06/rollout-2026-09-06T00-00-21-*.jsonl and
 * rollout-2026-09-06T17-26-02-*.jsonl, redacted to keys and lengths)
 *   Every line is `{ timestamp, ordinal, type, payload }`.
 *   - `session_meta`: payload.session_id / id, cwd, originator, source,
 *     thread_source (cli | vscode | automation | subagent), git.
 *   - `world_state`: payload.state.model names the model.
 *   - `event_msg` with payload.type `task_started` / `task_complete`
 *     bracket a turn and carry `turn_id`. `turn_context` repeats turn_id.
 *   - `response_item` with payload.type `message` and payload.role `user`
 *     is the input side. It is NOT always the operator: the harness injects
 *     AGENTS.md text, plugin recommendations and environment context as user
 *     messages too. They are told apart by
 *     `payload.internal_chat_message_metadata_passthrough.content_item_kinds`,
 *     an array aligned with `payload.content`: operator items are `user.text`
 *     / `user.image`; injected ones are `agents_md.instructions`,
 *     `plugins.recommendations`, `environments.environment_context`,
 *     `goal.internal_context`. A user message is a chapter boundary only if
 *     at least one kind starts with `user.`. When the kinds array is absent
 *     the fallback is: an `input_text` item whose text does not open with
 *     `<` or `# AGENTS.md`.
 *   - `response_item` / `message` / role `assistant`: one assistant turn.
 *   - `response_item` / `function_call` (name, arguments: JSON string) and
 *     `custom_tool_call` (name, input: string) are tool calls. Seen names:
 *     exec_command, exec, apply_patch, spawn_agent, send_message,
 *     automation_update. Outputs are `function_call_output` /
 *     `custom_tool_call_output` with an `output` string that, for shell and
 *     patch tools, opens with `Exit code: N`.
 *   - Touched paths come from apply_patch bodies: `*** Add File:`,
 *     `*** Update File:`, `*** Delete File:` lines. Codex has no structured
 *     file_path parameter, so this is a text match on the patch header and
 *     is a heuristic, named as such in KNOWN-LIMITS.
 *   - Sub-agent rollouts (`thread_source: subagent`) replay the parent's
 *     operator prompts with identical timestamps before their own work. They
 *     chapter the same way; the meta line says they are sub-agents.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { typeOf, resolveSince } from './since.js';

const TITLE_LEN = 80;

/** Collapse whitespace and cut to the title length. Operator words only. */
function makeTitle(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= TITLE_LEN) return flat;
  return flat.slice(0, TITLE_LEN - 1).trimEnd() + '…';
}

function newChapter(index, startedAt, title) {
  return {
    index,
    startedAt: startedAt ?? null,
    endedAt: startedAt ?? null,
    title,
    turns: 0,
    toolCalls: 0,
    tools: {},
    touched: [],
    failures: 0
  };
}

function parseLines(jsonlText) {
  return String(jsonlText ?? '')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/** Shared accumulator: chapters open on demand, activity lands on the open one. */
function makeBook() {
  const chapters = [];
  let current = null;
  const open = (ts, title) => {
    current = newChapter(chapters.length + 1, ts, title);
    chapters.push(current);
    return current;
  };
  // Activity before any operator prompt (a resumed session, a hook-driven
  // start) still needs a home. It gets an untitled chapter rather than being
  // dropped, because dropped activity is the one thing this view must not do.
  const ensure = ts => current ?? open(ts, null);
  const touch = (ts) => { if (current && ts) current.endedAt = ts; };
  return {
    chapters,
    open,
    turn(ts) { const c = ensure(ts); c.turns++; touch(ts); },
    call(ts, name) {
      const c = ensure(ts);
      c.toolCalls++;
      const key = name || 'unknown';
      c.tools[key] = (c.tools[key] ?? 0) + 1;
      touch(ts);
    },
    path(ts, p) {
      const c = ensure(ts);
      if (p && !c.touched.includes(p)) c.touched.push(p);
      touch(ts);
    },
    fail(ts) { const c = ensure(ts); c.failures++; touch(ts); }
  };
}

/* ------------------------------------------------------------------ */
/* Claude Code                                                         */
/* ------------------------------------------------------------------ */

const CLAUDE_TS = e => e?.createdAt || e?.timestamp || null;

/**
 * Harness-injected wrappers that ride inside a user message but are not the
 * operator speaking. Stripped before deciding whether any prompt text is left.
 */
const CLAUDE_NOISE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g
];

/** @returns {string|null} operator text of a user line, or null if it is not one */
function claudeUserText(entry) {
  const m = entry?.message;
  if (!m || m.role !== 'user') return null;
  let text;
  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    const texts = m.content.filter(i => i?.type === 'text' && typeof i.text === 'string');
    if (texts.length === 0) return null; // tool_result-only, or image-only
    text = texts.map(i => i.text).join('\n');
  } else {
    return null;
  }
  for (const re of CLAUDE_NOISE) text = text.replace(re, '');
  return text.trim() === '' ? null : text;
}

const FILE_TOOLS = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };

/**
 * @param {string} jsonlText raw Claude Code transcript
 * @returns {Array} chapters
 */
export function chaptersFromClaudeTranscript(jsonlText) {
  const book = makeBook();
  for (const e of parseLines(jsonlText)) {
    const msg = e?.message;
    if (!msg) continue;
    const ts = CLAUDE_TS(e);

    if (msg.role === 'user') {
      if (e.isSidechain !== true) {
        const text = claudeUserText(e);
        if (text !== null) { book.open(ts, makeTitle(text)); continue; }
      }
      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item?.type === 'tool_result' && item.is_error === true) book.fail(ts);
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      book.turn(ts);
      if (!Array.isArray(msg.content)) continue;
      for (const item of msg.content) {
        if (item?.type !== 'tool_use') continue;
        book.call(ts, item.name);
        const key = FILE_TOOLS[item.name];
        const p = key ? item.input?.[key] : undefined;
        if (typeof p === 'string' && p) book.path(ts, p);
      }
    }
  }
  return book.chapters;
}

/* ------------------------------------------------------------------ */
/* Codex                                                               */
/* ------------------------------------------------------------------ */

function codexUserText(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const kinds = payload?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (Array.isArray(kinds)) {
    if (!kinds.some(k => typeof k === 'string' && k.startsWith('user.'))) return null;
    // Prefer the item the harness itself labelled as operator text.
    for (let i = 0; i < content.length; i++) {
      if (kinds[i] === 'user.text' && typeof content[i]?.text === 'string' && content[i].text.trim()) {
        return content[i].text;
      }
    }
    const any = content.find(c => c?.type === 'input_text' && typeof c.text === 'string' && c.text.trim());
    return any ? any.text : '(image)';
  }
  // No kinds array: fall back to the shape of the text.
  const plain = content.find(c =>
    c?.type === 'input_text' && typeof c.text === 'string' &&
    c.text.trim() !== '' &&
    !c.text.trimStart().startsWith('<') &&
    !c.text.trimStart().startsWith('# AGENTS.md'));
  return plain ? plain.text : null;
}

const PATCH_FILE = /\*\*\* (?:Add|Update|Delete) File: ([^\n"\\]+?)(?=\\n|\n|"|$)/g;

/** Paths named in an apply_patch body, wherever it sits in the call. */
function codexPatchPaths(payload) {
  const raw = typeof payload.input === 'string'
    ? payload.input
    : (typeof payload.arguments === 'string' ? payload.arguments : '');
  if (!raw.includes('*** ')) return [];
  const out = [];
  for (const m of raw.matchAll(PATCH_FILE)) {
    const p = m[1].trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * @param {string} jsonlText raw Codex rollout
 * @returns {Array} chapters
 */
export function chaptersFromCodexRollout(jsonlText) {
  const book = makeBook();
  for (const o of parseLines(jsonlText)) {
    if (o?.type !== 'response_item') continue;
    const p = o.payload || {};
    const ts = o.timestamp || null;
    switch (p.type) {
      case 'message':
        if (p.role === 'user') {
          const text = codexUserText(p);
          if (text !== null) book.open(ts, makeTitle(text));
        } else if (p.role === 'assistant') {
          book.turn(ts);
        }
        break;
      case 'function_call':
      case 'custom_tool_call':
        book.call(ts, p.name);
        for (const path of codexPatchPaths(p)) book.path(ts, path);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const out = typeof p.output === 'string' ? p.output : '';
        const m = /^Exit code:\s*(-?\d+)/.exec(out);
        if ((m && Number(m[1]) !== 0) || p.status === 'failed') book.fail(ts);
        break;
      }
      default:
        break;
    }
  }
  return book.chapters;
}

/** Session-level facts from a rollout, for the report header. Metadata only. */
export function codexRolloutMeta(jsonlText) {
  const meta = {
    sessionId: null, cwd: null, model: null, originator: null,
    source: null, threadSource: null, startedAt: null, endedAt: null
  };
  for (const o of parseLines(jsonlText)) {
    if (o?.timestamp) {
      if (!meta.startedAt) meta.startedAt = o.timestamp;
      meta.endedAt = o.timestamp;
    }
    const p = o?.payload || {};
    if (o?.type === 'session_meta') {
      meta.sessionId = p.session_id ?? p.id ?? null;
      meta.cwd = p.cwd ?? null;
      meta.originator = p.originator ?? null;
      meta.source = p.source ?? null;
      meta.threadSource = p.thread_source ?? null;
    } else if (o?.type === 'world_state' && !meta.model) {
      meta.model = p.state?.model ?? null;
    }
  }
  return meta;
}

/* ------------------------------------------------------------------ */
/* Binding                                                             */
/* ------------------------------------------------------------------ */

export const CHAPTERS_SCHEMA = 'chapters/1';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted = {};
  for (const k of Object.keys(value).sort()) sorted[k] = canonicalize(value[k]);
  return sorted;
}

/**
 * The canonical text a receipt would bind: the chapter list with every
 * title removed, keys sorted at every depth, arrays in order. Titles are
 * operator words and never enter the chain; everything else in a chapter
 * is counts, timestamps and paths, which `touched` already puts there.
 */
export function chaptersCanonical(chapters) {
  const rows = (Array.isArray(chapters) ? chapters : []).map(c => {
    const { title, ...rest } = c;
    return canonicalize(rest);
  });
  return JSON.stringify(rows);
}

/**
 * `{ schema, count, digest }`, same shape as the thoughts binding that
 * src/ingest/index.js writes into `cost.thoughts`. This is what the queued
 * proposal (proposals/chapters-witness-2026-09-07.md) would put on the
 * session receipt. Exported now so the view can verify it once it lands.
 */
export function chaptersBinding(chapters) {
  const text = chaptersCanonical(chapters);
  return {
    schema: CHAPTERS_SCHEMA,
    count: Array.isArray(chapters) ? chapters.length : 0,
    digest: crypto.createHash('sha256').update(text, 'utf8').digest('hex')
  };
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const CODEX_CAVEAT =
  'Codex rollouts are read from disk and are not attested by the chain. ' +
  'No session-open, no receipt, no transcript hash: nothing here is witnessed.';

const isoToMs = iso => {
  const n = Date.parse(iso ?? '');
  return Number.isNaN(n) ? null : n;
};

function readFileSafe(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

/**
 * Build the report.
 *
 * @param {Array}  entries chain entries, oldest first
 * @param {object} opts
 * @param {number|string|{seq:number}} [opts.since]
 * @param {string} [opts.sessionId]        only this session
 * @param {Array<{runtime:string,path:string}>} [opts.extraTranscripts]
 *        transcripts not on the chain (Codex rollouts). Reported unwitnessed.
 */
export function chaptersReport(entries, opts = {}) {
  const all = Array.isArray(entries) ? entries : [];
  const sinceTs = resolveSince(opts.since, all);
  const rows = sinceTs === null ? all : all.filter(e => e.timestamp >= sinceTs);

  const sessions = new Map();
  const ensure = id => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        sessionId: id, runtime: 'claude-code',
        opened: null, closed: null, source: null, cwd: null, model: null,
        transcriptPath: null, receiptSeq: null, receiptCounts: null,
        transcriptHash: null, chaptersBinding: null,
        witnessed: false, transcriptHashMatches: null, chaptersDigestMatches: null,
        chapters: null, reason: null, caveats: []
      });
    }
    return sessions.get(id);
  };

  for (const e of rows) {
    const p = e.payload || {};
    const t = typeOf(p);
    if (t === 'session-open') {
      if (!p.sessionId) continue;
      const s = ensure(p.sessionId);
      if (s.opened === null) {
        s.opened = e.timestamp;
        s.source = p.source ?? null;
        s.cwd = p.cwd ?? null;
      }
      // A resume re-opens with the same path; the latest open is the one
      // that still points at a file if the harness ever moved it.
      if (typeof p.transcriptPath === 'string' && p.transcriptPath) s.transcriptPath = p.transcriptPath;
    } else if (t === 'session') {
      const id = p.session?.id;
      if (!id) continue;
      const s = ensure(id);
      s.closed = e.timestamp;
      s.receiptSeq = e.seq;
      s.witnessed = true;
      s.model = p.session?.model ?? s.model;
      s.receiptCounts = p.counts ?? s.receiptCounts;
      if (typeof p.transcriptHash === 'string') s.transcriptHash = p.transcriptHash;
      // Not written by anything today. Read so the view verifies it the day
      // the queued proposal lands, without a second change here.
      if (p.chapters && typeof p.chapters.digest === 'string') s.chaptersBinding = p.chapters;
    }
  }

  let list = [...sessions.values()];
  if (opts.sessionId) list = list.filter(s => s.sessionId === opts.sessionId);

  for (const s of list) {
    if (!s.transcriptPath) {
      s.reason = 'no transcriptPath on any session-open row';
      continue;
    }
    const bytes = readFileSafe(s.transcriptPath);
    if (bytes === null) {
      s.reason = 'transcript not found on disk';
      continue;
    }
    s.chapters = chaptersFromClaudeTranscript(bytes.toString('utf8'));
    if (s.transcriptHash) {
      // Same bytes-first rule as bin/hook-session-end: hash the file, not
      // a string round-trip. A mismatch usually means the transcript kept
      // growing after the receipt was written (a resumed session), so it is
      // reported, not treated as tampering.
      const now = crypto.createHash('sha256').update(bytes).digest('hex');
      s.transcriptHashMatches = now === s.transcriptHash;
    }
    if (s.chaptersBinding) {
      s.chaptersDigestMatches = chaptersBinding(s.chapters).digest === s.chaptersBinding.digest;
    }
    if (!s.witnessed) s.caveats.push('no session receipt on the chain for this session; chapters are unwitnessed');
    else if (s.transcriptHashMatches === false) s.caveats.push('transcript bytes differ from what the receipt bound; chapters after the receipt are unwitnessed');
  }

  const extra = [];
  for (const x of Array.isArray(opts.extraTranscripts) ? opts.extraTranscripts : []) {
    if (!x || typeof x.path !== 'string') continue;
    const rec = {
      sessionId: null, runtime: x.runtime ?? 'unknown',
      opened: null, closed: null, source: null, cwd: null, model: null,
      transcriptPath: x.path, receiptSeq: null, receiptCounts: null,
      transcriptHash: null, chaptersBinding: null,
      witnessed: false, transcriptHashMatches: null, chaptersDigestMatches: null,
      chapters: null, reason: null, caveats: []
    };
    const bytes = readFileSafe(x.path);
    if (bytes === null) {
      rec.reason = 'transcript not found on disk';
      extra.push(rec);
      continue;
    }
    const text = bytes.toString('utf8');
    if (rec.runtime === 'codex') {
      const meta = codexRolloutMeta(text);
      rec.sessionId = meta.sessionId;
      rec.cwd = meta.cwd;
      rec.model = meta.model;
      rec.source = meta.threadSource ? `${meta.originator ?? 'codex'}/${meta.threadSource}` : meta.originator;
      rec.opened = isoToMs(meta.startedAt);
      rec.closed = isoToMs(meta.endedAt);
      rec.chapters = chaptersFromCodexRollout(text);
      rec.caveats.push(CODEX_CAVEAT);
    } else if (rec.runtime === 'claude-code') {
      rec.chapters = chaptersFromClaudeTranscript(text);
      rec.caveats.push('read from disk, not located through the chain; unwitnessed');
    } else {
      rec.reason = `unknown runtime "${rec.runtime}"`;
    }
    if (sinceTs !== null && rec.opened !== null && rec.opened < sinceTs) continue;
    if (opts.sessionId && rec.sessionId !== opts.sessionId) continue;
    extra.push(rec);
  }

  const out = [...list, ...extra];
  out.sort((a, b) => (a.opened ?? a.closed ?? 0) - (b.opened ?? b.closed ?? 0));

  return {
    window: {
      from: sinceTs,
      to: rows.length ? rows[rows.length - 1].timestamp : null,
      entryCount: rows.length
    },
    sessions: out,
    caveats: [
      'Intent is not recorded. A chapter shows which tools ran and which files were named, never why.',
      'A chapter title is the operator\'s own words, quoted. It is not a claim about what was done.',
      'Chapters come from transcripts on disk, not from the chain. The chain witnesses the session receipt, not this list.',
      'Codex sessions are not on the chain at all. Their chapters are unattested.',
      'Capture is self-attested. A session with no chapters means nothing was recorded, not that nothing happened.'
    ]
  };
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

const stamp = ms =>
  ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString();

const hhmm = iso => {
  const ms = typeof iso === 'number' ? iso : isoToMs(iso);
  if (ms === null) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Human-readable render. Same plain style as renderSince. */
export function renderChapters(report) {
  const L = [];
  const w = report.window;

  L.push('');
  L.push('CHAPTERS: WHAT WAS ASKED, SESSION BY SESSION');
  L.push('='.repeat(66));
  L.push(`  window        ${stamp(w.from)}  ->  ${stamp(w.to)}`);
  L.push(`  chain rows    ${w.entryCount}`);
  L.push(`  sessions      ${report.sessions.length}`);
  L.push('');

  if (report.sessions.length === 0) {
    L.push('  No session in this window.');
    L.push('  That means nothing was RECORDED. It does not mean nothing ran.');
    L.push('');
  }

  for (const s of report.sessions) {
    L.push(`  ${s.sessionId ?? '(no session id)'}`);
    L.push(`    runtime     ${s.runtime}${s.source ? `  (${s.source})` : ''}`);
    if (s.model) L.push(`    model       ${s.model}`);
    L.push(`    opened      ${stamp(s.opened)}`);
    if (s.cwd) L.push(`    cwd         ${s.cwd}`);
    let wit = s.witnessed ? `yes  (receipt seq ${s.receiptSeq})` : 'NO';
    if (s.transcriptHashMatches === true) wit += ', transcript hash matches';
    else if (s.transcriptHashMatches === false) wit += ', transcript hash DOES NOT match';
    if (s.chaptersDigestMatches === true) wit += ', chapter digest matches';
    else if (s.chaptersDigestMatches === false) wit += ', chapter digest DOES NOT match';
    else if (s.witnessed) wit += ' (receipt binds the session, not the chapter list)';
    L.push(`    witnessed   ${wit}`);
    if (s.chapters === null) {
      L.push(`    chapters    none: ${s.reason ?? 'unknown reason'}`);
    } else if (s.chapters.length === 0) {
      L.push('    chapters    none recorded in the transcript');
    } else {
      for (const c of s.chapters) {
        const files = c.touched.length;
        const title = c.title === null ? '(no prompt recorded)' : `"${c.title}"`;
        const tail = `(${c.toolCalls} tool call${c.toolCalls === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}${c.failures ? `, ${c.failures} failed` : ''})`;
        L.push(`    #${String(c.index).padEnd(3)} ${hhmm(c.startedAt)}  ${title}  ${tail}`);
      }
    }
    for (const c of s.caveats) L.push(`    note        ${c}`);
    L.push('');
  }

  L.push('  WHAT THIS DOES NOT TELL YOU');
  for (const c of report.caveats) L.push(`    - ${c}`);
  L.push('');

  return L.join('\n');
}
