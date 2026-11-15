# WO-L86-02 receipt — seal CLI round 2

Date: 2026-11-15. Branch: `lotor-lane/seal-cli`. Files touched: exactly the two
the work order named, plus this receipt. No git commands run, nothing under
`src/`, `bin/` or `test/` touched.

## seal.js.draft (179 → 221 lines)

- `doCheck()` now runs BOTH `store.verifyIncremental({ trusted })` (fork
  detection against the kept note) AND `store.verifySealed()` (full walk from
  genesis), and exits 0 with CONSISTENT only when both are `ok`. Incremental
  failure keeps the round-1 output (`INCONSISTENT  <reason>` plus the
  `first bad entry` line, exit 2) and short-circuits before the walk. If
  incremental passes but the walk fails, it prints `INCONSISTENT  <verifySealed
  reason>` and exits 2.
- CONSISTENT message updated to the new three-clause form; `--fast` keeps the
  old two-clause round-1 message.
- Added `--fast` (accepts `check --fast <note>` and `check <note> --fast`;
  parses `--fast` out of the arg list and requires exactly one remaining path,
  so `check` alone or two paths is still a usage error, exit 1). In fast mode
  it prints, after the result line, exactly:
  `--fast skipped the full walk: a same-length rewrite of entries the note covers is not checked (KNOWN-LIMITS 85).`
- Usage lines and the header comment updated: the claim that a covered rewrite
  is invisible to `check` is gone; both checks and the `--fast` skip are now
  documented there.
- Result-shape check against `src/store/checkpoints.js` (read only):
  `verifyIncremental` returns `{ ok, reason, brokenAt?, from, size }`,
  `verifySealed` returns `{ ok, reason?, size, checkpoints }` — the drafted
  code uses only those fields.

## seal-cli.test.js.draft (279 → 331 lines)

- Flipped "case 5 companion (disclosed)": same tamper (same-length `"r"`→`"R"`
  at entry 2), now asserts `check` exits 2 and stdout matches `/INCONSISTENT/`
  and `/hash mismatch at entry 2/`. The old trailing store-level
  `verifySealed` assertion was dropped — the reason now comes out of `check`'s
  own stdout, which is the stronger pin.
- Added: `check --fast <note>` on that same tamper exits 0, matches
  `/CONSISTENT/`, matches the exact `--fast skipped the full walk: ...` line.
- Added: `check <note> --fast` (flag after path) behaves identically.
- Added: `check <note> --bogus` exits 1 with usage on stderr.
- Case 4's expected CONSISTENT regex updated to the new message.
- Header comment rewritten for round 2 (the old round-1 "ONE DISCLOSURE"
  paragraph is gone).

## Things I was unsure of (judgment calls, flagged for review)

1. **Fast-mode failure output.** The WO says fast mode "prints, after its
   result line, exactly: ...". I decided "its result line" includes the
   INCONSISTENT case, so `--fast` prints the skip notice on both the CONSISTENT
   exit 0 path and the INCONSISTENT exit 2 path. If the notice was meant for
   success only, the fix is to move one `stdout.write(FAST_LINE)` call.
2. **Repeated `--fast`.** `check --fast --fast <note>` is accepted (flags are
   treated set-like before the exactly-one-path check). The WO pins before/after
   the path but says nothing about repeats; I chose leniency here and strictness
   for anything that is not `--fast` or the single path.
3. **`verifySealed()` throwing.** The WO specifies only the `ok: false` path. I
   wrapped the call in try/catch and `die(e.message, 2)` to match the existing
   error style of every other store call in the file.
4. **Tests were not run.** As the WO states, they cannot run in place (the
   drafts live outside `test/`). I also attempted a syntax-only parse
   (`node --check`) on both drafts, but the permission to run node was not
   granted, so that did not happen either — the edits were reviewed by eye
   against the store API only. Nothing in this receipt should be read as a
   test pass.
5. **Ordering guarantee relied on.** Case 5 (one-byte shrink, `/truncated/`)
   and case 6 (fork) still pass in round 2 only because incremental failure
   short-circuits before the walk; if the ordering were reversed, their stdout
   could differ.
