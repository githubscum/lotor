#!/usr/bin/env node

/**
 * src/mcp/server.js
 *
 * MCP server exposing tools:
 *   - query_receipts
 *   - verify_chain
 *   - gated_action (WO-B4: fail-closed with approval)
 *
 * Uses stdio transport (standard for local MCP servers).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createStore } from '../store/index.js';
import { gatedAction, isApprovalKeyInitialized } from '../gate/index.js';
import { resolveHome } from '../home.js';
import { loadPolicy } from '../policy/index.js';
import { snapshotHookRegistration } from '../registration.js';
import { sinceReport } from '../views/since.js';
import { liveReport } from '../views/live.js';
import * as crypto from 'node:crypto';

// Initialize store under the canonical Lotor home
const store = createStore(resolveHome());

/**
 * The chain holds several kinds of entry and they do not share a shape.
 *
 *   (untyped)      the original session receipt. No `type` field, because it
 *                  predates typed payloads. Carries session, counts, touched.
 *   session-open   written at session start. sessionId at payload level.
 *   gated-action   a gate decision. decision, action (tool name), reason.
 *   policy-warn    a rule that warned rather than gated. ruleId.
 *   egress-event   something left the machine.
 *   ledger-head    a chain-head anchor.
 *
 * ABSENT IS NOT ZERO, and this is the whole reason this function was rewritten.
 *
 * The previous version mapped every entry through one shape with `|| 0` on the
 * counts, so a gate denial and a session that genuinely did nothing were
 * reported identically: `toolCalls: 0, touchedCount: 0`, no type, no way to
 * tell them apart. On 2026-07-26 an agent queried this surface to find out what
 * a concurrent session had built, got twelve consecutive rows of zeros, and
 * concluded the chain was empty. It was not: 771 entries, intact, ~67 of them
 * carrying real work counts. The data was there and the answer was unavailable.
 *
 * A counting product whose readout cannot distinguish "nothing happened" from
 * "this kind of row has no counts" is not counting. So a field that does not
 * apply to a row is now OMITTED rather than zeroed, and every row says what it
 * is.
 */
