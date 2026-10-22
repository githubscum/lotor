/**
 * src/reach/certificate.js
 *
 * The reach certificate (Lotor v3, work order V3-02).
 *
 * (src/reach/index.js is the V3-05 observer, observeRungs and reachReport.
 * The certificate lives beside it in its own module so the two lanes do not
 * share one file.)
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
 *
 * NO TRANSCRIPT STRING IS EVER AN OBJECT KEY
 *   A model id is whatever the runtime wrote, so it can be "__proto__" or
 *   "constructor". Used as a key on a plain object, such a string reads or
 *   writes the shared builtins (review F1, PR #70). Tallies are kept in Maps,
 *   and the certificate carries per-model reach as a LIST of entries with the
 *   id as a value. A keyed object would not be safe even with a null
 *   prototype: the chain canonicaliser rebuilds objects by assignment, which
 *   drops an own "__proto__" key from the hash, so that entry could be edited
 *   without breaking verification (KNOWN-LIMITS, queued core patch).
 */

import crypto from 'node:crypto';

/** Schema marker, so a later shape change is visible rather than silent. */
export const REACH_SCHEMA = 'reach/1';

/** The ladder, shallowest first. Index is depth. */
export const RUNGS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6'];

export const UNRECORDED = 'unrecorded';
export const NOT_YET_MEASURED = 'not-yet-measured';

/**
 * model.id on a close certificate when the transcript carried more than one
 * model. deepestRecorded is the session's union, so pairing it with any one
 * model's id would state that model reached a rung it may not have. With
 * several models the per-model entries in byModel are the answer, and
 * model.lastSeen still says which model wrote last.
 */
export const MULTIPLE_MODELS = 'multiple';

/**
 * The rung fields of a close certificate whose measurement threw. Distinct
 * from "unrecorded" on purpose: "unrecorded" is a measurement that found
 * nothing, this is a measurement that never ran.
 */
export const MEASUREMENT_FAILED = 'measurement-failed';

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

