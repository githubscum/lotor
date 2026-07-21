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

## Install as a Claude Desktop Extension (.mcpb)

Claude Desktop can install this server as a one-click extension instead of hand-editing the JSON above. The bundle format is `.mcpb` (MCP Bundle). The committed `manifest.json` at the repo root is the source of truth for the bundle.

Build the bundle from the repo root:

```bash
npx @anthropic-ai/mcpb pack
```

This produces an `agent-receipts.mcpb` file (a build artifact, gitignored). To validate the manifest without packing:

```bash
npx @anthropic-ai/mcpb validate manifest.json
```

Install the resulting `.mcpb` by opening Claude Desktop, going to the extensions surface (Settings, then Extensions / "Get apps and extensions"), and dragging the `.mcpb` file in, or using the "Install extension" control and selecting the file. Claude Desktop launches the server with `node src/mcp/server.js` over stdio, the same entry point as the manual config above.

The manual JSON method above remains the fallback for Claude Code and any client that does not support `.mcpb` bundles.

**Receipts location note:** the server resolves its `receipts/` and `keys/` directories relative to its working directory at launch. Under the manual JSON method that is wherever the client starts the process; when packed as an extension it is the extension's install directory. The path is not currently an install-time setting.

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
