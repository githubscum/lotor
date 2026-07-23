# Lotor

A local-first, MCP-native receipt layer for AI agent sessions.

## What it is

This tool writes a signed, tamper-evident log of what an agent did during a session: actions performed, files touched, messages sent, costs incurred, failures encountered. The log lives on your machine, in a format you can inspect, verify, and archive. It does not attempt to prove the agent's actions were correct, only to record them faithfully and make any subsequent tampering detectable.

## The other half of reliability

The argument getting loud right now is that you cannot have agentic systems that are reliable unless they can predict the consequences of their actions. That is true, and it is only the front half. Prediction is the front of reliability. The record is the back. A world model guesses what an action will do. A receipt states what it did. You need both, and only one of them is something you can hold in your hand today.

Lotor is the back half. It does not give your agent a world model. It gives you a signed, ordered, tamper-evident record of what your agent's session reported doing, so that "reliable" stops being a claim and starts being a record you can check. Not ground truth. A record, kept by you, that cannot be quietly changed afterward.

And it keeps that record where it belongs. The other warning in the same breath is about culture: if the world's information diet runs through a handful of proprietary engines, that is the end of local culture, and no system is ever truly unbiased. The same centralization is happening one layer down, quietly, to the record of what your agents do for you. Most accountability tools are cloud observability proxies. Your agent's activity flows through their servers, and your own history becomes inventory in someone else's books.

Lotor is routed local first. The receipt is written to your machine and nowhere else. There is no upload path, no account, no server component: nothing leaves because nothing is built to send it. Scoped custodial integrations, the sanctioned way to hand a redacted slice of your record to an auditor, a client, or your own IT, are pending. Reach out for details. That is the whole distinction, not a deployment checkbox and not an enterprise tier. The record of what your machines did for you lives with you, survives whichever vendor you were renting this quarter, and answers to your key, not their retention policy.

That is what a receipt means when the models centralize and the agents multiply. Your books. Local first. The floor that does not move when the vendor does.

## A company cannot audit itself

Every accountability story hits the same wall. The party that produced the record cannot also be the only one who keeps it and checks it. That is not an audit. That is a company grading its own homework. When the vendor whose model did the work also owns the sole log of what it did, you are trusting the audited party to certify itself.

Trust used to be the default, because checking was expensive. That assumption is expiring in public, one incident at a time. What replaces it is not more faith in the vendor. It is a record the vendor does not hold.

Lotor separates the two roles by construction. The receipt is written local first, to your machine, under your key. The party with the real stake in the record's integrity, you, is the party that keeps it. The one who did the work does not get to be the one who certifies it. That is why local first is not a feature here. It is the point.

## Use cases

Lotor is one primitive, a signed local receipt, applied wherever "what did my agent actually do" is a question you need answered honestly.

- **Session accountability.** End every interactive session with a signed receipt: what ran, what it touched, what it sent, what it cost, what failed. Failures are surfaced, not buried.
- **Overnight and unattended runs.** Wake up to a morning-after record of what an agent did while you were not watching, instead of a pile of transcripts you will never read.
- **Gated high-stakes actions.** Make destructive or irreversible actions (delete, deploy, send, spend) fail closed until you sign an approval bound to that exact action and its exact parameters. The denial and the approval are both receipted.
- **Proof of your side.** When a client, vendor, or counterparty disputes what happened, you have your own signed record. Their books, and now yours.
- **Tamper-evidence.** The chain detects after-the-fact alteration of the log. It does not prove the events were complete or truthful at capture time (see Known limits), but it proves the record has not been changed since.
- **Feeding your own memory.** Receipts are durable, structured input to your own long-horizon agent memory, not telemetry for a vendor's dashboard.
- **Vendor-churn survival.** Switch models or providers whenever you want. The record stays on your machine and stays readable. Your history does not belong to whichever engine you were renting.
- **Scoped custodial integrations (pending, reach out for details).** The sanctioned path for sharing a record with an auditor, a client, or your own IT: a scoped, redacted view, signed, sent only where you send it. Not built in v1. Today the default is absolute rather than chosen, because there is no export path at all. Anything you share, you share by hand.

## Claim discipline

