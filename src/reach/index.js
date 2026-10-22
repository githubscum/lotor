/**
 * src/reach/index.js
 *
 * The reach certificate (Lotor v3, work order V3-02).
 *
 * WHAT IT IS
 *   A statement, on the chain, of how deep the record of a session goes: the
 *   model, the runtime, and the deepest rung of the v3 ladder actually
 *   recorded. The ladder, top to bottom (LOTOR-V3-SPEC-2026-10-18):
 *
 *     R0 declared             what the agent says (text it emits)
 *     R1 actions              tool calls, targets, params digest
 *     R2 tool I/O             what each tool returned
 *     R3 reasoning trace      thinking emitted between actions
 *     R4 token probabilities  logprobs for emitted tokens
 *     R5 activations          internal features at chosen layers
 *     R6 weights and bits     the model itself
 *
 *   Depth increases with the number. "Deepest" means the highest-numbered rung
 *   with a record, and the per-rung map travels with it, because reach is not
 *   contiguous: V3-01 measured qwen2.5 giving R4 with no R3.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: MEASURED, NOT DECLARED
 *   A certificate is computed from what came back and what was kept, never
 *   from what was requested, configured or claimed. V3-01 found the failure in
 *   live form: Ollama cloud accepts a logprobs request, answers HTTP 200, and
 *   silently leaves the field out. A recorder that trusted the request would
 *   certify R4 it never received, and every finding built on it would claim
 *   depth its record does not have. So:
 *
 *     - Nothing in a hook payload or a transcript that DECLARES a rung is read.
 *       Only response-side fields that are present and non-empty count.
 *     - A rung is "recorded" only when the receipt holds a per-item record of
 *       it AND the transcript carried it. Both halves, so neither a receipt
 *       that claims more than the transcript held, nor a transcript the
 *       receipt never kept, can raise the certificate. That is the ceiling:
 *       recorded implies observed, always.
 *
 * TWO HALVES, BECAUSE THE RUNG IS ONLY KNOWABLE LATER
 *   Open (session-open receipt): model and runtime as the harness states them,
 *   each with its basis, and the rung marked "not-yet-measured". At open
 *   nothing has been emitted, so any rung stated there would be a guess.
 *   The Lotor build is not repeated: the same payload's `observer` field
 *   already carries the package version and the whole-tree source digest.
 *
 *   Close (session receipt, written at SessionEnd by src/ingest): the
 *   measurement. Model from the assistant messages themselves, runtime from
 *   the session's open receipt on the chain, every rung measured.
 *
 * ABSENCE READS AS "unrecorded", NEVER AS ZERO
 *   A rung with nothing carries `{ status: 'unrecorded' }` and no count field
 *   at all. A count of 0 would read as "measured, and the model did none of
 *   this", which is a claim about the model the record cannot back: a model
 *   that thought without exposing it looks identical to one that did not
 *   think. Same convention as session.thinkingBlocks and the subagent summary.
 *
 * WHAT THIS IS NOT
 *   Not a judgement of intent (the meter does that, never Lotor). Not proof
 *   that the transcript is the whole session (transcriptHash proves what was
 *   hashed, not completeness). Not authentication of the model id: the id is
 *   what the runtime wrote into its own messages, self-attested like capture
 *   itself (KNOWN-LIMITS 1). R3 here is the thinking the runtime chose to
 *   expose, which V3-01 could not establish is the raw trace rather than a
 *   vendor summary; it is evidence to read, not testimony.
 */

/** Schema marker, so a later shape change is visible rather than silent. */
export const REACH_SCHEMA = 'reach/1';

/** The ladder, shallowest first. Index is depth. */
export const RUNGS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6'];

export const UNRECORDED = 'unrecorded';
export const NOT_YET_MEASURED = 'not-yet-measured';

const STATUSES = new Set(['recorded', 'observed', UNRECORDED]);

/** Cap on any model id, so a hostile or broken value cannot bloat entries. */
const MAX_ID_LENGTH = 128;

