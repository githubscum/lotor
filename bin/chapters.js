#!/usr/bin/env node
/**
 * bin/chapters.js
 *
 * Cross-runtime chapter list: one block per session, one line per operator
 * prompt, sourced from transcripts and checked against the receipt chain.
 *
 * Usage:
 *   node bin/chapters.js                          # every session on the chain
 *   node bin/chapters.js --since <iso|ms>         # window start
 *   node bin/chapters.js --session <id>           # one session
 *   node bin/chapters.js --codex <dir-or-file>    # add Codex rollouts (unattested)
 *   node bin/chapters.js --json                   # data instead of prose
 *
 * The chain is resolved through resolveHome() and loaded the way bin/view.js
 * does. Codex rollouts are read from disk and are NOT on the chain; the
 * report says so on every one of them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadReceiptChain } from '../src/views/index.js';
import { resolveHome } from '../src/home.js';
import { chaptersReport, renderChapters } from '../src/views/chapters.js';

function parseArgs(argv) {
  const opts = { since: undefined, sessionId: undefined, codex: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--session') opts.sessionId = argv[++i];
    else if (a === '--codex') opts.codex.push(argv[++i]);
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (typeof opts.since === 'string' && /^\d+$/.test(opts.since)) opts.since = Number(opts.since);
  return opts;
}

/** rollout-*.jsonl under a directory, recursively; or the file itself. */
function rolloutFiles(target, out = []) {
  if (!target) return out;
  let st;
  try { st = fs.statSync(target); } catch { return out; }
  if (st.isFile()) { out.push(target); return out; }
  for (const item of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, item.name);
    if (item.isDirectory()) rolloutFiles(p, out);
    else if (/^rollout-.*\.jsonl$/.test(item.name)) out.push(p);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: node bin/chapters.js [--since <iso|ms>] [--session <id>] [--codex <dir-or-file>] [--json]');
    return;
  }

  const home = resolveHome();
  const entries = loadReceiptChain(home);

  const extraTranscripts = [];
  for (const target of opts.codex) {
    for (const f of rolloutFiles(target).sort()) extraTranscripts.push({ runtime: 'codex', path: f });
  }

  const report = chaptersReport(entries, {
    since: opts.since,
    sessionId: opts.sessionId,
    extraTranscripts
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderChapters(report));
  }
}

main();
