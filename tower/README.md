# Lotor tower — the local UI

A localhost-only reader over the receipt chain. It binds to `127.0.0.1`,
reads `LOTOR_HOME/receipts/chain.jsonl` (default `~/.lotor`), and never
writes to the chain. Code only: this directory ships no data, and the
pages render whatever chain exists on the machine they run on.

Run:

```
node tower/lineage-server.mjs
```

then open http://localhost:7778. Pages:

- `/lotor` — the product view: day blocks, where each session's work
  landed, rapid-evaluation rail, and **export → QR** (PAP): a spine goes
  through a server-side leak check, is signed by the chain key via
  `bin/pap-export.js`, and comes back as a scannable bundle bound to the
  live chain head. The chain key never reaches the browser.
- `/events` — every receipt, filterable. Any gate event expands into its
  **decision path**: tool → rule → params digest → signature wait →
  nonce → verdict, drawn from the fields the receipt actually carries.
  Receipts from before the 2026-08-15 enrichment render their missing
  steps dimmed as "unrecorded" rather than guessed at.
- `/control` — the mode panel (herded / grazing / loose) and the witness
  board. The outside-witness slot renders UNWITNESSED until a second
  party is configured, which is the point.
- `/` — session detail (the chain as a spine).
- `/ontology?source=receipts` — the chain as decision lineage.

Two routes (`/people`, and ontology sources `cards`/`decisions`) expect
operator-local data files that are deliberately not part of this repo;
they degrade to an error message when those files are absent. The
structure ships, the contents stay with the operator.
