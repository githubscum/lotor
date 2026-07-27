# Lotor

A local receipt and approval gate for AI agent sessions. The agent can act, but it cannot sign.

## What it is

This tool writes a signed, tamper-evident log of what an agent did during a session: actions performed, files touched, messages sent, costs incurred, failures encountered. The log lives on your machine, in a format you can inspect, verify, and archive. It does not attempt to prove the agent's actions were correct, only to record them faithfully and make any subsequent tampering detectable.

It also gates the actions you choose. Those stop and wait for an approval signed with a passphrase the model has never seen and cannot derive, so an agent can request a consequential action but cannot authorize one. That is the whole of the tagline: it can act, it cannot sign.

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

- **Replacing your harness's permission prompts.** Run the agent with its own confirmations off and let Lotor be the thing that stops it. A harness prompt is per-call, ephemeral, and dismissed with a click, which is the shape of a control people learn to click through. A Lotor gate is bound to one exact command, signed with a key the agent cannot produce, single use, and recorded whether you approve or deny. You trade a prompt you stop reading for a signature you have to mean.
- **Long-horizon and delegated work.** A gate that costs one trip to a terminal per action is a gate that gets turned off during exactly the sessions worth gating. Delegation grants make one signature cover an enumerated set of requests, so a long build or an overnight run stays gated instead of becoming a choice between friction and no floor at all.
- **Answering "what actually ran" without spending context.** Reconstructing what happened costs tokens: re-reading files, re-deriving history, holding it all in the window. Querying a receipt costs almost nothing and is not subject to the agent's account of itself. In practice the record is often faster than the reasoning, and it is right more often. A worker in this project once reported which model it was running on, in the section of its report reserved for admitting uncertainty, and was wrong. The receipt was not.
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

## Herding modes

Nine gated-or-warned matchers is not a posture anyone can hold in their head. Three named presets replace the nine-switch matrix with a single choice:

| Mode | Posture | Egress rules (push, publish, egress-other, opaque-exec) | Local-only rules (destructive, scope-escalation) |
|---|---|---|---|
| **Herded** | the pen | gate | gate |
| **Grazing** | the fence — the default on a fresh install | gate | warn |
| **Loose** | the open field | warn | warn |

`self-mod` and `mode-change` gate in every mode, with no exception. Loose means free to act on the world, not free to rewrite what stops you: an agent in Loose still cannot edit the gate, its policy, its hooks, or switch modes without your signature. Loose also never turns a rule fully `off` — it warns, which still appends a receipt. The alternative (`off`) would make the most dangerous mode the one that leaves the least evidence, since an unmatched rule takes a fast path with no chain write at all.

Check or switch the mode:

```bash
npm run mode              # print the current mode and its rule-by-rule expansion
npm run mode -- herded    # switch (requires your approval passphrase at a real terminal)
```

Switching requires the same passphrase that signs a gated action, for the same reason: changing what everything else requires should cost at least as much as approving one thing. The mode in force is stamped into every session's opening receipt (see `npm run receipts`), so a switch is never invisible after the fact.

An existing `policy.json` from before this feature shipped is not silently upgraded. It keeps its hand-tuned rules and loads with mode `custom`; naming a preset only happens when you ask for one.

**Honest limit.** Lotor's mode is independent of your harness's own permission mode, and the two do not compensate for one another. Loose plus a harness set to bypass its own checks is genuinely nothing stopping anything on either layer. Lotor now warns when it sees that combination and records the posture once per session, because your harness reports its own mode on every call and Lotor was throwing that away. Detection is not protection: it tells you the floor is gone, it does not put one back. See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) item 15.

## Delegation grants

A single-use approval covers one exact command and is spent once. That is right for a deploy and wrong for a working session. Forty gated actions means forty trips to a terminal, and a gate that expensive gets switched off, which is the failure it existed to prevent.

A grant is one signature over N enumerated requests, bound to one session, with an expiry and a shared action ceiling.

