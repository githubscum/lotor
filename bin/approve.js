#!/usr/bin/env node
/**
 * bin/approve.js
 *
 * CLI for the owner to approve gated actions.
 * Usage:
 *   node bin/approve.js init                    # generate approval keypair
 *   node bin/approve.js approve '<actionJSON>'  # create approval token
 *   node bin/approve.js approve --action-file <path> [--out <path>]  # file-based
 */

import fs from 'node:fs';
import path from 'node:path';
import { init, createApprovalToken } from '../src/gate/sign.js';
import { resolveHome } from '../src/home.js';

async function main() {
  const args = process.argv.slice(2);
  const [cmd, ...rest] = args;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`approve.js — Owner approval signer for gated actions

usage:
  node bin/approve.js init                        generate approval keypair
  node bin/approve.js approve '<actionJSON>'      create approval token
  node bin/approve.js approve --action-file <path> [--out <path>]
                                                  read action from file, write token to file
  node bin/approve.js approve --request <id>      the printed-from-the-gate path:
                                                  read the request the PreToolUse
                                                  hook staged at
                                                  <LOTOR_HOME>/pending-approvals/requests/<id>.json,
                                                  and write the token to
                                                  <LOTOR_HOME>/pending-approvals/<id>.json
                                                  (where the gate looks for it) unless
                                                  --out overrides that.

Signer requires a TTY. Run from a terminal, not from a piped process.
The approval token is printed to stdout as JSON.
If --out is provided, the token is also written to the specified file.
`);
    return;
  }

  if (cmd === 'init') {
    await init(resolveHome());
    return;
  }

  if (cmd === 'approve') {
    let actionJson = null;
    let outFile = null;
    const home = resolveHome();

    // Parse flags from remaining args
    const remainingArgs = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--action-file' && i + 1 < rest.length) {
        const actionFile = rest[i + 1];
        try {
          actionJson = fs.readFileSync(actionFile, 'utf8');
        } catch (e) {
          console.error(`error: cannot read action file '${actionFile}': ${e.message}`);
          process.exit(2);
        }
        i++; // skip the value
      } else if (rest[i] === '--request' && i + 1 < rest.length) {
        // The path a gate denial prints: read the request the PreToolUse hook
        // staged under pending-approvals/requests/, and default --out to
        // pending-approvals/<id>.json, which is exactly where the hook's own
        // findValidToken() looks. This is what makes the printed command
        // ("npm run approve -- --request <id>") complete on its own, with
        // nothing left for the owner or an agent to fill in.
        const id = rest[i + 1];
        const reqFile = path.join(home, 'pending-approvals', 'requests', `${id}.json`);
        try {
          actionJson = fs.readFileSync(reqFile, 'utf8');
        } catch (e) {
          console.error(`error: cannot read staged request '${reqFile}': ${e.message}`);
          process.exit(2);
        }
        if (!outFile) {
          outFile = path.join(home, 'pending-approvals', `${id}.json`);
        }
        i++; // skip the value
      } else if (rest[i] === '--out' && i + 1 < rest.length) {
        outFile = rest[i + 1];
        i++; // skip the value
      } else {
        remainingArgs.push(rest[i]);
      }
    }

    // If no --action-file, use argv fallback
    if (!actionJson) {
      actionJson = remainingArgs.join(' ');
      if (!actionJson) {
        console.error('error: no action JSON provided (use --action-file or argv)');
        process.exit(2);
      }
    }

    let actionRequest;
    try {
      actionRequest = JSON.parse(actionJson);
    } catch (e) {
      console.error('error: invalid JSON:', e.message);
      process.exit(2);
    }

    const token = await createApprovalToken(actionRequest, home);
    const tokenJson = JSON.stringify(token, null, 2);

    // Always print to stdout
    console.log(tokenJson);

    // Also write to file if --out provided
    if (outFile) {
      try {
        fs.writeFileSync(outFile, tokenJson + '\n', { mode: 0o600 });
      } catch (e) {
        console.error(`error: cannot write token file '${outFile}': ${e.message}`);
        process.exit(2);
      }
    }

    return;
  }

  console.error('error: unknown command:', cmd);
  process.exit(2);
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
