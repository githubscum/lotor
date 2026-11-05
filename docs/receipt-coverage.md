# What the chain records, and what it does not

**Written 2026-07-26 by reading the writers, not by reading notes about them.**
**Re-derived 2026-11-05 against commit 22ae903 by reading every append site.**
Every claim below cites the writer's file and the function or `type:` literal
that produces it, never a line number. Line numbers drift, and citing them is
how this file went stale between 2026-07-26 and 2026-11-05. Where a claim
could not be grounded in source it says so instead of guessing.

This document exists because counting is the product. A counter whose coverage
nobody has enumerated is a counter making promises it has not checked.

---

## The shapes

Nine kinds of entry share one chain and **they do not share a shape**. Two
different fields discriminate them, which is stated below.

| Entry | Discriminated by | Written in |
|---|---|---|
| session receipt | *(neither)*: carries `session`, no `type` | constructed in `src/parser/index.js` (`parseSession`), appended and enriched in `src/ingest/index.js` (`ingestSession`) |
| `session-open` | `type` | `bin/hook-session-start.js`, in its `appendReceiptGuarded` callback |
| `gated-action` | `type` | `src/gate/index.js` (`gatedAction`), called from `bin/hook-pre-tool-use.js`, the `bin/gate.js` CLI, and the `gated_action` MCP tool in `src/mcp/server.js` |
| `policy-warn` | `type` | `bin/hook-pre-tool-use.js` (six construction sites), `bin/hook-post-tool-use.js` (one) |
| `egress-event` | `type` | `bin/hook-post-tool-use.js` (`main`) |
| `grant-use` | `type` | `bin/hook-pre-tool-use.js`, the grant path of the gate branch |
| `delegation-grant` | `type` | `src/grant/issue.js` (`recordGrantOnChain`); the type is the `GRANT_TYPE` constant in `src/grant/grant-schema.js` |
| `reasoning-step` | `type` | `src/reasoning/index.js` (`captureStep`, appended by `recordReasoningStep`), triggered from `bin/hook-post-tool-use.js` (`main`) on every tool call |
| `ledger-head` | **`kind`** | **no writer in this repository** |

Two naming conventions live in one chain: camelCase payloads under `type`,
and the attempt-ledger's snake_case payloads under `kind` (read together in
`src/mcp/server.js`, `summarizeEntry`). Any reader checking only `type`
labels the `ledger-head` rows `unknown`.

---

## Field by field

### Session receipt, from `src/parser/index.js` (`parseSession`), appended by `src/ingest/index.js` (`ingestSession`)

The original shape. **It carries no `type` field at all**, because it predates
typed payloads. It is identified by the presence of `session`. Ingest decides
`subsession` and runs the no-change guard inside `appendReceiptGuarded`, so
two concurrent firings of the same session cannot both append subsession 0 or
duplicate a no-change append. One chain entry answers "what did that session do".

- `session`: `id`, `model`, `version`, `startedAt`, `endedAt`.
  `subsession` (0, 1, 2, ...) is added by ingest. Each qualifying SessionEnd
  appends a new receipt subsession when the transcript has grown; no growth,
  no append.
- `counts`: `turns`, `toolCalls`, `failures`, `transcriptEntries`,
  `assistantMessages`.
- `ran`: array of `{ tool, id, paramsDigest, paramsDigestCanonical }`.
  `paramsDigest` is the 16-hex parser dedup digest;
  `paramsDigestCanonical` is the full 64-hex digest over the params/1
  canonicalisation. The presence of the second field marks receipts written
  after the Observa interop seam was wired; it may carry
  `correlationIdEcho` when the harness planted `_observaCorrelationId` in
  the tool input (echoed verbatim, bounded, never interpreted).
- `touched`: array of `{ path, via, alsoVia?, outcome? }`, the structured
  record of files a session changed. `outcome` exists only for
  Edit/Write attempts settled by a tool_result: `ok`, `error`, or `unknown`
  when the session died mid-turn. Entries that came only from file-history
  carry no `outcome` key.
