# seal CLI (KNOWN-LIMITS 86, non-core half) — DRAFT, not landed

Executor: glm-5.3-flash:cloud (WO-L86-01, 2026-11-15). Target paths `bin/seal.js` and
`test/seal-cli.test.js` are self-mod gated; the executor's write was refused (request
39343210, unsigned, expired). Bytes staged here as `.draft` so nothing runs them.

## Verifier finding (ike, 2026-11-15) — blocks landing as drafted

`check <note>` calls only `verifyIncremental({ trusted })`. That proves the sidecar still
holds a record signing the kept root and that entries AFTER it verify forward. It never
recomputes the root over the entries the note covers. So a same-length rewrite of a
covered entry reports CONSISTENT. The executor's own test file pins that as expected
behaviour; it is the case a kept note exists to catch (limit 84), so the CLI would hand
the holder false comfort.

Fix for round 2: `check` = `verifyIncremental({ trusted })` (fork detection) AND
`verifySealed()` (full walk from genesis; it checks every sidecar root, including the one
equal to the kept root, against the entries). Report CONSISTENT only when both pass.
Optional `--fast` keeps incremental-only, with the limit 85 caveat printed.
Flip the "same-length substitution stays CONSISTENT" test to expect INCONSISTENT.
