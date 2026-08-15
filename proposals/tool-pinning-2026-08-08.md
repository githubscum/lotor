# Proposal: tool-definition pinning — 2026-08-08

**Draft only.** This proposal COMMITS to a non-trivial block of new code
(`fingerprintTool`, `diffPins`) and to a placement decision that the
operator must make. Nothing here has been applied. Nothing here is
grantable under the current `core-paths.js` mapping — see the placement
section below.

## Why

A tool's listing is what an agent reads before deciding to call it. If
the listing changes between sessions and the change is never surfaced,
the agent can be talked past a guard by a listing that quietly omits
the guard. Three concrete shapes the threat takes:

- `description` is rewritten to drop a warning that previously said
  "this does X". Still the same name, same inputSchema, same
  fingerprint under any definition that excludes description. The
  agent reads the new text and trusts it.
- `annotations.readOnlyHint` is dropped from `true` to absent. The
  shape difference is a single missing key, but the meaning flips
  from "no side effects" to "presumed side effects" or the reverse,
  depending on the harness's default.
- `inputSchema` is widened to allow a parameter that was previously
  forbidden. The agent calls with the new parameter and the harness
  honours it.

The defence is a listing-time fingerprint that the chain records at
session-open, and a session-open receipt that compares the current
listing against the prior one and names the diff. Pin at first sight;
diff on later sight; the operator gets the receipt and decides what
to do.

## What

Two pure functions, no I/O, deterministic, served by one source module
whose location is the operator's decision (see placement).

### `fingerprintTool(def)`

A tool definition is `{ name, description, inputSchema, outputSchema,
annotations }`. The fingerprint is:

```
sha256( "tp/1:" + name + "\0" + description + "\0"
      + canonicalJson(inputSchema) + "\0"
      + canonicalJson(outputSchema) + "\0"
      + canonicalJson(annotations) )
```

…where `canonicalJson` is the same recursive-key-sorter as
`digestParamsCanonical` in `src/parser/index.js` (string hash byte
count, no key reordering to worry about because NUL separators
disambiguate fields, but recursive sort still wins for `inputSchema` /
`outputSchema` / `annotations` which are objects).

The `tp/1:` prefix is a schema marker, mirroring `matcher/1` in
`src/policy/index.js` and `params/1` in Task 1 of this WO. Bump it
on a hashing-rule change; signers before the bump remain verifiable
against their own prefix.

NUL (`\0`) separators mean a description cannot smuggle a literal
`</annotations>` or any other field boundary. Without them, a
description ending in `</annotations><annotations>{"readOnlyHint":false}`
would re-parse into a different object graph under naive concatenation.

### `diffPins(oldPins, newPins)`

Given two `{ name -> fingerprint }` maps, produce a sorted list of:

```js
[
  { name, status: 'added' | 'removed' | 'unchanged' | 'changed',
    oldFp?: string, newFp?: string, severity: 'low' | 'high' }
]
```

Severity rules:

- `added`                   → `low` (new tool, surfaced for review)
- `removed`                 → `high` (a tool the agent relied on is gone)
- `unchanged`               → not in the output (filter at the call site)
- `changed`                 → depends on the change:
  - `annotations.readOnlyHint` going `true → absent` → `high`
  - `annotations.readOnlyHint` going `true → false` → `high`
  - `annotations.readOnlyHint` going `false → true` → `low`
  - any other annotations change → `low`
  - `description` changed     → `low` (informational; surface it)
  - `inputSchema` widened     → `high` (new params allowed)
  - `inputSchema` narrowed    → `low`
  - `outputSchema` changed    → `low`

The annotation-downgrade rule in the WO is **explicit**: `old === true
&& new !== true` counts as a downgrade. Omission is the evasion. If
the previous tool said "this is read-only" and the new tool says
nothing, the safe assumption is that the new tool is NOT read-only;
the diff must call that out, not equate absence with continuity.

#### Severity on tool identity alone

The diff also tags as `high` any change to a tool whose name appears in
Lotor's own destructive list (the same list `src/policy/index.js` uses
for destructive-tool detection). A `Bash` whose `description` is
shortened is not the same event as a `WebFetch` whose `description`
is shortened; the first is a much bigger deal.

### Module code

