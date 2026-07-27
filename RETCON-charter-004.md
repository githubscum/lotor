# Retcon: CHARTER 004, the counting surface

**Written 2026-07-26 20:20 CDT.** Charter issued 19:30 CDT, expires 2026-07-28
19:15 CDT. Signature and enumeration hash both verify.

**This appendix was written by hand, because the automated retcon cannot do this
job and reported the opposite of the truth.** That is the headline finding and it
is documented below with evidence rather than asserted.

---

## The automated run, and why its output is wrong

`npm run retcon -- --charter 004` reports:

```
  closed 0   blocked 0   withdrawn 0   open 8
  DEVIATION
    declared and never attempted   8
    attempted and not declared     0
```

**Seven of the eight items are built, tested and committed.** Verified against
`git log` and a green suite of 657, not against memory. The tool reports every
one of them as never attempted.

### Why: the two sides canonicalise different shapes

`bin/retcon.js:197` populates `actionsSeen` from `gated-action` receipts only:

```js
const c = canonicalizeItem(p.action);
```

On a gate receipt, `p.action` is a **bare tool-name string** — `"Edit"`,
`"Bash"`, `"PowerShell"`. But `declared` is built at line 329 from the charter's
items, which are `{ action, params: { file_path } }` objects.

**A string and an object never canonicalise to the same key, so no declared item
can ever match.** The string form almost certainly throws, is swallowed by the
empty `catch` on line 199, and `actionsSeen` stays empty — which is exactly why
both directions report absurdly: everything declared is "never attempted" and
nothing at all is "not declared".

**The deeper reason is a coverage fact, not a bug.** Per
`docs/receipt-coverage.md`, only the **session receipt** carries file paths, in
its `touched` array. Gate receipts carry no path at all (`KNOWN-LIMITS` 36). So
a charter of file items cannot be reconciled against gate receipts even in
principle. The comparison needs `touched`, and `touched` is written once, at
session end, which for this charter has not happened yet.

### And the caveat block states specific false facts

`bin/retcon.js:356-357`:

```js
w('    They carry no intent, ever. This shows that items 3 and 7 never ran');
w('    and that four things ran which were not on the list. It cannot show');
```

**That is hardcoded prose, not derived output.** It names items 3 and 7 and a
count of four regardless of the data, and it directly contradicts the numbers
printed six lines above it in the same report.

A tool whose entire purpose is honest reconciliation is stating invented
specifics in its own honesty section. This is worse than crying wolf: crying
wolf is a true signal at the wrong threshold, and this is a false statement with
a confident shape.

**Neither is fixed here.** `bin/` is non-delegable core, one signature per edit,
and the charter's own rules say to stop and record rather than work around.
Filed as `KNOWN-LIMITS` 38 and 39.

---

## What actually happened, verified by hand

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | `query_receipts` typed summaries | **closed** | `9909ef1` |
| 2 | The since-view | **closed** | `3bfe5e3` |
| 3 | Both surfaced over MCP | **closed** | `86a4aac` |
| 4 | Autograph ratio | **closed** | `2e747f1` |
| 5 | Coverage audit | **closed** | `121cf04` |
| 6 | Confession entries | **closed** | `fb59b86`, limits 35-37 |
| 7 | Tests | **closed** | 657 green; prove-fail-first run late, `5e08da2` |
| 8 | This appendix | **closed** | this file |

**8 of 8 closed.** 1,301 insertions across 12 files.

### Declared but not enumerated: five files

The enumeration named eight paths. Twelve were touched. The five extra, each a
consequence of changing a contract rather than scope creep:

| File | Why |
|---|---|
| `test/mcp.test.js` | its allowlist pinned the old summary shape |
| `test/mcp-e2e.test.js` | pinned the exact tool list |
| `test/server-identity.test.js` | asserts the manifest declares every served tool |
| `manifest.json` | had to declare the new tool, enforced by the test above |
| `test/autograph.test.js` | a third test file where two were declared |

**Nothing blocked any of these**, because nothing consults charters at the gate.
They were recorded in each commit message as they happened, which is the only
reason this table can be written now.

**This is the charter earning its keep with no enforcement whatsoever.** The
value was never a shield; it was having something to compare against afterwards.

### Prove-fail-first: broken, then satisfied late

Item 1's fix was written before its test, so the discipline was broken. Rather
than assert the test would have caught it, the pre-fix summariser was reproduced
verbatim and the assertions run against it. **All five failed**, so the test
discriminates. Recorded in the test file's own header, not just here.

---

## What this appendix does not tell you

**It presents. It does not detect.** Receipts carry which named tools ran and a
digest of their parameters. They carry no intent, ever. The table above is built
from git history and a test run, which are evidence of what was *committed*, not
of what was *intended*.

**The chain could not corroborate any of it.** This session had one row in the
chain — its `session-open` — for the entire duration of the work. The session
receipt that would carry `touched` is written at session end and does not exist
yet. So every "closed" above rests on git and the suite, and the receipt layer
contributed nothing to this reconciliation.

**That is the finding worth carrying forward.** A charter is reconciled against
the record, and for file work the record arrives only after the work is over.
Until a session's receipt exists, the retcon is reading an empty room.
