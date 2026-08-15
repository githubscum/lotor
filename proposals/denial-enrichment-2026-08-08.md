# Proposal: enrich denial receipts — 2026-08-08

**Draft only.** Both diffs in this proposal touch core. Every change here costs one signature; nothing here has been applied, and nothing should be applied by a dispatched session.

## Why

A denial receipt today tells you WHAT was denied and WHEN. It does not tell you WHICH RULE fired, what the canonical parameter digest was (so the denial is correlatable with a token that was or could have been signed), what the gate's classification of the outcome was (a present-but-rejected token is not the same event as a missing token), or how long the request sat staged before a verdict landed. Each of these is a missing leg of the audit story:

- A reader cannot group denials by rule without parsing the human-readable
  reason string. Rule id is already known inside the hook — it has been
  thrown away at the receipt boundary since the original write.
- A denial's parameters live in `pending-approvals/requests/<id>.json`
  for the next 60 minutes; after that the link is gone. A `paramsDigest`
  on the receipt itself makes the correlation durable.
- "Token rejected" and "no token presented" share the same shape today
  and are indistinguishable in the chain. Both matter; conflating them
  hides signature-burn attacks (a valid unexpired token exists, but the
  command string changed) inside a generic denial count.
- "How long was this staged before a verdict?" is the operator's natural
  follow-up question when a denial surprises them, and today the answer
  requires reconstructing two mtimes.

## What changes

### 1. New decision enum

`gatedAction()`'s `decision` field, today a two-way `'approved'|'denied'`,
becomes a five-way enum:

| value             | meaning                                                                                |
|-------------------|----------------------------------------------------------------------------------------|
| `approved`        | token validated, nonce recorded, action permitted                                      |
| `denied`          | no token, no grant, or grant ceiling reached — fail-closed                             |
| `no_response`     | hook exited before a verdict (engine error, post-rule fail-open)                       |
| `stale_signature` | a token matched this rule+path, was unexpired and signature-valid, but its command string did not byte-match — signature-burn, countable separately |
| `unreachable`     | the gate could not be reached at all (e.g. resolveHome failed)                          |

`stale_signature` is the one this proposal exists to name. Today it
surfaces as a plain `'denied'` receipt with a free-text reason. Naming it
makes signature-burn countable in `query_receipts` aggregations without
parsing prose.

### 2. New fields on every `gated-action` receipt

```js
{
  type: 'gated-action',
  decision: 'approved' | 'denied' | 'no_response' | 'stale_signature' | 'unreachable',
  ruleId,                       // which matcher fired (already known in hook)
  action,                       // existing: bare tool name
  reason,                       // existing: human-readable
  paramsDigestCanonical,        // NEW: SHA-256 hex over canonicalized params
  heldMs,                       // NEW: ms between staging and verdict (when measurable)
  approvalNonce,                // existing (approval only)
  timestamp                     // existing
}
```

`paramsDigestCanonical` is the digest from `digestParamsCanonical()` in
`src/parser/index.js` — that function is grantable and was landed under
WO-TOOLPORT-EXTRACT-01. It is byte-stable across key reorderings, so
two denials of the same logical action produce the same digest.

`heldMs` is `Date.now() - stagedAt`, where `stagedAt` is the
`stagedAt` field written next to the request by `stageRequest()`. It is
measured where measurable, omitted otherwise; missing on receipt
denotes "stage did not happen for this denial."

### 3. CORE files touched

Both diffs below touch core, so they cannot be applied by a dispatched
session. The exact files (verified live, 2026-08-08):

- `bin/hook-pre-tool-use.js` — every deny path and the staging call
- `src/gate/index.js` — the `gatedAction` function and its return shape

---

## Diff 1 of 2 — `src/gate/index.js`

The five-way enum replaces the two-way `'approved'|'denied'`. Existing
callers that compare `result.decision === 'approved'` keep working;
existing callers that compare `=== 'denied'` now also catch
`stale_signature`, which is the desired behaviour (the operator does
not want to whitelist-bypass the new classification by accident).

### `gatedAction()` — return shape and the new field