The requests come from files the gate already writes. Every denial stages the exact request it blocked, which is what makes the printed approve command runnable with nothing left to fill in. Work until the gate has stopped you a few times, then sign them together using the ids from those denials:

```bash
npm run grant -- --session <id> --requests a1b2c3d4,e5f6a7b8 --max-actions 10 --expires-in-ms 3600000
npm run grant -- --session <id> --all-pending --max-actions 20 --expires-in-ms 3600000
```

Before the passphrase prompt it prints every request in full, untruncated, with the session, the ceiling and the window. Reading that list is the security of the mechanism. Nothing else in the design substitutes for it.

Comparison is byte equality over the same canonical form the single-use path already uses. A grant is that identical check run against N pre-approved requests instead of one, so nothing here pattern-matches and nothing here inherits the evadability of the rule matcher.

Three independent ceilings, so no single failure lifts the lid:

- the **session** it is bound to, useless in any other
- the **wall-clock expiry**, which depends on the machine clock
- the **use count**, computed by counting signed entries on the append-only chain rather than from a counter file that could be reset by deleting it

**The non-delegable core.** A hard-coded set of paths no grant may ever cover, because a grant able to edit the verifier could widen every future grant. That is one hop and it is fatal. The gate, the policy, the hooks, the key handling, and the grant machinery itself. Work on those costs one signature per action, forever. Building on the core stays expensive on purpose, and the core is small so the expense is bounded.

Both halves reach the chain: the signed grant is recorded when it is issued, and every use is recorded as it is spent. So the log answers what was authorised and what was done with it, separately, and the two can be compared. Deleting a grant file removes the capability and leaves the authorisation on the record.

**Honest limit.** A single-use approval is reviewed once and spent once. A grant is reviewed once and spendable up to its ceiling, so a command you approved can run repeatedly without further review. That is the trade, made deliberately, and it is the one respect in which a grant is weaker than the primitive it extends. See KNOWN-LIMITS 17.

## Not built yet

Named here so no sentence above has to carry a promise it cannot keep.

- **Scoped custodial integrations.** Pending. Reach out for details. The sanctioned path for a redacted slice of your record to reach an auditor, a client, or your own IT, without handing over the whole chain and without a vendor in the middle. A portable bundle (`npm run export`) now packages the chain with its public key so a record verifies off the machine that wrote it (see KNOWN-LIMITS 9), but that is the whole chain or nothing. Selective disclosure is not built, and it is the piece this bullet is actually about.
- **External anchoring.** Pending. Without a timestamp authority or an outside notary, the chain proves alteration but not erasure: truncating the tail leaves a shorter chain that still verifies. See KNOWN-LIMITS 3.
- **Hardware-backed key custody.** Pending. The chain key sits on disk in plaintext today. See KNOWN-LIMITS 8.
- **Per-harness cost attribution.** Pending. Receipts now carry a per-model breakdown (`cost.byModel`, schema `cost/3`) and every `session-open` records which harness wrote it. Cost itself is still not broken down per harness, and the top-line total remains a blend reported under the last model seen, so read `byModel` and never the total. See KNOWN-LIMITS 13.

## Install

Installing Lotor means opting into two invariants: the record is written to your machine and to nowhere else, and the actions you have put behind the gate fail closed until you sign them. Everything below is a choice about *where* those two things happen, not *whether*.

Read the second one precisely, because the difference matters. The gate covers the rules you have set to `gate` in your policy, matched on tool name and parameters. It is not a claim that nothing can leave your machine. See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) item 11 for what the matcher does and does not catch, and check `lotor_status` for which rules are gated versus merely warned on your install.

Lotor is two pieces that install separately. An **MCP server**, which gives you the tools to query, verify and approve. And four **Claude Code hooks**, which are what actually record and what actually gate. Installing one without the other is the most common way to end up thinking Lotor is running when it is not.

### Prerequisites

- **Node 18 or later**, and a working `claude` CLI if you are installing into Claude Code.
- **A text editor, and willingness to hand-edit a JSON file.** This is the one that surprises people, so it is stated here rather than discovered at step 5.

