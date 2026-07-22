# Changelog

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