```diff
@@ src/gate/index.js:141
- * @returns {Object} { decision: 'approved'|'denied', reason?, approvalNonce?, receiptSeq? }
+ * @returns {Object} {
+ *   decision: 'approved'|'denied'|'no_response'|'stale_signature'|'unreachable',
+ *   reason?, approvalNonce?, receiptSeq?,
+ *   ruleId?, paramsDigestCanonical?, heldMs?
+ * }
  */
 function gatedAction(actionRequest, approvalToken, chain, baseDir = DEFAULT_BASE_DIR) {
   const action = actionRequest?.action || 'unknown';
   const timestamp = Date.now();
+  // `paramsDigestCanonical` is computed once at the gate boundary so every
+  // receipt this function emits carries the same byte-stable identifier for
+  // the action, regardless of which deny path fired. The tool call's exact
+  // parameters are not recorded in the receipt — only the digest — so this
+  // is a correlation handle, not a leak.
+  const paramsDigestCanonical = digestParamsCanonical(actionRequest?.params || {});
+  // `heldMs` is provided by the caller when the request was staged. The
+  // gate itself does not stage; it only records. Absent (undefined) on
+  // the receipt means "stage did not happen for this call," not "zero".
+  const heldMs = typeof actionRequest?._heldMs === 'number' ? actionRequest._heldMs : undefined;
+  // `ruleId` arrives on the actionRequest under a `_ruleId` carrier when
+  // the caller (the hook) knows it. Keeping it on the request rather
+  // than as a separate parameter preserves `gatedAction`'s 4-arg shape.
+  const ruleId = actionRequest?._ruleId || null;
```

```diff
@@ src/gate/index.js:148-158 (no-token path)
   if (!approvalToken) {
     const receipt = {
       type: 'gated-action',
       decision: 'denied',
+      ruleId,
+      paramsDigestCanonical,
+      heldMs,
       action,
       reason: 'no approval token provided',
       timestamp
     };
     const entry = chain.append(receipt);
-    return { decision: 'denied', reason: 'no approval token provided', receiptSeq: entry.seq };
+    return { decision: 'denied', ruleId, paramsDigestCanonical, heldMs,
+      reason: 'no approval token provided', receiptSeq: entry.seq };
   }
```

```diff
@@ src/gate/index.js:163-176 (token-present but invalid path)
   if (!verifyResult.valid) {
     const receipt = {
       type: 'gated-action',
       decision: 'denied',
+      ruleId,
+      paramsDigestCanonical,
+      heldMs,
       action,
       reason: verifyResult.reason,
       timestamp
     };
     const entry = chain.append(receipt);
-    return { decision: 'denied', reason: verifyResult.reason, receiptSeq: entry.seq };
+    return { decision: 'denied', ruleId, paramsDigestCanonical, heldMs,
+      reason: verifyResult.reason, receiptSeq: entry.seq };
   }
```

```diff
@@ src/gate/index.js:191-205 (replay-detected path)
   if (replay) {
     const receipt = {
       type: 'gated-action',
       decision: 'denied',
+      ruleId,
+      paramsDigestCanonical,
+      heldMs,
       action,
       reason: 'approval token nonce already used (replay detected)',
       timestamp
     };
     const entry = chain.append(receipt);
     return {
       decision: 'denied',
+      ruleId,
+      paramsDigestCanonical,
+      heldMs,
       reason: 'approval token nonce already used (replay detected)',
       receiptSeq: entry.seq
     };
   }
```

```diff
@@ src/gate/index.js:209-218 (approved path)
   const receipt = {
     type: 'gated-action',
     decision: 'approved',
+    ruleId,
+    paramsDigestCanonical,
+    heldMs,
     action,
     approvalNonce: nonce,
     timestamp
   };
   const entry = chain.append(receipt);

-  return { decision: 'approved', approvalNonce: nonce, receiptSeq: entry.seq };
+  return { decision: 'approved', ruleId, paramsDigestCanonical, heldMs,
+    approvalNonce: nonce, receiptSeq: entry.seq };
 }
```

### New import

