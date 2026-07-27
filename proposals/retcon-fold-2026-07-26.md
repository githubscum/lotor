# Prepared: the last two edits for KNOWN-LIMITS 38 and 39

Written overnight 2026-07-26 with the operator asleep. **Not applied.** Both edits
touch `bin/retcon.js`, which is non-delegable core, so each costs one signature and
no charter can cover them.

## Why this is a document and not an applied patch

A `.patch` file applied with `git apply proposals/...` would **not** trip the gate,
because the command string names the patch and never `bin/`. That is a real hole and
using it would be routing around the control, which is the drift this project exists
to catch. So the work is prepared for review and left for a signature.

The same reasoning kept the reconciliation logic out of `bin/`: it lives in
`src/views/reconcile.js`, which `core-paths.js` excludes from the core because
rendering cannot change what is permitted. That module is written and **fully
tested** (`test/reconcile.test.js`, 13 assertions green). What remains below is
mechanical wiring plus a two-field change to the fold.

## State

- 689 tests, 687 pass, **2 fail**, both deliberate and both in `test/retcon.test.js`
- `counts gated calls by TOOL NAME from the shape the gate really writes`
- `keeps the touched PATHS from a session receipt, not just how many`

Applying edit 1 below turns both green. Edit 2 has no test of its own because it is
display wiring over already-tested functions; it is verified by running the tool.

---

## Edit 1 of 2 — the fold. One contiguous hunk, `reconstruct()`.

Replaces the `actionsSeen` field and the two branches that feed it.

**Find** (the tail of the `out` literal):

```js
    deniedByRule: new Map(),
    actionsSeen: new Map()    // canonical action -> count
  };
```

**Replace with:**

```js
    deniedByRule: new Map(),

    // Tool NAME -> count. The rename from `actionsSeen` IS the fix for
    // KNOWN-LIMITS 38. A gated-action receipt records `action` as a bare tool
    // name (src/gate/index.js:144) and never its target (limit 36), so this can
    // answer WHICH TOOLS ran and can never answer ON WHAT. It was previously
    // fed through canonicalizeItem(), which throws on a string, into an empty
    // catch, so in production it was ALWAYS EMPTY.
    toolsSeen: new Map(),

    // Every file path a session receipt reported in the window. The only path
    // evidence the chain carries, so the only thing a declared file item can be
    // reconciled against. Shape at src/parser/index.js:186 is { path, via }.
    touchedPaths: new Set()
  };
```

**Then, in the `p.session` branch**, after the existing `out.sessions.set(id, {...})`
call and still inside `if (id) {`:

```js
        // Keep the PATHS, not only how many. The count is what the summary
        // prints; the paths are what reconciliation needs, and discarding them
        // is why a charter of file items could not be checked at all.
        if (Array.isArray(p.touched)) {
          for (const t of p.touched) {
            const s = typeof t === 'string' ? t : (t && t.path);
            if (s) out.touchedPaths.add(s);
          }
        }
```

**Then, in the `gated-action` branch**, replace:

```js
      try {
        const c = canonicalizeItem(p.action);
        out.actionsSeen.set(c, (out.actionsSeen.get(c) || 0) + 1);
      } catch { /* not a shape we can canonicalize; skip */ }
```

**with:**

```js
      // `p.action` is a bare tool-name string, not an object. Calling
      // canonicalizeItem() on it threw into the empty catch below, every time,
      // which is the whole of KNOWN-LIMITS 38. Key by the tool name it is.
      if (typeof p.action === 'string' && p.action !== '') {
        out.toolsSeen.set(p.action, (out.toolsSeen.get(p.action) || 0) + 1);
      }
```

`canonicalizeItem` is then unused in this file and can drop out of the import from
`../src/charter/index.js`. Harmless either way.

---

## Edit 2 of 2 — `printCharter()`, the deviation block

Replaces the hand-rolled comparison and the hardcoded caveat with calls into the
tested module. Add to the imports:

```js
import { reconcile, deviationNote } from '../src/views/reconcile.js';
```

**Find** everything from `  // The bearing itself.` through the closing of the
`WHAT THIS DOES NOT TELL YOU` block, and **replace with:**

```js
  const out = reconcile(charter, r);

  w('  DEVIATION');
  w(`    confirmed by a touched path      ${out.confirmed.length}`);
  w(`    declared, no matching path       ${out.noEvidence.length}`);
  for (const x of out.noEvidence.slice(0, 8)) {
    w(`      - ${x.item.id || '?'}  ${truncate(detailOf(x.item), 56)}`);
  }
  if (!out.pathEvidenceAvailable) {
    w(`    NOT YET CHECKABLE                ${out.undetermined.length}   (no session has closed in this window)`);
  }
  w(`    cannot be checked at all         ${out.unreconcilable.length}   (receipts record no command strings)`);
  for (const x of out.unreconcilable.slice(0, 8)) {
    w(`      - ${x.item.id || '?'}  ${truncate(detailOf(x.item), 56)}`);
  }
  w(`    tools used but not declared      ${out.toolsNotDeclared.length}`);
  for (const x of out.toolsNotDeclared.slice(0, 8)) {
    w(`      - ${String(x.n).padStart(2)}x  ${x.tool}`);
  }
  w('');

  w('  WHAT THIS DOES NOT TELL YOU');
  for (const line of deviationNote(out).split('\n')) w(`    ${line}`);
  w('');
```

---

## After applying

1. `npm test` — expect **689 / 689**.
2. `node bin/retcon.js --charter CHARTER-004` — the charter that produced 38 and 39.
   It previously reported `declared and never attempted 8` for eight items that were
   built, tested and committed. It should now report them as confirmed, or as
   unreconcilable if they are command items, and the closing caveat should carry
   numbers that match the block above it.
3. Amend entries **38** and **39** in `KNOWN-LIMITS.md`. Do not skip this: limit 29
   exists because fixes land and disclosures do not, and **merging is the moment the
   amendment is owed**.
