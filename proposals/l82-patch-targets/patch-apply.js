/**
 * WO-L82-01 + WO-L82-02: patch-target classifier for the self-mod gate (KNOWN-LIMITS 82).
 *
 * `git apply`, `git am` and `patch` write targets named only inside the patch file; this
 * reads the patch(es) and returns those targets, failing closed when a source cannot be
 * read. Verbs hidden behind env assignments, wrappers, shell keywords, an `&` separator,
 * an `env -S` string or a `shell -c` string are still found; and git's global options
 * before the subcommand and stdin patch spellings are parsed instead of left fail-open.
 */

import fs from 'node:fs';

const DEFAULT_READ = (p) => fs.readFileSync(p, 'utf8');

// `patch` options that swallow a separate value which is never a patch source.
const PATCH_VALUE_OPTS = new Set(['p', 'd', 'o', 'r', 'D', 'F', 'B', 'z', 'V', 'Y', 'g']);

// Re-entry shells; wrappers and the flags that eat a value next to them.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell']);
// Wrappers hide the verb after them; the listed flag swallows the next token.
const WRAPPERS = new Map([['sudo', ['-u']], ['env', ['-u', '-C', '--unset', '--chdir']], ['command', []], ['exec', []], ['nohup', []], ['time', []], ['nice', ['-n']], ['xargs', ['-I', '-n', '-L', '-d']]]);
// Shell reserved words and a lone `(` lead the real command; skipped like wrappers.
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'coproc', 'in', 'esac']);
// git global options that, without `=`, swallow the next token; with `=` they are one token.
const GIT_VALUE_OPTS = new Set(['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
// These spell stdin, and readFileSync on them can hang: never reach the reader with one.
const STDIN_SOURCES = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0']);

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

// Env assignments, shell keywords, wrappers and a leading `(` ahead of a hidden verb
// vanish; the return says how many tokens went away, whether xargs was among them (its
// verb reads stdin), and whether env carried -S/--split-string (its value is a whole
// inner command, returned unquoted for the caller to scan — never swallowed as a flag
// value, which would silently drop the verb it hides).
function skipHidden(toks, s, offs) {
  let k = 0, viaXargs = false, split = null;
  for (;;) {
    if (k >= toks.length) break;
    const name = baseName(toks[k]);
    if (envAssign(toks[k])) { k++; continue; }
    if (SHELL_KEYWORDS.has(toks[k]) || toks[k] === '(') { k++; continue; }
    // `case WORD in` heads a case statement: the word after `case` is not a command.
    if (toks[k] === 'case') { k += 2; continue; }
    // A quoted arg like `"a)"` is not a pattern. Unquoted `a)` ends with `)` and no `(`:
    // a case pattern, so a following verb is still reached and it never names a patch.
    if (toks[k].length > 1 && toks[k].endsWith(')') && !toks[k].includes('(') &&
        toks[k][0] !== "'" && toks[k][0] !== '"') { k++; continue; }
    const valued = WRAPPERS.get(name);
    if (!valued) break;
    if (name === 'xargs') viaXargs = true;
    for (k++; k < toks.length && toks[k].startsWith('-'); k++) {
      const t = toks[k];
      if (name === 'env' && (t.startsWith('-S') || t.startsWith('--split-string'))) {
        // The split string is the rest of the segment (sliced raw: tokens are whitespace-split).
        split = t.startsWith('--split-string=') ? unquote(s.slice(offs[k] + 15).trim())
          : t === '--split-string' ? unquote(s.slice(offs[k] + 14).trim())
          : unquote(s.slice(offs[k] + 2).trim());
        return { skip: k, viaXargs, split };
      }
      if (valued.includes(t) && k + 1 < toks.length) k++;
    }
  }
  return { skip: k, viaXargs, split };
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
  // Odd indices are the separators, so each even index knows what preceded it. A single
  // `&` is a command separator too, but not inside `&&`, `2>&1`, `>&`, `<&` or `&>`.
  const parts = cmd.split(/(&&|\|\||\|&|(?<![<>&|])&(?![>&])|[;|\n\r])/);
  for (let p = 0; p < parts.length; p += 2) {
    const seg = parts[p], prevSep = p > 0 ? parts[p - 1] : null;
    if (!seg.trim()) continue;
    let s = seg.trim();
    const leadParen = s.startsWith('(');
    if (leadParen) s = s.slice(1).trim();
    const toks = [], offs = [];
    for (const m of s.matchAll(/\S+/g)) { toks.push(m[0]); offs.push(m.index); }
    if (!toks.length) continue;
    // A bare `)` closes a subshell group, so it never names a patch source.
    for (let i = toks.length - 1; i >= 0; i--) {
      if (toks[i] === ')') { toks.splice(i, 1); offs.splice(i, 1); }
    }
    if (!toks.length) continue;
    if (leadParen && toks[toks.length - 1].endsWith(')')) toks[toks.length - 1] = toks[toks.length - 1].slice(0, -1);
    stripUnpairedQuotes(toks, offs);
    const { skip, viaXargs, split } = skipHidden(toks, s, offs);
    if (skip) { toks.splice(0, skip); offs.splice(0, skip); }
    // env -S/--split-string: the flag value is a space-split inner command, so the rest
    // of the segment is scanned like a shell -c body instead of parsed as tokens.
    if (split !== null) {
      if (split) {
        if (depth >= 8) { acc.matched = true; acc.failClosed = true; } // too deep to parse: stay closed
        else scanCommand(split, cwd, read, acc, depth + 1);
      }
      continue;
    }
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
      // Global options before the subcommand: -C/-c take a value; the ones in
      // GIT_VALUE_OPTS take the next token when spelled without `=`; with `=` or any
      // other flag they are self-contained. Keep looking until the verb shows up.
      let i = 1;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '-C' || t === '-c') i += 2;
        else if (GIT_VALUE_OPTS.has(t)) i += i + 1 < toks.length ? 2 : 1;
        else if (t.startsWith('-')) i++;
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
    if (prevSep === '|' || prevSep === '|&') acc.failClosed = true; // the verb reads its patch from stdin
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
      if (STDIN_SOURCES.has(src)) { acc.failClosed = true; continue; } // stdin: reading it can hang, so stay closed
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