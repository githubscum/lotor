#!/usr/bin/env node
/**
 * bin/gate.js
 *
 * CLI to drive the gated action.
 * Usage:
 *   node bin/gate.js '<actionJSON>' [approvalTokenJSON]
 *   echo '<actionJSON>' | node bin/gate.js [approvalTokenJSON]
 *   node bin/gate.js --action-file <path> [--token-file <path>]
 *
 * Without approval token: shows denial.
 * With valid approval token: shows approval.
 */

import fs from 'node:fs';
import { createStore } from '../src/store/index.js';
import { gatedAction } from '../src/gate/index.js';
import { resolveHome } from '../src/home.js';

function main() {
  let actionJson = null;
  let tokenJson = null;

  // Parse arguments
  const args = process.argv.slice(2);

  // Check for file-based flags
  let actionFile = null;
  let tokenFile = null;
  const remainingArgs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--action-file' && i + 1 < args.length) {
      actionFile = args[i + 1];
      i++; // skip the value
    } else if (args[i] === '--token-file' && i + 1 < args.length) {
      tokenFile = args[i + 1];
      i++; // skip the value
    } else {
      remainingArgs.push(args[i]);
    }
  }

  // If file flags provided, read from files
  if (actionFile) {
    try {
      actionJson = fs.readFileSync(actionFile, 'utf8');
    } catch (e) {
      console.error(`Error: cannot read action file '${actionFile}': ${e.message}`);
      process.exit(1);
    }
  }

  if (tokenFile) {
    try {
      tokenJson = fs.readFileSync(tokenFile, 'utf8');
    } catch (e) {
      console.error(`Error: cannot read token file '${tokenFile}': ${e.message}`);
      process.exit(1);
    }
  }

  // If no file flags, fall back to argv (legacy mode)
  if (!actionFile && !tokenFile) {
    if (remainingArgs.length === 0) {
      console.error('Usage: node bin/gate.js \'<actionJSON>\' [approvalTokenJSON]');
      console.error('   or: echo \'{"action":"test"}\' | node bin/gate.js [approvalTokenJSON]');
      console.error('   or: node bin/gate.js --action-file <path> [--token-file <path>]');
      process.exit(1);
    }

    // First arg is the action JSON
    actionJson = remainingArgs[0];

    // Second arg (optional) is the approval token JSON
    if (remainingArgs.length >= 2) {
      tokenJson = remainingArgs[1];
    }
  }

  // Ensure we have an action
  if (!actionJson) {
    console.error('Error: no action provided (use --action-file or argv)');
    process.exit(1);
  }

  // Parse action request
  let actionRequest;
  try {
    actionRequest = JSON.parse(actionJson);
  } catch (e) {
    console.error('Error: invalid action JSON:', e.message);
    process.exit(1);
  }

  // Parse approval token if provided
  let approvalToken = null;
  if (tokenJson) {
    try {
      approvalToken = JSON.parse(tokenJson);
    } catch (e) {
      console.error('Error: invalid approval token JSON:', e.message);
      process.exit(1);
    }
  }

  // Create store and get chain under the canonical Lotor home
  const home = resolveHome();
  const store = createStore(home);
  const chain = {
    entries: store.entries,
    append: store.appendReceipt.bind(store)
  };

  // Execute gated action
  const result = gatedAction(actionRequest, approvalToken, chain, home);

  // Output structured result
  console.log(JSON.stringify(result, null, 2));
}

main();
