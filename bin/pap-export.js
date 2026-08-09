#!/usr/bin/env node
/**
 * pap-export — encode a spine into a signed QR bundle.
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
 * keys without touching a real chain — same seam the prototype proved.
 *
 * The --public flag is required and unlocks nothing except the operator's
 * acknowledgment that everything about to be encoded is going onto a
 * medium anyone can scan. See KNOWN-LIMITS 45. The signature proves who
 * authored the bundle, not that the bundle is safe to distribute.
 *
 * Signing uses the CHAIN key, not the approval key (KNOWN-LIMITS 48):
 * bundle authenticity is chain-key strength, and the chain key is stored
 * plaintext at rest (limit 8).
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.public) {
    die(
      'refusing to encode without --public.\n' +
      'A QR is a broadcast medium. Anyone who scans this will read the spine.\n' +
      'Add --public to acknowledge and proceed.',
    );
  }
  if (!args.spine) die('missing --spine <path>');

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
  });

  const basepath = args.out || path.resolve(args.spine + '.pap');
  const [png, svg] = await Promise.all([
    bundleToPng(result.bundle),
    bundleToSvg(result.bundle),
  ]);
  fs.writeFileSync(basepath + '.png', png);
  fs.writeFileSync(basepath + '.svg', svg);
  fs.writeFileSync(basepath + '.bin', result.bundle);

  console.log(
    `pap-export ok\n` +
    `  spine raw ${result.spineRawLen} B\n` +
    `  compressed ${result.spineCompressedLen} B (${result.compressionRatio.toFixed(2)}x)\n` +
    `  bundle ${result.totalLen} B / budget ${result.budget} B (headroom ${result.headroom} B)\n` +
    `  chain seq ${seq}\n` +
    `  wrote ${basepath}.png\n` +
    `  wrote ${basepath}.svg\n` +
    `  wrote ${basepath}.bin`,
  );
}

function parseArgs(argv) {
  const out = { public: false };
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
      case '-h': case '--help': out.help = true; break;
      default:
        if (!a.startsWith('-')) break;
        die(`unknown flag: ${a}`);
    }
  }
  return out;
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
  process.stderr.write('pap-export: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