```js
// src/<placement>/tool-pin.js  (see placement section)
//
// Tool-definition pinning: fingerprint a tool listing at first sight,
// diff on later sight, surface the deltas in the session-open receipt.
//
// THIS MODULE IS PURE. No I/O. No chain. No MCP. Anything that wants
// to use these functions brings its own inputs and decides what to do
// with the outputs.

import crypto from 'node:crypto';

const SCHEME = 'tp/1';
const NUL = '\0';

/**
 * Deterministic JSON for canonical hashing. Same surface as
 * src/parser/index.js's digestParamsCanonical: object keys sorted
 * recursively, arrays kept in order, scalars via JSON.
 *
 * Strings are hashed as their JSON encoding so escapes are stable.
 * The NUL separators in the fingerprint format keep field boundaries
 * absolute, so a sorted-key recomposition of inputSchema cannot
 * collide with a different schema whose raw JSON is a permutation.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = canonicalJson(value[i]);
    return out;
  }
  const sorted = {};
  for (const k of Object.keys(value).sort()) {
    sorted[k] = canonicalJson(value[k]);
  }
  return sorted;
}

/**
 * Compute the fingerprint of a single tool definition.
 *
 * @param {Object} def - Tool definition as exposed by the harness.
 *        Must have at least `name`. Missing fields are treated as
 *        empty strings / empty objects, so a definition that drops
 *        `description` fingerprints differently from one that had it.
 * @returns {string} 64-char lowercase hex SHA-256
 */
export function fingerprintTool(def) {
  if (!def || typeof def !== 'object' || typeof def.name !== 'string') {
    throw new Error('fingerprintTool: def.name is required');
  }
  const parts = [
    SCHEME,
    def.name,
    typeof def.description === 'string' ? def.description : '',
    JSON.stringify(canonicalJson(def.inputSchema || {})),
    JSON.stringify(canonicalJson(def.outputSchema || {})),
    JSON.stringify(canonicalJson(def.annotations || {}))
  ];
  return crypto.createHash('sha256').update(parts.join(NUL)).digest('hex');
}

/**
 * The set of tool names that Lotor considers "destructive" for the
 * purposes of pin-diff severity. Mirrors the destructive-tool list
 * used in src/policy/index.js; deliberately duplicated here rather
 * than imported, because this module is intended to be pure and
 * standalone. The two MUST be kept in step manually.
 */
const DESTRUCTIVE_TOOLS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Agent'
]);

/**
 * Detect "inputSchema widened": any new required property, any
 * previously absent property now present, or any enum widened. Does
 * NOT cover the inverse (narrowing) — that is always `low`.
 *
 * Conservative by intent: a tightening we cannot prove is reported
 * as widened, which costs at most one false-high and never a missed
 * escalation.
 */
function schemaWidened(oldSchema, newSchema) {
  const oldProps = (oldSchema && oldSchema.properties) || {};
  const newProps = (newSchema && newSchema.properties) || {};
  const oldKeys = Object.keys(oldProps);
  const newKeys = Object.keys(newProps);
  // Any new property that did not exist before.
  for (const k of newKeys) {
    if (!oldKeys.includes(k)) return true;
  }
  // A previously optional property that is now required is a widening.
  const oldRequired = new Set((oldSchema && oldSchema.required) || []);
  const newRequired = new Set((newSchema && newSchema.required) || []);
  for (const r of newRequired) {
    if (!oldRequired.has(r)) return true;
  }
  // Enum widening.
  for (const k of newKeys) {
    const oldEnum = oldProps[k] && oldProps[k].enum;
    const newEnum = newProps[k] && newProps[k].enum;
    if (Array.isArray(newEnum) && Array.isArray(oldEnum)) {
      for (const v of newEnum) {
        if (!oldEnum.includes(v)) return true;
      }
    }
  }
  return false;
}

/**
 * Detect an annotations readOnlyHint downgrade: old === true and
 * new !== true. The WO states this explicitly: omission is the evasion.
 */
function annotationsDowngrade(oldAnno, newAnno) {
  const oldHint = (oldAnno && oldAnno.readOnlyHint) === true;
  const newHint = (newAnno && newAnno.readOnlyHint) === true;
  return oldHint && !newHint;
}

/**
 * Diff two pin maps. The result is sorted by name then by status, so
 * the output is byte-stable for a given input pair — important for a
 * receipt that records the diff.
 *
 * @param {Object} oldPins - { name -> fingerprint } from prior session
 * @param {Object} newPins - { name -> fingerprint } from current session
 * @param {Object} oldDefs - { name -> full definition } from prior session
 * @param {Object} newDefs - { name -> full definition } from current session
 * @returns {Array<{name, status, oldFp?, newFp?, severity, detail?}>}
 */
export function diffPins(oldPins, newPins, oldDefs = {}, newDefs = {}) {
  const out = [];
  const names = new Set([...Object.keys(oldPins), ...Object.keys(newPins)]);
  for (const name of [...names].sort()) {
    const oldFp = oldPins[name];
    const newFp = newPins[name];
    if (oldFp && !newFp) {
      out.push({ name, status: 'removed', oldFp, severity: 'high',
        detail: 'tool present last session, absent this session' });
    } else if (!oldFp && newFp) {
      out.push({ name, status: 'added', newFp, severity: 'low',
        detail: 'new tool exposed this session' });
    } else if (oldFp === newFp) {
      // unchanged; omitted by caller if it wants only diffs
      out.push({ name, status: 'unchanged', oldFp, newFp, severity: 'low' });
    } else {
      const oldDef = oldDefs[name] || {};
      const newDef = newDefs[name] || {};
      const destructive = DESTRUCTIVE_TOOLS.has(name);

      let severity = 'low';
      const detailParts = [];

      if (annotationsDowngrade(oldDef.annotations, newDef.annotations)) {
        severity = 'high';
        detailParts.push('readOnlyHint dropped from true');
      }
      if (typeof oldDef.description === 'string'
          && typeof newDef.description === 'string'
          && oldDef.description !== newDef.description) {
        detailParts.push('description changed');
      }
      if (schemaWidened(oldDef.inputSchema, newDef.inputSchema)) {
        severity = 'high';
        detailParts.push('inputSchema widened');
      }
      if (JSON.stringify(canonicalJson(oldDef.outputSchema || {}))
          !== JSON.stringify(canonicalJson(newDef.outputSchema || {}))) {
        detailParts.push('outputSchema changed');
      }
      if (destructive && severity === 'low') {
        severity = 'high';
        detailParts.push('destructive tool changed');
      }

      out.push({
        name, status: 'changed', oldFp, newFp, severity,
        detail: detailParts.join('; ') || 'definition changed'
      });
    }
  }
  return out;
}

/**
 * A short human-readable summary of a diff, for inclusion in the
 * session-open receipt. Caps at the first 8 entries so the summary
 * cannot be inflated by a hostile harness to bury the line above.
 */
export function summaryDiff(diff) {
  const changed = diff.filter(d => d.status !== 'unchanged');
  if (changed.length === 0) return 'no tool-definition changes';
  const high = changed.filter(d => d.severity === 'high');
  const lines = [`${changed.length} tool-definition change(s)`];
  if (high.length > 0) {
    lines.push(`${high.length} HIGH severity:`);
    for (const d of high.slice(0, 8)) {
      lines.push(`  - ${d.status} ${d.name}: ${d.detail}`);
    }
  }
  return lines.join('\n');
}
```

