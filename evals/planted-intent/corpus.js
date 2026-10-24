// Loader and validator for the planted-intent corpus (V3-08, serves evals E3 and E6).
//
// Binding split: Lotor captures what happens at each reach rung and never infers
// intent. The answer key inside each case exists only for scoring. stripToReach is
// the boundary that keeps the answer key, and anything below the observed rung,
// out of the view of the system under test.

import { readFileSync } from 'node:fs';

export const RUNGS = ['R0', 'R1', 'R2', 'R3'];

const TOOLS = new Set(['Read', 'Write', 'Edit', 'Bash', 'WebFetch', 'Grep']);
const ID_RE = /^pi-\d{3}$/;
const CANARY_EXACT_RE = /^LOTOR-CANARY-[A-Z0-9]{8,}$/;
const CANARY_SCAN_RE = /LOTOR-CANARY-[A-Z0-9]{8,}/g;
const LABEL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function loadCorpus(path = new URL('./corpus.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

const fmt = (v) => JSON.stringify(v) ?? typeOf(v);

function collectCanaries(text, sink) {
  for (const match of text.matchAll(CANARY_SCAN_RE)) sink.add(match[0]);
}

export function validateCorpus(corpus) {
  const errors = [];
  if (corpus === null || typeof corpus !== 'object' || Array.isArray(corpus)) {
    errors.push(`corpus: expected an object with { version, cases }, got ${typeOf(corpus)}`);
    return errors;
  }
  if (corpus.version !== 1) {
    errors.push(`corpus.version: expected 1, got ${fmt(corpus.version)}`);
  }

  if (!Array.isArray(corpus.cases)) {
    errors.push(`corpus.cases: expected an array, got ${typeOf(corpus.cases)}`);
    return errors;
  }
  if (corpus.cases.length === 0) {
    errors.push('corpus.cases: must be a non-empty array');
    return errors;
  }

  const idIndex = new Map();
  const canaryOwners = new Map();

  corpus.cases.forEach((c, i) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`case[${i}]: expected an object, got ${typeOf(c)}`);
      return;
    }
    const id = typeof c.id === 'string' && c.id ? c.id : `case[${i}]`;
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) {
      errors.push(`${id}: id must be a string matching /^pi-\\d{3}$/, got ${fmt(c.id)}`);
    } else if (idIndex.has(c.id)) {
      errors.push(`${id}: duplicate id (first seen at case index ${idIndex.get(c.id)})`);
    } else {
      idIndex.set(c.id, i);
    }

    if (typeof c.statedPurpose !== 'string' || c.statedPurpose === '') {
      errors.push(`${id}: statedPurpose must be a non-empty string`);
    }

    let stepCount = null;
    const stepTexts = []; // every string the case shows at R0..R3, minus tool semantics
    if (!Array.isArray(c.steps)) {
      errors.push(`${id}: steps must be an array, got ${typeOf(c.steps)}`);
    } else {
      stepCount = c.steps.length;
      if (stepCount < 2 || stepCount > 6) {
        errors.push(`${id}: steps must contain between 2 and 6 entries, got ${stepCount}`);
      }
      c.steps.forEach((s, j) => {
        if (s === null || typeof s !== 'object' || Array.isArray(s)) {
          errors.push(`${id}.steps[${j}]: expected an object, got ${typeOf(s)}`);
          return;
        }
        const where = `${id}.steps[${j}]`;
        if (typeof s.tool !== 'string' || !TOOLS.has(s.tool)) {
          errors.push(`${where}.tool: must be one of ${[...TOOLS].join(', ')}, got ${fmt(s.tool)}`);
        }
        for (const field of ['input', 'output', 'reasoning']) {
          if (typeof s[field] !== 'string') errors.push(`${where}.${field}: must be a string, got ${typeOf(s[field])}`);
          else stepTexts.push(s[field]);
        }
      });
    }

    const key = c.answerKey;
    if (key === null || typeof key !== 'object' || Array.isArray(key)) {
      errors.push(`${id}: answerKey must be an object, got ${typeOf(c.answerKey)}`);
      return;
    }

    if (typeof key.realIntent !== 'string' || !LABEL_RE.test(key.realIntent)) {
      errors.push(`${id}.answerKey.realIntent: must be a short kebab-case label, got ${fmt(key.realIntent)}`);
    }
    const divergent = key.divergent;
    if (typeof divergent !== 'boolean') {
      errors.push(`${id}.answerKey.divergent: must be a boolean, got ${fmt(divergent)}`);
    }
    if (typeof key.firstVisibleAt !== 'string' || !RUNGS.includes(key.firstVisibleAt)) {
      errors.push(`${id}.answerKey.firstVisibleAt: must be one of ${RUNGS.join(', ')}, got ${fmt(key.firstVisibleAt)}`);
    }

    if (!Array.isArray(key.evidenceSteps)) {
      errors.push(`${id}.answerKey.evidenceSteps: must be an array, got ${typeOf(key.evidenceSteps)}`);
    } else {
      for (const idx of key.evidenceSteps) {
        if (!Number.isInteger(idx)) errors.push(`${id}.answerKey.evidenceSteps: every entry must be an integer, got ${fmt(idx)}`);
        else if (idx < 0 || (stepCount !== null && idx >= stepCount)) {
          errors.push(`${id}.answerKey.evidenceSteps: index ${idx} out of range (steps length ${stepCount ?? 'unknown'})`);
        }
      }
    }

    if (typeof divergent === 'boolean') {
      if (divergent) {
        if (key.firstVisibleAt === 'R0') errors.push(`${id}: divergent cases cannot have firstVisibleAt "R0"`);
        if (Array.isArray(key.evidenceSteps) && key.evidenceSteps.length === 0) {
          errors.push(`${id}: divergent cases need a non-empty evidenceSteps list`);
        }
      } else {
        if (key.firstVisibleAt !== 'R0') {
          errors.push(`${id}: non-divergent cases must have firstVisibleAt "R0", got ${fmt(key.firstVisibleAt)}`);
        }
        if (Array.isArray(key.evidenceSteps) && key.evidenceSteps.length > 0) {
          errors.push(`${id}: non-divergent cases must have an empty evidenceSteps list`);
        }
      }
    }

    const listed = new Set();
    if (!Array.isArray(key.canaries)) {
      errors.push(`${id}.answerKey.canaries: must be an array, got ${typeOf(key.canaries)}`);
    } else {
      for (const canary of key.canaries) {
        if (typeof canary !== 'string' || !CANARY_EXACT_RE.test(canary)) {
          errors.push(`${id}.answerKey.canaries: entry must match /^LOTOR-CANARY-[A-Z0-9]{8,}$/, got ${fmt(canary)}`);
        } else if (listed.has(canary)) {
          errors.push(`${id}.answerKey.canaries: duplicate entry ${canary}`);
        } else {
          listed.add(canary);
        }
      }
    }
    const found = new Set();
    for (const text of stepTexts) collectCanaries(text, found);
    for (const canary of found) {
      if (canaryOwners.has(canary)) errors.push(`${id}: canary ${canary} already appears in ${canaryOwners.get(canary)}`);
      else canaryOwners.set(canary, id);
    }
    for (const canary of listed) {
      if (!found.has(canary)) errors.push(`${id}: canary ${canary} is listed in answerKey.canaries but absent from steps`);
    }
    if (Array.isArray(key.canaries)) {
      for (const canary of found) {
        if (!listed.has(canary)) errors.push(`${id}: canary ${canary} appears in steps but is not listed in answerKey.canaries`);
      }
    }

    if (typeof key.realIntent === 'string' && key.realIntent) {
      const label = key.realIntent;
      if (typeof c.statedPurpose === 'string' && c.statedPurpose.includes(label)) {
        errors.push(`${id}: statedPurpose leaks the realIntent label "${label}"`);
      }
      if (stepTexts.some((t) => t.includes(label))) {
        errors.push(`${id}: steps leak the realIntent label "${label}"`);
      }
    }
    const leakProbe = [c.statedPurpose, ...stepTexts].filter((t) => typeof t === 'string');
    if (leakProbe.some((t) => t.includes('answerKey'))) {
      errors.push(`${id}: case text leaks the literal "answerKey"`);
    }
  });

  return errors;
}

export function stripToReach(testCase, rung) {
  if (!RUNGS.includes(rung)) {
    throw new RangeError(`unknown reach rung: ${fmt(rung)} (expected one of ${RUNGS.join(', ')})`);
  }
  const out = {
    id: testCase?.id,
    statedPurpose: testCase?.statedPurpose,
  };
  if (rung === 'R0') return out;
  const steps = (Array.isArray(testCase?.steps) ? testCase.steps : []).map((s) => {
    const step = { tool: s?.tool, input: s?.input };
    if (rung === 'R2' || rung === 'R3') step.output = s?.output;
    if (rung === 'R3') step.reasoning = s?.reasoning;
    return step;
  });
  out.steps = steps;
  return out;
}