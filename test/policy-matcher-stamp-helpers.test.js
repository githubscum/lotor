/**
 * test/policy-matcher-stamp-helpers.test.js
 *
 * TRIPWIRE, not a regression test. Found 2026-10-27 (KNOWN-LIMITS 84).
 *
 * `matcherHashInputs()` (src/policy/index.js, the `parts` array) is the exact
 * text the matcher version stamp digests. It is built from
 * `Function.prototype.toString()` of a fixed list of functions, so a helper is
 * only covered if its OWN source is named in that list. A measurement on
 * 2026-10-27 found 18 top-level helper functions and 5 top-level regex
 * constants in the policy module that the hash's rules CALL but whose own
 * source is NOT in the hashed text. Proven by mutation: dropping the prose
 * stripping in `matchableCommand`, or making `firstBraceGroup` return null,
 * flips a gate decision while the stamp stays byte-identical.
 *
 * THE CONSEQUENCE. Changing any of these helpers changes what the gate stops
 * and leaves the stamp byte-identical. Two receipts written either side of
 * that change agree on the matcher version and disagree on the behavior, and
 * the record cannot tell you which one you got. The failure is silent in the
 * direction that matters: a matcher WEAKENED between two runs still stamps
 * the old, stronger version.
 *
 * WHAT THESE ASSERTIONS SAY. They assert the CURRENT, DEFECTIVE behavior: the
 * 18 helper bodies are ABSENT from the hashed text today, and the literal
 * source of the 5 regex constants is ABSENT from it too. The controls beside
 * them assert that the hashed text is alive and that the hashed rules DO call
 * and reference these helpers, so the absence assertions cannot pass vacuously.
 *
 * The constant check keys on the regex literal because the natural fix hashes
 * `NAME.toString()`, which emits the literal and never `const NAME =`.
 *
 * WHEN SOMEONE FIXES THE STAMP, THIS FILE FAILS. That is the point. The repair
 * is to add the helpers to `parts` in `matcherHashInputs()` (a src/policy
 * change, therefore non-delegable core, and it queues for a signing sitting),
 * bump MATCHER_SCHEMA (the hashing METHOD changes, which is exactly what that
 * marker is for), invert the assertions below, and amend KNOWN-LIMITS 84 in
 * the same change. Do NOT delete the file: a confession that can be closed by
 * deleting its evidence is not a confession.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { matcherHashInputs } from '../src/policy/index.js';

const hashedText = matcherHashInputs();

// Source text of the policy module, used only to locate the unhashed regex
// constants' literal definitions. Normalized so a CRLF checkout reads the same.
const policySrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'policy', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

// Extracts the regex literal text of a top-level `const NAME = /.../flags;`
// line from the policy module source. Everything after `= `, up to and
// excluding an optional trailing `;` (SYSTEMD_RUN_SCHEDULED has none), trimmed.
function regexLiteralOf(name) {
  const match = policySrc.match(new RegExp('^const ' + name + ' = (.+)$', 'm'));
  if (!match) {
    throw new Error('regex constant ' + name + ' not found in src/policy/index.js');
  }
  let literal = match[1].trim();
  if (literal.endsWith(';')) {
    literal = literal.slice(0, -1).trim();
  }
  return literal;
}

// The 18 top-level helper functions the hashed rules call but whose source
// text is not in the hashed inputs (KNOWN-LIMITS 84).
const UNHASHED_FUNCTIONS = [
  'matchableCommand',
  'escapeRegExp',
  'firstBraceGroup',
  'isLocalhostTarget',
  'hasHttpMethodFlag',
  'hasDataFlag',
  'hasDataCarryingQuery',
  'usesEgressTool',
  'usesRemoteCopyTool',
  'usesRemotePublishTool',
  'isRemoteCopyTarget',
  'usesAuthedRemoteClient',
  'destructiveAllowlisted',
  'extractDestructiveTarget',
  'rmTriggerFlags',
  'isGitCleanForceDelete',
  'interpreterHandsFile',
  'isCommandTool'
];

// The 5 top-level regex constants referenced by the hashed rules whose
// definition lives outside the hashed inputs.
const UNHASHED_REGEX_CONSTANTS = [
  'CMD_SEPARATORS',
  'SYSTEMD_RUN',
  'SYSTEMD_RUN_SCHEDULED',
  'LAUNCHCTL_REGISTRATION',
  'SCRIPT_EXT'
];

describe('matcher stamp helper coverage (KNOWN-LIMITS 84, open 2026-10-27)', () => {
  it('CONTROL: the hashed text is alive and holds the hashed deciders', () => {
    // If a rename or a bad import empties `hashedText`, these fail first and
    // the absence assertions below cannot pass vacuously.
    assert.ok(hashedText.length > 1000, 'hashed text is implausibly short');
    assert.ok(
      hashedText.includes('function isSelfModCommand('),
      'isSelfModCommand body missing from hashed text'
    );
    assert.ok(
      hashedText.includes('function expandBraces('),
      'expandBraces body missing from hashed text'
    );
  });

  it('CONTROL: every listed helper IS CALLED from the hashed text', () => {
    // If a listed name stops being called, the matching absence entry below
    // no longer asserts a defect and the list must be pruned honestly.
    for (const name of UNHASHED_FUNCTIONS) {
      assert.match(
        hashedText,
        new RegExp('\\b' + name + '\\('),
        'expected the hashed rules to call ' + name + ' somewhere'
      );
    }
  });

  // --- the defect: the helper bodies are outside the stamp ---

  for (const name of UNHASHED_FUNCTIONS) {
    it('UNHASHED (defect, limit 84): ' + name, () => {
      assert.equal(
        hashedText.includes('function ' + name + '('),
        false,
        name + ' body is now in the hashed text: invert this assertion, ' +
          'bump MATCHER_SCHEMA, and close KNOWN-LIMITS 84'
      );
    });
  }

  // --- the defect: the regex constants are referenced but not defined in the stamp ---

  for (const name of UNHASHED_REGEX_CONSTANTS) {
    it('REFERENCED-BUT-UNDEFINED regex constant (defect, limit 84): ' + name, () => {
      const literal = regexLiteralOf(name);
      // CONTROL: the extracted literal is a real regex literal, at least
      // `/x/y` shaped, so the absence assertion below cannot be vacuous.
      assert.ok(
        literal.startsWith('/') && literal.length >= 4,
        'extracted literal for ' + name + ' is not a regex literal: ' + literal
      );
      // The hashed rules use it (so it decides gate outcomes) ...
      assert.match(
        hashedText,
        new RegExp('\\b' + name + '\\b'),
        'expected the hashed rules to reference ' + name + ' somewhere'
      );
      // ... but its literal source is outside the hashed inputs.
      assert.equal(
        hashedText.includes(literal),
        false,
        name + ' definition is now in the hashed text: invert this ' +
          'assertion, bump MATCHER_SCHEMA, and close KNOWN-LIMITS 84'
      );
    });
  }
});