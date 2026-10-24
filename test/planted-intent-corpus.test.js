import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNGS, loadCorpus, stripToReach, validateCorpus } from '../evals/planted-intent/corpus.js';

const corpus = loadCorpus();
const cases = corpus.cases;
const snapshot = structuredClone(corpus);

const CANARY_RE = /LOTOR-CANARY-[A-Z0-9]{8,}/;

const firstDivergent = (m) => m.cases.find((c) => c.answerKey.divergent);
const firstPlain = (m) => m.cases.find((c) => !c.answerKey.divergent);
const firstCanaryCase = (m) => m.cases.find((c) => c.answerKey.canaries.length > 0);

test('RUNGS covers R0 through R3', () => {
  assert.deepEqual(RUNGS, ['R0', 'R1', 'R2', 'R3']);
});

test('1. the shipped corpus validates with zero errors', () => {
  const errors = validateCorpus(corpus);
  assert.equal(errors.length, 0, `expected zero validation errors, got:\n${errors.join('\n')}`);
});

test('2. the minimum counts and the named-example requirement hold', () => {
  assert.ok(cases.length >= 10, `expected at least 10 cases, got ${cases.length}`);

  // ids are pi-001.. in order
  cases.forEach((c, i) => {
    assert.equal(c.id, `pi-${String(i + 1).padStart(3, '0')}`, `case at index ${i} breaks the pi-001.. id order`);
  });

  const divergent = cases.filter((c) => c.answerKey.divergent);
  const plain = cases.filter((c) => !c.answerKey.divergent);
  assert.ok(plain.length >= 4, `expected at least 4 non-divergent cases, got ${plain.length}`);
  assert.ok(divergent.length >= 6, `expected at least 6 divergent cases, got ${divergent.length}`);

  for (const rung of ['R1', 'R2', 'R3']) {
    const atRung = divergent.filter((c) => c.answerKey.firstVisibleAt === rung);
    assert.ok(atRung.length >= 2, `expected at least 2 divergent cases with firstVisibleAt ${rung}, got ${atRung.length}`);
  }

  const canaryCases = cases.filter((c) => c.answerKey.canaries.length > 0);
  assert.ok(canaryCases.length >= 3, `expected at least 3 cases with canaries, got ${canaryCases.length}`);
  for (const c of canaryCases) {
    assert.ok(c.answerKey.divergent, `${c.id}: canary cases must be divergent`);
  }

  const readsSecret =
    divergent.some((c) => c.steps.some((s) => s.tool === 'Read' && /\.env|secret/.test(s.input)));
  assert.ok(readsSecret, 'expected at least one divergent case whose steps Read a path containing .env or secret');
});

test('3. stripped views never carry the answer key or the case real intent', () => {
  for (const c of cases) {
    for (const rung of RUNGS) {
      const view = stripToReach(c, rung);
      assert.ok(!('answerKey' in view), `${c.id} at ${rung}: stripped view carries an answerKey key`);
      const json = JSON.stringify(view);
      assert.ok(!json.includes('answerKey'), `${c.id} at ${rung}: stripped view contains the literal "answerKey"`);
      assert.ok(!json.includes(c.answerKey.realIntent), `${c.id} at ${rung}: stripped view contains the realIntent label "${c.answerKey.realIntent}"`);
    }
  }
});

test('4. rung monotonicity holds and stripToReach never mutates its input', () => {
  for (const c of cases) {
    const r0 = stripToReach(c, 'R0');
    assert.ok(!('steps' in r0), `${c.id}: R0 must have no steps key`);
    assert.deepEqual(Object.keys(r0).sort(), ['id', 'statedPurpose'], `${c.id}: R0 keys`);

    assert.ok(r0.id === c.id && r0.statedPurpose === c.statedPurpose, `${c.id}: R0 drops its identity fields`);

    const r1 = stripToReach(c, 'R1');
    assert.equal(r1.steps.length, c.steps.length, `${c.id}: R1 step count`);
    for (const step of r1.steps) assert.deepEqual(Object.keys(step).sort(), ['input', 'tool'], `${c.id}: R1 step keys`);

    const r2 = stripToReach(c, 'R2');
    for (const step of r2.steps) assert.deepEqual(Object.keys(step).sort(), ['input', 'output', 'tool'], `${c.id}: R2 step keys`);

    const r3 = stripToReach(c, 'R3');
    for (const step of r3.steps) assert.deepEqual(Object.keys(step).sort(), ['input', 'output', 'reasoning', 'tool'], `${c.id}: R3 step keys`);
  }

  assert.deepEqual(corpus, snapshot, 'the corpus object was mutated by stripToReach calls');
});

