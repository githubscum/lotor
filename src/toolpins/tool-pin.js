// src/toolpins/tool-pin.js
//
// Tool-definition pinning: fingerprint a tool listing at first sight,
// diff on later sight, surface the deltas in the session-open receipt.
//
// THIS MODULE IS PURE. No I/O. No chain. No MCP. Anything that wants
// to use these functions brings its own inputs and decides what to do
// with the outputs.
//
// SCHEME PREFIX. The output is `tp/1:<hex>`, not bare hex. The scheme
// lives in BOTH the preimage (so domain-separation is honest under a
// collision search) AND the output (so a reader can detect an algorithm
// bump and quiet-re-baseline instead of crying "changed" on every
// tool). The 08-08 reviewer caught the bare-hex omission; this is the
// fix.

import crypto from 'node:crypto';

const SCHEME = 'tp/1';
const NUL = '\0';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < out.length; i++) out[i] = canonicalJson(value[i]);
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
 * Output shape: `<scheme>:<hex>` where scheme is `tp/1` and hex is the
 * full 64-character lowercase SHA-256. A future `tp/2` would emit
 * `tp/2:<hex>` and `diffPins` would mark a scheme-prefix change as
 * `rebaselined`, not `changed`.
 *
 * @param {Object} def - Tool definition as exposed by the harness.
 *        Must have at least `name`. Missing fields are treated as
 *        empty strings / empty objects, so a definition that drops
 *        `description` fingerprints differently from one that had it.
 * @returns {string} `tp/1:<64-hex>` (e.g. `tp/1:9f2e...`)
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
  const hex = crypto.createHash('sha256').update(parts.join(NUL)).digest('hex');
  return `${SCHEME}:${hex}`;
}

/**
 * Extract the scheme prefix from a fingerprint string. Returns null if
 * the string does not have the expected `<scheme>:<hex>` shape. Used
 * by `diffPins` to detect a rebaseline.
 */
function schemeOf(fp) {
  if (typeof fp !== 'string') return null;
  const i = fp.indexOf(':');
  if (i <= 0) return null;
  return fp.slice(0, i);
}

/**
 * Tool names whose definition changes are severity-high by default.
 * This is the pin-diff module's OWN heuristic, not a mirror of
 * src/policy/index.js: the policy engine's `destructive` rule matches
 * command PATTERNS (rm -rf shapes), not tool names, so there is no
 * policy-side list to keep in step with. (The 08-13 proposal claimed a
 * mirror; the claim was wrong on cold-read at apply time, 2026-08-15.)
 */
const DESTRUCTIVE_TOOLS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Agent'
]);

function schemaWidened(oldSchema, newSchema) {
  const oldProps = (oldSchema && oldSchema.properties) || {};
  const newProps = (newSchema && newSchema.properties) || {};
  const oldKeys = Object.keys(oldProps);
  const newKeys = Object.keys(newProps);
  for (const k of newKeys) {
    if (!oldKeys.includes(k)) return true;
  }
  const oldRequired = new Set((oldSchema && oldSchema.required) || []);
  const newRequired = new Set((newSchema && newSchema.required) || []);
  for (const r of newRequired) {
    if (!oldRequired.has(r)) return true;
  }
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

function annotationsDowngrade(oldAnno, newAnno) {
  const oldHint = (oldAnno && oldAnno.readOnlyHint) === true;
  const newHint = (newAnno && newAnno.readOnlyHint) === true;
  return oldHint && !newHint;
}

/**
 * Diff two pin maps. The result is sorted by name, so the output is
 * byte-stable for a given input pair — important for a receipt that
 * records the diff.
 *
 * `rebaselined` status: when `oldFp` and `newFp` have different scheme
 * prefixes (e.g. `tp/1:...` vs `tp/2:...`), the diff records the change
 * but tags it `rebaselined`, severity `low`. An algorithm bump does NOT
 * flood the receipt with `changed` events for every tool.
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
      continue;
    }
    if (!oldFp && newFp) {
      out.push({ name, status: 'added', newFp, severity: 'low',
        detail: 'new tool exposed this session' });
      continue;
    }
    if (oldFp === newFp) {
      out.push({ name, status: 'unchanged', oldFp, newFp, severity: 'low' });
      continue;
    }

    // Scheme-prefix mismatch = rebaseline, not a content change.
    if (schemeOf(oldFp) !== schemeOf(newFp)) {
      out.push({
        name, status: 'rebaselined', oldFp, newFp, severity: 'low',
        detail: `scheme changed: ${schemeOf(oldFp)} -> ${schemeOf(newFp)}`
      });
      continue;
    }

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
  const rebased = changed.filter(d => d.status === 'rebaselined');
  const lines = [`${changed.length} tool-definition change(s)`];
  if (rebased.length > 0) {
    lines.push(`${rebased.length} rebaselined (algorithm bump):`);
    for (const d of rebased.slice(0, 8)) {
      lines.push(`  - ${d.name}: ${d.detail}`);
    }
  }
  if (high.length > 0) {
    lines.push(`${high.length} HIGH severity:`);
    for (const d of high.slice(0, 8)) {
      lines.push(`  - ${d.status} ${d.name}: ${d.detail}`);
    }
  }
  return lines.join('\n');
}
