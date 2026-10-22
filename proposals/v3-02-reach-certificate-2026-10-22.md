# STAGED 2026-10-22: the reach certificate (v3 V3-02)

Drafted 2026-10-22 by the V3-02 lane builder. Core: lands only at the owner's
signing sitting. Spec: `LOTOR-V3-SPEC-2026-10-18` ("The reach certificate",
row V3-02, evals E1 and E2) and the V3-01 measurement.

## The rule

Each session states the model, the runtime and the deepest rung recorded,
**measured, not declared**, so a later finding can never claim more depth
than its record had. V3-01 measured the failure this guards against: Ollama
cloud accepts a logprobs request, answers HTTP 200, and silently leaves the
field out.

## What is in the branch, and what is staged here

| Part | Where | State |
|---|---|---|
| Certificate builder, measurer, checker | `src/reach/certificate.js` (new; `src/reach/index.js` is #60's V3-05 observer) | in the branch |
| Close half on every session receipt | `src/ingest/index.js` | in the branch |
| Tests | `test/reach-certificate.test.js` | in the branch; one marked todo |
| Open half on the session-open receipt | `bin/hook-session-start.js` | **staged**: `v3-02-session-open-reach.patch` |
| Classification of `src/reach` | `test/core-classification.test.js` or core-paths + policy | **left for the owner**; that test fails on this branch alone. #60 (merges first) adds `reach` to GRANTABLE, which settles it for both modules unless the owner reverses it |
| Chain hashes an own `__proto__` key | `src/chain/index.js` | **staged**: `v3-02-chain-proto-key.patch` (found by the review fixes, below) |

## Added by the review fixes (2026-10-22, PR #70, second-family review)

Review F1: a model id is a transcript string, and used as a key on a plain
object `__proto__` wrote to `Object.prototype` (both here and in the
parser's `cost.byModel`), while `constructor` and `toString` wrote to shared
builtins and dropped the model from the certificate. Fixed in the branch:
tallies are Maps, the parser publishes buckets as own properties, and the
certificate's `byModel` is a **list** of `{ model, ... }` entries.

The list, rather than a null-prototype object, because of what the fix
turned up in the chain: `sortKeysReplacer` rebuilds each object by plain
assignment, so an own `__proto__` key is dropped from the canonical form and
the value under it can be edited without breaking verification. A keyed
certificate would have carried that gap; the list does not. `cost.byModel`
still does, today, for a transcript that names a model `__proto__`.

`v3-02-chain-proto-key.patch` closes it: a null-prototype `sorted` in
`sortKeysReplacer` (every other key canonicalises byte-for-byte as before,
pinned by its second test) and `test/chain-proto-key.test.js`. Fail-first was
run against the unpatched chain: the tamper test fails (the edit verifies),
the compatibility test passes. The green side was **not** run, because
applying the patch is the gated act. `git apply --check` passes on the
branch. One consequence to weigh: a chain that already holds an own
`__proto__` key anywhere would stop verifying at that entry once this lands.
That is the record surfacing an entry that was never fully hashed, not new
breakage, but it should be checked against the live chain first.

KNOWN-LIMITS: this is a new limit, not yet numbered. 75 to 78 are claimed by
open PRs (#61/#62, #67, #71) and the numbering test requires 1..N contiguous,
so a number taken here would either collide or fail the suite on this branch
alone. Assign the next free number (79 if those land first) at the sitting.

The hook is gated by the self-mod rule in every mode, so the lane did not
apply the two-line wiring. It is staged as a patch (`git apply --check`
passes against main at 5198a07, working tree and index). The test that
exercises it through the real hook is marked `todo` and must pass once the
patch is applied and the todo removed.

## The classification decision (the one failing test)

`test/core-classification.test.js` refuses any directory under `src/` that is
in neither CORE_DIRS nor GRANTABLE, and says it will not guess. The lane did
not guess either. Recommendation, for the owner to take or reverse:

- **Grantable today**, with the reason: "states evidentiary depth on a
  receipt; can mislead a reader, cannot change what the gate permits", the same
  line drawn for `harness.js`, `ingest` and `parser`. One line in GRANTABLE.
- **Moves to core the day a policy reads it.** The spec's sensitive-material
  rule (secrets only to a model whose certificate meets a stated rung) would
  make this module decide what is permitted. At that point it belongs in
  CORE_DIRS and `selfModFragmentsForBase()`, both, or the drift guard fails.
