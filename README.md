# Lotor

A local receipt and approval gate for AI agent sessions. The agent can act, but it cannot sign.

## What it is

Lotor writes a signed, tamper-evident log of what an agent did during a session: actions performed, files touched, messages sent, costs incurred, failures encountered. The log lives on your machine, in a format you can inspect, verify and archive.

It does not prove the agent's actions were correct. It records them, and makes later tampering detectable.

It also gates the actions you choose. Those stop and wait for an approval signed with a passphrase the model has never seen and cannot derive. An agent can request a consequential action. It cannot authorize one.

**Local first, and not as a deployment option.** The receipt is written to your machine and nowhere else. No upload path, no account, no server component. Nothing leaves because nothing is built to send it. Most accountability tooling is cloud observability, which means your agent's history becomes inventory in someone else's books. The record of what your machines did for you should answer to your key, not to a vendor's retention policy.

Longer arguments for why that matters live at [ikeanalytics.com](https://ikeanalytics.com). This file is about running the thing.

## What you use it for

**Know what ran.** Ask the record instead of re-reading transcripts. It is cheaper than reconstruction and it is not subject to the agent's account of itself. A worker in this project once reported which model it was running on, in the section of its own report reserved for admitting uncertainty, and was wrong. The receipt was not.

**Sleep through it.** Wake up to a signed account of an unattended run rather than a pile of transcripts you will never read.

**Stop the expensive ones.** Deletes, deploys, sends and spends fail closed until you sign that exact action with its exact parameters. The denial and the approval are both receipted.

**Hold your own copy.** When a client, vendor or counterparty disputes what happened, the record is yours. Their books, and now yours.

## Claim discipline

Measurement, not indictment. A receipt records what the session self-reports. It does not judge intent and it does not catch silent failures.

Self-attested capture. The log begins at signing time. What happened before that moment is not covered by the chain.

Nothing written in the present tense here is unbuilt. Anything not built is named as pending, in the same breath, either below or in [KNOWN-LIMITS.md](./KNOWN-LIMITS.md).

## Herding modes

Ten matchers is not a posture anyone can hold in their head. Three presets replace the matrix with one choice.

| Mode | Posture | Egress rules (push, publish, egress-other, opaque-exec) | Local-only rules (destructive, scope-escalation) |
|---|---|---|---|
| **Herded** | the pen | gate | gate |
| **Grazing** | the fence, and the default on a fresh install | gate | warn |
| **Loose** | the open field | warn | warn |

`self-mod` and `mode-change` gate in **every** mode, with no exception. Loose means free to act on the world, not free to rewrite what stops you. An agent in Loose still cannot edit the gate, its policy, its hooks, or switch modes without your signature.

Loose never turns a rule fully `off`. It warns, which still appends a receipt. The alternative would make the most dangerous mode the one that leaves the least evidence, since an unmatched rule takes a fast path with no chain write.

```bash
npm run mode              # print the current mode and its rule-by-rule expansion
npm run mode -- herded    # switch (requires your approval passphrase at a real terminal)
```

The mode in force is stamped into every session's opening receipt, so a switch is never invisible after the fact. An existing `policy.json` from before this feature is not silently upgraded: it keeps its rules and loads as mode `custom`.

**Honest limit.** Lotor's mode is independent of your harness's own permission mode and the two do not compensate for one another. Loose plus a harness set to bypass its own checks is genuinely nothing stopping anything on either layer. Lotor warns when it sees that combination and records the posture once per session. Detection is not protection. See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) item 15.

## Install

Installing Lotor means opting into two invariants: the record is written to your machine and nowhere else, and the actions you put behind the gate fail closed until you sign them. Everything below is a choice about *where* those happen, not *whether*.

Read the second one precisely. The gate covers the rules you have set to `gate`, matched on tool name and parameters. It is not a claim that nothing can leave your machine. See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) item 11 for what the matcher does and does not catch, and check `lotor_status` for which rules are gated versus merely warned on your install.

