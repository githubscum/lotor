/**
 * Regression test for the shell-shaped hole in the policy engine.
 *
 * Found 2026-07-22 by deploying a site to a Raspberry Pi. The deploy ran
 * through the PowerShell tool and shipped 1.3 MB off the machine over SSH.
 * No rule matched, because every command rule in evaluate() was guarded by
 * `toolName === 'Bash'`. The matchers were correct; they were simply never
 * handed anything that was not Bash.
 *
 * The blindness was not limited to egress. push-force, publish, destructive
 * and scope-escalation were equally blind, so `rm -rf` on a served directory
 * through PowerShell would not have raised a warning either.
 *
 * These tests fail against the pre-fix engine and pass after it. Each probe
 * is asserted through BOTH a Bash call and a non-Bash call, so the fix cannot
 * regress by quietly reintroducing a tool-name allowlist.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy, evaluate } from '../src/policy/index.js';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-policy-test-'));
const policy = loadPolicy(baseDir);

// Every rule below is set to at least 'warn' by the default policy, so a
// match returns a ruleId. The point of each probe is the ruleId, not the mode.
const PROBES = [
  { rule: 'egress-other', command: 'scp secret.txt pi@10.0.0.5:~/secret.txt' },
  { rule: 'egress-other', command: 'ssh pi@10.0.0.5 "cat /etc/hostname"' },
  { rule: 'publish', command: 'npm publish' },
  { rule: 'push-force', command: 'git push --force origin main' },
  { rule: 'destructive', command: 'rm -rf /var/www/example.com' },
];

// Shells other than Bash that a harness can plausibly expose. The fix keys on
// the shape of tool_input, not on this list, so all of them are covered.
const SHELLS = ['Bash', 'PowerShell', 'Shell', 'Terminal', 'SomeFutureShell'];

describe('policy: command rules are not scoped to a single shell', () => {
  for (const probe of PROBES) {
    for (const tool of SHELLS) {
      it(`${probe.rule} matches through ${tool}`, () => {
        const result = evaluate(tool, { command: probe.command }, policy, baseDir);
        assert.ok(
          result,
          `${tool} + "${probe.command}" produced no match; egress can leave unseen`
        );
        assert.equal(result.ruleId, probe.rule);
      });
    }
  }

  it('the real deploy that exposed this now matches', () => {
    // The exact shape of the call that shipped the site to the Pi unseen.
    const result = evaluate(
      'PowerShell',
      { command: 'cd C:\\Users\\liemi\\site; .\\deploy\\deploy.ps1 -PiHost pi@100.105.89.20' },
      policy,
      baseDir
    );
    assert.ok(result, 'the deploy command is still invisible to the gate');
    // No ssh or scp token in that string: the egress lives inside the script.
    // opaque-exec is the rule that refuses to wave through what it cannot read.
    assert.equal(result.ruleId, 'opaque-exec');
  });
});

describe('policy: shape detection does not over-match', () => {
  it('ignores tools that carry no command string', () => {
    assert.equal(evaluate('Read', { file_path: '/etc/passwd' }, policy, baseDir), null);
    assert.equal(evaluate('WebSearch', { query: 'scp to a host' }, policy, baseDir), null);
  });

  it('ignores an empty or whitespace-only command', () => {
    assert.equal(evaluate('PowerShell', { command: '' }, policy, baseDir), null);
    assert.equal(evaluate('PowerShell', { command: '   ' }, policy, baseDir), null);
  });

  it('ignores a harmless command through any shell', () => {
    for (const tool of SHELLS) {
      assert.equal(
        evaluate(tool, { command: 'echo hello' }, policy, baseDir),
        null,
        `${tool} false-positived on a harmless command`
      );
    }
  });
});
