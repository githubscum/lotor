# MCP Setup

One-line hookup to connect this MCP server to your Claude client.

## Claude Desktop / Claude Code

Add this to your Claude client's MCP config:

```json
{
  "mcpServers": {
    "agent-receipts": {
      "command": "node",
      "args": ["C:\\Users\\liemi\\agent-receipts\\src\\mcp\\server.js"]
    }
  }
}
```

**Note:** Adjust the path to match your actual install location.

## Tools Available

- `query_receipts` — Query receipt summaries from the chain (most recent first). Optional params: `limit`, `sessionId`.
- `verify_chain` — Verify chain integrity. Returns `{ ok, brokenAt?, reason?, entryCount }`.
- `gated_action` — STUB: fail-closed gate logic arrives in WO-B4.

## Prerequisites

- Node.js >= 18
- Dependencies installed (`npm install`)
- The `receipts/` and `keys/` directories will be created automatically on first use (both are gitignored)

## Running

```bash
npm start
```

The server uses stdio transport and will run until stdin closes.
