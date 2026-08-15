import crypto from 'node:crypto';

/**
 * src/parser/index.js
 *
 * Claude Code JSONL → structured session receipt.
 */

/**
 * Parse a Claude Code JSONL session file into a structured receipt.
 * @param {string} jsonlText - The raw JSONL content (one JSON object per line)
 * @returns {ReceiptSummary}
 */
function parseSession(jsonlText, opts = {}) {
  // opts.transcriptBytes: when provided, use this byte slice for the
  // transcriptHash. When absent, hash the utf-8 encoding of jsonlText.
  // Same bytes either way in the common case; the session-end hook
  // passes the raw Buffer so the bind does not rely on a round-trip
  // through the JS string type.
  const transcriptBytes = opts.transcriptBytes || Buffer.from(jsonlText, 'utf8');
  const lines = jsonlText.split('\n').filter(line => line.trim());
  const entries = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  // Session metadata from first entry
  const sessionStart = entries.find(e => e.sessionId || e.session_id);
  const session = {
    id: sessionStart?.sessionId || sessionStart?.session_id || 'unknown',
    model: null,
    version: entries.find(e => e.version)?.version || 'unknown',
    startedAt: null,
    endedAt: null
  };

  const ran = [];        // { tool, id, paramsDigest }
  const touched = new Map(); // path -> { via }
  const failed = [];     // { tool, id, errorDigest }
  const cost = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    note: 'tokens only; no USD in source',
    byModel: {} // { "<model-id>": { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, messages } }
  };
  const sent = {
    items: [],
    captureNote: 'self-attested; outbound not fully derivable from JSONL (see KNOWN-LIMITS #2)'
  };

  let turns = 0;
  let toolCalls = 0;
  let failures = 0;
  let assistantMessages = 0;

  // Track tool_use to tool_result linkage
  const toolUseMap = new Map(); // tool_use_id -> { tool, paramsDigest }
  // Dedup usage across the lines Claude Code writes for one assistant message.
  // Each line carries a full, byte-identical copy of message.usage, so we
  // accumulate cost.* only the first time we see a given usage key.
  const seenUsageKeys = new Set();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    // Count assistant turns
    if (entry.message?.role === 'assistant') {
      turns++;
      session.model = entry.message.model || session.model;

      // Token usage (deduped per assistant message)
      if (entry.message.usage) {
        const usageKey = usageIdentity(entry, i);
        if (!seenUsageKeys.has(usageKey)) {
          seenUsageKeys.add(usageKey);
          assistantMessages++;
          const input = entry.message.usage.input_tokens || 0;
          const output = entry.message.usage.output_tokens || 0;
          const cacheCreate = entry.message.usage.cache_creation_input_tokens || 0;
          const cacheRead = entry.message.usage.cache_read_input_tokens || 0;
          cost.inputTokens += input;
          cost.outputTokens += output;
          cost.cacheCreationTokens += cacheCreate;
          cost.cacheReadTokens += cacheRead;
          // Per-model breakdown. A message with no model field lands in the
          // "unknown" bucket rather than being dropped; a sum across buckets
          // is intentionally not produced (see KNOWN-LIMITS #13).
          const modelKey = entry.message.model || 'unknown';
          if (!cost.byModel[modelKey]) {
            cost.byModel[modelKey] = {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              messages: 0
            };
          }
          const bucket = cost.byModel[modelKey];
          bucket.inputTokens += input;
          bucket.outputTokens += output;
          bucket.cacheCreationTokens += cacheCreate;
          bucket.cacheReadTokens += cacheRead;
          bucket.messages += 1;
        }
      }

      // Tool invocations (tool_use content items)
      if (Array.isArray(entry.message.content)) {
        for (const item of entry.message.content) {
          // Per-thinking-block digest (thought-capture tier 1, 2026-08-15).
          // Captured self-report of reasoning emitted at a step in this turn.
          // Same 16-hex format as paramsDigest: short, sortable, never
          // reconstructible without the raw transcript. Full content never
          // enters the receipt. Empty blocks are skipped explicitly so a
          // reader never sees a zero-length entry; a transcript with no
          // thinking blocks yields NO thinkingBlocks field (absence reads
          // "unrecorded", never "no thoughts").
          if (item.type === 'thinking') {
            const thinkingText = typeof item.thinking === 'string'
              ? item.thinking
              : (typeof item.text === 'string' ? item.text : '');
            if (thinkingText.length > 0) {
              const thinkingDigest = crypto.createHash('sha256')
                .update(thinkingText)
                .digest('hex')
                .slice(0, 16);
              if (!session.thinkingBlocks) session.thinkingBlocks = [];
              session.thinkingBlocks.push({
                turn: turns,
                digest: thinkingDigest,
                length: thinkingText.length
              });
            }
            continue;
          }
          if (item.type === 'tool_use') {
            toolCalls++;
            const toolName = item.name || 'unknown';
            const toolId = item.id || `anon-${toolCalls}`;
            const paramsDigest = digestParams(item.input);

            // Observa interop seam, option 2 (OBSERVA-INTEROP-SEAM-SPEC
            // 2026-08-07 §4/§9, wired 2026-08-10). The canonical digest is a
            // SECOND field beside the legacy 16-hex digest, never a
            // replacement: old receipts stay verifiable, and a reader can
            // tell which rule produced which digest by presence + the
            // receiptSchema marker below. Full 256-bit on purpose - the
            // short digest is parser dedup, this one is an evidence seam
            // (spec §5: 64-bit prefixes are birthday-attackable on a laptop).
            const runRecord = {
              tool: toolName,
              id: toolId,
              paramsDigest,
              paramsDigestCanonical: digestParamsCanonical(item.input)
            };
            // Opaque correlation echo: an authorising system (e.g. Observa)
            // may plant `_observaCorrelationId` in the tool input; the
            // witness echoes it verbatim and never interprets it. Bounded
            // and typed so a hostile input cannot bloat or shape the chain.
            const corr = item.input && typeof item.input === 'object'
              ? item.input._observaCorrelationId : undefined;
            if (typeof corr === 'string' && corr.length > 0 && corr.length <= 64) {
              runRecord.correlationIdEcho = corr;
            }
            ran.push(runRecord);
            toolUseMap.set(toolId, { tool: toolName, paramsDigest });

            // Check for network-capable tools for 'sent' tracking
            if (isNetworkTool(toolName, item.input)) {
              sent.items.push({
                tool: toolName,
                target: extractTarget(item.input, toolName)
              });
            }

            // Track file mutations for 'touched'
            if (toolName === 'Edit' || toolName === 'Write') {
              const path = item.input?.file_path;
              if (path) {
                touched.set(path, { via: toolName.toLowerCase() });
              }
            }
          }
        }
      }
    }

    // Tool results (user turn with tool_result content)
    if (entry.message?.role === 'user' && Array.isArray(entry.message.content)) {
      for (const item of entry.message.content) {
        if (item.type === 'tool_result') {
          // Must walk EVERY tool_result to check for is_error
          if (item.is_error === true) {
            failures++;
            const toolInfo = toolUseMap.get(item.tool_use_id);
            const errorDigest = digestContent(item.content);
            failed.push({
              tool: toolInfo?.tool || 'unknown',
              id: item.tool_use_id || 'unknown',
              errorDigest
            });
          }
          // Note: absent is_error = success, no action needed
        }
      }
    }

    // File history tracking (additional touch records)
    if (entry.type === 'file-history-snapshot' && entry.snapshot?.trackedFileBackups) {
      for (const [path, backup] of Object.entries(entry.snapshot.trackedFileBackups)) {
        if (!touched.has(path)) {
          touched.set(path, { via: 'file-history' });
        }
      }
    }

    if (entry.type === 'file-history-delta' && entry.trackingPath) {
      if (!touched.has(entry.trackingPath)) {
        touched.set(entry.trackingPath, { via: 'file-history' });
      }
    }
  }

  // Session timing: first and last entries that actually carry a usable
  // timestamp. Real Claude Code transcripts use `timestamp` on every line and
  // may open or close with metadata lines, so scanning only the first/last
  // entry is not enough. `createdAt` wins when both are present.
  const stamps = entries.map(entryTimestamp).filter(Boolean);
  if (stamps.length > 0) {
    session.startedAt = stamps[0];
    session.endedAt = stamps[stamps.length - 1];
  }

  return {
    session,
    ran,
    touched: Array.from(touched.entries()).map(([path, meta]) => ({ path, ...meta })),
    failed,
    cost: { ...cost, schema: 'cost/3' },
    // receipt/2 (2026-08-10): ran[] items carry paramsDigestCanonical (full
    // 256-bit, params/1 canonicalisation) and may carry correlationIdEcho.
    // Absence of this field is the read hint that a receipt predates the
    // Observa seam wiring; those older receipts carry only the 16-hex digest.
    receiptSchema: 'receipt/2',
    // transcriptHash: pointer with teeth. Binds this receipt to the exact
    // transcript bytes it summarizes, so a missing or altered transcript is
    // a visible gap rather than a silent one. FULL 64-char hex, no slice:
    // this digest runs once per session and bytes-fidelity is the point.
    // It proves what was hashed, not that what was hashed is the whole
    // session (see KNOWN-LIMITS).
    transcriptHash: crypto.createHash('sha256').update(transcriptBytes).digest('hex'),
    sent,
    counts: { turns, toolCalls, failures, transcriptEntries: entries.length, assistantMessages }
  };
}

