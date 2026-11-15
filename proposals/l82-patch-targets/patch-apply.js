/**
 * WO-L82-01 + WO-L82-02: patch-target classifier for the self-mod gate (KNOWN-LIMITS 82).
 *
 * `git apply`, `git am` and `patch` write targets named only inside the patch file; this
 * reads the patch(es) and returns those targets, failing closed when a source cannot be
 * read. Verbs hidden behind env assignments, wrappers or a `shell -c` string are still
 * found; xargs feeding the verb means stdin patch names, so it fails closed.
 */

import fs from 'node:fs';

const DEFAULT_READ = (p) => fs.readFileSync(p, 'utf8');

// `patch` options that swallow a separate value which is never a patch source.
const PATCH_VALUE_OPTS = new Set(['p', 'd', 'o', 'r', 'D', 'F', 'B', 'z', 'V', 'Y', 'g']);

// Re-entry shells; wrappers and the flags that eat a value next to them.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell']);
// Wrappers hide the verb after them; the listed flag swallows the next token.
const WRAPPERS = new Map([['sudo', ['-u']], ['env', []], ['command', []], ['exec', []], ['nohup', []], ['time', []], ['nice', ['-n']], ['xargs', ['-I', '-n', '-L', '-d']]]);

function baseName(tok) {
  const b = tok.replace(/\\/g, '/').split('/').pop();
  return b.endsWith('.exe') ? b.slice(0, -4) : b;
}

function unquote(s) {
  return s.length > 1 && (s[0] === "'" || s[0] === '"') && s.endsWith(s[0]) ? s.slice(1, -1) : s;
}

// `NAME=value` assignments, one or more, can stand ahead of a hidden verb.
const envAssign = (t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
// Same lines carry targets for unified diffs and mboxes; each path is kept
// both stripped (a/, b/ removed) and raw — the gate matches substrings, more is safer.
function patchTextTargets(text) {
  const out = [];
  const add = (p) => {
    if (!p || p === '/dev/null') return;
    out.push(p);
    const stripped = p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
    if (stripped !== p) out.push(stripped);
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // Git appends "\t<timestamp>"; cut at the first tab so spaces in paths survive.
      const rest = line.slice(4);
      const tab = rest.indexOf('\t');
      add((tab === -1 ? rest : rest.slice(0, tab)).trim());
    } else if (line.startsWith('diff --git ')) {
      for (const t of line.slice(11).split(/\s+/)) {
        if (t.startsWith('a/') || t.startsWith('b/')) add(t);
      }
    } else if (line.startsWith('rename from ')) add(line.slice(12).trim());
    else if (line.startsWith('copy from ')) add(line.slice(10).trim());
    else if (line.startsWith('rename to ')) add(line.slice(10).trim());
    else if (line.startsWith('copy to ')) add(line.slice(8).trim());
  }
  return [...new Set(out)];
}

// `<<[=-]MARKER` in any spelling, or a bare `<<` followed by the marker token.
function heredocMarker(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '<<' || t === '<<-') return toks[i + 1] ? unquote(toks[i + 1]) : null;
    if (t.startsWith('<<<')) return null; // zsh herestring, not a patch feed
    if (t.startsWith('<<')) return unquote(t.slice(2).replace(/^-/, '')) || null;
  }
  return null;
}

// Fold \ to /, then a leading / or drive letter is absolute; the rest is cwd-relative.
function resolveSource(src, cwd) {
  const s = src.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return s;
  const base = (cwd ? cwd.replace(/\\/g, '/') : '').replace(/\/+$/, '');
  return base + '/' + s;
}

// Env assignments and wrappers ahead of a hidden verb vanish; the return says how many
// tokens went away and whether xargs was among them (its verb reads stdin).
function skipHidden(toks) {
  let k = 0, viaXargs = false;
  for (;;) {
    if (k >= toks.length) break;
    const name = baseName(toks[k]);
    if (envAssign(toks[k])) { k++; continue; }
    const valued = WRAPPERS.get(name);
    if (!valued) break;
    if (name === 'xargs') viaXargs = true;
    for (k++; k < toks.length && toks[k].startsWith('-'); k++) {
      if (valued.includes(toks[k]) && k + 1 < toks.length) k++;
    }
  }
  return { skip: k, viaXargs };
}

// Splitting on `;`/`|` can land inside a quoted string (an inner `shell -c 'cd r; ...'`),
// leaving one quote behind; drop the dangling one so the hidden verb still parses.
function stripUnpairedQuotes(toks, offs) {
  for (const q of ["'", '"']) {
    let n = 0;
    for (const t of toks) for (const c of t) if (c === q) n++;
    if (n % 2 === 0 || !toks.length) continue;
    if (toks[toks.length - 1].endsWith(q)) {
      if (toks[toks.length - 1] === q) { toks.pop(); offs.pop(); }
      else toks[toks.length - 1] = toks[toks.length - 1].slice(0, -1);
    } else if (toks[0].startsWith(q)) {
      if (toks[0] === q) { toks.shift(); offs.shift(); }
      else toks[0] = toks[0].slice(1);
    }
  }
}

// `shell -c '<inner>'` hides the verb inside the string after the flag; pwsh spells
// it -Command. The rest of the segment text is that inner command.
function shellRest(s, toks, offs) {
  if (!toks.length || !SHELLS.has(baseName(toks[0]))) return null;
  for (let i = 1; i < toks.length; i++) {
    if (toks[i] === '-c' || toks[i].toLowerCase() === '-command') {
      return unquote(s.slice(offs[i] + toks[i].length).trim());
    }
  }
  return null;
}

