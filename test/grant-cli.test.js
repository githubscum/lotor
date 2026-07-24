/**
 * test/grant-cli.test.js
 *
 * The grant CLI's ENTRYPOINT, not its exports.
 *
 * WHY THIS FILE EXISTS
 *   `npm run grant` was dead on Windows and every test passed anyway. The
 *   entrypoint guard compared fileURLToPath(import.meta.url), which returns
 *   backslashes on Windows, against argv[1] with backslashes rewritten to
 *   forward slashes. Never equal, so main() never ran: the command exited 0
 *   and printed nothing.
 *
 *   Nothing caught it because every other test imports the module's
 *   exported functions. A suite can be entirely green while the thing a
 *   human actually types does nothing at all. Exercising a module's exports
 *   is not exercising the program.
 *
 *   These tests spawn the CLI as a subprocess, the way a person runs it,
 *   against a temporary LOTOR_HOME so they never read or write real state.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderRequest, loadStagedRequest, resolveRequests, BuildGrantError } from '../src/grant/issue.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO_ROOT, 'src', 'grant', 'issue.js');

let home;

function stage(id, request) {
  const dir = path.join(home, 'pending-approvals', 'requests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(request, null, 2));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args, '--lotor-home', home], {
    encoding: 'utf8',
    cwd: REPO_ROOT
  });
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-grant-cli-'));
  const kp = crypto.generateKeyPairSync('ed25519');
  const jwk = kp.publicKey.export({ format: 'jwk' });
  const fp = crypto.createHash('sha256').update(jwk.x).digest('hex').slice(0, 32);
  fs.mkdirSync(path.join(home, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(home, 'keys', 'approval.pub'), `ed25519:${jwk.x}:fingerprint:${fp}\n`);
  stage('aaaa1111', { action: 'Edit', params: { file_path: 'src/mcp/server.js' } });
  stage('bbbb2222', { action: 'Bash', params: { command: 'git push -u origin feat/x' } });
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('the grant CLI entrypoint actually runs', () => {
  it('prints usage for --help and exits 0', () => {
    const r = runCli(['--help']);
    assert.strictEqual(r.status, 0, `--help should exit 0, got ${r.status}`);
    assert.match(r.stdout, /usage:/i, 'help output must reach stdout');
    assert.match(r.stdout, /--session/);
    assert.match(r.stdout, /--requests/);
    assert.match(r.stdout, /--all-pending/);
  });

  it('tells the reader the command they actually type', () => {
    // The usage block once named a path the file no longer lived at, which
    // is the kind of thing only a human running the command discovers.
    const r = runCli(['--help']);
    assert.match(r.stdout, /npm run grant/, 'usage must name the real invocation');
  });

  it('still runs when invoked by a relative path from the repo root', () => {
    // argv[1] arrives relative here, so the guard has to resolve before
    // comparing. This is the exact shape `npm run grant` produces.
    const r = spawnSync(process.execPath, ['src/grant/issue.js', '--help'], {
      encoding: 'utf8',
      cwd: REPO_ROOT
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /usage:/i, 'relative invocation must still reach main()');
  });
});

describe('it refuses bad input instead of silently doing nothing', () => {
  // A CLI that exits 0 on garbage is indistinguishable from the dead
  // entrypoint this file exists to prevent. Non-zero on refusal is what
  // makes "it did nothing" and "it declined" tell themselves apart.

  const base = ['--session', 's1', '--all-pending', '--max-actions', '5', '--expires-in-ms', '60000'];
  const without = (flag) => {
    const i = base.indexOf(flag);
    return [...base.slice(0, i), ...base.slice(i + 2)];
  };
  const withValue = (flag, v) => {
    const out = [...base];
    out[out.indexOf(flag) + 1] = v;
    return out;
  };

  it('exits non-zero when --session is missing', () => {
    const r = runCli(without('--session'));
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /--session/);
  });

  it('exits non-zero when neither --requests nor --all-pending is given', () => {
    const r = runCli(without('--all-pending').concat([]));
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /--requests|--all-pending/);
  });

  it('exits non-zero when --max-actions is not a positive integer', () => {
    const r = runCli(withValue('--max-actions', '0'));
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /max-actions/);
  });

  it('exits non-zero when --expires-in-ms is not positive', () => {
    const r = runCli(withValue('--expires-in-ms', '-5'));
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /expires-in-ms/);
  });

  it('exits non-zero on an unknown request id, naming where it looked', () => {
    const r = runCli(['--session', 's1', '--requests', 'deadbeef', '--max-actions', '2', '--expires-in-ms', '60000']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /deadbeef/);
  });

  it('validates arguments before demanding a key', () => {
    // Loading the approval key first meant every argument mistake on a
    // machine without a key reported "no approval public key" instead of
    // the actual problem.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-nokey-'));
    try {
      const r = spawnSync(process.execPath, [CLI, '--session', 's1', '--all-pending', '--max-actions', '0', '--expires-in-ms', '1', '--lotor-home', bare], { encoding: 'utf8', cwd: REPO_ROOT });
      assert.notStrictEqual(r.status, 0);
      assert.match(r.stderr, /max-actions/, 'the argument error must win over the missing key');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('staged requests are what a grant is built from', () => {
  it('loads a staged request by the id printed in a denial', () => {
    const { id, request } = loadStagedRequest(home, 'aaaa1111');
    assert.strictEqual(id, 'aaaa1111');
    assert.strictEqual(request.action, 'Edit');
  });

  it('rejects an id that is not an id, without touching the filesystem', () => {
    assert.throws(() => loadStagedRequest(home, '../../etc/passwd'), BuildGrantError);
  });

  it('--all-pending picks up everything staged', () => {
    const items = resolveRequests(home, { all: true, ids: [] });
    assert.strictEqual(items.length, 2);
  });

  it('deduplicates identical requests', () => {
    // Two staged ids can carry the same action request, e.g. the same
    // command denied twice. Counting it twice would silently consume two of
    // the ceiling for one distinct capability.
    stage('cccc3333', { action: 'Edit', params: { file_path: 'src/mcp/server.js' } });
    try {
      const items = resolveRequests(home, { all: true, ids: [] });
      assert.strictEqual(items.length, 2, 'the duplicate must collapse');
    } finally {
      fs.rmSync(path.join(home, 'pending-approvals', 'requests', 'cccc3333.json'), { force: true });
    }
  });
});

describe('what the signer is shown', () => {
  it('renders the full parameter value, never truncated', () => {
    // The entire security value of a grant rests on the owner reading this
    // before entering a passphrase. An elided command is an unread command.
    const long = 'git push -u origin feature/a-very-long-branch-name-that-would-be-tempting-to-shorten';
    const out = renderRequest({ id: 'x1', request: { action: 'Bash', params: { command: long } } }, 0);
    assert.ok(out.includes(long), 'the full command must appear');
    assert.ok(out.includes('x1'), 'the request id must appear');
    assert.ok(!out.includes('...'), 'nothing may be elided');
  });

  it('says so explicitly when a request has no parameters', () => {
    const out = renderRequest({ id: 'x2', request: { action: 'SomeTool', params: {} } }, 1);
    assert.match(out, /no parameters/);
  });
});