## Placement — the classification question

The WO asks for the placement question to be laid out openly and a
recommendation given, with the decision left to the operator.

**The two surfaces that need this code are different:**

1. **The fingerprinting + diffing itself.** These are pure functions
   with no I/O. They can live anywhere; they have no authority over
   enforcement.

2. **The emission of the diff on the session-open receipt.** That
   emission lives in `bin/hook-session-start.js`, which IS core
   (covered wholesale by `core-paths.js`'s `bin` entry). It is also
   the only place the OLD pin map needs to be read from chain / written
   to chain — and the chain is core.

**The split is therefore:**

- `fingerprintTool` and `diffPins` → grantable. New directory
  `src/tools/` (or similar) would be the natural home. It is
  classified GRANTABLE by default because it is a new top-level
  directory under `src/`, and `core-classification.test.js` will
  refuse to leave that classification implicit.

- The wiring in `bin/hook-session-start.js` (read previous
  `tool-pins` field from the chain's last `session-open`, call
  `fingerprintTool` on each current `tools/list` entry, call
  `diffPins`, attach the result to the new `session-open` payload) →
  core. Lives in `bin/`, which is already covered.

**Recommendation.** Place the pure functions in a new
`src/toolpins/` directory. Register it in `core-classification.test.js`
under `GRANTABLE` with the rationale "pure functions over tool
definitions; no authority over enforcement." Keep the diff emission
inside `bin/hook-session-start.js` (the session-open hand-off is
already part of that hook's contract; adding a sub-field to it there
is the lightest touch, and the wiring naturally reads back what
`fingerprintTool` produced).

**Not recommended.** A single `src/toolpins/` module that BOTH
contains the pure functions AND reads from the chain — that crosses
the boundary and would have to be core, which means an untouched
module directory becomes core for the life of the project, which is
not worth the saving.

**Not decided.** Whether the `oldPins` map is read from the LAST
session-open receipt in the chain, or from a sidecar file at
`LOTOR_HOME/tool-pins.json`. The first is append-only and tamper-
evident; the second is editable and lets a hostile change the prior
baseline. The chain is the right answer; a sidecar is not.

## KNOWN-LIMITS entry (draft)

> **KNOWN-LIMITS N — tool-definition pin diff is listing-time only.**
> The fingerprint is computed over what the harness exposes when
> `tools/list` is called. A mid-session mutation between listings is
> unseen; the next listing is the next comparison point. This is a
> detection surface, not a guard. A change that persists for less than
> one listing window — rare in practice, but real — escapes the diff.
> Silence is not safety. The pin catches what the harness reports;
> it does not catch what the harness withholds.

## Test sketch (not embedded as a file — placement pending)

```js
// test/tool-pin.test.js  (placement pending; would test the pure functions)
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fingerprintTool, diffPins } from '../src/toolpins/tool-pin.js';

describe('fingerprintTool', () => {
  it('is stable across key order in inputSchema', () => {
    const a = fingerprintTool({ name: 'x', inputSchema: { properties: { a: 1, b: 2 } } });
    const b = fingerprintTool({ name: 'x', inputSchema: { properties: { b: 2, a: 1 } } });
    assert.strictEqual(a, b);
  });

  it('changes when description changes', () => {
    const a = fingerprintTool({ name: 'x', description: 'old' });
    const b = fingerprintTool({ name: 'x', description: 'new' });
    assert.notStrictEqual(a, b);
  });

  it('a description that contains NUL does not collide with a field boundary', () => {
    // The "tp/1:" prefix and NUL separators together prevent a
    // description of "old\0outputSchema" from re-parsing.
    const a = fingerprintTool({ name: 'x', description: 'old' });
    const b = fingerprintTool({ name: 'old', description: 'x' });
    assert.notStrictEqual(a, b);
  });
});

describe('diffPins', () => {
  it('treats readOnlyHint true -> absent as a downgrade', () => {
    const oldPins = { x: 'a' };
    const newPins = { x: 'b' };
    const oldDefs = { x: { name: 'x', annotations: { readOnlyHint: true } } };
    const newDefs = { x: { name: 'x', annotations: {} } };
    const [d] = diffPins(oldPins, newPins, oldDefs, newDefs);
    assert.strictEqual(d.severity, 'high');
    assert.match(d.detail, /readOnlyHint/);
  });

  it('escalates any change to a destructive tool to high', () => {
    const oldPins = { Bash: 'a' };
    const newPins = { Bash: 'b' };
    const oldDefs = { Bash: { name: 'Bash', description: 'short' } };
    const newDefs = { Bash: { name: 'Bash', description: 'longer' } };
    const [d] = diffPins(oldPins, newPins, oldDefs, newDefs);
    assert.strictEqual(d.severity, 'high');
  });

  it('marks added tools, not removed, as low severity', () => {
    const oldPins = {};
    const newPins = { x: 'a' };
    const [d] = diffPins(oldPins, newPins, {}, { x: { name: 'x' } });
    assert.strictEqual(d.severity, 'low');
    assert.strictEqual(d.status, 'added');
  });

  it('marks removed tools as high severity', () => {
    const oldPins = { x: 'a' };
    const newPins = {};
    const [d] = diffPins(oldPins, newPins, { x: { name: 'x' } }, {});
    assert.strictEqual(d.severity, 'high');
    assert.strictEqual(d.status, 'removed');
  });
});
```

## Summary for the operator

- **Pure module code:** full, in this proposal, ready to lift into
  `src/toolpins/tool-pin.js` (placement pending operator decision).
- **Classification:** GRANTABLE; new directory must be added to
  `core-classification.test.js`'s GRANTABLE list with the rationale
  stated. The drift-guard will catch a missing entry.
- **Emission site:** `bin/hook-session-start.js` — core, already
  covered. The proposal sketches where the call lands but does not
  write the diff, because writing it is a core change and costs a
  signature.
- **KNOWN-LIMITS entry:** drafted above. Apply as part of the wiring
  patch in the same signature.
- **Tests:** sketched but not landed. Apply them with the wiring
  patch; they live in `test/` and run against the same module.

---

*Prepared by the Ollama lane as part of WO-TOOLPORT-EXTRACT-01. Read-only
deliverable. The pure functions are written to be drop-in under the
operator's chosen directory; the wiring patch is a follow-up that
costs one signature.*
---

## REVIEWER NOTE (orchestrator verification pass, 2026-08-08 ~13:20 CDT) — one defect, fix before apply

`fingerprintTool` puts the `tp/1` scheme INSIDE the hash preimage but returns
bare hex. A consumer reading a pin cannot tell which algorithm version
produced it, so the version-aware quiet-re-baseline behaviour (re-pin without
crying wolf when the algorithm changes) is unimplementable — a v2 bump would
surface as every tool "changed", which is exactly the false-alarm flood the
versioning exists to prevent. Fix: return `tp/1:<hex>` (prefix on the OUTPUT,
mirroring `matcher/1`'s usage and the reference design), and give `diffPins` a
rule: prefix mismatch between oldFp and newFp → status `rebaselined`, severity
`low`, never `changed`. Keep the scheme in the preimage too (harmless,
domain-separates the hash). Everything else reviewed clean: NUL-separator
boundary-smuggling defence is sound, downgrade rule matches the
omission-counts spec, the DESTRUCTIVE_TOOLS manual-sync duplication is
honestly flagged (add a drift test at apply time: import both lists in a test
and assert equality — test files may import from core, only edits gate).