/**
 * Resolve a stable identity for an assistant entry's usage block so that
 * the several JSONL lines Claude Code writes for one assistant message
 * all collapse to a single key. First non-empty wins:
 *   entry.message.id -> entry.requestId -> entry.uuid -> synthetic fallback
 *
 * The fallback matters: the existing synthetic fixture in
 * test/parser.test.js has assistant messages with NO id/requestId/uuid, and
 * those turns are genuinely distinct. A per-line fallback keeps them apart.
 */
function usageIdentity(entry, lineIndex) {
  const msgId = entry?.message?.id;
  if (typeof msgId === 'string' && msgId.trim() !== '') return `mid:${msgId}`;
  if (typeof entry?.requestId === 'string' && entry.requestId.trim() !== '') return `req:${entry.requestId}`;
  if (typeof entry?.uuid === 'string' && entry.uuid.trim() !== '') return `uuid:${entry.uuid}`;
  // Per-line fallback. The entry index in the JSONL is guaranteed unique
  // for any single parseSession call, so distinct turns with no id stay
  // distinct (matching the synthetic fixture's behavior).
  return `line:${lineIndex}`;
}

/**
 * Extract a usable timestamp from a single JSONL entry.
 * Accepts `createdAt` (fixture / legacy shape) or `timestamp` (real transcripts).
 * @param {Object} entry
 * @returns {string|null} The timestamp string, or null if the entry has none.
 */
