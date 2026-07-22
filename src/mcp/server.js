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
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createStore } from '../store/index.js';
import { gatedAction, isApprovalKeyInitialized } from '../gate/index.js';
import { resolveHome } from '../home.js';
import * as crypto from 'node:crypto';

// Initialize store under the canonical Lotor home
const store = createStore(resolveHome());

/**
 * Tool handler: query_receipts
 * Returns receipt summaries from the persisted chain (most recent first).
 * Optional filter by sessionId.
 */
function handleQueryReceipts(args) {
  const { limit, sessionId } = args || {};

  // Reload to get latest
  const entries = store.reload();

  // Map to receipt summaries, filter if needed
  let receipts = entries.map(entry => ({
    seq: entry.seq,
    timestamp: entry.timestamp,
    sessionId: entry.payload?.session?.id,
    model: entry.payload?.session?.model,
    hash: entry.hash,
    touchedCount: entry.payload?.touched?.length || 0,
    toolCalls: entry.payload?.counts?.toolCalls || 0
  }));

  // Filter by sessionId if provided
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

  let message;
  if (!gateInitialized) {
    message = `The receipt log is active at ${home}, but the human-signature gate is not set up yet. Run \`npm run setup\` in a terminal to set your signing passphrase and enable signed approvals.`;
  } else {
    message = `Lotor is fully active. Receipts live at ${path.join(home, 'receipts', 'chain.jsonl')} and the human-signature gate is enabled.`;
  }

  return {
    home,
    receiptCount,
    chainIntact: verifyResult.ok,
    gateInitialized,
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
 * Create and configure the MCP server.
 */
function createMcpServer() {
  const server = new Server(
    {
      name: 'lotor-mcp',
      version: '0.0.0'
    },
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
          description: 'Report Lotor runtime status: home path, receipt count, chain integrity, and whether the human-signature gate is set up. Call this at the start of a session or whenever the user asks about Lotor. If gateInitialized is false, walk the user through running `npm run setup` in a terminal to set their signing passphrase (this needs a real terminal; you cannot do it for them). Always tell the user the home path so they can see where the runtime lives.',
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
  handleGatedAction
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