/**
 * Where each recordable rung lives on the session receipt in this build.
 * A rung absent from this table has no per-item record in Lotor today, so it
 * can be observed but never recorded. V3-03 (R2) and V3-04 (R3 per step) add
 * entries here when their records land; nothing else needs to change.
 */
const RECORD_FIELDS = {
  R1: { field: 'ran', count: summary => lengthOf(summary?.ran) },
  R3: { field: 'session.thinkingBlocks', count: summary => lengthOf(summary?.session?.thinkingBlocks) }
};

function lengthOf(v) {
  return Array.isArray(v) ? v.length : 0;
}

function cleanId(value) {
  const raw = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' && typeof value.id === 'string' ? value.id : null);
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_ID_LENGTH ? trimmed.slice(0, MAX_ID_LENGTH) : trimmed;
}

// ---------- open half ----------

/**
 * Certificate for the session-open receipt. States only what is known at open.
 *
 * @param {Object} [payload] - the SessionStart hook payload as received
 * @param {Object} [harness] - resolveHarness(payload), already on the receipt
 */
export function buildOpenCertificate(payload, harness) {
  const id = cleanId(payload && typeof payload === 'object' ? payload.model : null);
  return {
    schema: REACH_SCHEMA,
    phase: 'open',
    // Declared by the harness, and labelled so. The close half measures it.
    model: id ? { id, basis: 'harness-payload' } : { id: UNRECORDED, basis: 'none' },
    runtime: harness && typeof harness.name === 'string'
      ? { harness: harness.name, basis: harness.basis || 'unknown' }
      : { harness: UNRECORDED, basis: 'unknown' },
    lotorBuild: { see: 'observer' },
    rungs: NOT_YET_MEASURED,
    deepestRecorded: NOT_YET_MEASURED,
    measuredOn: 'close'
  };
}

// ---------- close half ----------

/** Present and non-empty, which is the only way a response field counts. */
function nonEmpty(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') {
    // OpenAI-style { content: [...] } wrapper: the wrapper alone is not data.
    if (Array.isArray(v.content)) return v.content.length > 0;
    return Object.keys(v).length > 0;
  }
  return false;
}

function emptyTally() {
  const t = {};
  for (const r of RUNGS) t[r] = 0;
  return t;
}

/**
 * One pass over the raw transcript, counting what the RESPONSE side carried
 * at each rung, overall and per model. Request-side and declared fields are
 * never read. The predicates for R1 and R3 match the parser's exactly (every
 * tool_use; every thinking block with non-empty text), so what the parser
 * records and what this pass observes count the same things.
 */
function observeTranscript(jsonlText) {
  const overall = emptyTally();
  const byModel = {};
  const models = [];
  const toolModel = new Map();

  const lines = typeof jsonlText === 'string' ? jsonlText.split('\n') : [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let entry;
    try { entry = JSON.parse(l); } catch (_) { continue; }
    const msg = entry && entry.message;
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'assistant') {
      // Same bucket key as cost.byModel, so the two join.
      const model = typeof msg.model === 'string' && msg.model ? msg.model : 'unknown';
      if (!byModel[model]) { byModel[model] = emptyTally(); models.push(model); }
      const tally = byModel[model];
      const bump = r => { overall[r]++; tally[r]++; };

      if (typeof msg.content === 'string') {
        if (msg.content.trim() !== '') bump('R0');
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (!item || typeof item !== 'object') continue;
          if (item.type === 'text' && typeof item.text === 'string' && item.text.trim() !== '') bump('R0');
          else if (item.type === 'tool_use') {
            bump('R1');
            if (typeof item.id === 'string') toolModel.set(item.id, model);
          } else if (item.type === 'thinking') {
            const t = typeof item.thinking === 'string' ? item.thinking
              : (typeof item.text === 'string' ? item.text : '');
            if (t.length > 0) bump('R3');
          }
        }
      }
      // R4 counts once per message that carried logprobs anywhere on the
      // response side: the message, the line, or a content item.
      const itemLogprobs = Array.isArray(msg.content)
        && msg.content.some(i => i && typeof i === 'object' && nonEmpty(i.logprobs));
      if (nonEmpty(msg.logprobs) || nonEmpty(entry.logprobs) || itemLogprobs) bump('R4');
      // R5 and R6 are never read from a transcript: no runtime Lotor sits on
      // exposes them there, and a field named `activations` in a message is a
      // claim, not a capture. They stay unrecorded until a capture path exists.
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item && item.type === 'tool_result') {
          overall.R2++;
          const model = toolModel.get(item.tool_use_id);
          if (model && byModel[model]) byModel[model].R2++;
        }
      }
    }
  }
  return { overall, byModel, models };
}