function entryTimestamp(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const value = entry.createdAt || entry.timestamp;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Create a short digest of parameters (NOT full content)
 */
function digestParams(input) {
  if (!input) return 'empty';
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Canonicalize a value for hashing: object keys sorted recursively at every
 * depth, arrays kept in their original order, scalars passed through.
 *
 * Implemented locally rather than imported from src/gate/sign.js's
 * sortKeysReplacer because that file is non-delegable core (src/gate/).
 * If a later ceremony dedupes the two canonicalizers, this copy can drop;
 * until then the two are textually similar but semantically identical over
 * JSON-compatible input. Strings, numbers, booleans, and nulls survive
 * `JSON.stringify` unchanged, which is the surface a tool_input carries.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = canonicalize(value[i]);
    return out;
  }
  const sorted = {};
  for (const k of Object.keys(value).sort()) {
    sorted[k] = canonicalize(value[k]);
  }
  return sorted;
}

/**
 * Compute a canonical SHA-256 hex digest of a tool's parameters.
 *
 * Returns the FULL 64-character lowercase hex digest (no truncation), over
 * a canonical serialization where object keys are sorted recursively at
 * every depth and arrays keep their original order. Two inputs that
 * differ only in key ordering hash to the same digest; two inputs that
 * differ in content or array order hash differently.
 *
 * Strings hash as their JSON encoding (so embedded characters are
 * escaped the same way every time); numbers, booleans, and null survive
 * `JSON.stringify` unchanged. `undefined` and function values are
 * dropped by `JSON.stringify`, which matches what a JSON transcript
 * would round-trip.
 *
 * SCHEMA MARKER. The schema marker for receipts that record this digest
 * is `params/1`, extending the `<class>/N` convention `matcher/1`
 * established in src/policy/index.js. The marker is bumped only if the
 * canonicalization method changes (sort strategy, separator choice,
 * escape policy); a change to the function that calls this one does
 * not require bumping it.
 *
 * NOT WIRED INTO RECEIPT EMISSION. This function is exported only.
 * Existing call sites continue to use `digestParams`, which produces a
 * truncated 16-hex digest over an unordered serialization. Callers that
 * want a byte-stable identifier across key reorderings reach for this
 * function instead.
 *
 * @param {*} input - any JSON-compatible value (typically a tool input)
 * @returns {string} 64 lowercase hex chars, or 'empty' for absent input
 */