Lotor is two pieces that install separately. An **MCP server**, which gives you the tools to query, verify and approve. And four **Claude Code hooks**, which are what actually record and what actually gate. **Installing one without the other is the most common way to end up thinking Lotor is running when it is not.**

### Prerequisites

- **Node 18 or later**, and a working `claude` CLI if you are installing into Claude Code.
- **A text editor, and willingness to hand-edit a JSON file.** This is the one that surprises people, so it is stated here rather than discovered at step 5.

**Why Lotor does not install its own hooks.** It could. It deliberately does not. A tool that can silently register its own enforcement into your settings is a tool that can silently unregister it, and a gate you did not knowingly install is a gate you have no reason to trust. The settings file is inside your threat model, not outside it. The cost is one paste. The benefit is that you know exactly what is running.

### 1. Where it runs

| Install target | What it can receipt | Reach |
|---|---|---|
| Claude Code, user scope | every Claude Code session, in every project | widest, always on |
| Claude Code, project scope | only sessions started inside that one repo | scoped to a project |
| Claude Desktop extension (`.mcpb`) | Claude Desktop app sessions | the desktop app |

```bash
claude mcp add lotor -s user -- node /absolute/path/to/lotor/src/mcp/server.js
```

Use `-s project` instead to wire Lotor into a single repo, which writes a committed `.mcp.json` there. For the one-click desktop path see [MCP-SETUP.md](./MCP-SETUP.md).

### 2. Where receipts live

Lotor keeps one canonical store so your chain never fragments. By default `~/.lotor`, or `%USERPROFILE%\.lotor` on Windows. Every CLI and the MCP server read and write that same store regardless of which directory the client launched from. Override with `LOTOR_HOME`.

**Keep this on real local disk.** Point `LOTOR_HOME` at a synced cloud folder and you have handed your receipt log back to a third party, which is the exact custody Lotor exists to remove.

### 3. Activate it

Clients load MCP servers at session start. Restart your session or open a new one. Restarting the session you installed from is enough.

### 4. First run: set your key

```bash
npm run setup
```

Setup creates your log-integrity key, then walks you through setting a passphrase for your approval key. **The approval key's private half is never written to disk.** It is derived from your passphrase at the moment you approve an action, and nowhere else.

**Setting the key does not arm the gate.** The key is what a signature is made of. The hooks are what stops an action and asks for one. A Lotor install with a passphrase set and no hooks registered records nothing and blocks nothing. Do step 5.

### 5. Register the hooks (required)

This is the step that turns Lotor from a library into a gate. Skip it and you have installed a query tool against an empty log.

Open your Claude Code settings file (`~/.claude/settings.json`, or `%USERPROFILE%\.claude\settings.json` on Windows) and merge in the block below, substituting your own absolute path. If the file already has a `hooks` key, add these four events inside it rather than replacing it. Forward slashes work on every platform, including Windows.

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

| Hook | What it does | What is missing without it |
|---|---|---|
| `SessionStart` | opens the record: session id, policy in force, chain head, hook registration | a session that dies badly leaves no trace, and the log looks clean |
| `PreToolUse` | the gate: gated rules fail closed until you sign | nothing is ever blocked, whatever your policy says |
| `PostToolUse` | captures egress-shaped calls as they complete | outbound activity is only ever reconstructed later |
| `SessionEnd` | closes the record: what ran, what it touched, what it cost | no session receipt is written |

If you would rather not edit JSON by hand, the interactive `claude` CLI has a `/hooks` command that writes the same file through a menu.

**Restart your session after editing.** Hooks are read at session start, so the edit takes effect on the next one.

None of these hooks can break your session. None exits non-zero except the gate, and only when it is blocking on purpose. None writes to stdout. Every other failure is swallowed with a one-line note to stderr. A receipt layer that can wedge your editor is worse than no receipt layer.