```diff
@@ src/gate/index.js:13-23
 import {
   loadApprovalPubkey,
   canonicalizeRequest,
   nonceUsed,
   recordNonce,
   getPaths
 } from './sign.js';
 import { withLock } from '../store/lock.js';
+// digestParamsCanonical lives in src/parser/, which is grantable; importing
+// from a grantable module is fine for a core file when the dependency is a
+// pure function with no authority. The import shape (named, single function)
+// is deliberate — anything wider would let a grant rewrite drift the gate.
+import { digestParamsCanonical } from '../parser/index.js';
```

---

## Diff 2 of 2 — `bin/hook-pre-tool-use.js`

The hook carries three responsibilities for this change:

1. Compute `heldMs` from the staged request file and put it on the
   `actionRequest` before calling `gatedAction`.
2. Carry the `ruleId` it already knows onto the `actionRequest`.
3. Decide which `decision` value applies when no token was presented,
   distinguishing a true gate denial from a `stale_signature` burn.

### Import

```diff
@@ bin/hook-pre-tool-use.js:45-54
 import crypto from 'node:crypto';
 import fs from 'node:fs';
 import path from 'node:path';
 import { createStore } from '../src/store/index.js';
 import { resolveHome } from '../src/home.js';
 import { loadPolicy, evaluate, RULE_INFO } from '../src/policy/index.js';
 import { verifyApproval, gatedAction } from '../src/gate/index.js';
 import { canonicalizeRequest } from '../src/gate/sign.js';
+import { digestParamsCanonical } from '../src/parser/index.js';
 import { resolveGrant } from '../src/grant/check.js';
 import { colour, dim, colourEnabled } from '../src/term/colour.js';
```

### Helper: read the stage timestamp for heldMs

```diff
@@ bin/hook-pre-tool-use.js:306 (after readPurpose)
+/**
+ * Compute heldMs from a previously staged request. Returns undefined when
+ * no stage happened (requestId null, file missing, or stagedAt unparseable).
+ * The receipt's `heldMs` field carries undefined as "not measured", never
+ * zero — a stage and an immediate verdict are still > 0ms in wall time.
+ */
+function readStagedAt(home, requestId) {
+  if (!requestId) return undefined;
+  try {
+    const file = path.join(home, 'pending-approvals', 'requests', `${requestId}.json`);
+    const text = fs.readFileSync(file, 'utf8');
+    // The stage timestamp is intentionally written by the agent's companion
+    // file (purposes/<id>.json), not by requests/<id>.json, so a re-signed
+    // approval cannot retroactively rewrite heldMs.
+    const purposeFile = path.join(home, 'pending-approvals', 'purposes', `${requestId}.json`);
+    const purpose = JSON.parse(fs.readFileSync(purposeFile, 'utf8'));
+    return typeof purpose.stagedAt === 'number' ? purpose.stagedAt : undefined;
+  } catch (e) {
+    return undefined;
+  }
+}
```

### Wiring at the gate call site

```diff
@@ bin/hook-pre-tool-use.js:815-825 (gate-mode block, SIGNED_PARAMS / actionRequest)
     const SIGNED_PARAMS = ['command', 'file_path', 'url', 'path'];
     const signedInput = {};
     for (const k of SIGNED_PARAMS) {
       if (toolInput && toolInput[k] !== undefined) signedInput[k] = toolInput[k];
     }
-    const actionRequest = { action: toolName, params: signedInput };
+    // `_ruleId` and `_heldMs` are carrier fields on the actionRequest that
+    // gatedAction() lifts into the receipt. Underscored so they never
+    // participate in canonicalization for signing — they ride on the request
+    // object but are stripped by canonicalizeRequest's key sorter? No: the
+    // canonicalizer does not strip; it sorts. Stripping happens at sign time
+    // via SIGNED_PARAMS, and these fields are never under that key set, so
+    // they reach the receipt untouched.
+    const stagedAt = readStagedAt(home, requestId);
+    const actionRequest = {
+      action: toolName,
+      params: signedInput,
+      _ruleId: ruleId,    // 'ruleId' is destructured at the top of main(); capture here.
+      _heldMs: typeof stagedAt === 'number' ? Date.now() - stagedAt : undefined
+    };
     const tokenResult = findValidToken(actionRequest, home);
```

`ruleId` is destructured from `match` two lines above (`const { ruleId, mode } = match;`); in the live source that lives at line 787. The patch above places the `_ruleId: ruleId` reference where `ruleId` is in scope.