export function digestParamsCanonical(input) {
  if (input === undefined || input === null) return 'empty';
  const text = JSON.stringify(canonicalize(input));
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Create a short digest of content (for error reporting)
 */
function digestContent(content) {
  if (!content) return 'empty';
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (text.length > 200) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
  return text.slice(0, 50);
}

/**
 * Check if a tool invocation is network-capable
 */
function isNetworkTool(toolName, input) {
  const networkTools = ['WebFetch', 'WebSearch'];
  if (networkTools.includes(toolName)) {
    return true;
  }

  // Bash commands with network verbs
  if (toolName === 'Bash' && input?.command) {
    const cmd = input.command.toLowerCase();
    const networkVerbs = ['curl', 'wget', 'git push', 'git pull', 'git fetch',
                          'npm publish', 'npm install', 'npx', 'ssh', 'scp', 'rsync',
                          'ping', 'telnet', 'nc ', 'netcat'];
    return networkVerbs.some(verb => cmd.includes(verb.toLowerCase()));
  }

  return false;
}

/**
 * Extract target from tool input for 'sent' tracking
 */
function extractTarget(input, toolName) {
  if (!input) return 'unknown';

  if (toolName === 'WebFetch') {
    return input.url || 'unknown';
  }
  if (toolName === 'WebSearch') {
    return input.query || 'unknown';
  }
  if (toolName === 'Bash' && input.command) {
    return input.command.slice(0, 100);
  }

  return 'unknown';
}

/**
 * Schema marker for the parser hash's METHOD, distinct from
 * `cost.schema`, which versions only the cost sub-object. This covers
 * parser behavior `cost.schema` does not: `isNetworkTool`'s verb list,
 * `extractTarget`, `entryTimestamp`'s field preference. A change to any
 * of those moves the hash below without moving `cost.schema`.
 */
export const PARSER_SCHEMA = 'parser/1';

let cachedParserHash = null;

/**
 * Content hash of the parsing logic in force right now. Pure,
 * in-memory, no disk I/O. Safe to call on every gate/warn/grant/egress
 * receipt. Cached after first call in a process. Mirrors
 * matcherVersionHash() in src/policy/index.js: .toString() of every
 * parser function that materially shapes output. The purpose is to
 * DETECT a change, not enumerate exhaustively.
 */
export function parserVersionHash() {
  if (cachedParserHash) return cachedParserHash;
  const parts = [
    parseSession.toString(),
    isNetworkTool.toString(),
    extractTarget.toString(),
    entryTimestamp.toString(),
    usageIdentity.toString(),
    digestParams.toString(),
    digestContent.toString(),
    digestParamsCanonical.toString()
  ];
  cachedParserHash = crypto.createHash('sha256')
    .update(parts.join(' '))
    .digest('hex')
    .slice(0, 16);
  return cachedParserHash;
}

export { parseSession };