/**
 * Build the rung map from an observed tally and the receipt's records.
 * `recordedCounts` is null for a per-model map, where recorded status is
 * inherited from the overall map (the parser records every instance).
 */
function rungMap(observed, recordedCounts, overallRungs) {
  const rungs = {};
  for (const r of RUNGS) {
    const seen = observed[r];
    const rec = RECORD_FIELDS[r];
    let isRecorded = false;
    let recordedN = 0;
    if (rec && seen > 0) {
      if (recordedCounts) {
        recordedN = recordedCounts[r] || 0;
        isRecorded = recordedN > 0;
      } else {
        isRecorded = overallRungs?.[r]?.status === 'recorded';
      }
    }
    if (isRecorded) {
      rungs[r] = recordedCounts
        ? { status: 'recorded', observed: seen, recorded: recordedN, field: rec.field }
        : { status: 'recorded', observed: seen, field: rec.field };
    } else if (seen > 0) {
      rungs[r] = { status: 'observed', observed: seen };
    } else {
      rungs[r] = { status: UNRECORDED };
    }
  }
  return rungs;
}

function deepest(rungs, statuses) {
  for (let i = RUNGS.length - 1; i >= 0; i--) {
    if (statuses.includes(rungs[RUNGS[i]]?.status)) return RUNGS[i];
  }
  return UNRECORDED;
}

/**
 * Certificate for the session receipt, measured.
 *
 * @param {Object} summary - parseSession() output: the receipt about to be chained
 * @param {string} jsonlText - the transcript the summary was parsed from
 */
export function measureCloseCertificate(summary, jsonlText) {
  const seen = observeTranscript(jsonlText);
  const recordedCounts = {};
  for (const r of Object.keys(RECORD_FIELDS)) recordedCounts[r] = RECORD_FIELDS[r].count(summary);

  const rungs = rungMap(seen.overall, recordedCounts, null);
  const byModel = {};
  for (const m of seen.models) {
    const mr = rungMap(seen.byModel[m], null, rungs);
    byModel[m] = {
      deepestRecorded: deepest(mr, ['recorded']),
      deepestObserved: deepest(mr, ['recorded', 'observed']),
      rungs: mr
    };
  }

  const measuredModel = cleanId(summary?.session?.model);
  const version = summary?.session?.version;
  return {
    schema: REACH_SCHEMA,
    phase: 'close',
    // The last model the runtime wrote into its own messages, plus every
    // model seen. Self-attested by the runtime, measured by Lotor.
    model: {
      id: measuredModel || UNRECORDED,
      basis: 'transcript-messages',
      models: seen.models.slice().sort()
    },
    // Filled from the session's open receipt by attachOpenReference, inside
    // the chain lock. Until then, and when there is no open, it says so.
    runtime: {
      harness: UNRECORDED,
      basis: 'unknown',
      harnessVersion: typeof version === 'string' && version && version !== 'unknown' ? version : UNRECORDED
    },
    opened: UNRECORDED,
    lotorBuild: { see: 'session-open observer' },
    rungs,
    deepestRecorded: deepest(rungs, ['recorded']),
    deepestObserved: deepest(rungs, ['recorded', 'observed']),
    byModel
  };
}

/**
 * Link a close certificate to the latest session-open for the same session on
 * the chain, and take the runtime from it. Called inside the append lock so
 * the reference is the chain's own, not a transcript's claim. Returns a new
 * object; the input is not mutated.
 */