Provable priority, not enforced credit. This is bookkeeping: their books, and now yours.

Measurement, not indictment. A receipt records what the session self-reports; it does not judge intent or catch silent failures.

Self-attested capture. The log begins at signing time. What happened before that moment is not covered by the tamper-evidence chain.

Nothing described in the present tense here is unbuilt. Anything not built is in the list below or in [KNOWN-LIMITS.md](./KNOWN-LIMITS.md), and it is marked pending in the same breath as it is named.

## Not built yet

Named here so no sentence above has to carry a promise it cannot keep.

- **Scoped custodial integrations.** Pending. Reach out for details. The sanctioned path for a redacted slice of your record to reach an auditor, a client, or your own IT, without handing over the whole chain and without a vendor in the middle. There is no export path in v1, so today the only way anything leaves is you moving it by hand.
- **External anchoring.** Pending. Without a timestamp authority or an outside notary, the chain proves alteration but not erasure: truncating the tail leaves a shorter chain that still verifies. See KNOWN-LIMITS 3.
- **Hardware-backed key custody.** Pending. The chain key sits on disk in plaintext today. See KNOWN-LIMITS 8.
- **Per-model cost attribution.** Pending. A mixed-model session reports one blended total. See KNOWN-LIMITS 13.

## Install

Installing Lotor means opting into two invariants: the record is written to your machine and to nowhere else, and the actions you have put behind the gate fail closed until you sign them. Everything below is a choice about *where* those two things happen, not *whether*.

Read the second one precisely, because the difference matters. The gate covers the rules you have set to `gate` in your policy, matched on tool name and parameters. It is not a claim that nothing can leave your machine. See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) item 11 for what the matcher does and does not catch, and check `lotor_status` for which rules are gated versus merely warned on your install.

Lotor is an MCP server. You wire it into your client once, and from then on it can receipt the sessions of whatever it is wired into. There are two decisions.

### 1. Where it runs

| Install target | What it can receipt | Reach |
|---|---|---|
| Claude Code, user scope | every Claude Code session, in every project | widest, always on |
| Claude Code, project scope | only sessions started inside that one repo | scoped to a project |
| Claude Desktop extension (`.mcpb`) | Claude Desktop app sessions | the desktop app |

- **User scope** is the always-on posture. Every session you run, in any project, has the receipt tools. Pick this if Lotor is meant to be standing infrastructure.

  ```bash
  claude mcp add lotor -s user -- node /absolute/path/to/lotor/src/mcp/server.js
  ```
- **Project scope** wires Lotor into a single repo (it writes a committed `.mcp.json` there). Pick this to try it on one codebase without touching your global config.

  ```bash
  claude mcp add lotor -s project -- node /absolute/path/to/lotor/src/mcp/server.js
  ```
- **Desktop extension** is the one-click path. It prompts you at install time, including for where receipts should live. See [MCP-SETUP.md](./MCP-SETUP.md) for building and installing the `.mcpb`.

### 2. Where receipts live

Lotor keeps one canonical store so your chain never fragments. By default it lives at `~/.lotor` (`%USERPROFILE%\.lotor` on Windows), and the MCP server and every CLI read and write that same store regardless of which directory the client launched from. Override it with the `LOTOR_HOME` environment variable.

One implication is load-bearing: keep this on real local disk. Point `LOTOR_HOME` at a synced cloud folder and you have handed your receipt log back to a third party, which is the exact custody Lotor exists to remove. Local first means the record is on your machine, under your key, before anything else can touch it.

### 3. Activate it

Clients load MCP servers at session start. After you add Lotor, restart your current session or open a new one. Restarting the session you installed from is enough. It does not have to be a fresh project.

### 4. First run: set your key

From a terminal in the repo:

```bash
npm run setup
```

Setup creates your log-integrity key automatically, then walks you through setting a passphrase for your approval key. The approval key is the human in "gated actions wait for a human signature." Its private half is never written to disk. It is derived from your passphrase at the moment you approve an action, and nowhere else.

**Setting the key does not arm the gate.** The key is what a signature is made of; the hooks are what stops an action and asks for one. A Lotor install with a passphrase set and no hooks registered records nothing and blocks nothing. Do step 5.

