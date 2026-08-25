/**
 * test/policy-scheduled-task.test.js
 *
 * KNOWN-LIMITS 44: scheduled task and cron operations are not gated.
 *
 * The confession (KNOWN-LIMITS.md entry 44, found 2026-07-29): the
 * scope-escalation matcher keys on remembered invocation verbs
 * (`schtasks /create`, `Register-ScheduledTask`, `sc create`,
 * `New-Service`, `crontab`). Three persistence shapes walk past it:
 *
 *   - a cron artifact written BY PATH (`tee /etc/cron.d/foo`), no
 *     `crontab` token anywhere in the string;
 *   - launchd registration (`launchctl load ~/Library/LaunchAgents/*.plist`);
 *   - systemd/autostart artifact writes, by tool or by shell.
 *
 * The fix extends `isScopeEscalation` with the missing invocation verbs
 * (`at <timespec>`, `systemd-run --on-*`, `launchctl load|bootstrap|submit`,
 * `Register-ScheduledJob`) and adds a component-anchored persistence-artifact
 * path pattern checked from BOTH halves: command text (shell writers) and
 * Edit/Write/NotebookEdit file paths (Rule 7b), mirroring how the self-mod
 * rule already splits edit-half from command-half.
 *
 * PROVE-FAIL-FIRST: every `must gate` case below FAILS against the unfixed
 * matcher — that is the evidence the hole is real. This file deliberately
 * imports only symbols that exist on unpatched main (no new exports), so the
 * failures land per-case instead of crashing at import: an import crash
 * fails loudly but proves nothing about which cases were uncovered. The
 * controls pass before and after, so a fix cannot buy coverage by gating
 * everything that mentions a scheduler: reads of live state, lookalike
 * directories, non-unit files in unit-adjacent locations, and prose merely
 * containing the words must never trip.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_POLICY,
  evaluate,
  isScopeEscalation
} from '../src/policy/index.js';

const cmd = command => ({ command });

describe('scope-escalation: scheduled-task invocations must be seen', () => {
  // --- invocation half: cases that MUST gate (fail-first on unpatched main) ---

  it('gates at(1) with a time spec reading its job from stdin', () => {
    assert.strictEqual(
      isScopeEscalation(cmd("echo 'echo backup ran' | at 03:00")),
      true,
      'an at(1) scheduling invocation must gate'
    );
  });

  it('gates at(1) now-relative specs', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('echo reload | at now + 5 minutes')),
      true,
      'at now + N minutes registers future execution'
    );
  });

  it('gates at(1) after sudo and through -f', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('sudo at -f /opt/jobs/run.txt teatime')),
      true,
      'at(1) with teatime/named-day specs must gate'
    );
  });

  it('gates systemd-run transient timer units', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('systemd-run --on-active=30 touch /tmp/heartbeat-marker')),
      true,
      'a scheduled transient unit outlives the session'
    );
  });

  it('gates launchd registration', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('launchctl load ~/Library/LaunchAgents/com.sync.plist')),
      true,
      'launchctl load installs an agent that runs beyond this session'
    );
  });

  it('gates PowerShell Register-ScheduledJob', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('Register-ScheduledJob -Name nightly -ScriptBlock { echo hi }')),
      true,
      'scheduled-job registration joins Register-ScheduledTask'
    );
  });

  // --- artifact half via command text: MUST gate (fail-first on unpatched main) ---

  it('gates a cron drop-dir write that never spells crontab', () => {
    assert.strictEqual(
      isScopeEscalation(cmd("printf '%s\\n' '* * * * * echo nightly-backup ran' > /etc/cron.d/metrics")),
      true,
      'writing the cron artifact IS the registration; no crontab token required'
    );
  });

  it('gates a spool-cron write by path', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('cp my.cron /var/spool/cron/root')),
      true,
      'the spool file is the cron database'
    );
  });

  it('gates a freedesktop autostart entry written by shell', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('mkdir -p ~/.config/autostart && cp app.desktop ~/.config/autostart/sync.desktop')),
      true,
      'XDG autostart entries run beyond this session'
    );
  });
});

describe('scope-escalation: persistence-artifact paths through Edit/Write (evaluate)', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-sched-task-'));
  const policy = DEFAULT_POLICY;

  it('fires scope-escalation on a Write into a cron drop-dir (fail-first)', () => {
    const m = evaluate('Write', { file_path: '/etc/cron.d/backup-sync' }, policy, baseDir);
    assert.ok(m, 'the write must be caught');
    assert.strictEqual(m.ruleId, 'scope-escalation');
  });

  it('fires scope-escalation on an Edit of a systemd user unit (fail-first)', () => {
    const m = evaluate('Edit', { file_path: '/home/op/.config/systemd/user/poke.service' }, policy, baseDir);
    assert.ok(m, 'the edit must be caught');
    assert.strictEqual(m.ruleId, 'scope-escalation');
  });

  it('fires scope-escalation on a Write into the Windows task store, backslashes folded (fail-first)', () => {
    const m = evaluate('Write', { file_path: 'C:\\Windows\\System32\\Tasks\\SyncTask' }, policy, baseDir);
    assert.ok(m, 'the Windows spelling must be caught');
    assert.strictEqual(m.ruleId, 'scope-escalation');
  });

  it('does not fire on a LaunchAgents write? — it MUST fire (fail-first)', () => {
    const m = evaluate('Write', { file_path: '/Users/op/Library/LaunchAgents/com.sync.plist' }, policy, baseDir);
    assert.ok(m, 'launchd agent plists carry the same power as cron entries');
    assert.strictEqual(m.ruleId, 'scope-escalation');
  });

  it('does not fire on ordinary config writes (control)', () => {
    assert.strictEqual(evaluate('Write', { file_path: '/etc/app/settings.conf' }, policy, baseDir), null);
    assert.strictEqual(evaluate('Write', { file_path: '/tmp/notes.txt' }, policy, baseDir), null);
  });

  it('does not fire on lookalike directories and non-unit files (control)', () => {
    assert.strictEqual(evaluate('Edit', { file_path: '/home/op/projects/systemd-system-demo/demo.conf' }, policy, baseDir), null);
    assert.strictEqual(evaluate('Edit', { file_path: '/etc/systemd/system.conf' }, policy, baseDir), null);
    assert.strictEqual(evaluate('Edit', { file_path: '/etc/crontab-docs.md' }, policy, baseDir), null);
  });
});

describe('scope-escalation: controls that must stay free, before and after', () => {
  it('does not gate reads of scheduler state', () => {
    assert.strictEqual(isScopeEscalation(cmd('journalctl -u sync.service --since today')), false);
    assert.strictEqual(isScopeEscalation(cmd('systemctl status sync.timer')), false);
    assert.strictEqual(isScopeEscalation(cmd('launchctl list')), false);
  });

  it('does not gate a plain transient systemd-run', () => {
    assert.strictEqual(
      isScopeEscalation(cmd('systemd-run --wait touch /tmp/marker')),
      false,
      'runs-once-now execution stays with the other rules'
    );
  });

  it('does not gate filenames and prose that merely contain the words', () => {
    assert.strictEqual(isScopeEscalation(cmd('grep pattern /tmp/at-the-market.txt')), false);
    assert.strictEqual(isScopeEscalation(cmd('touch ~/projects/systemd-system-demo/demo.conf')), false);
    assert.strictEqual(isScopeEscalation(cmd("git commit -m 'document the cron layout'")), false);
  });

  it('keeps the pre-existing coverage intact (regression guards)', () => {
    assert.strictEqual(isScopeEscalation(cmd('schtasks /create /tn foo /tr bar')), true);
    assert.strictEqual(isScopeEscalation(cmd('schtasks /query')), false);
    assert.strictEqual(isScopeEscalation(cmd('crontab -l')), true, 'existing crontab coverage unchanged');
    assert.strictEqual(isScopeEscalation(cmd('sc create sync binPath= x')), true);
  });
});
