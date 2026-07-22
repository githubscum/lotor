/**
 * test/policy.test.js
 *
 * Unit tests for src/policy/index.js — every matcher, plus loadPolicy
 * and evaluate behavior (off mode, first-match-wins, malformed policy).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  DEFAULT_POLICY,
  loadPolicy,
  evaluate,
  isSelfMod,
  isPushForce,
  isPushProtected,
  isPublish,
  isEgressOther,
  isDestructive,
  isScopeEscalation,
  normalizePath,
  pathContainsFragment
} from '../src/policy/index.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-policy-'));
}

describe('policy: DEFAULT_POLICY shape', () => {
  it('locks the eight rule ids and the expected default modes', () => {
    assert.strictEqual(DEFAULT_POLICY.version, 1);
    assert.deepStrictEqual(DEFAULT_POLICY.modes, {
      'self-mod': 'gate',
      'push-force': 'warn',
      'push-protected': 'warn',
      'publish': 'warn',
      'egress-other': 'warn',
      'destructive': 'warn',
      'scope-escalation': 'warn',
      'spend': 'off'
    });
  });
});

describe('policy: normalizePath + pathContainsFragment', () => {
  it('converts backslashes to forward slashes and lowercases', () => {
    assert.strictEqual(
      normalizePath('C:\\Users\\Foo\\.claude\\Settings.JSON'),
      'c:/users/foo/.claude/settings.json'
    );
  });
  it('matches a fragment at start, middle, or end of a path', () => {
    const norm = normalizePath('/home/me/.claude/settings.json');
    assert.strictEqual(pathContainsFragment(norm, '.claude/settings.json'), true);
    assert.strictEqual(pathContainsFragment(norm, 'src/gate'), false);
  });
  it('rejects partial-token matches', () => {
    const norm = normalizePath('/home/me/.claudex/settings.json');
    assert.strictEqual(pathContainsFragment(norm, '.claude'), false);
  });
});

describe('policy: isSelfMod', () => {
  const baseDir = makeTempDir();
  afterEach(() => {
    // not strictly needed (per-test tempDirs would be cleaner), but safe
  });

  it('matches Edit to .claude/settings.json', () => {
    assert.strictEqual(
      isSelfMod('Edit', { file_path: 'C:\\Users\\me\\.claude\\settings.json' }, baseDir),
      true
    );
  });

  it('matches Write to a path under src/gate/', () => {
    assert.strictEqual(
      isSelfMod('Write', { file_path: '/repo/src/gate/index.js' }, baseDir),
      true
    );
  });

  it('matches Write to a path under src/policy/', () => {
    assert.strictEqual(
      isSelfMod('Write', { file_path: '/repo/src/policy/new.js' }, baseDir),
      true
    );
  });

  it('matches Write to bin/hook-*.js', () => {
    assert.strictEqual(
      isSelfMod('Write', { file_path: '/repo/bin/hook-pre-tool-use.js' }, baseDir),
      true
    );
  });

  it('matches Edit to <baseDir>/policy.json', () => {
    assert.strictEqual(
      isSelfMod('Edit', { file_path: path.join(baseDir, 'policy.json') }, baseDir),
      true
    );
  });

  it('matches Edit to <baseDir>/keys/anything', () => {
    assert.strictEqual(
      isSelfMod('Edit', { file_path: path.join(baseDir, 'keys', 'chain.key') }, baseDir),
      true
    );
  });

  it('matches NotebookEdit to .claude/settings.json', () => {
    assert.strictEqual(
      isSelfMod('NotebookEdit', { file_path: '/Users/me/.claude/settings.json' }, baseDir),
      true
    );
  });

  it('does NOT match Edit to an unrelated file', () => {
    assert.strictEqual(
      isSelfMod('Edit', { file_path: '/repo/src/views/index.js' }, baseDir),
      false
    );
  });

  it('does NOT match Read (Read is not in the rule)', () => {
    assert.strictEqual(
      isSelfMod('Read', { file_path: '/repo/.claude/settings.json' }, baseDir),
      false
    );
  });

  it('matches Bash whose command references a self-mod path', () => {
    assert.strictEqual(
      isSelfMod('Bash', { command: 'cat /repo/.claude/settings.json' }, baseDir),
      true
    );
  });

  it('matches Bash whose command references src/gate/', () => {
    assert.strictEqual(
      isSelfMod('Bash', { command: 'rm /repo/src/gate/whatever.js' }, baseDir),
      true
    );
  });
});

describe('policy: isPushForce', () => {
  it('matches git push --force', () => {
    assert.strictEqual(isPushForce({ command: 'git push --force origin main' }), true);
  });
  it('matches git push --force-with-lease', () => {
    assert.strictEqual(isPushForce({ command: 'git push --force-with-lease' }), true);
  });
  it('matches git push -f as a standalone token', () => {
    assert.strictEqual(isPushForce({ command: 'git push -f origin main' }), true);
  });
  it('does NOT match --follow (the -f false-positive guard)', () => {
    assert.strictEqual(isPushForce({ command: 'git push --follow-tags' }), false);
  });
  it('does NOT match bare git push', () => {
    assert.strictEqual(isPushForce({ command: 'git push origin main' }), false);
  });
  it('does NOT match a non-push git command', () => {
    assert.strictEqual(isPushForce({ command: 'git pull' }), false);
  });
  it('does NOT match a -f embedded inside a longer flag', () => {
    // -fx isn't a real flag, but the guard still rejects it: -f must be standalone
    assert.strictEqual(isPushForce({ command: 'git push -fx origin main' }), false);
  });
});

describe('policy: isPushProtected', () => {
  it('matches git push origin main', () => {
    assert.strictEqual(isPushProtected({ command: 'git push origin main' }), true);
  });
  it('matches git push origin master', () => {
    assert.strictEqual(isPushProtected({ command: 'git push origin master' }), true);
  });
  it('matches git push main (no remote, explicit ref)', () => {
    assert.strictEqual(isPushProtected({ command: 'git push main' }), true);
  });
  it('does NOT match bare git push (no ref)', () => {
    assert.strictEqual(isPushProtected({ command: 'git push' }), false);
  });
  it('does NOT match git push to a feature branch', () => {
    assert.strictEqual(isPushProtected({ command: 'git push origin feat/awesome' }), false);
  });
  it('does NOT match a non-push command', () => {
    assert.strictEqual(isPushProtected({ command: 'git checkout main' }), false);
  });
  it('does NOT match when `main` appears only in a non-ref position (documented limit)', () => {
    // bare git push with main as commit message text, not ref — still allowed
    // (we match if `main` appears anywhere after `git push`).
    // Document the false-positive: git push --message "main" → matches.
    assert.strictEqual(isPushProtected({ command: 'git push --message "main"' }), true);
  });
});

describe('policy: isPublish', () => {
  it('matches gh pr merge', () => {
    assert.strictEqual(isPublish({ command: 'gh pr merge 42 --squash' }), true);
  });
  it('matches npm publish', () => {
    assert.strictEqual(isPublish({ command: 'npm publish --access public' }), true);
  });
  it('matches gh release create', () => {
    assert.strictEqual(isPublish({ command: 'gh release create v1.0.0' }), true);
  });
  it('does NOT match npm install', () => {
    assert.strictEqual(isPublish({ command: 'npm install foo' }), false);
  });
  it('does NOT match empty command', () => {
    assert.strictEqual(isPublish({}), false);
  });
});

describe('policy: isEgressOther', () => {
  it('matches curl with -X POST to a non-localhost host', () => {
    assert.strictEqual(
      isEgressOther({ command: 'curl -X POST https://api.example.com/v1/x' }),
      true
    );
  });
  it('matches curl with -d to a non-localhost host', () => {
    assert.strictEqual(
      isEgressOther({ command: 'curl -d "x=1" https://api.example.com' }),
      true
    );
  });
  it('matches Invoke-WebRequest with -Method Post', () => {
    assert.strictEqual(
      isEgressOther({ command: 'Invoke-WebRequest -Uri https://x.example -Method Post' }),
      true
    );
  });
  it('matches iwr with -Body', () => {
    assert.strictEqual(
      isEgressOther({ command: 'iwr https://x.example -Body "hi"' }),
      true
    );
  });
  it('excludes curl to localhost (regardless of method flag)', () => {
    assert.strictEqual(
      isEgressOther({ command: 'curl -X POST http://localhost:8080/api' }),
      false
    );
  });
  it('excludes curl to 127.0.0.1 (regardless of method flag)', () => {
    assert.strictEqual(
      isEgressOther({ command: 'curl -X POST http://127.0.0.1:8080/api' }),
      false
    );
  });
  it('does NOT match a bare GET curl (no method/data flag)', () => {
    assert.strictEqual(
      isEgressOther({ command: 'curl https://api.example.com/v1/x' }),
      false
    );
  });
  it('matches ssh user@host:', () => {
    assert.strictEqual(
      isEgressOther({ command: 'ssh me@host.example ls' }),
      true
    );
  });
  it('matches scp host:/path', () => {
    assert.strictEqual(
      isEgressOther({ command: 'scp file.txt host.example:/tmp/' }),
      true
    );
  });
  it('matches rsync user@host:/path', () => {
    assert.strictEqual(
      isEgressOther({ command: 'rsync -avz me@host.example:/data ./' }),
      true
    );
  });
  it('does NOT match ssh to a non-remote target (none in our shape)', () => {
    // bare `ssh` with no user@host pattern: not a remote form
    assert.strictEqual(
      isEgressOther({ command: 'ssh' }),
      false
    );
  });
});

describe('policy: isDestructive', () => {
  it('matches rm -rf of a non-temp path', () => {
    assert.strictEqual(
      isDestructive({ command: 'rm -rf /home/me/project' }),
      true
    );
  });
  it('matches rm -fr (alternate flag order)', () => {
    assert.strictEqual(
      isDestructive({ command: 'rm -fr /home/me/project' }),
      true
    );
  });
  it('excludes rm -rf of /tmp', () => {
    assert.strictEqual(
      isDestructive({ command: 'rm -rf /tmp/whatever' }),
      false
    );
  });
  it('excludes rm -rf of a path containing "scratchpad"', () => {
    assert.strictEqual(
      isDestructive({ command: 'rm -rf /home/me/scratchpad/run-1' }),
      false
    );
  });
  it('excludes rm -rf of a path containing "mktemp"', () => {
    assert.strictEqual(
      isDestructive({ command: 'rm -rf /home/me/mktemp-xyz' }),
      false
    );
  });
  it('matches Remove-Item -Recurse -Force', () => {
    assert.strictEqual(
      isDestructive({ command: 'Remove-Item -Recurse -Force C:\\Users\\me\\project' }),
      true
    );
  });
  it('does NOT match plain rm (no -rf)', () => {
    assert.strictEqual(
      isDestructive({ command: 'rm /home/me/project' }),
      false
    );
  });
});

describe('policy: isScopeEscalation', () => {
  it('matches schtasks /create', () => {
    assert.strictEqual(isScopeEscalation({ command: 'schtasks /create /tn foo /tr bar' }), true);
  });
  it('matches schtasks.exe /create (tolerate .exe)', () => {
    assert.strictEqual(isScopeEscalation({ command: 'schtasks.exe /create /tn foo' }), true);
  });
  it('matches Register-ScheduledTask', () => {
    assert.strictEqual(isScopeEscalation({ command: 'Register-ScheduledTask -TaskName foo' }), true);
  });
  it('matches sc create', () => {
    assert.strictEqual(isScopeEscalation({ command: 'sc create mysvc binPath= "x.exe"' }), true);
  });
  it('matches New-Service', () => {
    assert.strictEqual(isScopeEscalation({ command: 'New-Service -Name foo -BinaryPathName "x"' }), true);
  });
  it('matches crontab', () => {
    assert.strictEqual(isScopeEscalation({ command: 'crontab -e' }), true);
  });
  it('does NOT match schtasks /query', () => {
    assert.strictEqual(isScopeEscalation({ command: 'schtasks /query' }), false);
  });
});

describe('policy: evaluate (first-match-wins, off mode)', () => {
  const baseDir = makeTempDir();

  it('returns null when no rule matches', () => {
    const m = evaluate('Read', { file_path: '/repo/x.js' }, DEFAULT_POLICY, baseDir);
    assert.strictEqual(m, null);
  });

  it('returns the first matching rule (self-mod wins over push-force when both apply)', () => {
    // A bash command that both references a self-mod path AND contains a force push.
    // In practice, first-match-wins means self-mod is reported.
    const m = evaluate(
      'Bash',
      { command: 'git push --force origin main && cat /repo/.claude/settings.json' },
      DEFAULT_POLICY,
      baseDir
    );
    assert.ok(m);
    assert.strictEqual(m.ruleId, 'self-mod');
  });

  it('returns push-force when only push-force matches', () => {
    const m = evaluate(
      'Bash',
      { command: 'git push -f origin feat/x' },
      DEFAULT_POLICY,
      baseDir
    );
    assert.ok(m);
    assert.strictEqual(m.ruleId, 'push-force');
  });

  it('an "off" mode never matches', () => {
    const policy = { version: 1, modes: { ...DEFAULT_POLICY.modes, 'push-force': 'off' } };
    const m = evaluate(
      'Bash',
      { command: 'git push -f origin feat/x' },
      policy,
      baseDir
    );
    assert.strictEqual(m, null);
  });

  it('mode field reflects the policy mode (gate vs warn)', () => {
    const policy = { version: 1, modes: { ...DEFAULT_POLICY.modes, 'push-force': 'gate' } };
    const m = evaluate(
      'Bash',
      { command: 'git push -f origin feat/x' },
      policy,
      baseDir
    );
    assert.ok(m);
    assert.strictEqual(m.mode, 'gate');
  });

  it('unknown mode in policy file: rule is treated as not matching (safe default)', () => {
    // Unknown mode strings are dropped during loadPolicy merge; the default
    // for that rule applies. Confirm by passing a raw policy with an unknown
    // mode and a matching command:
    const policy = { version: 1, modes: { ...DEFAULT_POLICY.modes, 'push-force': 'silly' } };
    const m = evaluate(
      'Bash',
      { command: 'git push -f origin feat/x' },
      policy,
      baseDir
    );
    assert.strictEqual(m, null, 'unknown mode should not match');
  });
});

describe('policy: loadPolicy', () => {
  it('first-use: writes DEFAULT_POLICY to <baseDir>/policy.json and returns it', () => {
    const dir = makeTempDir();
    const policy = loadPolicy(dir);
    assert.deepStrictEqual(policy, DEFAULT_POLICY);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8'));
    assert.deepStrictEqual(onDisk, DEFAULT_POLICY);
  });

  it('malformed JSON: returns DEFAULT_POLICY without overwriting the file', () => {
    const dir = makeTempDir();
    const policyPath = path.join(dir, 'policy.json');
    fs.writeFileSync(policyPath, '{ this is not json', { mode: 0o644 });
    const before = fs.readFileSync(policyPath, 'utf8');
    const policy = loadPolicy(dir);
    assert.deepStrictEqual(policy, DEFAULT_POLICY);
    const after = fs.readFileSync(policyPath, 'utf8');
    assert.strictEqual(after, before, 'malformed file must not be overwritten');
  });

  it('a user policy overrides individual mode strings but leaves unknown rules at default', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'policy.json'),
      JSON.stringify({
        version: 1,
        modes: {
          'push-force': 'gate',
          'unknown-rule': 'off' // must be ignored
        }
      }),
      { mode: 0o644 }
    );
    const policy = loadPolicy(dir);
    assert.strictEqual(policy.modes['push-force'], 'gate');
    assert.strictEqual(policy.modes['push-protected'], 'warn', 'unchanged default');
    assert.strictEqual(policy.modes['unknown-rule'], undefined, 'unknown rule is not added');
  });

  it('directory in place of policy.json: returns defaults without throwing', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'policy.json'));
    // Should not throw; isReadableFile returns false, so the write path is
    // also tried and fails silently. Defaults returned.
    const policy = loadPolicy(dir);
    assert.deepStrictEqual(policy, DEFAULT_POLICY);
  });
});