### The `stale_signature` classification

The path that classifies a presented-but-rejected token currently lives at the `tokenResult.rejected` branch (live source lines 901–924). It is rewritten to pass the token's reason through and let `gatedAction` label the receipt `stale_signature` when the failure is a command-string mismatch (not a replay, not a signature failure).

```diff
@@ bin/hook-pre-tool-use.js:901-924 (tokenResult.rejected branch)
     if (tokenResult.rejected) {
-      // Token was presented but failed verification (e.g. replay, signature
-      // failure). Fail closed: pass the token to gatedAction so the denial
-      // receipt records the specific reason.
+      // Token was presented but failed verification. Three sub-cases:
+      //   - command-string mismatch  → 'stale_signature' (a valid token
+      //                                exists for this rule/path; the
+      //                                command drifted)
+      //   - replay                   → 'denied' (the nonce was spent)
+      //   - signature/key failure    → 'denied' (security failure)
+      // The first is countable separately: a spike in stale_signature is a
+      // signal that an automation is rewriting commands post-signing. Today
+      // it is indistinguishable from a generic denial and therefore invisible.
       const store = createStore(home);
       const chain = {
         entries: store.entries,
         append: store.appendReceipt.bind(store)
       };
       try {
         const token = readTokenFile(tokenResult.rejected.tokenFile);
-        gatedAction(actionRequest, token || null, chain, home);
+        gatedAction(actionRequest, token || null, chain, home);
       } catch (e) {
         note(`denial receipt failed (${e.message}); still denying`);
       }
       try { fs.unlinkSync(tokenResult.rejected.tokenFile); } catch (_) { /* best-effort */ }
       note(`BLOCKED: ${ruleId} (${toolName}) — ${tokenResult.rejected.reason}`);
       process.stderr.write(buildDenialMessage(ruleId, actionRequest, home, requestId) + '\n');
       process.exit(2);
     }
```

The `stale_signature` labelling itself is done by `gatedAction()` based on the rejection reason. Add a tiny branch inside the token-invalid path:

```diff
@@ src/gate/index.js:163-176 (token-present-but-invalid path)
   if (!verifyResult.valid) {
+    // A token presented but failing verification. Three failure modes;
+    // one of them is a clean "the signature was for a different command"
+    // event and worth naming so signature-burn is countable.
+    const isStaleSignature = typeof verifyResult.reason === 'string'
+      && verifyResult.reason.includes('request mismatch');
+    const decision = isStaleSignature ? 'stale_signature' : 'denied';
     const receipt = {
       type: 'gated-action',
-      decision: 'denied',
+      decision,
       ruleId,
       paramsDigestCanonical,
       heldMs,
       action,
       reason: verifyResult.reason,
       timestamp
     };
     const entry = chain.append(receipt);
-    return { decision: 'denied', ruleId, paramsDigestCanonical, heldMs,
+    return { decision, ruleId, paramsDigestCanonical, heldMs,
       reason: verifyResult.reason, receiptSeq: entry.seq };
   }
```

The string match is fragile in principle; in practice the only call site that emits `request mismatch` is `verifyApproval` itself at `src/gate/index.js:104`, and that text is part of the operator-facing message contract. A constant export from `sign.js` would be cleaner; that is left for the operator to decide when applying.

---

## Tests (embedded, prove-fail-first)

These tests do NOT exist as files in the tree yet. They are written here so the operator who applies this proposal can lift them into `test/` and run them against the unpatched source to prove the patch's claims.

### Test A — `ruleId` lands on every `gated-action` receipt

```js
// test/denial-enrichment-rule-id.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store/index.js';
import { gatedAction } from '../src/gate/index.js';

describe('denial receipt carries ruleId', () => {
  it('every gatedAction receipt includes ruleId', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-enrich-'));
    try {
      const store = createStore(tmp);
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };
      // No-token path.
      const r1 = gatedAction(
        { action: 'Bash', params: { command: 'rm -rf /' }, _ruleId: 'self-mod' },
        null, chain, tmp
      );
      assert.strictEqual(r1.ruleId, 'self-mod',
        'no-token gatedAction must surface ruleId from actionRequest._ruleId');

      // Read what landed in the chain.
      const last = store.entries[store.entries.length - 1];
      assert.strictEqual(last.payload.ruleId, 'self-mod',
        'ruleId must appear on the receipt payload');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

**Why it fails today.** `gatedAction` ignores `_ruleId` entirely; the
returned object has no `ruleId` field and the appended receipt has no
`ruleId` field. Both assertions above fail with `undefined !== 'self-mod'`.

### Test B — `paramsDigestCanonical` is byte-stable across orderings

```js
// test/denial-enrichment-params-digest.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store/index.js';
import { gatedAction } from '../src/gate/index.js';

