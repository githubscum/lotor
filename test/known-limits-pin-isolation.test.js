import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Run the real CLI in a disposable repository. Even the pre-fix CLI can only
// overwrite this fixture's log; regression verification never touches ours.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pin-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'limits'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}');
  for (const file of ['bin/limits-pin.js', 'src/limits/pin.js']) {
    fs.copyFileSync(path.join(REPO, file), path.join(repo, file));
  }
  const shippedLog = path.join(repo, 'KNOWN-LIMITS.md');
  const original = '# Known Limits\n\nUnverified fixture; do not stamp this file.\n';
  fs.writeFileSync(shippedLog, original);
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture source']);
  const hash = git(['rev-parse', 'HEAD']);
  const alternate = path.join(root, 'scratch log.md');
  const run = (arg) => spawnSync(process.execPath, [path.join(repo, 'bin', 'limits-pin.js'), arg], {
    cwd: root, encoding: 'utf8', env: { ...process.env, LOTOR_LIMITS_FILE: alternate }
  });
  return { root, shippedLog, original, alternate, hash, run };
}

it('stamping a scratch log never writes the shipped log, even from another cwd', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.alternate, '# Scratch log\n');
  const stamped = f.run('--stamp');
  assert.equal(stamped.status, 0, stamped.stderr);
  assert.equal(fs.readFileSync(f.shippedLog, 'utf8'), f.original,
    'the tracked log must remain untouched; interrupted tests cannot leave a false pin');
  assert.ok(fs.readFileSync(f.alternate, 'utf8').includes(f.hash),
    'the scratch pin must resolve the CLI repository, not the caller cwd');
  assert.equal(f.run('--check').status, 0);
});

it('checking an alternate stale log reports its pinned commit and the real source commit', (t) => {
  const f = fixture(t);
  const foreign = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  fs.writeFileSync(f.alternate, `<!-- known-limits:pin v1\n This file describes commit ${foreign}\nknown-limits:pin end -->\n\n# Scratch log\n`);
  const checked = f.run('--check');
  assert.equal(checked.status, 1);
  assert.ok(checked.stdout.includes(foreign), checked.stdout);
  assert.ok(checked.stdout.includes(f.hash), checked.stdout);
  assert.equal(fs.readFileSync(f.shippedLog, 'utf8'), f.original);
});

it('a missing explicitly selected log is an error, never a fallback to the shipped log', (t) => {
  const f = fixture(t);
  const checked = f.run('--check');
  assert.equal(checked.status, 2);
  assert.ok(checked.stderr.includes(f.alternate), checked.stderr);
  assert.equal(fs.readFileSync(f.shippedLog, 'utf8'), f.original);
});