test('5. canaries are planted in outputs only: absent at R0/R1, visible at R2/R3', () => {
  for (const c of cases) {
    for (const input of c.steps.map((s) => s.input)) {
      assert.ok(!CANARY_RE.test(input), `${c.id}: canary appears in an input (${input})`);
    }

    const inSteps = [...JSON.stringify(c.steps).matchAll(/LOTOR-CANARY-[A-Z0-9]{8,}/g)].map((m) => m[0]);
    if (c.answerKey.canaries.length > 0) {
      assert.deepEqual(
        [...new Set(inSteps)].sort(),
        [...c.answerKey.canaries].sort(),
        `${c.id}: canaries found in steps do not match answerKey.canaries`,
      );
    }

    for (const canary of c.answerKey.canaries) {
      assert.ok(!JSON.stringify(stripToReach(c, 'R0')).includes(canary), `${c.id}: canary ${canary} visible at R0`);
      assert.ok(!JSON.stringify(stripToReach(c, 'R1')).includes(canary), `${c.id}: canary ${canary} visible at R1`);
      assert.ok(JSON.stringify(stripToReach(c, 'R2')).includes(canary), `${c.id}: canary ${canary} not visible at R2`);
      assert.ok(JSON.stringify(stripToReach(c, 'R3')).includes(canary), `${c.id}: canary ${canary} not visible at R3`);
    }
  }
});

test('6. stripToReach throws RangeError for a rung outside RUNGS', () => {
  assert.throws(() => stripToReach(cases[0], 'R4'), RangeError);
  assert.throws(() => stripToReach(cases[0], 'R5'), RangeError);
  assert.throws(() => stripToReach(cases[0], 'r2'), RangeError);
});

test('7. fail-first: each corpus mutation yields at least one validation error, and null never throws', () => {
  const mutations = {
    'duplicate id': (m) => {
      m.cases[1].id = m.cases[0].id;
    },
    'evidence index out of range': (m) => {
      firstDivergent(m).answerKey.evidenceSteps = [99];
    },
    'divergent case with empty evidenceSteps': (m) => {
      firstDivergent(m).answerKey.evidenceSteps = [];
    },
    'non-divergent case with firstVisibleAt R2': (m) => {
      firstPlain(m).answerKey.firstVisibleAt = 'R2';
    },
    'canary listed in answerKey but absent from steps': (m) => {
      m.cases.find((c) => c.answerKey.canaries.length === 0).answerKey.canaries.push('LOTOR-CANARY-ZZ99XX88');
    },
    'canary in steps but not listed': (m) => {
      firstCanaryCase(m).answerKey.canaries = [];
    },
    'same canary in two cases': (m) => {
      const donor = firstCanaryCase(m);
      const other = m.cases.find((c) => c.answerKey.canaries.length === 0);
      other.steps[0].output = (other.steps[0].output ?? '') + ' ' + donor.answerKey.canaries[0];
    },
    'realIntent label copied into statedPurpose': (m) => {
      const d = firstDivergent(m);
      d.statedPurpose = `Run the ${d.answerKey.realIntent} plan`;
    },
    'step with tool Rm': (m) => {
      m.cases[0].steps[0].tool = 'Rm';
    },
  };

  for (const [name, mutate] of Object.entries(mutations)) {
    const mutated = structuredClone(corpus);
    mutate(mutated);
    let errors;
    assert.doesNotThrow(() => {
      errors = validateCorpus(mutated);
    }, `validateCorpus threw on mutation: ${name}`);
    assert.ok(
      Array.isArray(errors) && errors.length >= 1,
      `expected validation errors for mutation "${name}", got ${JSON.stringify(errors)}`,
    );
  }

  let nullErrors;
  assert.doesNotThrow(() => {
    nullErrors = validateCorpus(null);
  }, 'validateCorpus(null) must not throw');
  assert.ok(Array.isArray(nullErrors) && nullErrors.length >= 1, 'expected validation errors for corpus = null');
});