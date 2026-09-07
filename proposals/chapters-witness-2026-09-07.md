# DRAFT: witnessing the chapter list on the session receipt

Drafted 2026-09-07 by the chapters-view work order. **Not applied.** Queued for
Isaac's next signing sitting per AGENTS.md rule 5 (core changes accumulate into
one ceremony). Companion to KNOWN-LIMITS 62.

## What is unwitnessed today

`src/views/chapters.js` derives a per-prompt chapter list from the transcript
file on disk. The chain binds that file's bytes through the receipt's
`transcriptHash`, so a reader can tell whether the chapters were derived from
the bytes the hook saw. The chain does not bind the chapter list itself: a
future change to the chaptering rules, or a different reader applying
different rules to the same bytes, produces a different list with the same
`transcriptHash` and nothing on the chain notices.

## The change

At session end, the receipt gains one field:

```json
"chapters": { "schema": "chapters/1", "count": 7, "digest": "<sha256 hex>" }
```

`digest` is SHA-256 over the canonical chapter JSON **with every title
removed**: key-sorted at every depth, arrays in order, one JSON array of
`{ index, startedAt, endedAt, turns, toolCalls, tools, touched, failures }`.
Titles are operator words and never land on the chain. Everything that does
land is a count, a timestamp or a path, and paths are already on the receipt
under `touched`.

The shape mirrors the thoughts binding that has been on receipts since
2026-08-29 (`cost.thoughts = { schema, count, digest }`), and for the same
reason: bind by digest, do not embed. Unlike thoughts, no sidecar is written.
The transcript is the sidecar; anyone holding the bytes recomputes the list
and the digest. `chaptersCanonical()` and `chaptersBinding()` already exist in
`src/views/chapters.js`, are tested, and the view already verifies a receipt
that carries this field (`chaptersDigestMatches`). Landing this proposal
turns that null into a true.

## Where the patch actually lands, and a correction to the work order

The work order asked for diffs to `bin/hook-session-end.js` and
`src/parser/index.js`. Reading both: **neither needs to change.**

- `bin/hook-session-end.js` reads the transcript bytes and calls
  `ingestSession(text, { transcriptBytes })`. It constructs no receipt fields.
- `src/parser/index.js` builds the ReceiptSummary, but the binding step for
  thoughts does not live there either. The parser emits the raw array and
  `src/ingest/index.js` replaces it with `{ schema, count, digest }` before the
  append. Putting chaptering in the parser would also invert the layering
  (`src/parser` importing from `src/views`).

So the single real change is in `src/ingest/index.js`, alongside the thoughts
binding, and it is the diff below. `src/ingest/` is not in the gate's
non-delegable core list, but it is the writer of every session receipt on the
chain, which is the surface this proposal changes. It goes to the ceremony on
that basis, not on a path match. If the owner prefers the parser to carry the
raw array for symmetry with `cost.thoughts`, the second diff shows that shape;
it is strictly more code for the same digest and is not the recommendation.

### Diff 1 (recommended): `src/ingest/index.js`

```diff
--- a/src/ingest/index.js
+++ b/src/ingest/index.js
@@
 import { parseSession } from '../parser/index.js';
 import { createStore } from '../store/index.js';
 import { resolveHome } from '../home.js';
+import { chaptersFromClaudeTranscript, chaptersBinding } from '../views/chapters.js';
@@ function ingestSession(jsonlText, opts = {}) {
       digest: crypto.createHash('sha256').update(sidecarText, 'utf-8').digest('hex')
     };
   }
+
+  // Chapter binding (2026-09-07, KNOWN-LIMITS 62). The chapter list is
+  // derived from the same text the receipt summarises; the receipt carries
+  // its digest so a reader recomputing chapters from the transcript can
+  // tell whether they got the list the hook saw. Titles are stripped
+  // before hashing: operator words never enter the chain. No sidecar is
+  // written, because the transcript already is one.
+  receiptSummary.chapters = chaptersBinding(chaptersFromClaudeTranscript(jsonlText));
```

### Diff 2 (alternative, not recommended): raw array in the parser, bound in ingest

```diff
--- a/src/parser/index.js
+++ b/src/parser/index.js
@@ function parseSession(jsonlText, opts = {}) {
+  // opts.chapters: when the caller has already chaptered the transcript,
+  // the raw list rides on the summary for ingest to bind. The parser does
+  // not chapter itself: src/parser must not import src/views.
+  const chapters = Array.isArray(opts.chapters) ? opts.chapters : undefined;
@@
   return {
     session,
     ran,
     touched: Array.from(touched.entries()).map(([path, meta]) => ({ path, ...meta })),
     failed,
     cost: { ...cost, schema: 'cost/4' },
+    ...(chapters ? { chapters } : {}),
```

```diff
--- a/src/ingest/index.js
+++ b/src/ingest/index.js
@@
+import { chaptersFromClaudeTranscript, chaptersBinding } from '../views/chapters.js';
@@ function ingestSession(jsonlText, opts = {}) {
-  const receiptSummary = parseSession(jsonlText, opts);
+  const receiptSummary = parseSession(jsonlText, {
+    ...opts,
+    chapters: chaptersFromClaudeTranscript(jsonlText)
+  });
@@
+  if (Array.isArray(receiptSummary.chapters)) {
+    receiptSummary.chapters = chaptersBinding(receiptSummary.chapters);
+  }
```

### `bin/hook-session-end.js`

```diff
(no change)
```

## Test to land with it

`test/ingest-chapters-binding.test.js`: ingest the chapters fixture into a
throwaway `LOTOR_HOME`, read the appended receipt, assert
`payload.chapters.schema === 'chapters/1'`, `count === 2`, digest equals
`chaptersBinding(chaptersFromClaudeTranscript(fixture)).digest`, and that the
serialised payload does not contain the string `Please fix`. Then run
`chaptersReport` over that home's chain and assert
`chaptersDigestMatches === true`. Fail-first: the first assertion is red on
current main because no receipt carries `chapters`.

## What it does not do

- It does not witness Codex. Nothing runs at Codex session end; a binding
  needs a writer, and there is none. KNOWN-LIMITS 62 stays true for Codex.
- It does not bind titles, on purpose, and so it cannot detect a transcript
  whose prompts were reworded but whose counts were untouched. That is the
  `transcriptHash` bind's job, and it already does it.
- It does not change `receiptSchema`. A receipt without `chapters` predates
  this; absence reads as "unrecorded", the same rule as `thinkingBlocks`.
- It does not pin the chaptering rules. `chapters/1` names this
  canonicalisation; if `chaptersFromClaudeTranscript` changes what a chapter
  is, bump the schema, or old receipts will verify false for a reason a reader
  cannot see.