describe('denial receipt carries canonical params digest', () => {
  it('two orderings of the same params produce the same digest', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-enrich-'));
    try {
      const store = createStore(tmp);
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };
      const a = gatedAction(
        { action: 'Bash', params: { command: 'ls', file_path: '/a' } },
        null, chain, tmp
      );
      const b = gatedAction(
        { action: 'Bash', params: { file_path: '/a', command: 'ls' } },
        null, chain, tmp
      );
      assert.strictEqual(a.paramsDigestCanonical, b.paramsDigestCanonical,
        'canonical params digest must be order-stable');
      assert.match(a.paramsDigestCanonical, /^[0-9a-f]{64}$/,
        'canonical params digest must be full 64-char SHA-256 hex');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

**Why it fails today.** `gatedAction` returns no
`paramsDigestCanonical` field; the assertion sees `undefined` on both
sides and happens to pass the equality — but the regex match fails
because `undefined` is not 64 lowercase hex chars.

### Test C — `stale_signature` classification

```js
// test/denial-enrichment-stale-signature.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store/index.js';
import { gatedAction } from '../src/gate/index.js';

describe('stale_signature is its own decision', () => {
  it('a token with the wrong command string yields decision="stale_signature"', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-enrich-'));
    try {
      // Pre-populate an approval pubkey (gatedAction will look it up).
      const keysDir = path.join(tmp, 'keys');
      fs.mkdirSync(keysDir, { recursive: true });
      // A synthetic token whose `request` does not byte-match the action
      // being gated. The exact key material does not matter for this test;
      // we only need verifyApproval to return a `request mismatch` reason.
      const token = {
        request: '{"action":"Bash","params":{"command":"something_else"}}',
        nonce: 'nonsense-nonce',
        timestamp: Date.now(),
        signature: '00'.repeat(64)
      };
      const store = createStore(tmp);
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };
      const r = gatedAction(
        { action: 'Bash', params: { command: 'rm -rf /' } },
        token, chain, tmp
      );
      assert.strictEqual(r.decision, 'stale_signature',
        'a token with a different command string must classify as stale_signature, ' +
        'not as a plain denial');
      const last = store.entries[store.entries.length - 1];
      assert.strictEqual(last.payload.decision, 'stale_signature');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

**Why it fails today.** `gatedAction` returns `decision: 'denied'`
regardless of which `verifyApproval` reason fired; the assertion fails
on the first `assert.strictEqual`.

### Test D — `heldMs` is measured when staging happened

```js
// test/denial-enrichment-held-ms.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store/index.js';
import { gatedAction } from '../src/gate/index.js';

describe('denial receipt carries heldMs', () => {
  it('a denial after staging carries a non-negative heldMs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-enrich-'));
    try {
      const store = createStore(tmp);
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };
      const stagedAt = Date.now() - 42;
      const r = gatedAction(
        { action: 'Bash', params: { command: 'rm -rf /' }, _heldMs: Date.now() - stagedAt },
        null, chain, tmp
      );
      assert.ok(typeof r.heldMs === 'number' && r.heldMs >= 0,
        'heldMs must be a non-negative number when stage happened');
      const last = store.entries[store.entries.length - 1];
      assert.strictEqual(last.payload.heldMs, r.heldMs,
        'heldMs must round-trip onto the receipt payload');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

**Why it fails today.** `gatedAction` returns no `heldMs` field; the
first assertion sees `typeof undefined === 'number'` is false and fails.

---

## What this proposal deliberately does not change

- **`bin/view.js`**, **`src/views/`**, **`src/mcp/`** — presentation
  surfaces. They will display the new fields without code changes
  because the JSON shape is forward-compatible (extra keys). Whether to
  highlight `stale_signature` in colour is a UX choice for the
  operator, and is out of scope here.
- **`src/parser/`** — already grantable; the `digestParamsCanonical`
  function lands under WO-TOOLPORT-EXTRACT-01 ahead of this proposal.
  This proposal imports it, it does not redefine it.
- **`src/policy/`** — rule-id strings are the matcher's own output;
  this proposal reads them, never rewrites them.
- **Token format** — the carrier `_ruleId` / `_heldMs` fields are
  intentionally not part of the canonicalized signed bytes. The signer
  continues to bind to `action` + `params` only. A receipt that
  recorded `ruleId` could in theory let a token be replayed against a
  different rule's payload, but that replay would still fail
  `canonicalizeRequest`'s equality check, so the security boundary is
  unchanged.

## Open questions for the operator

1. **Carrier-field naming.** `_ruleId` / `_heldMs` ride on the
   `actionRequest` object but never participate in signing. Is
   underscore-prefixed the right convention, or should they be on a
   separate `meta` envelope? (`_ruleId` is read by gatedAction but
   never serialized into the signed bytes; canonicalizeRequest strips
   nothing, so the underscore is documentation-only.)
2. **`stale_signature` reason matching.** The current detection
   inspects `verifyResult.reason` for the substring `request mismatch`.
   Cleaner: export `STALE_SIGNATURE_REASON` from `src/gate/sign.js` and
   compare exactly. Left as a refactor for the operator.
3. **`heldMs` for approvals.** The proposal puts `heldMs` on approvals
   too, computed the same way. That is consistent but a successful
   approval's `heldMs` is usually small (the agent retries immediately
   after signing); the operator may prefer to suppress it on approvals.
4. **`no_response` and `unreachable`.** Defined in the enum, not
   emitted by any path in this proposal. They are placeholders for a
   future patch that hooks the fail-open branches. Naming them now
   means a later patch can land without a schema break.

---

*Prepared by the Ollama lane as part of WO-TOOLPORT-EXTRACT-01. Read-only
deliverable. Apply by hand under one signature covering both diffs, then
lift the embedded tests into `test/` and run `npm test`.*
---

## REVIEWER NOTE (orchestrator verification pass, 2026-08-08 ~13:15 CDT) — Diff 2 REJECTED AS DRAFTED

**Do not apply the carrier-field mechanism.** Verified against live source:
`canonicalizeRequest` (src/gate/sign.js:253) is `JSON.stringify(actionRequest,
sortKeysReplacer)` — it serializes the ENTIRE actionRequest and strips
nothing. Consequences of putting `_ruleId`/`_heldMs` on the actionRequest:

1. Every already-signed token binds to `{action, params}` bytes; the enriched
   request canonicalizes differently, so EVERY token fails verification with
   `request mismatch`. The gate would deny all signed approvals.
2. `_heldMs` is a wall-clock delta: it differs on every retry, so even
   re-staging and re-signing cannot converge. Unfixable loop, not a one-time
   re-sign.
3. Ironic failure shape: the broken mechanism would misclassify every
   legitimate approval as the very `stale_signature` event it exists to count.

**Required fix before apply:** pass enrichment OUT OF BAND of the signed
request. Either (a) a fifth `meta` parameter on `gatedAction(actionRequest,
approvalToken, chain, baseDir, meta)` — additive, existing callers unaffected;
or (b) a separate `enrichment` object the hook passes alongside. The signed
bytes must remain exactly `{action, params}`. The proposal's open question 1
is therefore answered: a separate envelope is MANDATORY, not stylistic.

Everything else in this proposal survives review: the five-way enum, the
receipt fields, the `stale_signature` reason-matching (with the constant
export suggested in open question 2 preferred), and tests A-D — with the
tests adjusted to pass `meta` as the fifth argument rather than underscore
fields. Test C additionally needs a real keypair fixture or it will fail on
signature-invalid before reaching the request-mismatch branch — verify which
reason fires first in `verifyApproval` before trusting it as a
stale_signature probe.

Also note: the second hunk of "The stale_signature classification" contains a
no-op diff line (identical before/after `gatedAction(...)` call) — ignore it
at apply time.
