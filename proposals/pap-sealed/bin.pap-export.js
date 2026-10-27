#!/usr/bin/env node
/**
 * pap-export: encode a spine into a signed QR bundle.
 *
 * Usage:
 *   node bin/pap-export.js --spine <path.txt> [options] --public
 *
 * Options:
 *   --spine <path>            the spine text file to encode (required)
 *   --memoir-url <url>        optional memoir pointer baked into the manifest
 *   --out <basepath>          output basepath (default <spine-file>.pap)
 *   --public                  REQUIRED acknowledgment (see below)
 *
 * Sealed mode (manifest v2, docs/PAP-SEALED.md):
 *   --seal                    encrypt the spine; only the recipients can read it
 *   --to <key>                X25519 recipient public key: 64 hex chars or a
 *                             path to a .pub / SPKI PEM file. Repeat per recipient.
 *   --passphrase-env <VAR>    also seal to the passphrase held in env var VAR
 *
 * Chain-state overrides (default: read live from the Lotor home):
 *   --key <path.pem>          Ed25519 private key (default: the chain key)
 *   --chain-head <hex64>      chain head hash (default: current head)
 *   --chain-pubkey-fp <hex64> raw pubkey fingerprint (default: chain pubkey)
 *   --seq <n>                 chain seq (default: current head seq)
 *   --timestamp <ms>          epoch ms (default: now)
 *
 * By default this tool reads the operator's live chain state: the head
 * hash, seq, and signing key come from the Lotor home (LOTOR_HOME or
 * ~/.lotor). The override flags exist so tests can run against synthetic
 * keys without touching a real chain, the same seam the prototype proved.
 *
 * The --public flag is required and unlocks nothing except the operator's
 * acknowledgment that everything about to be encoded is going onto a
 * medium anyone can scan. See KNOWN-LIMITS 45. The signature ties the bundle
 * to the key fingerprint it carries; it does not make the bundle safe to
 * distribute, and it names the author only to a reader who compares that
 * fingerprint with one they trust. Sealed
 * mode still needs --public: the ciphertext, the recipient count, the
 * signer, the chain head, the seq and the timestamp stay readable by anyone.
 *
 * Signing uses the CHAIN key, not the approval key (KNOWN-LIMITS 48):
 * bundle authenticity is chain-key strength, and the chain key is stored
 * plaintext at rest (limit 8). "Cannot be forged" means "cannot be forged
 * without the chain key file", and anyone who can read that file can sign
 * bundles in your name.
 *
 * Emits <basepath>.png, <basepath>.svg, and <basepath>.bin.
 *
 * Ported from projects/spinoff/pap-prototype/cli/pap-export.js
 * (WO-PAP-01) with the chain-state wiring the proposal's D1 specified.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pack } from '../src/publish/pack.js';
import { bundleToPng, bundleToSvg } from '../src/publish/qr.js';
import { resolveHome } from '../src/home.js';
import { loadChain, loadOrCreateKeyPair } from '../src/store/index.js';

const USAGE = [
  'usage: node bin/pap-export.js --spine <path.txt> --public [options]',
  '',
  '  --spine <path>            spine text file to encode (required)',
  '  --public                  acknowledge a QR is a broadcast medium (required)',
  '  --memoir-url <url>        optional memoir pointer',
  '  --out <basepath>          output basepath (default <spine-file>.pap)',
  '',
  'sealed mode (only the recipients can read the spine):',
  '  --seal                    encrypt, then sign',
  '  --to <hex64|file>         X25519 recipient public key; repeat per recipient',
  '                            (make one with: node bin/pap-keygen.js --out <base>)',
  '  --passphrase-env <VAR>    also seal to the passphrase in env var VAR',
  '',
  'chain-state overrides: --key <pem> --chain-head <hex64> --chain-pubkey-fp <hex64>',
  '                       --seq <n> --timestamp <ms>',
  '',
  'What a bundle proves, and what it does not:',
  '  Anyone can check that the bundle is untouched and verifies under the key',
  '  fingerprint it carries. That names you only to a reader who compares the',
  '  fingerprint with one they already trust, and only while the chain key is',
  '  secret. The chain key is stored unencrypted on this machine (KNOWN-LIMITS 8, 48):',
  '  anyone who can read the key file can sign bundles in your name.',
  '  A signature proves custody, never that the spine is correct (KNOWN-LIMITS 46).',
  '  Sealed mode hides the spine, not the fact of the bundle: the ciphertext,',
  '  recipient count, signer, chain head, seq and time are public (KNOWN-LIMITS 45).',
].join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(0);
  }

  if (!args.public) {
    die(
      'refusing to encode without --public.\n' +
      'A QR is a broadcast medium. Anyone who scans this will read the spine.\n' +
      (args.seal
        ? 'Sealed, they cannot read the spine, but they can read the ciphertext, the\n' +
          'recipient count, the signer, the chain head, the seq and the timestamp.\n'
        : '') +
      'Add --public to acknowledge and proceed.',
    );
  }
  if (!args.spine) die('missing --spine <path>');

  let seal;
  if (args.seal) {
    const to = args.to.map(readRecipientKey);
    let passphrase;
    if (args.passphraseEnv) {
      passphrase = process.env[args.passphraseEnv];
      if (!passphrase) die(`--passphrase-env ${args.passphraseEnv}: that environment variable is empty or unset`);
    }
    if (to.length === 0 && passphrase === undefined) {
      die('--seal needs at least one --to <recipient key> or --passphrase-env <VAR>');
    }
    seal = { to, passphrase };
  } else if (args.to.length > 0 || args.passphraseEnv) {
    die('--to and --passphrase-env only make sense with --seal');
  }

  const spine = fs.readFileSync(args.spine, 'utf8');

  // Chain-state defaults: read the live Lotor home unless every field is
  // overridden. Tests override all four; operators override none.
  let chainHeadHash, chainPubkeyFp, seq, signingKey;
  const needChain = !args.chainHead || !args.chainPubkeyFp || args.seq === undefined || !args.key;
  if (needChain) {
    const home = resolveHome();
    const entries = loadChain(home);
    if (entries.length === 0) {
      die(
        `no chain found at ${home} and no explicit chain-state flags given.\n` +
        'A PAP bundle binds a spine to a receipt chain. Run Lotor first, or\n' +
        'pass --chain-head, --chain-pubkey-fp, --seq, and --key explicitly.',
      );
    }
    const head = entries[entries.length - 1];
    const keyPair = loadOrCreateKeyPair(home);
    const pubKeyObj = crypto.createPublicKey(keyPair.publicKey);
    const pubRaw = pubKeyObj.export({ format: 'der', type: 'spki' }).subarray(-32);

    chainHeadHash = args.chainHead ? hex32(args.chainHead, '--chain-head') : Buffer.from(head.hash, 'hex');
    chainPubkeyFp = args.chainPubkeyFp ? hex32(args.chainPubkeyFp, '--chain-pubkey-fp') : pubRaw;
    seq = args.seq !== undefined ? Number(args.seq) : head.seq;
    signingKey = args.key
      ? crypto.createPrivateKey({ key: fs.readFileSync(args.key), format: 'pem' })
      : crypto.createPrivateKey(keyPair.privateKey);
  } else {
    chainHeadHash = hex32(args.chainHead, '--chain-head');
    chainPubkeyFp = hex32(args.chainPubkeyFp, '--chain-pubkey-fp');
    seq = Number(args.seq);
    signingKey = crypto.createPrivateKey({ key: fs.readFileSync(args.key), format: 'pem' });
  }

  const timestamp = Number(args.timestamp || Date.now());

  const result = pack({
    spine,
    chainHeadHash,
    chainPubkeyFp,
    seq,
    timestamp,
    memoirUrl: args.memoirUrl || '',
    signingKey,
    seal,
  });

  const basepath = args.out || path.resolve(args.spine + '.pap');
  const [png, svg] = await Promise.all([
    bundleToPng(result.bundle),
    bundleToSvg(result.bundle),
  ]);
  fs.writeFileSync(basepath + '.png', png);
  fs.writeFileSync(basepath + '.svg', svg);
  fs.writeFileSync(basepath + '.bin', result.bundle);

  const sealedLines = result.sealed
    ? `  sealed to ${result.recipients.x25519} recipient key(s)${result.recipients.passphrase ? ' + a passphrase' : ''}` +
      ` (sealing cost ${result.sealOverhead} B)\n`
    : '';
  console.log(
    `pap-export ok\n` +
    `  spine raw ${result.spineRawLen} B\n` +
    `  compressed ${result.spineCompressedLen} B (${result.compressionRatio.toFixed(2)}x)\n` +
    sealedLines +
    `  bundle ${result.totalLen} B / budget ${result.budget} B (headroom ${result.headroom} B)\n` +
    `  chain seq ${seq}\n` +
    `  wrote ${basepath}.png\n` +
    `  wrote ${basepath}.svg\n` +
    `  wrote ${basepath}.bin`,
  );
}

function parseArgs(argv) {
  const out = { public: false, seal: false, to: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--public': out.public = true; break;
      case '--spine': out.spine = argv[++i]; break;
      case '--key': out.key = argv[++i]; break;
      case '--chain-head': out.chainHead = argv[++i]; break;
      case '--chain-pubkey-fp': out.chainPubkeyFp = argv[++i]; break;
      case '--seq': out.seq = argv[++i]; break;
      case '--memoir-url': out.memoirUrl = argv[++i]; break;
      case '--timestamp': out.timestamp = argv[++i]; break;
      case '--out': out.out = argv[++i]; break;
      case '--seal': out.seal = true; break;
      case '--to': out.to.push(argv[++i]); break;
      case '--passphrase-env': out.passphraseEnv = argv[++i]; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (!a.startsWith('-')) break;
        die(`unknown flag: ${a}`);
    }
  }
  return out;
}

// A recipient key on the command line is either 64 hex chars or a file
// holding hex (a .pub from pap-keygen) or an SPKI PEM. pack() validates it.
function readRecipientKey(s) {
  if (typeof s !== 'string' || s.length === 0) die('--to needs a key or a key file');
  if (/^[0-9a-f]{64}$/i.test(s)) return s;
  if (!fs.existsSync(s)) die(`--to ${s}: not 64 hex characters and not a readable file`);
  return fs.readFileSync(s, 'utf8').trim();
}

function hex32(s, name) {
  if (typeof s !== 'string' || !/^[0-9a-f]{64}$/i.test(s)) {
    die(`${name} must be 64 hex characters (32 bytes); got ${s}`);
  }
  return Buffer.from(s, 'hex');
}

function die(msg) {
  process.stderr.write('pap-export: ' + msg + '\n');
  process.exit(2);
}

main().catch((err) => {
  if (err && err.code === 'PAP_BUDGET_EXCEEDED') {
    process.stderr.write('pap-export: ' + err.message + '\n');
    process.exit(3);
  }
  if (err && (err.code === 'PAP_BAD_KEY' || err.code === 'PAP_SPINE_TOO_LARGE' || err.code === 'PAP_KDF_TOO_WEAK')) {
    process.stderr.write('pap-export: ' + err.message + '\n');
    process.exit(2);
  }
  process.stderr.write('pap-export: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
