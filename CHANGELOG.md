# Changelog

## 2026-07-23 — the record now opens when a session starts, and the docs stopped overclaiming

Lotor used to write its record only when a session ended. A session that was
killed, crashed, or lost power wrote nothing at all, which meant the log showed
a clean run of well-behaved sessions and gave you no way to tell that others had
existed. The sessions most worth a record were the ones being dropped.

A new `SessionStart` hook opens the record at the start instead: session id,
the policy in force, the chain head, and which Lotor hooks were actually
registered. It also brings the local store up before the first tool call rather
than lazily. A session that dies now leaves an opened-but-never-closed entry,
and `npm run receipts` reports the unclosed count. See `KNOWN-LIMITS.md` item 14
for what an open does and does not tell you, and the README install steps for
wiring it up. **If you installed before today, you need to add the hook.**

Separately, several claims in the README were stronger than the software. They
have been corrected rather than quietly softened:

- "the ground truth of what your agent actually did" is now "what your agent's
  session reported doing". Lotor proves a record has not been altered since it
  was signed. It does not prove the record is complete.
- "nothing leaves unless you sign a scoped disclosure" described an export path
  that does not exist. Scoped custodial integrations are **pending** and are now
  labelled as such wherever they appear. Today nothing leaves because nothing is
  built to send it, and anything you share, you share by hand.
- "once the passphrase is set, the gate is live" was wrong and was the most
  consequential of the three. Setting the key does not arm anything. The hooks
  are what stop an action and ask for a signature. The install docs now say so
  in those words, and list what each hook buys you.

A new "Not built yet" section collects everything named but unshipped, so no
sentence has to carry a promise it cannot keep.

## 2026-07-22 — token counts were about 2x too high, now fixed

Found and fixed a bug where every token count Lotor reported was roughly double
reality. Claude Code writes one assistant turn across several log lines, and each
line repeats the same usage numbers; the parser was adding it up every time
instead of once. Verified on real sessions: about 2x inflation, and the dedup is
exact, not a guess. Receipts written from today carry a `cost.schema` marker so
you can tell corrected numbers from old ones apart. Old signed receipts can't be
corrected (the log is append-only), so treat any token number from before today
as roughly double what it should be.

Also worth knowing: costs aren't yet broken out by which model or service ran
them. A session that uses more than one model reports one combined total. Full
detail in `KNOWN-LIMITS.md` items 12 and 13.
