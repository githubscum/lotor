# MCP Setup

One-line hookup to connect this MCP server to your Claude client.

## Claude Desktop / Claude Code

Add this to your Claude client's MCP config:

```json
{
  "mcpServers": {
    "agent-receipts": {
      "command": "node",
      "args": ["/absolute/path/to/agent-receipts/src/mcp/server.js"]
    }
  }
}
```

**Note:** Adjust the path to match your actual install location.

## Tools Available

- `query_receipts`: Query receipt summaries from the chain (most recent first). Optional params: `limit`, `sessionId`.
- `verify_chain`: Verify chain integrity. Returns `{ ok, brokenAt?, reason?, entryCount }`.
- `gated_action`: Fail-closed gate. Denies an action unless a valid owner-signed approval token is presented for that exact action, and writes a receipt to the chain in both directions (denied and approved). Params: `action`, optional `params`, optional `approvalToken` (`{ request, nonce, timestamp, signature }`). Returns `{ decision, reason?, approvalNonce?, receiptSeq }`.

## Prerequisites

- Node.js >= 18
- Dependencies installed (`npm install`)
- The `receipts/` and `keys/` directories will be created automatically on first use (both are gitignored)

## Running

```bash
npm start
```

The server uses stdio transport and will run until stdin closes.
