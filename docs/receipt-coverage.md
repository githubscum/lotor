# What the chain records, and what it does not

**Written 2026-07-26 by reading the writers, not by reading notes about them.**
Every claim below cites the file that produces the thing described. Where a
claim could not be grounded in source it says so instead of guessing.

This document exists because counting is the product. A counter whose coverage
nobody has enumerated is a counter making promises it has not checked.

---

## The six shapes

Six kinds of entry share one chain and **they do not share a shape**. Two
different fields discriminate them, which is the first finding below.

| Entry | Discriminated by | Written in |
|---|---|---|
| session receipt | *(neither)* — carries `session` | `src/parser/index.js` |
| `session-open` | `type` | `bin/hook-session-start.js` |
| `gated-action` | `type` | `src/gate/index.js` |
| `policy-warn` | `type` | `bin/hook-pre-tool-use.js`, `bin/hook-post-tool-use.js` |
| `egress-event` | `type` | `bin/hook-post-tool-use.js` |
| `ledger-head` | **`kind`** | **no writer in this repository** |

---

## Field by field

### Session receipt — `src/parser/index.js:186,190`

The original shape. **It carries no `type` field at all**, because it predates
typed payloads. It is identified by the presence of `session`.

- `session` — id, model, subsession
- `counts` — `turns`, `toolCalls`, `failures`, `transcriptEntries`,
  `assistantMessages`
- `touched` — array of `{ path, ...meta }`, so this is the **only** entry type
  that records paths

This is the only entry that answers "what did that session do".

### `session-open` — `bin/hook-session-start.js:216`

- `sessionId`, `openIndex`, `source`, `cwd`, `transcriptPath`
- `chainHeadAtOpen`, `chainLengthAtOpen`, `verifiedAtOpen`
- `policy` — version, mode, modes, digest

**`sessionId` sits at payload level, deliberately not nested under `session`.**
The source comment says why: the view layer treats any payload carrying
`session` as a full session receipt, and an open is not one. A reader that only
looks under `session.id` drops it silently, which is what `query_receipts` did
until this pass.

### `gated-action` — `src/gate/index.js:149, 167, 192, 209`

Four call sites, three denials and one approval.

- denied, no token: `decision`, `action`, `reason`, `timestamp`
- denied, invalid token: same
- denied, nonce replay: same
- **approved**: `decision`, `action`, `approvalNonce`, `timestamp`

**It records that a signature was spent and on which tool. It does not record
what was approved.** No path, no command, no params, no request digest. This is
the hardest limit in the file and it is load-bearing: a signature cannot be
matched to a charter item after the fact, so per-signature attribution is not
merely unbuilt, it is not derivable. `src/views/autograph.js` attributes by
window for exactly this reason.

### `policy-warn` — `bin/hook-pre-tool-use.js:626,643,688,712,731,895` and `bin/hook-post-tool-use.js:249`

- `ruleId`, `tool`, `paramsDigest`, `timestamp`

A rule that warned rather than gated. `paramsDigest` is a hash, so the params
are provably identical or provably different and never readable.

### `egress-event` — `bin/hook-post-tool-use.js:259`

- `ruleId`, `tool`, `paramsDigest`, `responseDigest`, `responseOk`, `timestamp`

The only entry that records anything about a **response**, and only as a digest
plus a boolean.

### `ledger-head` — **no writer in this repository**

Observed live in the chain at seq 727 and 728. Fields: `limit_id`,
`limit_text_sha256`, `entry_count`, `head_hash`.

**Two things about it are worth stating plainly.**

It is discriminated by **`kind`**, not `type`, and its fields are snake_case
where every other payload is camelCase. So the chain has two naming conventions
and two discriminator fields. Any reader checking only `type` labels these rows
`unknown`. Both readers in this repo did until this pass; both were fixed in the
same commit as this document.

And **nothing in this repository writes it.** A grep for the string across all
JavaScript finds it only in a comment, a test, and the chain itself. It is
produced by the attempt-ledger work, which lives in a separate staging tree. A
chain that accepts entries from writers outside the repository is not wrong, but
it means **this table cannot claim to be complete**, and any future audit should
re-derive it from the chain rather than from this file.

---

## What the chain does not record, anywhere

**Intent.** No entry carries why anything was done. Receipts are behavioural
metadata: which named tools ran, against digests of their parameters. Every
surface built on them has to say so, and the views in this repo do.

**What was approved.** See `gated-action` above. The tool, never the target.

**Paths, except in one place.** Only the session receipt's `touched` array
carries paths. Gate decisions, warnings and egress events all reduce their
subject to a digest. A digest proves two things are the same and tells you
nothing about either.

**Session attribution for gate decisions.** `gated-action` has no `sessionId`.
With concurrent sessions running, a denial cannot be attributed to the session
that caused it, and attributing by timestamp would be a guess that is wrong
often enough to be worse than an honest gap.

**Completeness.** Capture is self-attested. A clean chain proves nothing was
altered after the fact. It does not prove anything was written in the first
place. **Silence is not safety**, and an empty report means nothing was
recorded rather than nothing happened.

**Cost per model or per harness.** A session touching several models reports one
blended total under whichever ran last.

---

## Consequences already acted on

- `query_receipts` reported every row through one shape with `|| 0`, so a gate
  denial and an idle session were indistinguishable. Fixed; **absent is now
  omitted rather than zeroed**.
- `sessions_since` groups by session and reports gate decisions unattributed
  rather than guessing.
- `autograph.js` attributes signatures by charter **window**, because the
  per-signature version is not derivable.
- Both readers now accept `kind` as well as `type`.

## What this audit did not do

It did not read every hook end to end; it read the receipt-construction sites
and the fields they set. A field set conditionally somewhere below those lines
would not appear here. The honest scope is **what each writer constructs at the
point it constructs it**, and a fuller pass should walk each hook in full.