- `failed`: array of `{ tool, id, errorDigest }`.
- `cost`: `inputTokens`, `outputTokens`, `cacheCreationTokens`,
  `cacheReadTokens`, `byModel`, and `schema: 'cost/4'`. `byModel` is a
  per-model breakdown keyed by the model string the runtime wrote, one
  bucket of `inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
  messages` per model; a message with no model lands in the `"unknown"`
  bucket rather than being dropped, and no sum across buckets is produced.
  The parser's own `note` field says so: **tokens only; no USD in source**.
  The parser's `cost.thoughts` array is replaced by ingest, before the
  append, with a binding `{ schema: 'thoughts/1', count, digest }` over a
  sidecar file, so the receipt stays slim.
- `sent`: `{ items: [{ tool, target }], captureNote }`, filled by
  `isNetworkTool` and `extractTarget` in `src/parser/index.js`. The
  `target` is PLAINTEXT on the chain: the full URL for a WebFetch call, the
  full query for a WebSearch call, and the first 100 characters of a Bash
  command. A Bash command qualifies when its lowercased text contains any
  network verb as a bare substring (`curl`, `wget`, `git push`, `git pull`,
  `git fetch`, `npm publish`, `npm install`, `npx`, `ssh`, `scp`, `rsync`,
  `ping`, `telnet`, `nc `, `netcat`), so `mapping` qualifies through `ping`.
  Nothing redacts the target (KNOWN-LIMITS 87). The note says the capture is
  self-attested and outbound is not fully derivable from JSONL.
- `receiptSchema: 'receipt/2'`.
- `transcriptHash`: full 64-char SHA-256 over the exact transcript bytes the
  receipt summarizes. It proves what was hashed, not that what was hashed
  was the whole session.
- Added by ingest, before the append:
  - `chapters`: `{ schema: 'chapters/1', count, digest }`, a digest binding
    over chapter titles derived from the same text the receipt summarizes.
    Titles are stripped before hashing, so operator words never enter the
    chain.
  - `reasoning`: the reconciliation between the `reasoning-step` receipts on
    the chain and the transcript. When binding fails it carries
    `{ schema: 'reasoning-trace/1', error }`. Its normal-success shape was
    not fully chased in this pass (see the audit note at the bottom).
  - `reach`: the close half of the reach certificate
    (`src/reach/certificate.js`, `measureCloseCertificate`), schema
    `reach/1`, model and runtime each with the basis they were measured on,
    a per-rung map over `R0` through `R6`, `deepestRecorded`,
    `deepestObserved`, and an open-half link taken from the chain inside the
    lock. A measurement failure is a distinct `measurement-failed` state, so
    a failed rung never reads as "measured and found nothing".
  - `subagents`: present only when the caller passed `transcriptPath` and a
    `<sessionId>/subagents/` directory of child transcripts sits beside it
    (`src/ingest/subagents.js`). Omitted entirely otherwise, never a false
    zero. Its inner field shape was not fully chased in this pass.

### `session-open`, from `bin/hook-session-start.js` (within its `appendReceiptGuarded` callback)

- `toolPins`, `toolDefs`, `toolPinDiff`, `toolPinDiffSummary`,
  `toolPinSchemaVersion` (`tp/1`), from `buildToolPins`: fingerprints of
  every tool definition the harness exposed at open, a diff against the most
  recent previous open that carried pins, and (when the harness gave a
  listing) `toolDefs` holds the **full tool definitions in plaintext**. When
  the harness exposed no listing, the pin fields are null and the summary
  says so.
- `sessionId`: sits at payload level, deliberately not nested under
  `session`. The source comment says why: the view layer treats any payload
  carrying `session` as a full session receipt, and an open is not one. A
  reader that only looks under `session.id` drops it silently.
