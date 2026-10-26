# proposals/agent-id-attribution.md — subagent tool-call attribution

WO-AGENT-ID, 2026-10-22. Queued for the next signing sitting per Isaac's go:
"Queue the agent_id fix for the next signing sitting: write the patch and its test."

## What changed

Two halves.

**Part 1 — GRANTABLE, already applied in this working copy** (`src/reasoning/index.js`
plus `test/reasoning-subagent.test.js`): a PostToolUse payload carrying `agent_id`
now resolves the CHILD transcript (`agent_transcript_path` if given, ending in
`.jsonl` and present, else the `src/ingest/subagents.js` convention
`<dirname>/<sessionId>/subagents/agent-<agentId>.jsonl`), advances a child cursor
under `<home>/reasoning/cursors/agents/<safeId(sessionId)>/<sha256(agentId) first
32 hex>.json` — a parent cursor path is impossible to produce from a child call,
and the agent id is hashed rather than safeId'd, so a truncated or
character-substituted combined key (`a.b`/`a_b`, a 200-character session id) can
no longer alias the parent's file — carries `agentId`/`agentType` on the step
payload (agentType capped at 128 characters), never loads, advances or saves the
parent's cursor, and treats an agent id outside `[A-Za-z0-9_-]` or longer than 128
characters as `unrecorded` with reason `agent-id-invalid` (no cursor touched).
`agent_transcript_path` that does not end in `.jsonl` is ignored and the convention
path is used; a subagent call may carry `agent_transcript_path` without a parent
`transcript_path` and still records from the agent transcript. A step carrying
`agentId` is excluded from the parent's `reconcileTrace` (and therefore from
`reasoningBinding`, which delegates to it). A child cursor is created with
`includeSidechain: true` so `scanEntry` does not skip the child transcript's own
sidechain lines; the choice rides on the cursor, survives a reset, and is checked
against the call's expected kind on every load (a parent cursor file with no
`includeSidechain` key still loads as a parent cursor). A parent
call's step payload and cursor are byte-identical to today.

**Part 2 — CORE, patch only** (`proposals/agent-id-attribution.patch`, never applied
by the builder):

- `bin/hook-pre-tool-use.js`: `parsePayload` reads `agent_id`/`agent_type` the same
  way `session_id` is read (string, trimmed non-empty, else null). They pass into
  every `meta` object handed to `gatedAction` (three sites), and — only when
  present — spread into the `both-layers-permissive`, `grant-use` and `warn`
  `policy-warn` receipts.
- `src/gate/index.js`: one small helper (`agentFields`, empty when `meta.agentId` is
  not a non-empty string) spread into all four `gated-action` receipts. The meta
  comment now names the fields and why.
- `bin/hook-post-tool-use.js`: `parsePayload` returns `sessionId`, `agentId`,
  `agentType`; the `egress-event` receipt gains `sessionId` (it has none today —
  same reason as KNOWN-LIMITS 35) plus the agent fields only when present.

Everywhere, absence of `agent_id` produces receipts with exactly today's keys
(plus `sessionId` on `egress-event`). No grant, nonce, verify or matching behaviour
changes.

## Why

Measured 2026-10-22 on the live chain, two probes:

1. A subagent's Bash call was recorded as a reasoning step **of the parent**, status
   `unrecorded` with reason `tool-use-not-in-transcript` — Lotor searched the
   parent's transcript for a tool_use that lives in the child's.
2. Worse: the subagent's call used the **parent's reasoning cursor** (cursor files
   are keyed by session id only, and the child shares the parent's session id) and
   advanced it by **9,495 bytes of the parent's transcript**. A child's call could
   claim or skip the parent's reasoning.
3. Gate rows from a subagent carry no mark that a subagent made them — KNOWN-LIMITS
   66/70 territory: the harness now fires the same hooks for subagent tool calls,
   and the row must say so.

## Sitting steps, in order

```
1. git show HEAD:proposals/agent-id-attribution.patch | git apply
   (the patch file must be committed to HEAD first — it is currently an
   uncommitted file in the working tree)
2. in test/agent-id-attribution.test.js: delete the `todo: true` option
3. npm test
```

If any hunk fails to apply, do not hand-merge: stop and re-read the patch against a
fresh checkout. The patch was written against c69f552.

## Open question for Isaac (stated, not decided)

**A child shares the parent's `session_id`, so a grant issued to the parent session
also covers its subagents' calls.** That was true before this work and stays true
after: this patch changes no grant behaviour. Now that gate rows carry `agentId`,
the coverage is at least *visible* on the chain — a grant consumed by a child shows
`agentId` on its `grant-use` row. Whether a grant should scope to the parent's own
calls only, or explicitly cover (or refuse to cover) children, is a decision for a
sitting, not something smuggled in here.

## Notes for the sitting

- KNOWN-LIMITS 66 and 70 should be amended after landing: gate rows (and reasoning
  steps) now mark subagent calls. The patch's own comments cite 66/70.
- The `both-layers-permissive` warning's "once per session" dedupe keys on
  `sessionId` alone; a parent and its children can therefore be warned ONCE, not
  once each. Left as is — it is a warning about posture, not attribution.
- Child steps are not reconciled at session end: a child step that misses the flush race,
  or runs before the subagent transcript exists, stays `unrecorded`. A child `unrecorded`
  count is expected, not a defect.
- Decision for the sitting: engine-error and unknown-mode `policy-warn` receipts do not
  carry agent fields in this patch.