Lotor's recording and its gate both run as **Claude Code hooks**, and hooks are configured in Claude Code's own settings file. Adding the MCP server does not add them. You edit `settings.json` yourself:

| Platform | File |
|---|---|
| macOS / Linux | `~/.claude/settings.json` |
| Windows | `%USERPROFILE%\.claude\settings.json` |

Step 5 has the exact block to paste. If you would rather not edit JSON by hand, the interactive `claude` CLI has a `/hooks` command that writes the same file through a menu.

**Why Lotor does not install its own hooks.** It could. It deliberately does not. A tool that can silently register its own enforcement into your settings is a tool that can silently unregister it, and a gate you did not knowingly install is a gate you have no reason to trust. The settings file is inside your threat model, not outside it (see [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) item 11), so the act of arming this thing is yours. The cost is one paste. The benefit is that you know exactly what is running and can see it in a file you own.

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

### 5. Register the hooks (required)

This is the step that turns Lotor from a library into a gate. Skip it and you have installed a query tool against an empty log.

Open your Claude Code settings file (`~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json` on Windows) and merge in the `hooks` block below, substituting your own absolute path to this repo. If the file already has a `hooks` key, add these four events inside it rather than replacing it. If the file does not exist yet, create it with exactly this content.

Forward slashes work in the command path on every platform, including Windows.

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

With no `matcher`, each fires on every occurrence of its event.

Restart your session after editing. Hooks are read at session start, so the edit takes effect on the next one, not this one.

Every one of these hooks is deliberately unable to break your session. None exits non-zero except the gate, and the gate only when it is blocking on purpose. None writes to stdout. Every other failure (missing transcript, malformed payload, unreadable chain, a Lotor bug) is swallowed with a one-line note to stderr. A receipt layer that can wedge your editor is worse than no receipt layer.

**What it looks like when the gate fires.** Every denial prints the same fixed shape, regardless of which model triggered it:

```
LOTOR GATE — rule "self-mod" (Write)

  WHAT    Write: C:\Users\you\lotor\bin\hook-session-start.js
  WHY     this path can change the gate, its policy, its hooks, or the log
  RISK    HIGH — approving this lets the agent alter what stops it
  SCOPE   signs file_path only. Nothing else about this call is covered by the signature.
          Single use. Bound to this exact request. Review before you sign.

  Approve, in a real terminal:
    npm run approve -- --request a1b2c3d4

  (staged at <LOTOR_HOME>/pending-approvals/requests/a1b2c3d4.json)

  Doing nothing denies. The denial is already receipted.
```

The command is complete as printed: nothing to substitute, nowhere left for a model to improvise. `CLAUDE.md` at the repo root asks any agent working here to relay this verbatim and wait, rather than compose its own warning — the point of the fixed shape is that the experience of hitting the gate does not depend on which model is driving.

Two consequences worth being clear-eyed about. Hook registration lives in a file you can edit, so it is part of your threat model, not outside it; `SessionStart` snapshots which hooks were present into the open receipt so a between-session edit shows up in the log at the next start. And the gate only covers tool calls made after its hook is loading, which is the argument for the receipt layer being the first thing a session spins up rather than the last.

### 6. Confirm it is live

Inside Claude, the `lotor_status` tool reports your home path, how many receipts exist, whether the chain is intact, and whether the gate is active. From a terminal:

```bash
npm run receipts
```

Look at the `SESSION OPENS` block. During a live session you should see one more opened than closed: that is your current session, open and not yet finished. If it reads `Opened: 0`, the `SessionStart` hook is not registered and step 5 did not take.

If you skip step 5 entirely, nothing is recorded automatically and you are back to ingesting a transcript by hand:

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

Point your client at `src/mcp/server.js` over stdio. See [MCP-SETUP.md](./MCP-SETUP.md) for the exact config block and the tools it exposes (`query_receipts`, `verify_chain`, `lotor_status`, `gated_action`).

That connects the tools. It does not start recording and it does not arm the gate: both are hooks, registered separately in Claude Code's `settings.json`. See [step 5](#5-register-the-hooks-required).

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
