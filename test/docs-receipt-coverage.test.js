/**
 * test/docs-receipt-coverage.test.js
 *
 * Tripwire for docs/receipt-coverage.md (WO-COVERAGE-RESYNC, 2026-11-05).
 *
 * The doc claims to enumerate every chain receipt shape. That claim went
 * stale once, silently, between 2026-07-26 and 2026-11-05, because the code
 * gained writers and nobody reread the doc. This test makes the claim
 * checkable: it walks src/ and bin/ as PLAIN TEXT, collects every string
 * literal written into a `type: '<kebab-case-with-at-least-one-hyphen>'`
 * property, and asserts each one appears in the doc in backticks. It reads
 * files and imports nothing from src/, bin/ or the doc's subject matter, so
 * a code change that adds a receipt type cannot land without either naming
 * it in the doc or explicitly allow-listing a literal that is not a receipt.
 *
 * Declared gap of the method, narrowed 2026-11-05: `delegation-grant`
 * reaches the chain via the GRANT_TYPE constant (src/grant/grant-schema.js),
 * not a `type:` string literal at the append site, so the literal scan
 * cannot see it. The second check below reads that constant as text and
 * pins its value in the doc, so `delegation-grant` is no longer beyond the
 * tripwire. What stays beyond it: a type passed through some OTHER constant,
 * a new field on an existing shape, and any new entry kind written outside
 * this repository. The doc's "What this audit did not do" repeats this.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['src', 'bin'];
const DOC_PATH = path.join(ROOT, 'docs', 'receipt-coverage.md');
const GRANT_SCHEMA_PATH = path.join(ROOT, 'src', 'grant', 'grant-schema.js');

// String literals this scan finds in a `type: '<kebab>'` property that are
// NOT chain receipt types, subtracted from the assertion. Currently empty:
// every kebab-case `type:` literal in src/ and bin/ writes a receipt
// (session-open, gated-action, policy-warn, egress-event, grant-use,
// reasoning-step). Literals without a hyphen (key encodings like 'spki' and
// 'pkcs8', JSON-schema types like 'object' and 'string') never match the
// pattern, so they need no entry here. If a future kebab-case `type:`
// literal is NOT a receipt type (an enum value, a config key), add it here
// with a one-line reason, never silently.
const NOT_RECEIPT_TYPES = [];

// A `type:` property set to a quoted kebab-case literal. The lookbehind
// keeps property accesses like `payload.type` and member names like
// `entryType:` out of the match. Both quote styles, because source and
// comments write both.
const TYPE_PROP_RE = /(?<![\w$.])type\s*:\s*(['"`])([a-z0-9]+(?:-[a-z0-9]+)+)\1/g;

function walkJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Scan every .js file under src/ and bin/ as text and return a Map of
 * kebab-case `type:` literal -> sorted list of files it appears in.
 */
function collectTypeLiterals() {
  const found = new Map();
  for (const dirName of SCAN_DIRS) {
    for (const file of walkJsFiles(path.join(ROOT, dirName))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(TYPE_PROP_RE)) {
        const literal = match[2];
        if (NOT_RECEIPT_TYPES.includes(literal)) continue;
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        if (!found.has(literal)) found.set(literal, new Set());
        found.get(literal).add(rel);
      }
    }
  }
  return found;
}

describe('docs/receipt-coverage.md: tripwire against silent staleness', () => {
  it('names every chain receipt type written in src/ and bin/, in backticks', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    const found = collectTypeLiterals();

    // Guard the guard: an empty scan means the walk or the regex broke, not
    // that the doc is complete.
    assert.ok(
      found.size > 0,
      'the scan found no `type:` literals under src/ and bin/; the walk or the regex is broken, not the doc'
    );

    const missing = [];
    for (const [literal, files] of found) {
      if (!doc.includes('`' + literal + '`')) {
        missing.push(`${literal} (written in: ${[...files].sort().join(', ')})`);
      }
    }

    assert.deepStrictEqual(
      [],
      missing,
      'docs/receipt-coverage.md is stale: these `type:` literals appear in source but not in the doc '
        + '(in backticks). Either update the doc or, if the literal is not a chain receipt type, '
        + 'allow-list it in test/docs-receipt-coverage.test.js with a reason. Missing: '
        + missing.join('; ')
    );
  });

  it('names the delegation-grant type, read from the GRANT_TYPE constant', () => {
    // GRANT_TYPE never appears as a `type:` literal at the append site
    // (src/grant/issue.js passes it through), so the literal scan above
    // cannot see it. This check closes that specific gap: read the constant
    // as text and require the doc to name its value. A type passed through
    // some other constant stays beyond both checks.
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    const schemaText = fs.readFileSync(GRANT_SCHEMA_PATH, 'utf8');
    const match = schemaText.match(/GRANT_TYPE\s*=\s*(['"`])([^'"`]+)\1/);
    assert.ok(match, 'GRANT_TYPE not found in src/grant/grant-schema.js; the scan or the constant is broken');
    const grantType = match[2];
    assert.ok(grantType.length > 0, 'GRANT_TYPE is empty');
    assert.ok(
      doc.includes('`' + grantType + '`'),
      'docs/receipt-coverage.md is stale: the GRANT_TYPE constant ("' + grantType + '") '
        + 'is not named in the doc in backticks'
    );
  });
});