function scanCommand(cmd, cwd, read, acc, depth) {
  // Odd indices are the separators, so each even index knows what preceded it.
  const parts = cmd.split(/(&&|\|\||[;|\n\r])/);
  for (let p = 0; p < parts.length; p += 2) {
    const seg = parts[p], prevSep = p > 0 ? parts[p - 1] : null;
    if (!seg.trim()) continue;
    let s = seg.trim();
    const leadParen = s.startsWith('(');
    if (leadParen) s = s.slice(1).trim();
    const toks = [], offs = [];
    for (const m of s.matchAll(/\S+/g)) { toks.push(m[0]); offs.push(m.index); }
    if (!toks.length) continue;
    if (leadParen && toks[toks.length - 1].endsWith(')')) toks[toks.length - 1] = toks[toks.length - 1].slice(0, -1);
    stripUnpairedQuotes(toks, offs);
    const { skip, viaXargs } = skipHidden(toks);
    if (skip) { toks.splice(0, skip); offs.splice(0, skip); }
    if (!toks.length) continue;
    // The inner string of a shell re-entry is scanned on its own; its result lands in acc.
    const rest = shellRest(s, toks, offs);
    if (rest !== null) {
      if (depth >= 8) { acc.matched = true; acc.failClosed = true; } // too deep to parse: stay closed
      else scanCommand(rest, cwd, read, acc, depth + 1);
      continue;
    }
    const base = baseName(toks[0]);
    let verb = null, start = 1;
    if (base === 'git') {
      let i = 1;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '-C' || t === '-c') i += 2;
        else if ((t.startsWith('-C') || t.startsWith('-c')) && t.length > 2) i++;
        else if (t === '--no-pager' || t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) i++;
        else break;
      }
      if (toks[i] === 'apply' || toks[i] === 'am') { verb = toks[i]; start = i + 1; } else continue;
    } else if (base === 'patch') verb = 'patch';
    else continue;

    // Browsing invocations look at patches without writing them.
    if (verb !== 'patch') {
      const flags = toks.slice(start).filter((t) => t.startsWith('-'));
      const browses = verb === 'apply'
        ? ['--check', '--stat', '--numstat', '--summary'].some((f) => flags.includes(f)) &&
          !flags.includes('--apply')
        : flags.some((f) => f === '--abort' || f === '--quit' || f === '--show-current-patch');
      if (browses) continue;
    }
    acc.matched = true;
    // < redirects feed the patch either way: `< f` and `<f` mean the same.
    const fed = new Set();
    const sources = [];
    for (let i = start; i < toks.length; i++) {
      const t = toks[i];
      if (t === '<' && i + 1 < toks.length) { fed.add(i); fed.add(i + 1); sources.push(unquote(toks[i + 1])); }
      else if (t.startsWith('<(')) { fed.add(i); acc.failClosed = true; } // never a readable patch file
      else if (t.startsWith('<') && !t.startsWith('<<') && t.length > 1) { fed.add(i); sources.push(unquote(t.slice(1))); }
    }
    if (prevSep === '|') acc.failClosed = true; // the verb reads its patch from stdin
    if (viaXargs) acc.failClosed = true; // xargs feeds the verb patch names from stdin
    const hasHeredoc = toks.some((t) => t.startsWith('<<'));
    if (hasHeredoc) {
      acc.inline = true;
      // The heredoc body IS the patch text: collect targets from it directly.
      const marker = heredocMarker(toks);
      let body = '';
      for (let q = p + 2; q < parts.length; q += 2) {
        if (parts[q].trim() === marker) break;
        body += parts[q] + (parts[q + 1] ?? '');
      }
      for (const t of patchTextTargets(body)) acc.targets.add(t);
    }
    if (verb === 'patch') {
      // Value opts (-d, -o, ...) swallow their value; -i / --input= name the patch.
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i];
        if (fed.has(i) || t.startsWith('<')) continue;
        if (t === '-i' && i + 1 < toks.length) { sources.push(unquote(toks[i + 1])); i++; continue; }
        if (t.startsWith('-i') && t.length > 2) { sources.push(unquote(t.slice(2))); continue; }
        if (t.startsWith('--input=')) { sources.push(unquote(t.slice(8))); continue; }
        const c = t.slice(1, 2);
        const i2 = PATCH_VALUE_OPTS.has(c) ? (t.length === 2 ? 1 : 0) : -1;
        if (i2 === 1) { i++; continue; } // `-p 1`: the next token is the value
        if (i2 === 0) continue; // `-p1`: the value is attached
        if (t.startsWith('-')) continue; // any other flag is self-contained
        sources.push(unquote(t));
        acc.targets.add(unquote(t)); // positionals are write targets: patched file, then patch file
      }
    } else {
      for (let i = start; i < toks.length; i++) {
        const t = toks[i];
        if (fed.has(i) || t.startsWith('-') || t.startsWith('<')) continue;
        sources.push(unquote(t)); // flags keep their values attached
      }
    }

    for (const src of sources) {
      if (src.startsWith('<(') || src.includes('$(') || src.includes('`')) { acc.failClosed = true; continue; }
      let text;
      try { text = read(resolveSource(src, cwd)); }
      catch { acc.failClosed = true; continue; } // cannot see what the patch writes: fail closed
      for (const t of patchTextTargets(String(text))) acc.targets.add(t);
    }
    if (!sources.length && !hasHeredoc && prevSep !== '|') acc.failClosed = true; // stdin feed
  }
}

export function patchApplyTargets(cmd, cwd, readFile) {
  const acc = { matched: false, targets: new Set(), failClosed: false, inline: false };
  scanCommand(cmd || '', cwd, readFile || DEFAULT_READ, acc, 0);
  if (!acc.matched) return null;
  return { targets: [...acc.targets], failClosed: acc.failClosed, inline: acc.inline };
}