# Staged: `bin/chapters.js` and its npm script

Staged 2026-09-07 by the chapters-view work order, after the gate denied both
writes. Nothing here has been applied. The view module it calls,
`src/views/chapters.js`, is on the branch and tested; only the CLI entry point
and the `package.json` line wait on a signature.

## Why it is here and not in `bin/`

The work order assumed only `bin/hook-*.js` was protected. The gate's own
denial says otherwise:

> WHAT    Write: <repo>\bin\chapters.js
> WHY     a tool in the protected bin/ directory. It reports rather than
>         enforces, so it cannot change what the gate permits. It is gated
>         because it is what you read to judge whether the work matched the plan

That reasoning is sound and this file does not argue with it. A reporting tool
is what the owner reads to judge the work, so it lands under the same signature
as the enforcing ones. `package.json` was denied on the same rule
("this path can change the gate, its policy, its hooks, or the log").

`test/chapters-cli.test.js` is on the branch and skips, loudly, until the file
below exists.

## To apply, under signature

1. Create `bin/chapters.js` with the contents of the first block, verbatim.
2. Apply the one-line `package.json` hunk in the second block.
3. `npm test` — the skipped CLI suite runs and should go green (4 tests).

## `bin/chapters.js`

```js
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
```

## `package.json`

```diff
@@ scripts @@
     "receipts": "node bin/view.js --all",
+    "chapters": "node bin/chapters.js",
     "tokens": "node bin/tokens.js",
```
