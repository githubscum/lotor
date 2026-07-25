# MCP Setup

One-line hookup to connect this MCP server to your Claude client.

> **This page is half the install.** Connecting the MCP server gives you the tools to query, verify, and approve. It does not record anything and it does not block anything. Recording and the gate both run as **Claude Code hooks**, which live in a different file (`~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json` on Windows) and are not touched by anything on this page.
>
> Finish with **step 5 of the [README install](./README.md#5-register-the-hooks-required)**. Skip it and you have a query tool pointed at an empty log. `npm run receipts` will tell you: `Opened: 0` under SESSION OPENS means the hooks never ran.
>
> Hooks are a Claude Code feature. On a client that does not support them, Lotor records only the transcripts you ingest by hand (`npm run ingest -- /path/to/session.jsonl`) and the gate does not run at all.

## Claude Desktop / Claude Code

Add this to your Claude client's MCP config:

```json
{
  "mcpServers": {
    "lotor": {
      "command": "npx",
      "args": ["-y", "lotor-mcp"]
    }
  }
}
```

The npm package is `lotor-mcp`. The bare name `lotor` is unavailable on npm,
which rejects it as too similar to an existing package.

### From a local clone instead

```json
{
  "mcpServers": {
    "lotor": {
      "command": "node",
      "args": ["/absolute/path/to/lotor/src/mcp/server.js"]
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

This produces a `lotor.mcpb` file (a build artifact, gitignored). To validate the manifest without packing:

```bash
npx @anthropic-ai/mcpb validate manifest.json
```

Install the resulting `.mcpb` by opening Claude Desktop, going to the extensions surface (Settings, then Extensions / "Get apps and extensions"), and dragging the `.mcpb` file in, or using the "Install extension" control and selecting the file. Claude Desktop launches the server with `node src/mcp/server.js` over stdio, the same entry point as the manual config above.

The manual JSON method above remains the fallback for Claude Code and any client that does not support `.mcpb` bundles.

**Receipts location note:** the server and the CLIs share one canonical home for the `receipts/` and `keys/` directories, so they all read and write the same chain regardless of the client's launch directory. That home is `LOTOR_HOME` when the environment variable is set, otherwise `~/.lotor` (`%USERPROFILE%\.lotor` on Windows). Set `LOTOR_HOME` if you want the store somewhere other than the default.

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
