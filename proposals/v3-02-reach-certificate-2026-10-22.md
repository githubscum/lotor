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
