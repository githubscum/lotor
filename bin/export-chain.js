#!/usr/bin/env node
/**
 * bin/export-chain.js
 *
 * Portable receipt bundles: hand someone a file they can verify on a machine
 * that has never seen this install.
 *
 * WHY THIS EXISTS (KNOWN-LIMITS 9)
 *   The chain signing key is generated on first use and lives on one machine,
 *   so receipts written here do not verify anywhere else "unless you copy the
 *   chain public key across." That sentence described a possibility, not a
 *   workflow: nothing packaged the two halves together, and nothing verified a
 *   chain against a supplied key rather than the local one.
 *
 *   That gap matters more than it sounds, because the product's whole claim is
 *   that the operator holds a record they can show someone. A record you cannot
 *   hand over is a record only you can read, which is most of the way back to
 *   trusting the party being audited.
 *
 * WHAT IS AND IS NOT IN A BUNDLE
 *   In:  the chain public key (PEM) and every chain entry.
 *   Out: the PRIVATE key, always. `keys/chain.key` is never read by this file.
 *
 *   A bundle is therefore safe to send. It proves the chain has not been
 *   altered since signing; it does not let the recipient forge entries.
 *
 * WHAT A CLEAN VERIFY DOES NOT PROVE
 *   Read `verify` as "what is here has not been altered", never as "this is
 *   everything that happened". Tail-truncation still passes (limit 22), capture
 *   is still self-attested (limit 1), and a bundle inherits both. The output
 *   says so rather than printing a bare tick.
 *
 * USAGE
 *   node bin/export-chain.js export [--out <file>]
 *   node bin/export-chain.js verify <file>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyChain } from '../src/chain/index.js';
import { resolveHome } from '../src/home.js';

const BUNDLE_FORMAT = 'lotor-bundle/1';

function die(msg) {
  process.stderr.write(`lotor export-chain: ${msg}\n`);
  process.exit(1);
}

function readChain(home) {
  const chainFile = path.join(home, 'receipts', 'chain.jsonl');
  if (!fs.existsSync(chainFile)) die(`no chain at ${chainFile}`);
  return fs.readFileSync(chainFile, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try { return JSON.parse(l); }
      catch (e) { die(`chain line ${i + 1} is not valid JSON`); }
    });
}

function doExport(outArg) {
  const home = resolveHome();
  const pubFile = path.join(home, 'keys', 'chain.pub');
  if (!fs.existsSync(pubFile)) die(`no chain public key at ${pubFile}`);

  const entries = readChain(home);
  const bundle = {
    format: BUNDLE_FORMAT,
    exportedAt: Date.now(),
    // PEM, already mode 0644 on disk. The private half is never touched.
    publicKey: fs.readFileSync(pubFile, 'utf-8'),
    entryCount: entries.length,
    entries
  };

  const out = outArg || path.join(process.cwd(), `lotor-bundle-${entries.length}.json`);
  fs.writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o644 });

  process.stdout.write(`exported ${entries.length} entries to ${out}\n`);
  process.stdout.write(`public key included; private key was not read\n`);
  process.stdout.write(`verify elsewhere with: node bin/export-chain.js verify ${path.basename(out)}\n`);
}

function doVerify(file) {
  if (!file) die('verify needs a bundle path');
  if (!fs.existsSync(file)) die(`no such file: ${file}`);

  let bundle;
  try { bundle = JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { die(`not valid JSON: ${e.message}`); }

  if (bundle.format !== BUNDLE_FORMAT) {
    die(`unknown bundle format ${JSON.stringify(bundle.format)}, expected ${BUNDLE_FORMAT}`);
  }
  if (!bundle.publicKey || !Array.isArray(bundle.entries)) {
    die('bundle is missing publicKey or entries');
  }

  // Verify against the key IN THE BUNDLE, never the local one. That is the
  // whole point: this must work on a machine with no Lotor install and no keys.
  let pub;
  try { pub = crypto.createPublicKey(bundle.publicKey); }
  catch (e) { die(`bundle public key is unreadable: ${e.message}`); }

  // verifyChain returns { ok, brokenAt, reason } — NOT { valid, seq }. The
  // first version of this file checked `result.valid`, which is always
  // undefined, so a perfectly good 564-entry chain reported INVALID. Caught by
  // running it; a verifier that cries wolf is worse than none, because the one
  // time it matters nobody believes it.
  const result = verifyChain(bundle.entries, pub);

  if (result.ok) {
    process.stdout.write(`VALID  ${bundle.entries.length} entries, hashes and signatures check out\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`This proves what is here has not been altered since signing.\n`);
    process.stdout.write(`It does NOT prove this is everything that happened: entries removed\n`);
    process.stdout.write(`from the END of a chain leave a valid prefix (KNOWN-LIMITS 22), and\n`);
    process.stdout.write(`capture was self-attested in the first place (KNOWN-LIMITS 1).\n`);
    process.exit(0);
  }

  process.stdout.write(`INVALID  ${result.reason || 'chain did not verify'}\n`);
  if (result.brokenAt !== undefined) {
    process.stdout.write(`  first bad entry: index ${result.brokenAt}\n`);
  }
  process.exit(2);
}

const [, , cmd, ...rest] = process.argv;

if (cmd === 'export') {
  const i = rest.indexOf('--out');
  doExport(i >= 0 ? rest[i + 1] : null);
} else if (cmd === 'verify') {
  doVerify(rest[0]);
} else {
  process.stderr.write(
    'usage:\n' +
    '  node bin/export-chain.js export [--out <file>]\n' +
    '  node bin/export-chain.js verify <file>\n'
  );
  process.exit(1);
}
