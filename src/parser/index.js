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
function parseSession(jsonlText) {
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
    note: 'tokens only; no USD in source'
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
          cost.inputTokens += entry.message.usage.input_tokens || 0;
          cost.outputTokens += entry.message.usage.output_tokens || 0;
          cost.cacheCreationTokens += entry.message.usage.cache_creation_input_tokens || 0;
          cost.cacheReadTokens += entry.message.usage.cache_read_input_tokens || 0;
        }
      }

      // Tool invocations (tool_use content items)
      if (Array.isArray(entry.message.content)) {
        for (const item of entry.message.content) {
          if (item.type === 'tool_use') {
            toolCalls++;
            const toolName = item.name || 'unknown';
            const toolId = item.id || `anon-${toolCalls}`;
            const paramsDigest = digestParams(item.input);

            ran.push({ tool: toolName, id: toolId, paramsDigest });
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
    cost: { ...cost, schema: 'cost/2' },
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

export { parseSession };