- `openIndex`: counted under the chain lock; SessionStart fires again on
  resume, clear and compact, and each firing gets its own entry.
- `source`, `cwd` (null when the payload carried none), `transcriptPath`.
- `chainHeadAtOpen` (`{ seq, hash }` or null), `chainLengthAtOpen`,
  `verifiedAtOpen` (`{ ok, reason, brokenAt? }` from verifying the chain as
  loaded, against the chain public key).
- `policy`: `{ version, mode, modes, digest }` of the effective policy, or
  null when the policy could not be loaded (the open is still recorded).
- `hooks`: the hook-registration snapshot (`src/registration.js`,
  `snapshotHookRegistration`): `readable`, `sessionStart`, `preToolUse`,
  `postToolUse`, `sessionEnd`, `sourcesRead`. A settings file that could not
  be read records `readable: false` instead of a false "not registered".
- `observer`: what the witness itself was capable of: `schema: 'observer/2'`,
  `packageVersion`, `matcher` and `parser` stamps (`{ schema, hash }`), and
  `build`, the whole-tree source digest. Absence on an older entry means the
  chain predates instrument versioning, not an error.
- `harness`: which harness wrote this and on what basis (`declared`,
  `inferred`, `unknown`). Never a bare name: an unknown harness stays
  unknown rather than defaulting to the common case.
- `reach`: open half of the certificate (`src/reach/certificate.js`,
  `buildOpenCertificate`): model and runtime as the harness declared them,
  each with its basis, rungs left `not-yet-measured`. Nothing has been
  emitted at open, so any rung stated there would be a guess.
- `lotorVersion: 1`, `timestamp`.

### `gated-action`, from `src/gate/index.js` (`gatedAction`)

Four construction sites inside the one function: three denials and one
approval, appended through the `chain.append` interface the caller passes.

- common to all four: `type`, `decision` (`approved`, `denied`, or
  `stale_signature` when verification failed because the token's timestamp is
  stale or in the future), `action`
  (the tool name), `ruleId` (null when the caller had no rule), `sessionId`
  (null when the caller had none), `agentId`/`agentType` **only when the
  caller's meta carries an agent id** (a call made inside a subagent),
  `paramsDigestCanonical`, `heldMs` (milliseconds between staging and
  decision, or null), `matcherHash`, `timestamp`.
- each denial adds `reason` (`no approval token provided`, the verification
  failure, or `approval token nonce already used (replay detected)`).
- the approval adds `approvalNonce` (the nonce that was verified and spent).

**`paramsDigestCanonical` is a digest, never the params.** It is a full
64-hex SHA-256 over the request's params under the params/1 canonicalisation
(`src/parser/index.js`, `digestParamsCanonical`). The hook caller
(`bin/hook-pre-tool-use.js`) signs only the subset of params that carry
security meaning (`command`, `file_path`, `url`, `path`), so this digest
covers exactly that subset; the `gated_action` MCP tool and the `bin/gate.js`
CLI pass whatever params the caller supplied and digest all of them.

**It records that a signature was spent, on which tool, against the digest of
the signed params, and whether it was denied or approved.** What it does not
record: the params themselves, the agent's stated purpose, anything about the
response. The digest proves a request was identical or different and tells
you nothing about either. Per-signature attribution is derivable only by
candidate matching (`src/views/autograph.js` attributes by charter window,
with digest attribution computed against candidates, for exactly this
reason).

Callers that pass no meta (`bin/gate.js` CLI, the `gated_action` MCP tool)
produce null `ruleId`, `sessionId`, `heldMs` and no agent fields on the row.

### `policy-warn`, from `bin/hook-pre-tool-use.js` (six sites) and `bin/hook-post-tool-use.js` (one)

Not one shape but four, all `type: 'policy-warn'`:

