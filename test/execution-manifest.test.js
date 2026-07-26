/**
 * test/execution-manifest.test.js
 *
 * The npm manifest is executable, so it is core.
 *
 * THE BYPASS, found 2026-07-26
 *   The manifest's `scripts` block is arbitrary shell that runs under a NAME,
 *   and a name is all a command matcher ever sees. The full chain:
 *
 *     1. Add a script to the manifest. Unsigned — it was in neither core list.
 *     2. Run it by name. The command string carries no protected path and no
 *        script extension, so `self-mod` matches nothing and `opaque-exec`
 *        matches nothing.
 *     3. The body does whatever it likes: write to bin/, delete the chain,
 *        push, call out.
 *
 *   Every matcher in this codebase reads command strings. This indirection
 *   lives in a data file, which is exactly why all of them missed it.
 *
 * IT IS THE CLASS opaque-exec ALREADY NAMES
 *   That rule's own principle is that an action the engine cannot read is
 *   unverified, and unverified must not mean allowed. It was built for `.ps1`
 *   and `.sh` invocations. A named script is the same thing reached through a
 *   file instead of through a command, and the principle did not travel with it.
 *
 * HOW IT SURFACED, which is the part worth remembering
 *   Not by audit. The `bin/` fix shipped an hour earlier had started gating the
 *   *running* of bin scripts, so running one by name was used instead — in good
 *   faith, calling it "the documented interface", which it is. It worked because
 *   the gate cannot see through it. **A convenient workaround and a bypass are
 *   the same mechanism viewed from different sides**, and the only thing
 *   separating them is intent, which no matcher can read.
 *
 * WHAT THIS FIX IS AND IS NOT
 *   It closes the INJECTION vector: no new script appears without a signature,
 *   so the existing known set is the only set that runs. It does NOT gate
 *   running them, because that would gate the test command and every
 *   observability command, and constant friction is how an operator learns to
 *   stop reading (KNOWN-LIMITS 26). Partial, and recorded as partial.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isSelfMod } from '../src/policy/index.js';
import { classifyPath, CORE_FILES } from '../src/grant/core-paths.js';
import { resolveHome } from '../src/home.js';

const home = resolveHome();
const MANIFEST = 'package' + '.json';   // split so this file's own prose is not the thing under test

describe('the execution manifest is non-delegable', () => {
  it('is on the core list, so no grant may ever cover it', () => {
    assert.ok(CORE_FILES.includes(MANIFEST), 'the manifest must be a core file');
    assert.strictEqual(classifyPath(MANIFEST).verdict, 'core');
  });

  it('gates an Edit to it', () => {
    assert.strictEqual(isSelfMod('Edit', { file_path: MANIFEST }, home), true);
  });

  it('gates a Write that would replace it wholesale', () => {
    assert.strictEqual(isSelfMod('Write', { file_path: MANIFEST }, home), true);
  });

  it('gates a shell write to it, in both shells', () => {
    assert.strictEqual(isSelfMod('Bash', { command: `echo {} > ${MANIFEST}` }, home), true);
    assert.strictEqual(isSelfMod('PowerShell', { command: `Set-Content ${MANIFEST} -Value x` }, home), true);
  });

  it('gates it under a directory prefix, not only bare', () => {
    assert.strictEqual(isSelfMod('Edit', { file_path: `some/nested/${MANIFEST}` }, home), true);
  });
});

describe('what this fix deliberately does NOT do', () => {
  // Stated as tests so the gap is impossible to forget and impossible to
  // mistake for coverage. If someone later decides to close it, these are the
  // assertions that flip.
  it('does not gate running a script by name — the indirection remains', () => {
    assert.strictEqual(isSelfMod('Bash', { command: 'npm run build' }, home), false,
      'running a named script is still ungated; only introducing one is gated');
  });

  it('does not gate the test command, which is the whole reason it stops here', () => {
    assert.strictEqual(isSelfMod('Bash', { command: 'npm test' }, home), false);
  });
});
