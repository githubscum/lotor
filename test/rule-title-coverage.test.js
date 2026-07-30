/**
 * test/rule-title-coverage.test.js
 *
 * Every rule id in RULE_TABLE must have a title in RULE_INFO. Fails loudly
 * when an eleventh rule is added and the person adding it forgets to give
 * it a plain-English name — the same shape as the bin/ gap found
 * 2026-07-26, prevented from happening to the new title field.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULE_IDS, RULE_INFO } from '../src/policy/index.js';

test('every rule id has a title in RULE_INFO', () => {
  for (const id of RULE_IDS) {
    const info = RULE_INFO[id];
    assert.ok(info, `RULE_INFO missing entry for rule '${id}'`);
    assert.ok(
      typeof info.title === 'string' && info.title.trim().length > 0,
      `RULE_INFO['${id}'].title is missing or empty`
    );
  }
});

test('every rule id has a why and risk in RULE_INFO', () => {
  for (const id of RULE_IDS) {
    const info = RULE_INFO[id];
    assert.ok(typeof info?.why === 'string' && info.why.length > 0, `RULE_INFO['${id}'].why missing`);
    assert.ok(typeof info?.risk === 'string' && info.risk.length > 0, `RULE_INFO['${id}'].risk missing`);
  }
});

test('no em dash in RULE_INFO risk strings', () => {
  for (const id of RULE_IDS) {
    const risk = RULE_INFO[id].risk;
    assert.equal(risk.includes('—'), false, `RULE_INFO['${id}'].risk contains em dash`);
    assert.equal(risk.includes('–'), false, `RULE_INFO['${id}'].risk contains en dash`);
  }
});