- `ruleId: 'engine-error'` (three sites in the pre hook, one in the post
  hook, same keys): `ruleId`, `tool`, `paramsDigest` (16-hex),
  `matcherHash`, `timestamp`. **No session id and no agent fields.** This is
  the engine reporting that the engine itself is degraded; it has no session
  binding to offer.
- warn-mode rule hit (one site): `ruleId`, `tool`, `agentId`/`agentType`
  (subagent calls only), `paramsDigest`, `matcherHash`, `timestamp`.
  **No session id.**
- `ruleId: 'both-layers-permissive'` (one site, at most once per session,
  deduplicated by a chain read): `ruleId`, `sessionId`,
  `agentId`/`agentType` (subagent calls only), `tool`, `lotorMode`,
  `harnessMode`, `matcherHash`, `timestamp`. **No `paramsDigest`**: it warns
  about posture, not a specific call.
- unknown mode treated as warn (one site): `ruleId`, `tool`, `paramsDigest`,
  `matcherHash`, `timestamp`. **No session id and no agent fields.**

`paramsDigest` is a hash of the JSON tool input, so the params are provably
identical or provably different and never readable.

### `egress-event`, from `bin/hook-post-tool-use.js` (`main`)

Written only for a Bash call that matched an egress rule
(`push-force`, `push-protected`, `publish`, `egress-other`; `matchEgress`
returns null for every other tool). Anything else writes no egress row, but
the `reasoning-step` row for that call was already written before this check.

