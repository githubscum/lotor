#!/usr/bin/env node
/**
 * bin/view.js
 *
 * CLI for viewing receipts.
 * Usage:
 *   node bin/view.js                    # Show morning-after summary
 *   node bin/view.js --session           # Show latest session receipt
 *   node bin/view.js --all               # Show both views
 */

import {
  loadReceiptChain,
  findLatestSessionReceipt,
  renderSessionReceipt,
  renderMorningAfter
} from '../src/views/index.js';
import { resolveHome } from '../src/home.js';

function main() {
  const args = process.argv.slice(2);
  const showSession = args.includes('--session');
  const showAll = args.includes('--all');
  const showMorning = !showSession || showAll;
  const showSessionOnly = showSession || showAll;

  // Load chain from the canonical Lotor home
  const home = resolveHome();
  const entries = loadReceiptChain(home);

  // Morning-after summary
  if (showMorning) {
    console.log(renderMorningAfter(entries, home));
  }

  // Session receipt
  if (showSessionOnly) {
    if (showAll) {
      console.log('\n\n');
    }
    const sessionReceipt = findLatestSessionReceipt(entries);
    if (sessionReceipt) {
      console.log(renderSessionReceipt(sessionReceipt.payload));
    } else {
      console.log('No session receipt found.');
    }
  }
}

main();