Two things to be clear-eyed about. Hook registration lives in a file you can edit, so it is part of your threat model. `SessionStart` snapshots which hooks were present, so a between-session edit shows up at the next start. And the gate only covers tool calls made after its hook is loading.

### 6. Confirm it is live

```bash
npm run receipts
```

Look at the `SESSION OPENS` block. During a live session you should see one more opened than closed: that is your current session. **If it reads `Opened: 0`, the `SessionStart` hook is not registered and step 5 did not take.** Inside Claude, the `lotor_status` tool reports the same thing.

If you skip step 5 entirely, nothing is recorded automatically and you are back to ingesting a transcript by hand with `npm run ingest -- /path/to/session.jsonl`.

## Delegation grants

A single-use approval covers one exact command and is spent once. That is right for a deploy and wrong for a working session: forty gated actions means forty trips to a terminal, and a gate that expensive gets switched off, which is the failure it existed to prevent.

A grant is one signature over N enumerated requests, bound to one session, with an expiry and a shared action ceiling. Before the passphrase prompt it prints every request in full, untruncated. **Reading that list is the security of the mechanism.**

```bash
npm run grant -- --session <id> --all-pending --max-actions 20 --expires-in-ms 3600000
```

**The non-delegable core.** A hard-coded set of paths no grant may ever cover, because a grant able to edit the verifier could widen every future grant. The gate, the policy, the hooks, the key handling, and the grant machinery itself. Work on those costs one signature per action, forever. The core is small so the expense is bounded.

**Honest limit.** A grant is reviewed once and spendable up to its ceiling, so a command you approved can run repeatedly without further review. That is the trade, made deliberately. See KNOWN-LIMITS 17.

## Not built yet

- **Scoped custodial integrations.** The sanctioned path for a redacted slice of your record to reach an auditor, a client or your own IT. `npm run export` packages the whole chain with its public key so it verifies off the machine that wrote it, but whole-chain-or-nothing is the only granularity there is. Selective disclosure is the piece that does not exist. Reach out for details.
- **External anchoring.** Without a timestamp authority the chain proves alteration but not erasure: truncating the tail leaves a shorter chain that still verifies. See KNOWN-LIMITS 3.
- **Hardware-backed key custody.** The chain key sits on disk in plaintext. See KNOWN-LIMITS 8.
- **Per-harness cost attribution.** Receipts carry a per-model breakdown (`cost.byModel`). Cost is still not broken down per harness, and the top-line total is a blend reported under the last model seen, so read `byModel` and never the total. See KNOWN-LIMITS 13.

## Known limits

Everything I know to be wrong with Lotor is in [KNOWN-LIMITS.md](./KNOWN-LIMITS.md), written against my own interest, because a list of your own product's weaknesses is the one claim in this repository that is expensive to fake.

Some are open bounties. The [confession board](./confessions/) publishes them with a file:line anchor, a scope, and acceptance criteria written so you can check your own work without me in the loop.

| ID | Title | Difficulty |
|---|---|---|
| [A1](./confessions/A1-armed-first-receipt.md) | Armed. Install Lotor, arm the gate, earn your first signed receipt | trivial |
| [LOTOR-C1](./confessions/C1-egress-get-query-string.md) | Data leaves in a GET query string, ungated and uncaptured | medium |
| [LOTOR-C2](./confessions/C2-command-rule-undergate.md) | A dangerous command that a gated rule does not catch | hard |
| [LOTOR-C3](./confessions/C3-bare-push-protected-branch.md) | A bare `git push` to a checked-out protected branch is not seen | medium |

You claim one with a signed Lotor receipt of your own work, so claiming a bounty means running the tool. Attribution and contributor status. No money in this round.

**And if you read KNOWN-LIMITS and come back with an entry that is not on it yet, you have done something better than close a bounty.**

## Development

```bash
npm install
npm test
```

See [DEMO.md](./DEMO.md) for a runnable walkthrough and [MCP-SETUP.md](./MCP-SETUP.md) for the MCP config block and the tools it exposes.
