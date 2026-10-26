/*
 * test/reach-glm-leak-fixtures.test.js
 *
 * Real response bodies, not synthetic ones: the six glm-5.3-flash:cloud
 * fixtures under test/fixtures/e1-glm-leak/ from WO E1-GLM-LEAK-PIN
 * (think:false; reasoning leaked into the answer channel as a stray
 * </think> tag; T1 bodies carry one read_file tool call, T2 bodies carry
 * none, none has a message.thinking field). Pins that reach's
 * observeRungs and reasoning's classifyBlock agree on what counts as an
 * inline-reasoning marker: content markers make R3 true exactly when
 * classifyBlock says text-inline-reasoning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { observeRungs } from '../src/reach/index.js';
import { classifyBlock } from '../src/reasoning/index.js';

const FIXTURE_DIR = new URL('./fixtures/e1-glm-leak/', import.meta.url);

function loadFixtures() {
  return fs.readdirSync(FIXTURE_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(file => ({ file, body: JSON.parse(fs.readFileSync(new URL(file, FIXTURE_DIR), 'utf8')) }));
}

test('1. exactly six fixture files exist in test/fixtures/e1-glm-leak/', () => {
  const files = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 6, `expected 6 fixture files, found: ${files.join(', ')}`);
});

test('2. each fixture: R0 and R3 true, r3Sources content-markers only, R4 false, logprobs null, model pinned', () => {
  for (const { file, body } of loadFixtures()) {
    const obs = observeRungs(body);
    assert.equal(obs.rungs.R0, true, `${file}: R0`);
    assert.equal(obs.rungs.R3, true, `${file}: R3`);
    assert.deepEqual(obs.r3Sources, ['content-markers'], `${file}: r3Sources`);
    assert.equal(obs.rungs.R4, false, `${file}: R4`);
    assert.equal(obs.logprobs, null, `${file}: logprobs`);
    // Model read from the body, per WO E1-GLM-LEAK-PIN test 2.
    assert.equal(body.model, 'glm-5.3-flash', `${file}: fixture model`);
    assert.equal(obs.model, body.model, `${file}: observed model tracks body`);
  }
});

test('3. tool_calls split: every T1 fixture R1 true, every T2 fixture R1 false', () => {
  for (const { file, body } of loadFixtures()) {
    const obs = observeRungs(body);
    if (file.includes('T1')) {
      assert.equal(obs.rungs.R1, true, `${file}: T1 R1`);
    } else if (file.includes('T2')) {
      assert.equal(obs.rungs.R1, false, `${file}: T2 R1`);
    } else {
      assert.fail(`${file}: fixture name matches neither T1 nor T2`);
    }
  }
});

test('4. each fixture: classifyBlock files the leaked content as text-inline-reasoning', () => {
  for (const { file, body } of loadFixtures()) {
    const row = classifyBlock({ type: 'text', text: body.message.content });
    assert.equal(row && row.block, 'text-inline-reasoning', `${file}: classifyBlock block`);
  }
});

test('5. agreement probe: reach R3 equals reasoning text-inline-reasoning for marker edge cases', () => {
  const LT = String.fromCharCode(60);
  const probes = [
    'x' + LT + '/think>',
    'x' + LT + '/THINK>',
    LT + 'Think>x',
    LT + 'think>x',
    'x' + LT + ' /think>',
    'x' + LT + '/think >',
    'no markers here',
    'thinking about it'
  ];
  for (const s of probes) {
    const r3 = observeRungs({ model: 'm', message: { content: s } }).rungs.R3;
    const inline = classifyBlock({ type: 'text', text: s }).block === 'text-inline-reasoning';
    assert.equal(r3, inline, 'probe ' + JSON.stringify(s) + ': reach R3 vs reasoning inline');
  }
  const r3Of = s => observeRungs({ model: 'm', message: { content: s } }).rungs.R3;
  assert.equal(r3Of(probes[0]), true, 'probe 0: R3 must be true');
  assert.equal(r3Of(probes[1]), true, 'probe 1: R3 must be true');
  assert.equal(r3Of(probes[2]), true, 'probe 2: R3 must be true');
  assert.equal(r3Of(probes[3]), true, 'probe 3: R3 must be true');
  assert.equal(r3Of(probes[4]), false, 'probe 4: R3 must be false');
  assert.equal(r3Of(probes[5]), false, 'probe 5: R3 must be false');
  assert.equal(r3Of(probes[7]), false, 'probe 7: R3 must be false');
});