export function attachOpenReference(cert, entries, sessionId) {
  let open = null;
  if (Array.isArray(entries) && sessionId != null) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const p = entries[i]?.payload;
      if (p && p.type === 'session-open' && p.sessionId === sessionId) { open = entries[i]; break; }
    }
  }
  if (!open) return { ...cert, opened: UNRECORDED };
  const h = open.payload.harness;
  return {
    ...cert,
    opened: { seq: open.seq, hash: open.hash },
    runtime: {
      ...cert.runtime,
      harness: h && typeof h.name === 'string' ? h.name : UNRECORDED,
      basis: h && typeof h.basis === 'string' ? h.basis : 'unknown'
    }
  };
}

// ---------- checking ----------

/**
 * Check a certificate's internal consistency and, given the receipt it sits
 * on, that its recorded counts are backed by the receipt's own fields. For
 * readers (the meter, a verifier): a certificate that fails here is claiming
 * depth its record does not hold, and must not be relied on.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkCertificate(cert, receipt) {
  const problems = [];
  if (!cert || typeof cert !== 'object') return { ok: false, problems: ['no certificate'] };
  if (cert.schema !== REACH_SCHEMA) problems.push(`unknown schema ${cert.schema}`);

  if (cert.phase === 'open') {
    if (cert.deepestRecorded !== NOT_YET_MEASURED) problems.push('open certificate states a deepestRecorded rung');
    if (cert.rungs !== NOT_YET_MEASURED) problems.push('open certificate states rungs');
    return { ok: problems.length === 0, problems };
  }
  if (cert.phase !== 'close') {
    problems.push(`unknown phase ${cert.phase}`);
    return { ok: false, problems };
  }

  const checkMap = (rungs, where, inherit) => {
    if (!rungs || typeof rungs !== 'object') { problems.push(`${where}: no rungs`); return; }
    for (const r of RUNGS) {
      const e = rungs[r];
      if (!e || !STATUSES.has(e.status)) { problems.push(`${where}.${r}: bad status`); continue; }
      if (e.status === UNRECORDED) {
        if ('observed' in e || 'recorded' in e) problems.push(`${where}.${r}: unrecorded carries a count`);
        continue;
      }
      if (!(Number.isInteger(e.observed) && e.observed > 0)) {
        problems.push(`${where}.${r}: ${e.status} without an observed count`);
      }
      if (e.status === 'recorded') {
        if (!RECORD_FIELDS[r]) problems.push(`${where}.${r}: recorded, but this build has no record field for it`);
        if (!inherit && !(Number.isInteger(e.recorded) && e.recorded > 0)) {
          problems.push(`${where}.${r}: recorded without a recorded count`);
        }
      }
    }
  };

  checkMap(cert.rungs, 'rungs', false);
  if (problems.length === 0) {
    const dr = deepest(cert.rungs, ['recorded']);
    const dobs = deepest(cert.rungs, ['recorded', 'observed']);
    if (cert.deepestRecorded !== dr) problems.push(`deepestRecorded ${cert.deepestRecorded} != measured ${dr}`);
    if (cert.deepestObserved !== dobs) problems.push(`deepestObserved ${cert.deepestObserved} != measured ${dobs}`);
  }
  for (const [m, entry] of Object.entries(cert.byModel || {})) {
    checkMap(entry?.rungs, `byModel[${m}]`, true);
    if (entry?.rungs) {
      for (const r of RUNGS) {
        if (entry.rungs[r]?.status === 'recorded' && cert.rungs?.[r]?.status !== 'recorded') {
          problems.push(`byModel[${m}].${r}: recorded for a model but not for the session`);
        }
      }
      if (entry.deepestRecorded !== deepest(entry.rungs, ['recorded'])) {
        problems.push(`byModel[${m}].deepestRecorded does not match its rungs`);
      }
    }
  }

  if (receipt && typeof receipt === 'object') {
    for (const [r, rec] of Object.entries(RECORD_FIELDS)) {
      const e = cert.rungs?.[r];
      if (e?.status === 'recorded' && e.recorded !== rec.count(receipt)) {
        problems.push(`${r}: certificate says ${e.recorded} recorded, receipt ${rec.field} holds ${rec.count(receipt)}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
