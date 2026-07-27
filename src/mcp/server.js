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
  // An untyped payload is the original session receipt. Naming it here rather
  // than leaving it undefined means callers never have to know the history.
  const type = p.type ?? 'session';

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
