#!/usr/bin/env node
/**
 * pap-boot — decode a signed bundle back into a spine.
 *
 * Usage:
 *   node bin/pap-boot.js --bundle <path.bin> [--verify-key <path.pem>]
 *   node bin/pap-boot.js --bundle <path.bin> --recipient-key <path|hex>
 *   node bin/pap-boot.js --bundle <path.bin> --passphrase-env <VAR>
 *   node bin/pap-boot.js --bundle <path.bin> --content-key <hex64>
 *
 * Reads bundle bytes from --bundle (or stdin if the path is `-`),
 * verifies the signature (against --verify-key if supplied, otherwise
 * against the pubkey embedded in the manifest), decompresses the spine,
 * and writes it to stdout.
 *
 * A sealed (v2) bundle verifies without a key: with no key flag, pap-boot
 * prints "verified, sealed to N" and exits 5 with nothing on stdout. A
 * recipient key, the passphrase, or the revealed content key opens it.
 * --print-content-key writes the content key to stderr after opening, so a
 * recipient can reveal the bundle to everyone later; the bundle's public key
 * commitment lets anyone check that a revealed key is the right one.
 *
 * Exit codes:
 *   0 on success
 *   1 on I/O error or unexpected failure
 *   2 on bad arguments
 *   4 on signature verification failure (limit of the record itself)
 *   5 sealed bundle verified, but no key given to open it
 *   6 sealed bundle verified, but the key does not open it
 *   7 sealed bundle failed its key commitment, decrypt or inner binding check
 *
 * A separate decoder-from-image tool is out of scope for v1 (see
 * src/publish/qr.js). The boot spec (BOOT-SPEC.md in the WO-PAP-01
 * prototype directory) describes the byte-mode read a reader must do to
 * get from a QR image to the bundle bytes this command consumes.
 *
 * Verification note (KNOWN-LIMITS 46): a verified signature proves the
 * decoded bytes are the bytes the key signed. It says nothing about
 * whether the spine boots a functional agent or whether the identity
 * described matches who the operator meant to publish.
 *
 * Ported from projects/spinoff/pap-prototype/cli/pap-boot.js
 * (WO-PAP-01) with a CJS-to-ESM conversion only.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { unpack } from '../src/publish/pack.js';

const SEALED_EXIT = {
  PAP_SEALED_NEEDS_KEY: 5,
  PAP_NOT_A_RECIPIENT: 6,
  PAP_KEY_COMMIT_MISMATCH: 7,
  PAP_DECRYPT_FAILED: 7,
  PAP_INNER_BINDING_INVALID: 7,
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle) die('missing --bundle <path> (or --bundle - for stdin)');

  const bundle = args.bundle === '-'
    ? fs.readFileSync(0)
    : fs.readFileSync(args.bundle);

  const verifyKey = args.verifyKey
    ? crypto.createPublicKey({
        key: fs.readFileSync(args.verifyKey),
        format: 'pem',
      })
    : undefined;

  const opener = {};
  if (args.recipientKey) {
    opener.recipientKey = /^[0-9a-f]{64}$/i.test(args.recipientKey)
      ? args.recipientKey
      : fs.readFileSync(args.recipientKey, 'utf8').trim();
  }
  if (args.passphraseEnv) {
    const p = process.env[args.passphraseEnv];
    if (!p) die(`--passphrase-env ${args.passphraseEnv}: that environment variable is empty or unset`);
    opener.passphrase = p;
  }
  if (args.contentKey) {
    if (!/^[0-9a-f]{64}$/i.test(args.contentKey)) die('--content-key must be 64 hex characters');
    opener.contentKey = args.contentKey;
  }

  try {
    const { manifest, spine, spineRawLen, spineCompressedLen, contentKey } = unpack({ bundle, verifyKey, ...opener });
    process.stdout.write(spine);
    process.stderr.write(
      `pap-boot ok\n` +
      `  version ${manifest.version}\n` +
      (manifest.sealed ? `  sealed to ${describe(manifest.recipients)}, opened\n` : '') +
      `  seq ${manifest.seq}\n` +
      `  timestamp ${manifest.timestamp} (${new Date(manifest.timestamp).toISOString()})\n` +
      `  chain head ${manifest.chainHeadHash.toString('hex')}\n` +
      `  chain pubkey fp ${manifest.chainPubkeyFp.toString('hex')}\n` +
      (manifest.memoirUrl ? `  memoir ${manifest.memoirUrl}\n` : '') +
      `  raw ${spineRawLen} B, compressed ${spineCompressedLen} B\n` +
      (args.printContentKey && contentKey ? `  content key ${contentKey.toString('hex')}\n` : ''),
    );
    process.exit(0);
  } catch (err) {
    if (err.code === 'PAP_SIGNATURE_INVALID') {
      process.stderr.write('pap-boot: ' + err.message + '\n');
      process.exit(4);
    }
    if (err.code in SEALED_EXIT) {
      const i = err.info;
      process.stderr.write(
        'pap-boot: ' + err.message + '\n' +
        (i
          ? `  seq ${i.seq}\n` +
            `  timestamp ${i.timestamp} (${new Date(i.timestamp).toISOString()})\n` +
            `  chain head ${i.chainHeadHash.toString('hex')}\n` +
            `  chain pubkey fp ${i.chainPubkeyFp.toString('hex')}\n`
          : ''),
      );
      process.exit(SEALED_EXIT[err.code]);
    }
    process.stderr.write('pap-boot: ' + (err && err.stack || err) + '\n');
    process.exit(1);
  }
}

function describe(r) {
  const parts = [];
  if (r.x25519 > 0) parts.push(`${r.x25519} recipient key(s)`);
  if (r.passphrase) parts.push('a passphrase');
  return parts.join(' and ');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--bundle': out.bundle = argv[++i]; break;
      case '--verify-key': out.verifyKey = argv[++i]; break;
      case '--recipient-key': out.recipientKey = argv[++i]; break;
      case '--passphrase-env': out.passphraseEnv = argv[++i]; break;
      case '--content-key': out.contentKey = argv[++i]; break;
      case '--print-content-key': out.printContentKey = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (!a.startsWith('-')) break;
        die(`unknown flag: ${a}`);
    }
  }
  return out;
}

function die(msg) {
  process.stderr.write('pap-boot: ' + msg + '\n');
  process.exit(2);
}

main();
