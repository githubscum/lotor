/**
 * test/policy-modes.test.js
 *
 * Unit tests for the herding-mode preset layer added to src/policy/index.js
 * on 2026-07-23 (Herded / Grazing / Loose). Covers the two invariants the
 * design plan calls out as deliberate rather than incidental:
 *
 *   - Loose is 'warn' on every rule except self-mod/mode-change, never
 *     'off'. evaluate() takes a no-chain-I/O fast path on a null match, so
 *     an all-off Loose would make the most dangerous mode the one that
 *     leaves the least evidence.
 *   - self-mod (and mode-change) stay gated in every preset. Loose means
 *     free to act on the world, not free to rewrite what stops you.
 *
 * Also covers: preset expansion is exact, an unrecognized mode name falls
 * back to the pre-preset legacy defaults (never silently upgraded), a
 * preset name surviving only when the file's modes still match it exactly,
 * and the mode-change matcher itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  DEFAULT_POLICY,
  MODE_NAMES,
  RULE_IDS,
  RULE_INFO,
  expandMode,
  loadPolicy,
  evaluate,
  isModeChange,
  isSelfMod
} from '../src/policy/index.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-policy-modes-'));
}

function writePolicy(dir, obj) {
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(obj, null, 2), { mode: 0o644 });
}

describe('herding modes: preset expansion', () => {
  it('exposes exactly three mode names', () => {
    assert.deepStrictEqual([...MODE_NAMES].sort(), ['grazing', 'herded', 'loose']);
  });

  it('Herded gates every rule except spend', () => {
    const modes = expandMode('herded');
    for (const ruleId of RULE_IDS) {
      if (ruleId === 'spend') {
        assert.strictEqual(modes[ruleId], 'off', `${ruleId} should be off`);
      } else {
        assert.strictEqual(modes[ruleId], 'gate', `${ruleId} should gate under Herded`);
      }
    }
  });

  it('Grazing gates egress-shaped rules and warns local-only ones', () => {
    const modes = expandMode('grazing');
    const shouldGate = ['self-mod', 'mode-change', 'push-force', 'push-protected', 'publish', 'egress-other', 'opaque-exec'];
    const shouldWarn = ['destructive', 'scope-escalation'];
    for (const ruleId of shouldGate) {
      assert.strictEqual(modes[ruleId], 'gate', `${ruleId} should gate under Grazing`);
    }
    for (const ruleId of shouldWarn) {
      assert.strictEqual(modes[ruleId], 'warn', `${ruleId} should warn under Grazing`);
    }
    assert.strictEqual(modes.spend, 'off');
  });

  it('Loose warns everything except self-mod and mode-change, and never turns a rule off', () => {
    const modes = expandMode('loose');
    assert.strictEqual(modes['self-mod'], 'gate', 'self-mod must survive Loose');
    assert.strictEqual(modes['mode-change'], 'gate', 'mode-change must survive Loose');
    for (const ruleId of RULE_IDS) {
      if (ruleId === 'self-mod' || ruleId === 'mode-change' || ruleId === 'spend') continue;
      assert.strictEqual(modes[ruleId], 'warn', `${ruleId} must be warn, not off, under Loose`);
    }
  });

  it('DEFAULT_POLICY ships as the Grazing preset', () => {
    assert.strictEqual(DEFAULT_POLICY.mode, 'grazing');
    assert.deepStrictEqual(DEFAULT_POLICY.modes, expandMode('grazing'));
  });

  it('every rule id has a RULE_INFO entry (why + risk), so the denial message is never generic', () => {
    for (const ruleId of RULE_IDS) {
      assert.ok(RULE_INFO[ruleId], `missing RULE_INFO for ${ruleId}`);
      assert.strictEqual(typeof RULE_INFO[ruleId].why, 'string');
      assert.strictEqual(typeof RULE_INFO[ruleId].risk, 'string');
    }
  });
});

describe('herding modes: Loose still records (the test that would catch an all-off Loose)', () => {
  it('a matched warn-mode rule under Loose still returns a match, not null', () => {
    const baseDir = makeTempDir();
    const policy = { version: 2, mode: 'loose', modes: expandMode('loose') };
    const m = evaluate('Bash', { command: 'rm -rf /var/www/example.com' }, policy, baseDir);
    assert.ok(m, 'destructive must still match under Loose, not silently vanish');
    assert.strictEqual(m.ruleId, 'destructive');
    assert.strictEqual(m.mode, 'warn', 'Loose warns, it does not turn the rule off');
  });

  it('self-mod still GATES under Loose: rewriting the fence is never free', () => {
    const baseDir = makeTempDir();
    const policy = { version: 2, mode: 'loose', modes: expandMode('loose') };
    const m = evaluate('Edit', { file_path: path.join(baseDir, 'policy.json') }, policy, baseDir);
    assert.ok(m);
    assert.strictEqual(m.ruleId, 'self-mod');
    assert.strictEqual(m.mode, 'gate', 'Loose must not weaken self-mod to warn');
  });
});

describe('herding modes: mode-change matcher', () => {
  it('matches `npm run mode -- <name>`', () => {
    assert.strictEqual(isModeChange({ command: 'npm run mode -- loose' }), true);
  });

  it('matches a direct `node bin/mode.js` invocation, either slash style', () => {
    assert.strictEqual(isModeChange({ command: 'node bin/mode.js herded' }), true);
    assert.strictEqual(isModeChange({ command: 'node bin\\mode.js herded' }), true);
  });

  it('does not match an unrelated command', () => {
    assert.strictEqual(isModeChange({ command: 'npm run test' }), false);
    assert.strictEqual(isModeChange({ command: 'node bin/approve.js approve' }), false);
  });

  it('mode-change gates through evaluate() even when running through a non-Bash shell', () => {
    const baseDir = makeTempDir();
    const policy = { version: 2, mode: 'loose', modes: expandMode('loose') };
    const m = evaluate('PowerShell', { command: 'npm run mode -- loose' }, policy, baseDir);
    assert.ok(m);
    assert.strictEqual(m.ruleId, 'mode-change');
    assert.strictEqual(m.mode, 'gate');
  });
});

describe('herding modes: loadPolicy resolves mode, expands, and detects drift', () => {
  it('fresh home: loads as Grazing', () => {
    const dir = makeTempDir();
    const policy = loadPolicy(dir);
    assert.strictEqual(policy.mode, 'grazing');
    assert.deepStrictEqual(policy.modes, expandMode('grazing'));
  });

  it('a file naming a preset that exactly matches its own modes keeps that name', () => {
    const dir = makeTempDir();
    writePolicy(dir, { version: 2, mode: 'herded', modes: expandMode('herded') });
    const policy = loadPolicy(dir);
    assert.strictEqual(policy.mode, 'herded');
  });

  it('a file naming a preset but hand-edited away from it resolves to "custom"', () => {
    const dir = makeTempDir();
    const modes = { ...expandMode('herded'), destructive: 'off' }; // hand-weakened
    writePolicy(dir, { version: 2, mode: 'herded', modes });
    const policy = loadPolicy(dir);
    assert.strictEqual(policy.mode, 'custom', 'a name that no longer matches its file must not be trusted');
    assert.strictEqual(policy.modes.destructive, 'off', 'the hand edit itself is still honored');
  });

  it('an existing v1 file with no mode field loads as "custom" against the pre-preset legacy defaults, untouched', () => {
    const dir = makeTempDir();
    // The exact shape a pre-herding-modes install would have on disk: no
    // `mode` key, and push-force/publish/egress-other still at warn.
    writePolicy(dir, {
      version: 1,
      modes: {
        'self-mod': 'gate',
        'push-force': 'warn',
        'push-protected': 'warn',
        'publish': 'warn',
        'egress-other': 'gate', // this install had hand-raised this one
        'opaque-exec': 'gate',
        'destructive': 'warn',
        'scope-escalation': 'warn',
        'spend': 'off'
      }
    });
    const policy = loadPolicy(dir);
    assert.strictEqual(policy.mode, 'custom');
    assert.strictEqual(policy.modes['push-force'], 'warn', 'untouched rule keeps its pre-preset default, not Grazing\'s gate');
    assert.strictEqual(policy.modes['publish'], 'warn', 'untouched rule keeps its pre-preset default');
    assert.strictEqual(policy.modes['egress-other'], 'gate', 'the hand-set value is preserved');
    assert.strictEqual(policy.modes['mode-change'], 'gate', 'a rule the old file never knew about still defaults safe');
  });

  it('an unrecognized mode string is treated the same as no mode field', () => {
    const dir = makeTempDir();
    writePolicy(dir, { version: 2, mode: 'feral', modes: { 'push-force': 'gate' } });
    const policy = loadPolicy(dir);
    assert.strictEqual(policy.mode, 'custom');
    assert.strictEqual(policy.modes['push-force'], 'gate');
    assert.strictEqual(policy.modes['push-protected'], 'warn', 'falls back to legacy default, not Grazing');
  });
});
