/**
 * src/harness.js
 *
 * Which harness wrote this entry, and how confident that answer is.
 *
 * WHY THIS EXISTS (KNOWN-LIMITS 13, second half)
 *   `cost.byModel` closed the per-MODEL half of limit 13 on 2026-07-26. The
 *   per-HARNESS half did not move: no field anywhere said which harness
 *   produced an entry, so a chain written by two of them could not be split
 *   back apart.
 *
 *   The deadline is structural rather than a preference. The chain is
 *   append-only, so **an entry written without this field can never acquire
 *   it.** Every entry a second harness writes before the field exists is
 *   permanently unattributable. That is why this ships before the second
 *   harness rather than alongside it.
 *
 * THE HONESTY REQUIREMENT, which is most of this file
 *   A field reading `"claude-code"` with nothing saying how it knows is a
 *   claim wearing the clothes of a fact. This module therefore never returns
 *   a bare name. It returns the name AND the basis for it:
 *
 *     declared  an operator or harness stated it (env var or payload field).
 *               Trustworthy to exactly the degree that whoever set it is.
 *     inferred  guessed from the shape of the hook payload, with the evidence
 *               that produced the guess recorded alongside it.
 *     unknown   nothing to go on. Says so, rather than defaulting to the
 *               harness that happens to be most common.
 *
 *   The default matters. Defaulting an unknown harness to "claude-code"
 *   would silently attribute a foreign harness's entries to this one, which
 *   is worse than no field at all: it converts an absence of information into
 *   a false statement, and a reader has no way to tell the difference.
 *
 * WHAT THIS IS NOT
 *   Not authentication. A harness declaring itself is self-attested, exactly
 *   like capture is self-attested (limit 1). Anything able to set an
 *   environment variable can name itself whatever it likes. This makes a
 *   chain SEPARABLE by harness under honest conditions; it does not make the
 *   label adversarially trustworthy, and nothing here should be read as
 *   proving provenance.
 *
 * DELIBERATELY NOT IN THE NON-DELEGABLE CORE
 *   This decides an attribution label, never what the gate permits. Editing
 *   it can mislead a reader, which is real, but it cannot widen authority.
 *   That is the same line core-paths.js already draws for src/views: mixing
 *   reporting integrity into enforcement integrity makes the core large
 *   enough to be useless, which is its own failure mode.
 */

/** Schema marker, so a later shape change is visible rather than silent. */
export const HARNESS_SCHEMA = 'harness/1';

/**
 * Payload field names a harness may use to declare itself, in preference
 * order. Both spellings are accepted for the same reason the session-id
 * reader accepts both: hook payloads in the wild are not consistent about
 * snake_case versus camelCase, and rejecting one spelling would produce an
 * `unknown` that looks like an absent harness rather than a naming mismatch.
 */
const DECLARED_PAYLOAD_KEYS = ['harness', 'harness_name', 'harnessName'];

/** Environment variable an operator or launcher can set. */
const DECLARED_ENV_KEY = 'LOTOR_HARNESS';

/** Cap on a declared name, so a hostile or broken value cannot bloat entries. */
const MAX_NAME_LENGTH = 64;

/**
 * Normalize a declared name. Returns null for anything unusable, so a bad
 * value falls through to inference rather than being recorded as a harness
 * called "   " or a 4 KB string.
 */
function cleanName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_NAME_LENGTH) return trimmed.slice(0, MAX_NAME_LENGTH);
  return trimmed;
}

/**
 * Infer the harness from the shape of the hook payload.
 *
 * Claude Code's payload carries `session_id` plus `transcript_path`, and its
 * `source` is one of a known set. That combination is distinctive enough to
 * be worth guessing from and weak enough that the guess must be labelled as
 * one, which is why the evidence travels with the answer.
 *
 * @returns {{name: string, evidence: string[]}|null}
 */
function inferFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const evidence = [];
  if (typeof payload.session_id === 'string') evidence.push('session_id');
  if (typeof payload.transcript_path === 'string') evidence.push('transcript_path');
  if (['startup', 'resume', 'clear', 'compact'].includes(payload.source)) {
    evidence.push(`source=${payload.source}`);
  }

  // Two independent signals minimum. One alone is too thin: plenty of tools
  // emit a `session_id`, and a single weak match producing a confident-looking
  // name is the failure this module exists to avoid.
  if (evidence.length >= 2) {
    return { name: 'claude-code', evidence };
  }
  return null;
}

/**
 * Resolve the harness for an entry.
 *
 * @param {Object} [payload] - the hook payload, if there is one
 * @param {Object} [env] - environment, injectable for tests
 * @returns {{name: string, basis: 'declared'|'inferred'|'unknown', via?: string, evidence?: string[], schema: string}}
 */
export function resolveHarness(payload = {}, env = process.env) {
  const declaredEnv = cleanName(env && env[DECLARED_ENV_KEY]);
  if (declaredEnv) {
    return { name: declaredEnv, basis: 'declared', via: DECLARED_ENV_KEY, schema: HARNESS_SCHEMA };
  }

  if (payload && typeof payload === 'object') {
    for (const key of DECLARED_PAYLOAD_KEYS) {
      const declared = cleanName(payload[key]);
      if (declared) {
        return { name: declared, basis: 'declared', via: `payload.${key}`, schema: HARNESS_SCHEMA };
      }
    }
  }

  const inferred = inferFromPayload(payload);
  if (inferred) {
    return {
      name: inferred.name,
      basis: 'inferred',
      evidence: inferred.evidence,
      schema: HARNESS_SCHEMA
    };
  }

  // No default to the common case, on purpose. See the header.
  return { name: 'unknown', basis: 'unknown', schema: HARNESS_SCHEMA };
}
