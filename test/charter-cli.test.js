/**
 * test/charter-cli.test.js
 *
 * The charter issuer, exercised as a real child process.
 *
 * WHY A CHILD PROCESS AND NOT AN IMPORT
 *   `bin/charter.js` calls `main()` unconditionally at module scope, like every
 *   other bin script here. Importing it would run the CLI inside the test
 *   runner and call `process.exit`, which kills the runner rather than failing a
 *   test. Spawning is also the honest shape: this is a thing the owner types.
 *
 * WHAT IS AND IS NOT COVERED
 *   Everything up to the passphrase prompt. The signing path itself cannot be
 *   tested here and should not be: it requires a TTY and the owner's passphrase
 *   by design, and a test that could sign would mean the process could sign,
 *   which is the property the whole architecture refuses. So these tests assert
 *   the behaviour AROUND the boundary — that the refusal happens before the
 *   prompt, that the dry run never reaches it, and that what gets printed is
 *   what would be signed.
 *
 * THE ONE THAT MATTERS MOST
 *   `refuses a plan naming a core path, before any prompt`. This tool must never
 *   ask the owner to type a passphrase for something that was going to be
 *   rejected anyway, and it must never issue a charter over the gate's own
 *   source. It is belt and braces — the gate has to check independently, since
 *   someone writing a charter file by hand never runs this code — but the belt
 *   should still hold.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'bin', 'charter.js');

function run(args, { home } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, LOTOR_HOME: home || process.env.LOTOR_HOME },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

let tmp;
function planFile(name, plan) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-charter-cli-')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

describe('charter CLI: it parses and runs at all', () => {
  it('prints help and exits 0', async () => {
    const r = await run(['--help']);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /issue --file/);
  });

  it('says plainly that nothing consults charters yet', async () => {
    // The claim this tool must not let anyone form is that signing a charter
    // authorizes something. It does not, until the gate consumes them.
    const r = await run(['--help']);
    assert.match(r.stdout, /not an authorization/i);
  });

  it('rejects an unknown command rather than doing something surprising', async () => {
    const r = await run(['frobnicate']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown command/);
  });
});

describe('charter CLI: bad input is refused, not guessed at', () => {
  it('needs a file', async () => {
    const r = await run(['issue']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--file/);
  });

  it('reports a missing plan file by name', async () => {
    const r = await run(['issue', '--file', path.join(tmp, 'nope.json')]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /cannot read plan file/);
  });

  it('reports invalid JSON as invalid JSON', async () => {
    const p = path.join(tmp, 'bad.json');
    fs.writeFileSync(p, '{ not json');
    const r = await run(['issue', '--file', p]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not valid JSON/);
  });

  it('refuses an empty enumeration', async () => {
    const p = planFile('empty.json', { id: 'c-empty', items: [] });
    const r = await run(['issue', '--file', p]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /non-empty "items"/);
  });
});

describe('charter CLI: the core refusal, which is the important one', () => {
  const CORE_PLANS = [
    ['gate', 'src/gate/index.js'],
    ['policy', 'src/policy/index.js'],
    ['chain', 'src/chain/index.js'],
    ['charter itself', 'src/charter/index.js'],
    ['a hook', 'bin/hook-pre-tool-use.js'],
    ['the issuer itself', 'bin/charter.js'],
    ['the execution manifest', 'package' + '.json']
  ];

  for (const [label, target] of CORE_PLANS) {
    it(`refuses a plan naming ${label}, before any prompt`, async () => {
      const p = planFile(`core-${label.replace(/\W+/g, '-')}.json`, {
        id: 'c-core-attempt',
        title: 'should never issue',
        items: [{ action: 'Edit', params: { file_path: target } }]
      });
      const r = await run(['issue', '--file', p]);
      assert.equal(r.code, 4, `expected the core-refusal exit code; stderr: ${r.stderr}`);
      assert.match(r.stderr, /REFUSED/);
      assert.ok(r.stderr.includes(target), 'the refusal must name the offending path');
    });
  }

  it('refuses even in dry-run, so the refusal cannot be previewed away', async () => {
    const p = planFile('core-dry.json', {
      id: 'c-core-dry',
      items: [{ action: 'Edit', params: { file_path: 'src/gate/index.js' } }]
    });
    const r = await run(['issue', '--file', p, '--dry-run']);
    assert.equal(r.code, 4);
  });
});

describe('charter CLI: dry run shows what would be signed and signs nothing', () => {
  const plan = {
    id: 'c-dry-001',
    title: 'a plan that touches only ordinary files',
    source: 'PDLC.md',
    items: [
      { action: 'Edit', params: { file_path: 'test/example.test.js' } },
      { action: 'Edit', params: { file_path: 'README.md' } }
    ]
  };

  it('prints the enumeration, the hash, and an explicit NOT signed', async () => {
    const p = planFile('dry.json', plan);
    const r = await run(['issue', '--file', p, '--dry-run']);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /c-dry-001/);
    assert.match(r.stdout, /enumeration\s+[0-9a-f]{8,}/);
    assert.match(r.stdout, /signed\s+NO/);
    assert.match(r.stdout, /AUTHORIZES EXACTLY THESE/);
    assert.ok(r.stdout.includes('test/example.test.js'), 'every item is shown');
    assert.ok(r.stdout.includes('README.md'), 'every item is shown');
  });

  it('writes nothing to disk', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-charter-home-'));
    try {
      const p = planFile('dry2.json', plan);
      await run(['issue', '--file', p, '--dry-run'], { home });
      assert.equal(fs.existsSync(path.join(home, 'charters')), false,
        'a dry run must not create the charters directory');
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  });

  it('the same enumeration hashes the same way twice', async () => {
    // The hash is what the signature covers. If it moved between two identical
    // runs, a signature could not mean anything.
    const p = planFile('dry3.json', plan);
    const a = await run(['issue', '--file', p, '--dry-run']);
    const b = await run(['issue', '--file', p, '--dry-run']);
    const hash = s => (s.match(/enumeration\s+([0-9a-f]+)/) || [])[1];
    assert.ok(hash(a.stdout), 'a hash was printed');
    assert.equal(hash(a.stdout), hash(b.stdout));
  });

  it('adding an item changes the hash, which is the whole security property', async () => {
    const p1 = planFile('h1.json', plan);
    const p2 = planFile('h2.json', {
      ...plan,
      items: [...plan.items, { action: 'Edit', params: { file_path: 'test/extra.test.js' } }]
    });
    const a = await run(['issue', '--file', p1, '--dry-run']);
    const b = await run(['issue', '--file', p2, '--dry-run']);
    const hash = s => (s.match(/enumeration\s+([0-9a-f]+)/) || [])[1];
    assert.notEqual(hash(a.stdout), hash(b.stdout),
      'an added work order must fall outside the signed enumeration');
  });
});

describe('charter CLI: listing an empty store', () => {
  it('says none rather than failing', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-charter-empty-'));
    try {
      const r = await run(['list'], { home });
      assert.equal(r.code, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /none/);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  });
});
