# WO-TOOLPORT-EXTRACT-01 — Toolport extractions, grantable halves + core drafts

**Dispatched:** 2026-08-08, remote session. Executor: Ollama lane.
**Repo:** `C:\Users\liemi\agent-receipts` (Lotor).
**Design source:** `C:\Users\liemi\.second-brain\projects\spinoff\TOOLPORT-EXTRACTION-2026-08-08.md` — read it first.

## Hard constraints (read before any edit)

1. **DO NOT edit these paths, at all:** `src/gate/`, `src/policy/`, `src/store/`,
   `src/chain/`, `src/grant/`, `src/charter/`, `bin/`, `package.json`,
   `.claude/`. They are the non-delegable core; editing them without a
   signature is the exact failure this system exists to stop. If a task seems
   to need one of them, write the needed change into the proposal doc instead.
2. **DO NOT run any shell/bash commands.** No git, no npm, no test runs. The
   dispatching session runs the suite as verification. Your lane is: read
   files, edit/create files in the allowed set, report.
3. **Allowed write locations:** `src/parser/`, `test/`, `proposals/`.
4. The repo has uncommitted changes on branch `trials/portability-2026-07-30`,
   including `src/policy/index.js` (landed work, not yours). Do not touch any
   already-modified file except `src/parser/index.js` is NOT in the modified
   set — verify with a read, not an assumption, before editing it.
5. Read the live source of every file before editing it. Do not trust this WO's
   line numbers.

## Task 1 — `digestParamsCanonical` in the parser (grantable)

`src/parser/index.js` has `digestParams(input)` (~line 230) doing
`JSON.stringify(input)` with no key sorting, truncated digest. Add alongside it
(do not remove or change the existing function or its call sites):

- `export function digestParamsCanonical(input)`: SHA-256 hex, full 64 chars,
  over a canonical serialization: object keys sorted recursively at every
  depth, arrays kept in order, scalars via JSON. Strings hash as their JSON
  encoding. Implement the canonical serializer locally in this file (the
  existing `sortKeysReplacer` lives in `src/gate/sign.js`, which is core — do
  NOT import from it; instead note in your report that the ceremony may dedupe
  the two later).
- JSDoc on the function stating: schema marker for receipts using this is
  `params/1`, extending the `<class>/N` convention `matcher/1` established.
- Wire NOTHING into receipt emission. Export only.

## Task 2 — pinned-hash regression tests (grantable)

New file `test/params-canonical.test.js` using the repo's existing test style
(node:test, look at a neighboring test file for conventions):

1. **Byte-compat pin:** compute the canonical digest of the fixture
   `{"b":1,"a":{"d":4,"c":3}}` once, then assert the literal hex string in the
   test with a comment: "must remain byte-for-byte compatible with digests
   persisted by previous versions — if this test fails, every previously
   signed params/1 digest is orphaned." (You will need to derive the literal:
   write the implementation first, require it in a small inline computation
   inside the test file at authoring time is NOT acceptable — hardcode the
   literal you compute by hand-tracing or by a temporary assertion you then
   freeze. State in your report how you derived it.)
2. Key order does not change the digest (same object, two orderings).
3. Array order DOES change the digest.
4. Different content → different digest.
5. Digest is 64 lowercase hex chars and never contains the raw value.
6. Nested-object sorting is recursive (three levels deep).

## Task 3 — denial-receipt enrichment proposal (draft only, core)

Write `proposals/denial-enrichment-2026-08-08.md` in the Lotor repo. Content:
ready-to-apply diffs (unified format, exact current-source context lines from
a live read) for:

- Denial receipts gaining: `ruleId` (which rule fired), `paramsDigestCanonical`
  (from Task 1's function), `decision`, `heldMs` (ms between staging and
  decision where measurable).
- `decision` as a five-way enum: `approved | denied | no_response |
  stale_signature | unreachable`. `stale_signature` = a valid unexpired token
  exists for this rule/path but the command string did not byte-match it —
  today that surfaces as a generic denial; name it so signature-burn is
  countable.
- The test code (do NOT create failing test files; embed the test code in the
  proposal) proving each new field, written prove-fail-first style: state what
  the test asserts and why it fails against current source.
- Name the files each diff touches and mark every one CORE (they will be:
  `bin/hook-pre-tool-use.js`, `src/gate/index.js` — confirm by reading).

## Task 4 — tool-definition pinning proposal (draft only)

Write `proposals/tool-pinning-2026-08-08.md`. Design per the extraction doc
§4: fingerprint = SHA-256 over name + description + inputSchema + outputSchema
+ annotations with NUL separators and a version prefix (`tp/1:`); pin at first
sight; diff on later sight; annotation-downgrade rule is `old === true && new
!== true` (dropping the hint counts — omission is the evasion); severity high
on destructive tools or any downgrade. Propose:

- Module code in full (JS, repo style) for `fingerprintTool(def)` and
  `diffPins(oldPins, newPins)` — pure functions, no I/O.
- Where it should live, with the classification question stated openly:
  a new `src/` directory defaults to REFUSED by `test/core-classification`
  until classified; the emission side (session-open receipt) is core. Lay out
  the split; recommend; do not decide.
- A draft KNOWN-LIMITS entry: detection surface is what the harness exposes at
  listing time; a mid-session mutation between listings is unseen; silence is
  not safety.

## Report format (mandatory)

Per task: status (done / drafted / blocked+why), files created or edited with
exact paths, and for Task 1-2 the function signature and the pinned literal
digest. List any file you read but did not modify. Do not claim tests pass —
you cannot run them; the verifier does. End with anything you saw in the live
source that contradicts this WO.