- `ruleId`, `tool`, `sessionId` (null when the hook payload carried none),
  `agentId`/`agentType` (a subagent's call only), `paramsDigest` (16-hex),
  `responseDigest` (16-hex over the JSON of the response, `empty` when there
  was none), `responseOk` (boolean, or null when no success/error signal
  was recognizable), `toolIo`, `matcherHash`, `timestamp`.

`toolIo` is real, on the chain, not staged: `src/toolio/index.js`
(`describeToolResponse`) builds `{ schema: 'toolio/1', hash, response }`
where `hash` names the code that ran it and `response` is either
`{ recorded: true, digest, bytes }` plus the host's own error flag, or
`{ recorded: false, reason: 'absent' | 'null' | 'unserializable' }`. An empty
string or empty object **is** recorded; unrecorded is never an empty or
sentinel digest. Where `responseOk` and `toolIo`'s error flag disagree,
`toolIo` is authoritative. It sits beside the legacy `responseDigest`, not
in place of it.

### `grant-use`, from `bin/hook-pre-tool-use.js` (grant path of the gate branch)

Appended via `appendReceiptGuarded` together with the grant decision itself,
inside the chain lock: the use count is read and the entry lands on the same
view, so two overlapping calls under one grant cannot both pass the ceiling.

- `grantId`, `useIndex`, `ruleId`, `tool`, `agentId`/`agentType` (subagent
  calls only), `paramsDigest` (16-hex over the full tool input),
  `matcherHash`, `timestamp`.
- **No `sessionId`.** The grant itself is session-bound and the resolution
  was given the session id, but the row does not carry it; a grant use is
  attributed to the grant, not the session.
- If the use cannot be recorded, the call is denied: the ceiling is enforced
  by counting these rows, so an unrecorded use would be an uncounted one.

### `delegation-grant`, from `src/grant/issue.js` (`recordGrantOnChain`)

The type is the `GRANT_TYPE` constant (`'delegation-grant'`) in
`src/grant/grant-schema.js`, so a scan for `type:` string literals will not
find it at the append site; this doc names it anyway.

- `grantId`, `sessionId`, `requests`, `maxActions`, `issuedAt`,
  `expiresAt`, `nonce`, `signature` (the owner's, verifiable against the
  approval public key, which is passphrase-derived and never on disk),
  `timestamp`.

**This is the one writer that puts exact request parameters on the chain in
plaintext, including command strings.** The source comment states why: a
digest would let someone verify a grant file they still have, not reconstruct
what was authorized once the file is gone, and reconstruction is the
requirement. The chain entry is the record, not the authority: a grant is
honoured because it carries a valid signature, and the verifier deliberately
does not require a chain row.

### `reasoning-step`, from `src/reasoning/index.js` (`captureStep`, appended by `recordReasoningStep`, triggered from `bin/hook-post-tool-use.js` (`main`))

One per tool call, before the egress fast path, so every call gets a step
whether or not it matched an egress rule. Never throws; a failure is a note,
never a changed outcome.

- always: `type`, `schema: 'reasoning-step/1'`, `sessionId` (null when the
  payload had none), `toolUseId`, `tool`, `captureMs`, `timestamp`, and
  `agentId`/`agentType` when the call was made inside a subagent (a child
  has its own cursor file under `cursors/agents/` and never advances the
  parent's).
- recorded path adds: `status: 'recorded'`, `matchedBy` (`tool_use_id` or
  `name+input`), `kind`, `kinds`, `blocks`, `chars`, `digests` (one row per
  thinking block, up to a cap, `{ block, sha256, length }`;
  `digestsTruncated` names the overflow), `segmentDigest`, `batchIndex`,
  and a `transcript` binding for the I/O the capture performed.
- unrecorded path: `status: 'unrecorded'`, `reason` (`no-session-id`,
  `agent-id-invalid`, `subagent-transcript-not-found`, `no-transcript-path`,
  `transcript-missing`, `transcript-unreadable`, `tool-use-not-in-transcript`),
  `kind: 'unrecorded'`, `kinds`, and the same `transcript` binding.

**No content is on the chain.** Thinking blocks and transcript segments are
bound by digest and length. The cursor read-advance-write runs inside the
chain lock, so parallel tool calls cannot interleave cursor updates.

### `ledger-head`: no writer in this repository

Observed in the chain on 2026-07-26 at seq 727 and 728. Fields:
`limit_id`, `limit_text_sha256`, `entry_count`, `head_hash`.

Two things about it are worth stating plainly.

It is discriminated by **`kind`**, not `type`, and its fields are snake_case
where every other payload is camelCase. So the chain has two naming
conventions and two discriminator fields. Any reader checking only `type`
labels these rows `unknown`.

And **nothing in this repository writes it.** A grep for the string across
the writers finds it only in comments and tests. It is produced by the
attempt-ledger work, which lives in a separate staging tree outside
`src/` and `bin/` (not checked in this pass). A chain that accepts entries
from writers outside the repository is not wrong, but it means **this table
cannot claim to be complete**, and any future audit should re-derive it from
the chain rather than from this file.

---

## What the chain does not record, anywhere

**Intent.** No entry carries why anything was done. The agent's `description`
is used to build the denial message and is staged for display alongside a
request, deliberately off the chain, so it can never bind a signature or be
voided by rewording (`bin/hook-pre-tool-use.js`). Receipts are behavioural
metadata: which named tools ran, against digests of their parameters. Every
surface built on them has to say so, and the views in this repo do.

**Reasoning content.** The `reasoning-step` receipts and the session
receipt's thinking digests bind thinking-block and transcript-segment
**digests**. The words themselves are never on the chain.

**What was approved, as text.** An approved `gated-action` row carries the
params digest, the nonce, the tool, and nothing else. The params themselves
never reach a gate row. What changed since 2026-07-26: **grant-authorized
actions are no longer fully in this gap.** The `delegation-grant` row records
the exact authorized requests in plaintext, by design, and each `grant-use`
row records the digest of the params of the call that spent it. So the chain
pairs a legible authorized request against each granted use. For a
token-approved action the chain still cannot show the approved text: the
match to a charter item is reconstructed by candidate comparison in
`autograph.js`.

**Plaintext, and where it is.** Most rows reduce their subject to a digest,
which proves two things are the same and tells you nothing about either.
These fields hold readable text: the session receipt's `touched` paths and
`sent` targets (URLs, search queries, the first 100 characters of
network-shaped Bash commands, see KNOWN-LIMITS 87); `session-open` `cwd`,
`transcriptPath` and `toolDefs`; `delegation-grant` `requests` (see
KNOWN-LIMITS 18). So "the chain holds digests" is not a safe summary, and a
chain is not safe to share just because it is digest-heavy.

**Session attribution for gate decisions, and for other rows.** `gated-action`, `egress-event`,
`session-open`, `reasoning-step` and the `both-layers-permissive` warn carry
a session id (`null` when the writer had none). What still carries none:

- `policy-warn` in its `engine-error`, warn-mode, and unknown-mode shapes.
- every `grant-use` row, which is attributed to the grant, not the session.

`agentId`/`agentType` name the subagent a call was made inside, on every row
that carries them, and are present only for subagent calls (the hook payload
carries the parent's session id plus those two fields). Rows written before
each field's date simply have no key for it.

**Cost in money.** Tokens are recorded, per model now (`cost.byModel`). The
receipt's own note says no USD is derivable from the source.

**Turn boundaries.** No entry says where one operator prompt ended and the
next began. A session is an open row and close receipts with totals; the
order of tool calls is on the chain through `reasoning-step` rows, one per
call, but nothing on the chain marks which operator prompt a call answered.
The session receipt's `chapters`
binding (2026-09-07) carries a digest of the chapter list, so a reader
recomputing chapters from the transcript named in
`session-open.transcriptPath` can tell whether they got the list the
receipt bound. What the view prints is still a claim about that file,
cross-checked by digest, never a claim the chain itself makes.

**Completeness.** Capture is self-attested. A clean chain proves nothing was
altered after the fact. It does not prove anything was written in the first
place. **Silence is not safety**, and an empty report means nothing was
recorded rather than nothing happened. The hooks make this concrete: the
post hook writes no egress row on its fast path, the pre hook exits with no
write when no rule matched, and a receipt append that throws is a note on
stderr, not a row.

---

## Consequences already acted on

- `query_receipts` reports every row as `type ?? kind ?? session`
  (`src/mcp/server.js`, `summarizeEntry`) and **omits a field that does not
  apply rather than zeroing it**, so a gate denial and an idle session are
  distinguishable. Both naming conventions are read; `ledger-head` rows are
  reported with no session id.
- `src/views/since.js`, behind `sessions_since`, groups by session but still
  lists every `gated-action`, `policy-warn` and `egress-event` row as
  unattributed and prints the caveat that gate decisions carry no session
  id. That caveat is false for rows since 2026-09-07; KNOWN-LIMITS 74 names
  it as open.
- `autograph.js` attributes signatures by charter window, with digest
  candidate matching computed beside it, because full per-signature
  attribution is not derivable from the gate row alone.
- Readers accept `kind` as well as `type` (`src/mcp/server.js`,
  `summarizeEntry`).

## What this audit did not do

It did not read every writer end to end; it read the receipt-construction
sites and the fields they set there, with the helper functions named in the
citations. This pass walked every append site in `src/` and `bin/`, which is
wider than the 2026-07-26 pass, but not the whole graph. Specifically not
fully chased: the normal-success shape of the session receipt's `reasoning`
field, the inner fields of the ingest `subagents` summary, the basis rules
of `resolveHarness` (`src/harness.js`), and the inner nesting of the reach
certificate's per-model rung maps. A field constructed conditionally deeper
inside one of these helpers could appear on the chain without appearing in
this file. `test/docs-receipt-coverage.test.js` trips on a **new `type:`
literal** landing without a doc update, and its second check reads the
`GRANT_TYPE` constant in `src/grant/grant-schema.js` as text and requires
the `delegation-grant` type to be named in the doc. What the tripwire still
cannot see: a new field on an existing shape, a type passed through some
other constant, and any new entry kind written outside this repository, so
this table still cannot claim to be complete for writers it has never read.
