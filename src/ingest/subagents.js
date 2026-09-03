import fs from 'node:fs';
import path from 'node:path';

/**
 * src/ingest/subagents.js
 *
 * Read-only ingest of Claude Code subagent (sidechain) transcripts.
 *
 * A parent session writes <dir>/<sessionId>.jsonl; each child it dispatches
 * writes <dir>/<sessionId>/subagents/agent-<agentId>.jsonl. This module turns
 * those child files into structured summaries a receipt can bind. It is pure
 * with respect to the chain and the store: it imports nothing from the
 * project, writes no files, and every function tolerates a missing, empty, or
 * malformed input without throwing.
 */

/** A value that is not a finite number contributes 0 to a sum. */
function finiteOrZero(n) {
  return Number.isFinite(n) ? n : 0;
}

/** Recover an agentId from a filename shaped `agent-<id>.jsonl`. */
function agentIdFromFilename(name) {
  const m = /^agent-(.+)\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

/**
 * Summarize one child transcript file.
 *
 * @param {string} file - Absolute path to the agent-*.jsonl file
 * @param {string} basename - Filename, used to recover agentId if no row carries one
 * @returns {Object} child summary, or `{ __unreadable: basename }` if the file
 *   could not be read at all (caller moves that into `unreadable`).
 */
function summarizeChild(file, basename) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (_) {
    return { __unreadable: basename };
  }

  let rows = 0;
  let malformedRows = 0;
  let agentId = null;
  let parentSessionId = null;
  let parentToolUseUuid = null;
  let model = null;
  const modelSet = new Set();
  let cwd = null;
  let gitBranch = null;
  const requestIds = [];
  const requestIdSeen = new Set();
  let sidechainHasField = false;
  let sidechainAllTrue = true;
  let startedAt = null;
  let endedAt = null;
  let assistantTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;

  for (const raw of text.split('\n')) {
    // A trailing newline yields a final empty element; it is not a line of
    // content, so skip it without counting it as malformed.
    if (raw.length === 0) continue;

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      malformedRows++;
      continue;
    }
    rows++;

    if (agentId === null && obj.agentId != null) agentId = String(obj.agentId);
    if (parentSessionId === null && obj.sessionId != null) parentSessionId = String(obj.sessionId);
    if (parentToolUseUuid === null && obj.sourceToolAssistantUUID != null) {
      parentToolUseUuid = String(obj.sourceToolAssistantUUID);
    }
    if (cwd === null && obj.cwd != null) cwd = String(obj.cwd);
    if (gitBranch === null && obj.gitBranch != null) gitBranch = String(obj.gitBranch);

    if (obj.requestId != null && !requestIdSeen.has(obj.requestId)) {
      requestIdSeen.add(obj.requestId);
      requestIds.push(String(obj.requestId));
    }

    // isSidechain is null when no row carries the field at all, true only when
    // every row that carries it has it true, false otherwise.
    if (Object.prototype.hasOwnProperty.call(obj, 'isSidechain')) {
      sidechainHasField = true;
      if (obj.isSidechain !== true) sidechainAllTrue = false;
    }

    if (obj.timestamp != null) {
      const ts = String(obj.timestamp);
      if (startedAt === null || ts < startedAt) startedAt = ts;
      if (endedAt === null || ts > endedAt) endedAt = ts;
    }

    const msg = obj.message;
    if (msg && typeof msg === 'object') {
      if (msg.model != null) {
        const m = String(msg.model);
        modelSet.add(m);
        if (model === null) model = m;
      }
      if (msg.usage != null) {
        assistantTurns++;
        // Defensive summing: a missing or non-finite sub-field contributes 0,
        // so a partially-written or malformed usage object can never produce
        // NaN/undefined that would propagate into a receipt total.
        const u = msg.usage;
        inputTokens += finiteOrZero(u.input_tokens);
        outputTokens += finiteOrZero(u.output_tokens);
        cacheCreationInputTokens += finiteOrZero(u.cache_creation_input_tokens);
        cacheReadInputTokens += finiteOrZero(u.cache_read_input_tokens);
      }
    }
  }

  if (agentId === null) agentId = agentIdFromFilename(basename);

  return {
    agentId,
    parentSessionId,
    parentToolUseUuid,
    model,
    models: [...modelSet].sort(),
    cwd,
    gitBranch,
    requestIds,
    isSidechain: sidechainHasField ? sidechainAllTrue : null,
    startedAt,
    endedAt,
    assistantTurns,
    rows,
    malformedRows,
    usage: { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }
  };
}

/**
 * Collect every child transcript beside a parent transcript.
 *
 * @param {string} transcriptPath - Path to the parent <sessionId>.jsonl
 * @returns {{found: boolean, dir: string, children: Array, unreadable: Array}}
 *
 * The found:false / found:true-with-children:[] split is load-bearing:
 *   - found:false  => there is no subagents directory at all. The parent
 *     dispatched no subagents (or the sidecar path is wrong). A caller should
 *     OMIT the field, not record a zero.
 *   - found:true, children:[] => the directory exists and held no readable
 *     child. That is a real, recorded zero, distinct from "absent".
 */
function collectSubagents(transcriptPath) {
  const dir = path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, '.jsonl'),
    'subagents'
  );

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (_) {
    return { found: false, dir, children: [] };
  }
  if (!stat.isDirectory()) {
    return { found: false, dir, children: [] };
  }

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return { found: false, dir, children: [] };
  }

  const files = entries.filter(n => /^agent-.*\.jsonl$/.test(n)).sort();
  const children = [];
  const unreadable = [];
  for (const name of files) {
    const child = summarizeChild(path.join(dir, name), name);
    if (child && child.__unreadable) {
      unreadable.push(child.__unreadable);
    } else {
      children.push(child);
    }
  }

  return { found: true, dir, children, unreadable };
}

/**
 * Produce a receipt-bindable subagents summary for a parent transcript.
 *
 * Returns null when no subagents directory exists at all, so a caller can
 * omit the field rather than record a false zero. Never computes dollars; a
 * price table, when supplied, is only passed through as a date string.
 *
 * @param {string} transcriptPath - Path to the parent <sessionId>.jsonl
 * @param {{priceTableDate?: string}} [opts]
 */
function summarizeSubagents(transcriptPath, opts = {}) {
  const collected = collectSubagents(transcriptPath);

  // No sidecar dir => null: the caller omits the field entirely rather than
  // recording a false zero. A present-but-empty dir returns count 0 below.
  if (!collected.found) return null;

  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    assistantTurns: 0
  };
  for (const c of collected.children) {
    totals.inputTokens += c.usage.inputTokens;
    totals.outputTokens += c.usage.outputTokens;
    totals.cacheCreationInputTokens += c.usage.cacheCreationInputTokens;
    totals.cacheReadInputTokens += c.usage.cacheReadInputTokens;
    totals.assistantTurns += c.assistantTurns;
  }

  const out = {
    schema: 'subagents/1',
    count: collected.children.length,
    derived: true,
    source: 'transcript-sidecar',
    totals,
    children: collected.children,
    unreadable: collected.unreadable
  };

  if (opts && typeof opts.priceTableDate === 'string' && opts.priceTableDate.length > 0) {
    out.priceTableDate = opts.priceTableDate;
  }

  return out;
}

export { collectSubagents, summarizeSubagents };