/** A transcript string field, trimmed and capped; anything else is null. */
function cleanString(value) {
  return typeof value === 'string' ? cleanId(value) : null;
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
  // Keyed by a transcript-controlled string, so a Map, never a plain object.
  // Insertion order is first-seen order.
  const byModel = new Map();
  const toolModel = new Map();
  let lastModel = null;

  const lines = typeof jsonlText === 'string' ? jsonlText.split('\n') : [];
  for (const l of lines) {
    if (!l.trim()) continue;
    let entry;
    try { entry = JSON.parse(l); } catch (_) { continue; }
    const msg = entry && entry.message;
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'assistant') {
      // Same bucket name as cost.byModel ("unknown" when absent), so the two
      // join for any id up to MAX_ID_LENGTH; longer ids are capped here
      // because this copy lands on the chain once per receipt.
      const measured = cleanString(msg.model);
      if (measured) lastModel = measured;
      const model = measured || 'unknown';
      let tally = byModel.get(model);
      if (!tally) { tally = emptyTally(); byModel.set(model, tally); }
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
      // R4 counts once per message that carried logprobs on the response
      // side: the message itself or one of its content items. A logprobs
      // field on the transcript LINE is not read: from the shape alone it
      // cannot be told apart from a request echo, and an unreadable field
      // must under-claim, never over-claim.
      const itemLogprobs = Array.isArray(msg.content)
        && msg.content.some(i => i && typeof i === 'object' && nonEmpty(i.logprobs));
      if (nonEmpty(msg.logprobs) || itemLogprobs) bump('R4');
      // R5 and R6 are never read from a transcript: no runtime Lotor sits on
      // exposes them there, and a field named `activations` in a message is a
      // claim, not a capture. They stay unrecorded until a capture path exists.
    } else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item && item.type === 'tool_result') {
          overall.R2++;
          const caller = byModel.get(toolModel.get(item.tool_use_id));
          if (caller) caller.R2++;
        }
      }
    }
  }
  return { overall, byModel, lastModel };
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
  const models = [...seen.byModel.keys()].sort();
  // Per-model reach as a list, sorted by id: the id is a value, never a key
  // (see the header). One entry per model the transcript carried.
  const byModel = models.map(m => {
    const mr = rungMap(seen.byModel.get(m), null, rungs);
    return {
      model: m,
      deepestRecorded: deepest(mr, ['recorded']),
      deepestObserved: deepest(mr, ['recorded', 'observed']),
      rungs: mr
    };
  });

  const version = cleanString(summary?.session?.version);
  return {
    schema: REACH_SCHEMA,
    phase: 'close',
    // Self-attested by the runtime, measured by Lotor, from the same pass
    // as the rungs. `id` stands beside deepestRecorded, so it names a model
    // only when there was exactly one; with several it says so, and the
    // per-model answer is in byModel. `lastSeen` is the last model the
    // runtime wrote into its own messages, whatever the count.
    model: {
      id: models.length > 1 ? MULTIPLE_MODELS : (seen.lastModel || UNRECORDED),
      lastSeen: seen.lastModel || UNRECORDED,
      basis: 'transcript-messages',
      models
    },
    // Filled from the session's open receipt by attachOpenReference, inside
    // the chain lock. Until then, and when there is no open, it says so.
    runtime: {
      harness: UNRECORDED,
      basis: 'unknown',
      harnessVersion: version && version !== 'unknown' ? version : UNRECORDED
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
 * Close certificate for a measurement that threw. The session keeps its
 * receipt; the certificate says the measurement failed, in the rung fields
 * themselves, so a reader that never runs checkCertificate still cannot
 * mistake it for "measured, nothing found".
 *
 * Nothing of the exception's text reaches the chain: messages in this
 * codebase can embed the offending value, and the value here is transcript
 * content. Only a code (the error's own code or name, when it is a plain
 * identifier) and a digest of the message, enough to match a local log.
 */
export function failedCloseCertificate(err) {
  const ident = v => (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(v) ? v : null);
  const code = ident(err?.code) || (err instanceof Error ? ident(err.name) : null) || 'Error';
  let text;
  try { text = String(err && typeof err === 'object' && 'message' in err ? err.message : err); } catch (_) { text = ''; }
  return {
    schema: REACH_SCHEMA,
    phase: 'close',
    status: MEASUREMENT_FAILED,
    rungs: MEASUREMENT_FAILED,
    deepestRecorded: MEASUREMENT_FAILED,
    deepestObserved: MEASUREMENT_FAILED,
    failed: {
      code,
      digest: crypto.createHash('sha256').update(text, 'utf-8').digest('hex')
    }
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
  if (cert.status === MEASUREMENT_FAILED || cert.rungs === MEASUREMENT_FAILED) {
    problems.push('measurement failed: no rung was measured, so none may be relied on');
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
  // Per-model reach is a list with the id as a value. A keyed object is
  // refused rather than read: its keys are transcript strings (review F1).
  const perModel = cert.byModel;
  const listed = [];
  if (!Array.isArray(perModel)) {
    problems.push('byModel is not a list');
  } else {
    for (const entry of perModel) {
      if (!entry || typeof entry !== 'object' || typeof entry.model !== 'string') {
        problems.push('byModel: entry without a model id');
        continue;
      }
      const m = entry.model;
      if (listed.includes(m)) problems.push(`byModel[${m}]: listed twice`);
      listed.push(m);
      checkMap(entry.rungs, `byModel[${m}]`, true);
      if (!entry.rungs || typeof entry.rungs !== 'object') continue;
      for (const r of RUNGS) {
        if (entry.rungs[r]?.status === 'recorded' && cert.rungs?.[r]?.status !== 'recorded') {
          problems.push(`byModel[${m}].${r}: recorded for a model but not for the session`);
        }
      }
      if (entry.deepestRecorded !== deepest(entry.rungs, ['recorded'])) {
        problems.push(`byModel[${m}].deepestRecorded does not match its rungs`);
      }
      if (entry.deepestObserved !== deepest(entry.rungs, ['recorded', 'observed'])) {
        problems.push(`byModel[${m}].deepestObserved does not match its rungs`);
      }
    }
  }

  // The model block must agree with the per-model list, and model.id may
  // name a single model only when there was exactly one (review F2).
  const models = cert.model?.models;
  if (!Array.isArray(models)) {
    problems.push('model.models is not a list');
  } else {
    if (Array.isArray(perModel) && JSON.stringify(models) !== JSON.stringify(listed)) {
      problems.push('model.models does not match the byModel entries');
    }
    if (models.length > 1 && cert.model.id !== MULTIPLE_MODELS) {
      problems.push(`model.id names one model of ${models.length}; the session-level rungs are not its own`);
    }
    if (models.length <= 1 && cert.model.id === MULTIPLE_MODELS) {
      problems.push('model.id says multiple, but at most one model is listed');
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
