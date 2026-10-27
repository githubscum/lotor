/*
 * test/think-tag-one-source.test.js
 *
 * KNOWN-LIMITS 79: pin that reach and reasoning share one THINK_TAG
 * definition, pin its flags, pin its behaviour with probes built from a
 * fromCharCode less-than (never typed), and scan both witness sources for a
 * reintroduced local const THINK_TAG (the drift tripwire).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as reachMod from '../src/reach/index.js';
import * as reasoningMod from '../src/reasoning/index.js';

const LT = String.fromCharCode(60);

test('one source: reach and reasoning export the very same regex object', () => {
  assert.equal(reachMod.THINK_TAG, reasoningMod.THINK_TAG);
});

test('shared regex has flags exactly i (no g, so .test has no lastIndex state)', () => {
  assert.equal(reachMod.THINK_TAG.flags, 'i');
});

test('behaviour table: matches', () => {
  const re = reasoningMod.THINK_TAG;
  const matches = [
    LT + 'think>',
    LT + '/think>',
    LT + 'THINK>',
    LT + '/Think>',
    'a ' + LT + '/tHiNk> b'
  ];
  for (const probe of matches) {
    assert.equal(re.test(probe), true, 'should match: ' + JSON.stringify(probe));
  }
});

test('behaviour table: does not match', () => {
  const re = reasoningMod.THINK_TAG;
  const doesNotMatch = [
    'think>',
    LT + 'thinking>',
    LT + 'think >',
    LT + '/ think>',
    ''
  ];
  for (const probe of doesNotMatch) {
    assert.equal(re.test(probe), false, 'should not match: ' + JSON.stringify(probe));
  }
});

test('drift tripwire: neither witness source contains const THINK_TAG', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../src/reach/index.js', '../src/reasoning/index.js']) {
    const file = path.resolve(here, rel);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('const THINK_TAG'), false,
      file + ' contains const THINK_TAG again');
  }
});