function summarizeEntry(entry) {
  const p = entry.payload || {};
  // Two discriminator conventions live in the same chain, found 2026-07-26
  // while auditing coverage:
  //   `type`  camelCase payloads written by the gate and the hooks
  //   `kind`  snake_case payloads written by the attempt-ledger work
  // Reading only one of them labels the other as unknown, which is the same
  // absent-is-not-zero failure in a different costume. An untyped payload
  // carrying `session` is the original receipt shape and predates both.
  const type = p.type ?? p.kind ?? (p.session ? 'session' : 'unknown');

  const base = { seq: entry.seq, timestamp: entry.timestamp, type, hash: entry.hash };

  switch (type) {
    case 'session': {
      const s = p.session || {};
      const c = p.counts || {};
      return {
        ...base,
        sessionId: s.id,
        model: s.model,
        // subsession is meaningfully null on a top-level session, so it is
        // reported rather than omitted.
        subsession: s.subsession ?? null,
        ...(typeof c.turns === 'number' ? { turns: c.turns } : {}),
        ...(typeof c.toolCalls === 'number' ? { toolCalls: c.toolCalls } : {}),
        ...(typeof c.failures === 'number' ? { failures: c.failures } : {}),
        ...(typeof c.transcriptEntries === 'number'
          ? { transcriptEntries: c.transcriptEntries } : {}),
        ...(Array.isArray(p.touched) ? { touchedCount: p.touched.length } : {})
      };
    }

    case 'session-open':
      return {
        ...base,
        sessionId: p.sessionId,
        ...(p.source ? { source: p.source } : {}),
        ...(p.cwd ? { cwd: p.cwd } : {})
      };

    case 'gated-action':
      // There is no rule id on this payload. decision + action + reason is the
      // whole of what was recorded, and reporting a rule name here would be
      // inventing one.
      return {
        ...base,
        ...(p.decision ? { decision: p.decision } : {}),
        ...(p.action ? { action: p.action } : {}),
        ...(p.reason ? { reason: p.reason } : {})
      };

    case 'policy-warn':
      return { ...base, ...(p.ruleId ? { ruleId: p.ruleId } : {}) };

    default:
      // Unknown or future types still report their type and anything from the
      // small set of fields that recur across payloads. Silently dropping a row
      // would be worse than describing it thinly.
      return {
        ...base,
        ...(p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(p.ruleId ? { ruleId: p.ruleId } : {}),
        ...(p.decision ? { decision: p.decision } : {}),
        ...(p.action ? { action: p.action } : {})
      };
  }
}

/**
 * Tool handler: sessions_since
 *
 * The cross-session answer. `query_receipts` returns rows; this returns what
 * those rows MEAN, grouped by session, which is the unit a reader thinks in.
 *
 * WHY IT IS AN MCP TOOL AND NOT ONLY A CLI
 *   An agent mid-session will not shell out to run a view. It will call a tool
 *   or it will guess. On 2026-07-26 one asserted three times that something did
 *   not exist while another session's receipt, and a file that session had
 *   written, both said otherwise. Putting this where the agent already looks is
 *   the entire point of the item.
 *
 * Defaults to the last 24 hours, because "while I was not looking" is almost
 * always since yesterday rather than since the beginning of the chain.
 */
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

function handleSessionsSince(args) {
  const { since, excludeSessionId, includeQuiet, limit } = args || {};
  const entries = store.reload();

  const report = sinceReport(entries, {
    since: since ?? Date.now() - DEFAULT_SINCE_MS,
    excludeSessionId,
    includeQuiet: Boolean(includeQuiet)
  });

  // A long window can carry a lot of sessions. Truncate the list rather than
  // the report, and say so, because a silently shortened answer is the same
  // class of failure this whole item exists to fix.
  if (limit && typeof limit === 'number' && report.sessions.length > limit) {
    report.truncated = {
      shown: limit,
      of: report.sessions.length,
      note: 'Session list truncated by the limit argument. Raise it or narrow the window.'
    };
    report.sessions = report.sessions.slice(-limit);
  }

  return report;
}

/**
 * Tool handler: sessions_live
 *
 * What the other windows are doing RIGHT NOW.
 *
 * `sessions_since` reads the chain, and the chain only learns about a session
 * when it ends. With three windows open concurrently that answers nothing about
 * the two you are not looking at. This reads their live transcripts instead,
 * whose paths their own session-open receipts already recorded.
 *
 * Awareness, not evidence: unsigned, not in the chain, and changing as you read.
 */
function handleSessionsLive(args) {
  const { excludeSessionId, staleAfterMinutes, withinHours } = args || {};
  return liveReport(resolveHome(), {
    excludeSessionId,
    ...(typeof staleAfterMinutes === 'number' ? { staleAfterMs: staleAfterMinutes * 60000 } : {}),
    ...(typeof withinHours === 'number' ? { withinMs: withinHours * 3600000 } : {})
  });
}

/**
 * Tool handler: query_receipts
 * Returns receipt summaries from the persisted chain (most recent first).
 * Optional filter by sessionId, which now matches session-open rows too.
 */
function handleQueryReceipts(args) {
  const { limit, sessionId } = args || {};

  // Reload to get latest
  const entries = store.reload();

  let receipts = entries.map(summarizeEntry);

  // Filter by sessionId if provided. session-open carries it at payload level
  // and the session receipt carries it under session.id; summarizeEntry has
  // already normalised both onto `sessionId`, so one comparison covers them.
  if (sessionId) {
    receipts = receipts.filter(r => r.sessionId === sessionId);
  }

  // Most recent first (highest seq first)
  receipts.reverse();

  // Apply limit if provided
  if (limit && typeof limit === 'number') {
    receipts = receipts.slice(0, limit);
  }

  return { receipts };
}

/**
 * Tool handler: verify_chain
 * Verifies chain integrity using stored public key.
 */
function handleVerifyChain() {
  // Reload to get latest chain state (ensures fresh view for verification)
  store.reload();
  const result = store.verify();
  return {
    ok: result.ok,
    brokenAt: result.brokenAt ?? null,
    reason: result.reason ?? null,
    entryCount: store.entries.length
  };
}

/**
 * Tool handler: lotor_status
 * First-run visibility: reports the runtime home, chain state, and whether the
 * human-signature gate is set up. Meant to be called at session start.
 */
function handleStatus() {
  const home = resolveHome();

  store.reload();
  const verifyResult = store.verify();
  const receiptCount = store.entries.length;
  const gateInitialized = isApprovalKeyInitialized(home);

  let mode = 'unknown';
  try {
    mode = loadPolicy(home).mode;
  } catch (e) {
    // best-effort; status must never throw
  }

  const hooks = snapshotHookRegistration();

  // "The approval key exists" used to be reported as "fully active", which
  // is the exact belief that let content leave this machine unsigned on
  // 2026-07-22: the key is what a signature is made of, the hooks are what
  // stops an action and asks for one. Distinguish the three states rather
  // than collapsing them.
  let message;
  if (!gateInitialized) {
    message = `The receipt log is active at ${home}, but the human-signature gate is not set up yet. Run \`npm run setup\` in a terminal to set your signing passphrase and enable signed approvals.`;
  } else if (hooks.readable && !hooks.preToolUse) {
    message = `The approval key is set, but the PreToolUse hook is not registered in your Claude Code settings, so nothing is actually gated yet. See the README install steps to register it.`;
  } else if (!hooks.readable) {
    message = `The approval key is set, but Lotor could not read your Claude Code settings to confirm the hooks are registered. If nothing seems to be gating, check the README install steps.`;
  } else {
    message = `Lotor is active in ${mode} mode. Receipts live at ${path.join(home, 'receipts', 'chain.jsonl')}.`;
  }

  return {
    home,
    receiptCount,
    chainIntact: verifyResult.ok,
    gateInitialized,
    mode,
    hooksRegistered: hooks,
    message
  };
}

/**
 * Tool handler: gated_action
 * WO-B4: fail-closed gate. Requires approval token for action execution.
 * Returns structured denial on failure (not prose the model can argue with).
 */
function handleGatedAction(args) {
  const { action, params, approvalToken } = args || {};

  if (!action) {
    return {
      decision: 'denied',
      reason: 'no action specified',
      receiptSeq: null
    };
  }

  const actionRequest = { action, params };

  // Import the chain module to create a temporary chain for the receipt
  // We use the store's chain via the internal chain instance
  const result = gatedAction(actionRequest, approvalToken, {
    append: (receipt) => store.appendReceipt(receipt)
  }, resolveHome());

  // First-run hint: if the approval gate is not initialized, tell the caller
  // how to enable signed approvals. Only added when uninitialized; existing
  // fields (decision/reason/receiptSeq) are untouched.
  if (!isApprovalKeyInitialized(resolveHome())) {
    result.hint = 'Approval gate not initialized. Run `npm run setup` in a terminal to enable human-signed approvals.';
  }

  return result;
}

/**
 * Identity reported to every client that connects.
 *
 * Read from package.json rather than hardcoded. A version literal here is a
 * second source of truth that drifts silently: it sat at 0.0.0 through the
 * 1.0.0 release and reported that to every client, while npm and the registry
 * both said otherwise. Nothing tests what a server calls itself, so the only
 * durable fix is having one place to be wrong.
 */
export function readIdentity() {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  return { name: pkg.name, version: pkg.version };
}

/**
 * Create and configure the MCP server.
 */
function createMcpServer() {
  const server = new Server(
    readIdentity(),
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'query_receipts',
          description: 'Query receipt summaries from the persisted chain (most recent first). Never returns full file contents.',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of receipts to return'
              },
              sessionId: {
                type: 'string',
                description: 'Filter by specific session ID'
              }
            }
          }
        },
        {
          name: 'sessions_since',
          description: 'What happened while you were not looking. Summarises every session recorded in the chain since a point in time, grouped by session, with what each one ran and which files it touched. Use this BEFORE asserting that something does not exist, has not been built, or was never done: concurrent sessions cannot see each other, and the chain is the only place their work is visible. Also worth calling at the start of a session to find out what changed since the last one. Sessions that opened and did nothing are counted rather than listed. Gate decisions carry no session id and are reported unattributed rather than guessed at. Reports what it cannot tell you: receipts carry which tools ran and a digest of their parameters, never intent, and capture is self-attested, so an empty result means nothing was recorded rather than nothing happened.',
          inputSchema: {
            type: 'object',
            properties: {
              since: {
                type: 'string',
                description: 'Window start as an ISO timestamp. Defaults to the last 24 hours.'
              },
              excludeSessionId: {
                type: 'string',
                description: 'Omit one session, usually your own, to see only what everyone else did.'
              },
              includeQuiet: {
                type: 'boolean',
                description: 'Include sessions that opened and did no work. Off by default; one real day produced 101 of them against 6 that did work.'
              },
              limit: {
                type: 'number',
                description: 'Cap the session list. Truncation is reported rather than silent.'
              }
            }
          }
        },
        {
          name: 'sessions_live',
          description: 'What the other windows are doing RIGHT NOW. Reads the live transcripts of sessions that have opened but not yet written a close receipt, so it sees work in progress that the chain cannot: a receipt is only written when a session ends. Use this when you are working in more than one window, before editing a shared file, and before `git add -A` in a repo another session may be using. Reports per session: model, working directory, tool calls, files touched, and how long since it last did anything. AWARENESS, NOT EVIDENCE: these readings are unsigned, are not receipts, are not in the chain, and change as the sessions run. Absence means no open receipt, no transcript, or no work yet, and never that no session is running.',
          inputSchema: {
            type: 'object',
            properties: {
              excludeSessionId: {
                type: 'string',
                description: 'Omit one session, usually your own.'
              },
              staleAfterMinutes: {
                type: 'number',
                description: 'Idle minutes after which a session reads as stale rather than live. Default 30.'
              },
              withinHours: {
                type: 'number',
                description: 'Only consider sessions opened within this many hours. Default 24. Older transcripts are cleaned up and their absence is expected.'
              }
            }
          }
        },
        {
          name: 'verify_chain',
          description: 'Verify the integrity of the receipt chain using the stored public key. Returns ok, brokenAt, reason, and entryCount.',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'lotor_status',
          description: 'Report Lotor runtime status: home path, receipt count, chain integrity, current herding mode (herded | grazing | loose | custom), whether the human-signature gate is set up, and whether the hooks that actually record and gate are registered in Claude Code settings. Call this at the start of a session or whenever the user asks about Lotor. If gateInitialized is false, walk the user through running `npm run setup` in a terminal to set their signing passphrase (this needs a real terminal; you cannot do it for them). If hooksRegistered.preToolUse is false, nothing is gated regardless of gateInitialized: point the user at the README install steps. Always tell the user the home path so they can see where the runtime lives.',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'gated_action',
          description: 'Execute a gated action with approval token. FAILS CLOSED: without a valid approval token, returns decision:denied.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: 'Action to execute'
              },
              params: {
                type: 'object',
                description: 'Action parameters'
              },
              approvalToken: {
                type: 'object',
                description: 'Owner-signed approval token { request, nonce, timestamp, signature }'
              }
            },
            required: ['action']
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'query_receipts':
        return { content: [{ type: 'text', text: JSON.stringify(handleQueryReceipts(args), null, 2) }] };
      case 'sessions_live':
        return { content: [{ type: 'text', text: JSON.stringify(handleSessionsLive(args), null, 2) }] };
      case 'sessions_since':
        return { content: [{ type: 'text', text: JSON.stringify(handleSessionsSince(args), null, 2) }] };
      case 'verify_chain':
        return { content: [{ type: 'text', text: JSON.stringify(handleVerifyChain(), null, 2) }] };
      case 'lotor_status':
        return { content: [{ type: 'text', text: JSON.stringify(handleStatus(), null, 2) }] };
      case 'gated_action':
        return { content: [{ type: 'text', text: JSON.stringify(handleGatedAction(args), null, 2) }] };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

// Export handlers for testing
export {
  handleQueryReceipts,
  handleSessionsSince,
  handleSessionsLive,
  handleVerifyChain,
  handleStatus,
  handleGatedAction,
  // Exported so the per-type shaping can be tested against synthetic payloads
  // without standing up a store or a chain.
  summarizeEntry
};

// Export store for testing (allows tests to reset/reload)
export { store };

// Main entry: start stdio server
if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  // Server runs until stdio closes
}
