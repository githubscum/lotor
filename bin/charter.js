#!/usr/bin/env node
/**
 * bin/charter.js
 *
 * Issue and sign a charter: one signature over a reviewed plan, instead of N
 * signatures over the commands that plan implies.
 *
 * WHY THIS EXISTS
 *   `src/charter` shipped 2026-07-26 with 33 passing tests and, it turned out,
 *   neither a producer nor a consumer. `loadCharters()` read a directory nothing
 *   wrote. There was no way for the owner to create a charter at all, which was
 *   discovered only when someone tried to ask them to sign one. This is the
 *   producer. The consumer (the gate consulting a charter in the deny path) is a
 *   separate, separately-reviewed step and is NOT built.
 *
 * THIS FILE'S OWN HISTORY IS THE ARGUMENT FOR PROTECTING IT
 *   The first attempt to create it succeeded with NO SIGNATURE, because the
 *   self-mod matcher gated `bin/` by exact filename and this name was not on the
 *   list. That was the hazard in its sharpest form: this file PRINTS A CHARTER
 *   FOR THE OWNER TO READ IMMEDIATELY BEFORE THEY TYPE THEIR PASSPHRASE.
 *   Editable unsigned, an agent could change what the owner READS without
 *   changing what they SIGN — a valid signature over an enumeration they were
 *   shown a doctored version of. The placeholder was deleted, the matcher was
 *   fixed, and only then was this written.
 *
 * THE TRUST BOUNDARY DOES NOT MOVE
 *   Signing uses the same passphrase-derived approval key as `bin/approve.js`,
 *   through the same TTY prompt in `src/gate/sign.js`. The private key is never
 *   on disk; it is derived at signing time. **The calling process never sees the
 *   passphrase, never sees the seed, and only ever receives the signature.**
 *   Nothing here reimplements that: the derivation lives in one module and is
 *   called from here, so there is no second copy to drift.
 *
 * READ BEFORE YOU SIGN
 *   `--dry-run` prints the charter and its enumeration hash and does NOT prompt
 *   for a passphrase. That is the posture this tool is built around: look at
 *   what is about to be authorized, then authorize it. A signature the owner did
 *   not read is the failure the whole gate exists to prevent (KNOWN-LIMITS 26),
 *   and a charter is broader than a token, so it deserves more caution rather
 *   than less. Even without --dry-run the charter is printed BEFORE the prompt,
 *   so the passphrase is typed against something just read rather than against a
 *   filename.
 *
 * WHAT A CHARTER DOES NOT COVER, EVER
 *   The non-delegable core. This tool refuses at issue time to enumerate an item
 *   whose path is core, so a charter naming one cannot be created here at all.
 *   That is belt and braces, not the control: the gate must check independently,
 *   because a check that lives only in the issuing tool is a check an attacker
 *   simply does not run.
 *
 * USAGE
 *   node bin/charter.js issue --file <plan.json> [--dry-run] [--out <path>]
 *   node bin/charter.js list
 *   node bin/charter.js show <id>
 *
 * PLAN FILE SHAPE
 *   { "id": "...", "title": "...", "source": "path/to/PDLC.md",
 *     "expiresAt": <ms epoch, optional>,
 *     "items": [ { "action": "Edit", "params": { "file_path": "..." } }, ... ] }
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildCharter, verifyCharter, loadCharters, charterSignBuffer } from '../src/charter/index.js';
import { signWithApprovalKey, loadApprovalPubkey } from '../src/gate/sign.js';
import { resolveHome } from '../src/home.js';
import { classifyPath } from '../src/grant/core-paths.js';

const PATH_PARAMS = ['file_path', 'path', 'notebook_path'];

function die(msg, code = 2) {
  process.stderr.write(`lotor charter: ${msg}\n`);
  process.exit(code);
}

function chartersDir(home) {
  return path.join(home, 'charters');
}

/**
 * Refuse at issue time to enumerate anything in the non-delegable core.
 *
 * Deliberately duplicated with the gate rather than trusted in place of it. This
 * catches an honest mistake early, with a readable message, at the moment the
 * owner is reading the plan. It is NOT the security control: someone who writes
 * a charter file by hand never runs this code, which is exactly why the gate has
 * to check for itself.
 */
