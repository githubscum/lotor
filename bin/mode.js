#!/usr/bin/env node
/**
 * bin/mode.js
 *
 * Switch or display Lotor's herding-policy mode: herded | grazing | loose.
 *
 * usage:
 *   node bin/mode.js              print the current mode and its expansion
 *   node bin/mode.js <name>       switch to a named preset (requires the
 *                                 owner's approval passphrase at a real TTY)
 *
 * A mode switch rewrites policy.json wholesale to the named preset's
 * expansion (src/policy/index.js expandMode()). It is not a diff onto
 * whatever was there before.
 *
 * WHY THE PASSPHRASE
 *   The switch reuses the same approval-key derivation bin/approve.js uses
 *   to sign a gated action, and for the same reason: a headless model
 *   process has no TTY, so the check fails shut, not open. Changing the
 *   posture that decides what everything else requires should cost at
 *   least as much as approving one gated action, not less.
 *
 *   Belt and braces: the `mode-change` policy rule (src/policy/index.js)
 *   additionally gates any command that invokes this file through a shell,
 *   in every preset including Loose. So even a model attempting to run this
 *   non-interactively is stopped at the PreToolUse hook before this file's
 *   own TTY check would ever run.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveHome } from '../src/home.js';
import { loadPolicy, MODE_NAMES, expandMode, RULE_INFO } from '../src/policy/index.js';
import { loadApprovalPubkey, SALT, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST } from '../src/gate/sign.js';
import { colour, dim } from '../src/term/colour.js';

// Group labels for the consequence-grouped mode printout. Same three keys
// as the policy states themselves so a printout in a new state (e.g. a
// future 'custom-off' variant) would fail loudly here rather than silently
// omit rules from the display.
const GROUP_LABELS = { gate: 'STOPS YOU', warn: 'RECORDS YOU', off: 'ASLEEP' };

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Read one line of raw-mode, non-echoed TTY input. Duplicated from
 * src/gate/sign.js's promptPassphrase/readLineSilent rather than importing
 * them, because that file lives under the self-mod-protected src/gate/
 * directory and this command does not need to touch it: only the
 * already-exported key-derivation constants and loadApprovalPubkey are needed.
 */
function readLineSilent() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (c === '\n' || c === '\r' || c === '') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write('\n');
        resolve(input);
      } else if (c === '') {
        process.exit(1);
      } else if (c === '') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else {
        input += c;
        process.stderr.write('*');
      }
    });
  });
}

/**
 * Verify the owner's passphrase against the stored approval public key.
 * Never writes anything; a mismatch or missing TTY exits the process.
 *
 * Order matters here: the key-existence check runs BEFORE the TTY check.
 * Both a missing key and a missing TTY are non-interactive failures (no
 * prompt is shown either way), so there is no interactivity cost to
 * checking the more specific, more actionable problem first. A piped
 * invocation with no key set up gets pointed at `npm run setup`, not a
 * generic "not a TTY" — the two failures are otherwise indistinguishable
 * from the caller's side, which is exactly what makes each one testable
 * in isolation.
 */
async function verifyOwnerPassphrase(home) {
  let pub;
  try {
    pub = loadApprovalPubkey(home);
  } catch (e) {
    console.error(`error: ${e.message}`);
    console.error('run `npm run setup` first to set your approval passphrase.');
    process.exit(2);
  }

  if (!process.stdin.isTTY) {
    console.error('error: not a TTY. mode switch must be run from a terminal, not a piped process.');
    process.exit(2);
  }

  process.stderr.write('passphrase: ');
  const passphrase = await readLineSilent();
  const seed = crypto.pbkdf2Sync(passphrase, SALT, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);

  const jwkPriv = { crv: 'Ed25519', d: base64url(seed), x: pub.b64, kty: 'OKP' };
  const privKeyObj = crypto.createPrivateKey({ key: jwkPriv, format: 'jwk' });
  const derivedPub = crypto.createPublicKey(privKeyObj).export({ format: 'jwk', type: 'public' });

  if (derivedPub.x !== pub.b64) {
    console.error('error: passphrase does not match the stored approval key.');
    process.exit(3);
  }
}

/**
 * Print the mode grouped by consequence rather than sorted alphabetically.
 * The invariant that matters to a fresh reader is what each rule DOES to
 * them (stops, records, sleeps), so that is the primary axis; the rule id
 * is the technical anchor and sits dim on the right. Closes with a
 * computed summary line so an eleventh rule added later shows up in the
 * arithmetic without anyone remembering to update a hardcoded count.
 */
function printMode(home) {
  const policy = loadPolicy(home);
  const modes = policy.modes;
  const ids = Object.keys(modes);

  const grouped = {
    gate: ids.filter(id => modes[id] === 'gate'),
    warn: ids.filter(id => modes[id] === 'warn'),
    off:  ids.filter(id => modes[id] === 'off'),
  };

  console.log('');
  console.log(`  mode: ${colour('ok', policy.mode)}`);
  console.log('');

  for (const state of ['gate', 'warn', 'off']) {
    if (grouped[state].length === 0) continue;
    console.log('  ' + colour(state, GROUP_LABELS[state]));
    for (const id of grouped[state]) {
      const title = RULE_INFO[id]?.title || id;
      const line = '    ' + colour(state, '│') + '  ' + title.padEnd(34) + dim(id);
      console.log(line);
    }
    console.log('');
  }

  const total = ids.length;
  const g = grouped.gate.length;
  const w = grouped.warn.length;
  const o = grouped.off.length;
  const parts = [`${total} rules.`];
  if (g > 0) parts.push(`${g} ${g === 1 ? 'stops' : 'stop'} you.`);
  if (w > 0) parts.push(`${w} ${w === 1 ? 'records' : 'record'} you.`);
  if (o > 0) parts.push(`${o} ${o === 1 ? 'is' : 'are'} asleep.`);
  console.log('  ' + parts.join(' '));
  console.log('');
}

async function main() {
  const home = resolveHome();
  const requested = process.argv[2];

  if (!requested) {
    printMode(home);
    return;
  }

  const modeName = requested.toLowerCase();
  if (!MODE_NAMES.includes(modeName)) {
    console.error(`error: unknown mode '${requested}'. Choose one of: ${MODE_NAMES.join(', ')}`);
    process.exit(2);
  }

  await verifyOwnerPassphrase(home);

  const nextPolicy = { version: 2, mode: modeName, modes: expandMode(modeName) };
  fs.writeFileSync(
    path.join(home, 'policy.json'),
    JSON.stringify(nextPolicy, null, 2) + '\n',
    { mode: 0o644 }
  );

  console.log(`mode set to ${modeName}.`);
  console.log('');
  printMode(home);
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