### 5. Register the hooks

This is the step that turns Lotor from a library into a gate. Add these to your Claude Code settings (`~/.claude/settings.json`), substituting your own absolute path:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node /absolute/path/to/lotor/bin/hook-session-start.js" } ] }
    ],
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "node /absolute/path/to/lotor/bin/hook-pre-tool-use.js" } ] }
    ],
    "PostToolUse": [
      { "hooks": [ { "type": "command", "command": "node /absolute/path/to/lotor/bin/hook-post-tool-use.js" } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node /absolute/path/to/lotor/bin/hook-session-end.js" } ] }
    ]
  }
}
```

What each one buys you:

| Hook | What it does | What is missing without it |
|---|---|---|
| `SessionStart` | opens the record: session id, policy in force, chain head, hook registration | a session that dies badly leaves no trace at all, and the log looks clean |
| `PreToolUse` | the gate: gated rules fail closed until you sign | nothing is ever blocked, whatever your policy says |
| `PostToolUse` | captures egress-shaped calls at the moment they complete | outbound activity is only ever reconstructed later, from the transcript |
| `SessionEnd` | closes the record: what ran, what it touched, what it cost | no session receipt is written |

Restart your session after editing. Hooks are read at session start, so the edit takes effect on the next one, not this one.

Two consequences worth being clear-eyed about. Hook registration lives in a file you can edit, so it is part of your threat model, not outside it; `SessionStart` snapshots which hooks were present into the open receipt so a between-session edit shows up in the log at the next start. And the gate only covers tool calls made after its hook is loading, which is the argument for the receipt layer being the first thing a session spins up rather than the last.

### 6. Confirm it is live

Inside Claude, the `lotor_status` tool reports your home path, how many receipts exist, whether the chain is intact, and whether the gate is active. From a terminal, `npm run receipts` prints the same. If you ever wonder whether Lotor is watching, ask it.

### 6. Turn on automatic session receipts

Installing the server gives you the tools. It does not yet record anything. To get a receipt written automatically every time a session ends, register the `SessionEnd` hook in your Claude Code settings (`~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json` on Windows):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/lotor/bin/hook-session-end.js"
          }
        ]
      }
    ]
  }
}
```

Merge that `hooks` key into your existing settings rather than replacing the file. With no `matcher`, it fires on every session end.

The hook is deliberately unable to break your session. It never exits non-zero, never writes to stdout, and swallows every failure (missing transcript, malformed payload, unreadable chain) with a one-line note to stderr. A receipt layer that can wedge your editor is worse than no receipt layer.

Without the hook, nothing is recorded until you ingest a transcript by hand:

```bash
npm run ingest -- /path/to/session.jsonl
```

## Quickstart

Prerequisites: Node.js >= 18. Install dependencies with `npm install`.

Run the test suite:

```bash
npm test
```

### Connect the MCP server to a Claude client

Point your client at `src/mcp/server.js` over stdio. See [MCP-SETUP.md](./MCP-SETUP.md) for the exact config block and the three tools it exposes (`query_receipts`, `verify_chain`, `gated_action`).

### The gated-action loop at a glance

If you have not run `npm run setup` yet, do that first (see [Install](#4-first-run-set-your-key)). It sets the approval passphrase once. The private key is derived from that passphrase at signing time and is never written to disk. Only the public key is stored. (`npm run approve:init` is the lower-level command setup wraps.)

Ingest a session, then run a gated action. Without an owner-signed approval token the gate DENIES by default (fail closed); with a valid token bound to that exact action it APPROVES. Both directions append a receipt to the signed chain.

```bash
npm run ingest -- test-data/sample-session.jsonl
npm run gate -- --action-file test-data/sample-action.json
npm run approve -- --action-file test-data/sample-action.json --out my-token.json
npm run gate -- --action-file test-data/sample-action.json --token-file my-token.json
```

### Verify the chain and view receipts

```bash
npm run receipts
```

`npm run receipts` prints a summary of every receipt and the chain-integrity result. The MCP `verify_chain` tool reports the same integrity check to a connected client.

See [DEMO.md](./DEMO.md) for the full runnable walkthrough and [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) for scope.

## Known limits

See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md).