function coreItems(items) {
  const bad = [];
  for (const item of items) {
    const params = (item && item.params) || {};
    for (const key of PATH_PARAMS) {
      const p = params[key];
      if (typeof p !== 'string' || p === '') continue;
      const verdict = classifyPath(p);
      if (verdict.verdict !== 'grantable') {
        bad.push({ param: key, value: p, reason: verdict.reason });
      }
    }
  }
  return bad;
}

function readPlan(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    die(`cannot read plan file '${file}': ${e.message}`);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (e) {
    die(`plan file is not valid JSON: ${e.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    die('plan file must be a JSON object');
  }
  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    die('plan file must carry a non-empty "items" array');
  }
  return plan;
}

function printCharter(charter, { signed }) {
  const w = s => process.stdout.write(s + '\n');
  w('');
  w(`CHARTER  ${charter.id}`);
  w('='.repeat(66));
  w(`  title           ${charter.title}`);
  w(`  source          ${charter.source || '(none)'}`);
  w(`  items           ${charter.itemCount}`);
  w(`  enumeration     ${charter.enumerationHash}`);
  w(`  expires         ${charter.expiresAt ? new Date(charter.expiresAt).toLocaleString() : 'never (completion only)'}`);
  w(`  signed          ${signed ? 'YES' : 'NO'}`);
  w('');
  w('  AUTHORIZES EXACTLY THESE, AND NOTHING ELSE:');
  for (const [i, item] of charter.items.entries()) {
    const params = (item && item.params) || {};
    const detail = params.file_path || params.path || params.command || JSON.stringify(params);
    w(`    ${String(i + 1).padStart(3)}. ${String((item && item.action) || '?').padEnd(12)} ${String(detail).slice(0, 88)}`);
  }
  w('');
  w('  Adding an item changes the enumeration hash and falls outside this');
  w('  charter. The document may grow; this authorization cannot.');
  w('');
  w('  NOTE: nothing consults charters at the gate yet. Signing one today');
  w('  declares intent for the record; it does not authorize an action.');
  w('');
}

async function cmdIssue(rest) {
  const home = resolveHome();
  let file = null;
  let out = null;
  let dryRun = false;

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--file' && i + 1 < rest.length) { file = rest[++i]; }
    else if (rest[i] === '--out' && i + 1 < rest.length) { out = rest[++i]; }
    else if (rest[i] === '--dry-run') { dryRun = true; }
    else die(`unrecognised argument '${rest[i]}'`);
  }
  if (!file) die('issue needs --file <plan.json>');

  const plan = readPlan(file);

  // Refuse before anything else, and before any passphrase prompt. The owner
  // should never be asked to type a passphrase for something that was going to
  // be rejected anyway.
  const bad = coreItems(plan.items);
  if (bad.length > 0) {
    process.stderr.write('lotor charter: REFUSED — the plan names non-delegable core paths.\n\n');
    for (const b of bad) {
      process.stderr.write(`  ${b.value}\n      ${b.reason}\n`);
    }
    process.stderr.write(
      '\n  No charter may cover the gate, its policy, the chain, the store, the\n' +
      '  grant machinery, the charter machinery or the execution manifest.\n' +
      '  Editing what stops you costs one signature per action, forever. That\n' +
      '  is the product, not a limit to work around.\n\n'
    );
    process.exit(4);
  }

  let charter;
  try {
    charter = buildCharter({
      id: plan.id,
      title: plan.title,
      source: plan.source,
      items: plan.items,
      expiresAt: plan.expiresAt
    });
  } catch (e) {
    die(`cannot build charter: ${e.message}`);
  }

  // Printed BEFORE the prompt in both modes, so a passphrase is always typed
  // against something the owner has just read.
  printCharter(charter, { signed: false });

  if (dryRun) {
    process.stdout.write('  Dry run. Nothing signed, nothing written.\n');
    process.stdout.write('  Re-run without --dry-run to sign this exact enumeration.\n\n');
    return;
  }

  let signature;
  try {
    signature = await signWithApprovalKey(charterSignBuffer(charter), home);
  } catch (e) {
    die(`signing failed: ${e.message}`, 3);
  }

  const signed = { ...charter, signature };

  // Verify what was just produced rather than assuming the signature is good. A
  // charter that does not verify is worse than no charter: it looks like
  // authorization and is not.
  const pub = loadApprovalPubkey(home);
  const check = verifyCharter(signed, pub.b64);
  if (!check.ok) {
    die(`refusing to write a charter that does not verify: ${check.reason}`, 5);
  }

  const dir = chartersDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const target = out || path.join(dir, `${signed.id}.json`);
  fs.writeFileSync(target, JSON.stringify(signed, null, 2) + '\n', { mode: 0o600 });

  process.stdout.write(`  SIGNED and written to ${target}\n`);
  process.stdout.write('  Verified after writing.\n\n');
}

function cmdList() {
  const home = resolveHome();
  const charters = loadCharters(home);
  const w = s => process.stdout.write(s + '\n');

  w('');
  w(`CHARTERS   ${chartersDir(home)}`);
  w('='.repeat(66));
  if (!charters || charters.length === 0) {
    w('');
    w('  none. Issue one with:');
    w('    node bin/charter.js issue --file <plan.json> --dry-run');
    w('');
    return;
  }

  const pub = loadApprovalPubkey(home);
  w('');
  for (const c of charters) {
    const check = verifyCharter(c, pub.b64);
    const state = check.ok ? 'verified' : `INVALID (${check.reason})`;
    w(`  ${String(c.id).padEnd(28)} ${String(c.itemCount).padStart(3)} items   ${state}`);
    w(`    ${c.title}`);
  }
  w('');
  w('  "verified" means the signature and the enumeration hash both hold.');
  w('  It does NOT mean the gate consults it. Nothing does, yet.');
  w('');
}

function cmdShow(id) {
  const home = resolveHome();
  const found = (loadCharters(home) || []).find(c => c.id === id);
  if (!found) die(`no charter with id '${id}'`);
  const pub = loadApprovalPubkey(home);
  const check = verifyCharter(found, pub.b64);
  printCharter(found, { signed: !!found.signature });
  process.stdout.write(check.ok
    ? '  Signature and enumeration hash both verify.\n\n'
    : `  DOES NOT VERIFY: ${check.reason}\n\n`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(`charter.js — issue and sign a charter

usage:
  node bin/charter.js issue --file <plan.json> --dry-run
        build the charter and print exactly what it would authorize.
        Does NOT prompt for a passphrase and writes nothing. Do this first.

  node bin/charter.js issue --file <plan.json> [--out <path>]
        build it, print it, then prompt for the passphrase and sign.
        Written to <LOTOR_HOME>/charters/<id>.json unless --out says otherwise.

  node bin/charter.js list           every charter, with its verify state
  node bin/charter.js show <id>      one charter in full

Signing requires a TTY. Run it from a real terminal, not a piped process.
The private key is never stored; it is derived from your passphrase at
signing time and the calling process never sees either.

Nothing consults charters at the gate yet. A signed charter today is a
declared intention for the record, not an authorization.
`);
    return;
  }

  if (cmd === 'issue') return cmdIssue(rest);
  if (cmd === 'list') return cmdList();
  if (cmd === 'show') {
    if (!rest[0]) die('show needs a charter id');
    return cmdShow(rest[0]);
  }
  die(`unknown command '${cmd}'`);
}

main().catch(e => {
  process.stderr.write(`lotor charter: unexpected failure: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
});
