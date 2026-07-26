/**
 * src/policy/index.js
 *
 * PreToolUse policy engine for Lotor's gated-runs hook (v1).
 *
 * The rule TABLE is locked (see gated-runs-policy-2026-07-22.md). The user's
 * policy.json only sets the mode (gate | warn | off) per rule id, either
 * directly or via one of the three herding-mode presets below. There is no
 * user-defined regex in v1.
 *
 * Security model (locked):
 *   - No rule match: allow, no chain I/O, fast path.
 *   - Rule match, mode "warn": append a policy-warn receipt, stderr one-liner, allow (exit 0).
 *   - Rule match, mode "gate": require a valid signed token in pending-approvals/.
 *     No token -> denial receipt + exit 2 with signing instructions.
 *     Token fail-closed: any invalid/expired/replayed token is a deny.
 *   - Mode "off": rule never matches.
 *   - Engine error (policy unreadable, evaluator crash): allow + stderr + best-effort receipt.
 *     Fail-open on engine error, fail-closed on an unverifiable token for a gate rule.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Herding modes (2026-07-23): three named presets over the same matchers,
 * plus a tenth rule — mode-change — that protects the mode switch itself.
 * A preset is a full expansion, not a diff: switching modes replaces
 * policy.json wholesale (see bin/mode.js) rather than layering onto
 * whatever was there before.
 *
 * Herded:  the pen. Every matched rule gates.
 * Grazing: the fence. Anything leaving the machine gates; local-only
 *          actions (destructive, scope-escalation) warn. Ships as the
 *          default for a fresh install.
 * Loose:   the open field. Nothing blocks. Still 'warn', never 'off' —
 *          evaluate() takes a no-chain-I/O fast path on a null match (see
 *          the top of evaluate() below), so an all-off Loose would make
 *          the most dangerous mode the one that leaves the least evidence.
 *          self-mod and mode-change stay gated in every mode: Loose means
 *          free to act on the world, not free to rewrite what stops you,
 *          and changing modes always costs a signature.
 */
const RULE_TABLE = {
  'self-mod':         { herded: 'gate', grazing: 'gate', loose: 'gate' },
  'mode-change':      { herded: 'gate', grazing: 'gate', loose: 'gate' },
  'push-force':       { herded: 'gate', grazing: 'gate', loose: 'warn' },
  'push-protected':   { herded: 'gate', grazing: 'gate', loose: 'warn' },
  'publish':          { herded: 'gate', grazing: 'gate', loose: 'warn' },
  'egress-other':     { herded: 'gate', grazing: 'gate', loose: 'warn' },
  'opaque-exec':      { herded: 'gate', grazing: 'gate', loose: 'warn' },
  'destructive':      { herded: 'gate', grazing: 'warn', loose: 'warn' },
  'scope-escalation': { herded: 'gate', grazing: 'warn', loose: 'warn' },
  'spend':            { herded: 'off',  grazing: 'off',  loose: 'off' }
};

const MODE_NAMES = ['herded', 'grazing', 'loose'];
const RULE_IDS = Object.keys(RULE_TABLE);

/**
 * Full mode -> modes expansion for a named preset.
 * @param {string} modeName - one of MODE_NAMES
 * @returns {Object} modes map, one entry per RULE_IDS
 */
function expandMode(modeName) {
  const modes = {};
  for (const ruleId of RULE_IDS) {
    modes[ruleId] = RULE_TABLE[ruleId][modeName];
  }
  return modes;
}

/**
 * The pre-herding-modes (v1, 2026-07-22) per-rule defaults. Kept as the
 * merge fallback for a policy.json with no recognized `mode` field, so an
 * existing hand-tuned install is never silently upgraded to a preset it did
 * not ask for. A file that resolves here loads with mode "custom".
 */
const LEGACY_V1_DEFAULTS = {
  'self-mod': 'gate',
  'push-force': 'warn',
  'push-protected': 'warn',
  'publish': 'warn',
  'egress-other': 'warn',
  'opaque-exec': 'warn',
  'destructive': 'warn',
  'scope-escalation': 'warn',
  'spend': 'off',
  'mode-change': 'gate'
};

/**
 * Per-rule risk description, shown in the gate's denial message so the
 * warning is proportional to what was actually matched. See
 * bin/hook-pre-tool-use.js buildDenialMessage().
 */
const RULE_INFO = {
  'self-mod': {
    why: 'this path can change the gate, its policy, its hooks, or the log',
    risk: 'HIGH — approving this lets the agent alter what stops it'
  },
  'mode-change': {
    why: 'this replaces the gate posture for every rule at once',
    risk: 'HIGH — approving this changes what every future action requires'
  },
  'push-force': {
    why: 'a force push can overwrite history on a remote you do not control from here',
    risk: 'HIGH — overwritten history is not easy to get back'
  },
  'push-protected': {
    why: 'this pushes directly to a protected branch ref (main/master)',
    risk: 'MEDIUM — bypasses whatever review that branch normally requires'
  },
  'publish': {
    why: 'this ships a package, release, or merge to somewhere other people see it',
    risk: 'MEDIUM — hard to unpublish once someone else has pulled it'
  },
  'egress-other': {
    why: 'this sends data off this machine to a remote host',
    risk: 'HIGH — once sent, it is out of your custody'
  },
  'opaque-exec': {
    why: 'this hands control to a local script the gate cannot read the contents of',
    risk: 'HIGH — what it actually does is unverified by construction'
  },
  'destructive': {
    why: 'this recursively force-deletes a path',
    risk: 'HIGH — deleted this way does not go to a trash you can recover from'
  },
  'scope-escalation': {
    why: 'this registers a scheduled task or service that runs beyond this session',
    risk: 'MEDIUM — it keeps running after you stop watching'
  },
  'spend': {
    why: 'this rule is reserved for financial actions and has no matcher yet',
    risk: 'N/A — off in v1'
  }
};

const DEFAULT_POLICY = {
  version: 2,
  mode: 'grazing',
  modes: expandMode('grazing')
};

/** Shallow, structurally-independent copy of DEFAULT_POLICY. */
function defaultPolicyCopy() {
  return { version: DEFAULT_POLICY.version, mode: DEFAULT_POLICY.mode, modes: { ...DEFAULT_POLICY.modes } };
}

// ---------- path normalization ----------

/**
 * Normalize a file path for substring matching: lowercase, all backslashes to
 * forward slashes, strip trailing separator. Both Windows and POSIX forms
 * collapse to a single form so .toLowerCase() comparisons work uniformly.
 */
function normalizePath(p) {
  if (typeof p !== 'string' || p === '') return '';
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * True when `haystack` (already normalized) contains `needleFragment`
 * (already normalized) as a path segment, so ".claude/settings.json" doesn't
 * match a hypothetical ".claudeX/settings.json" path.
 */
function pathContainsFragment(haystackNorm, needleFragment) {
  const needle = normalizePath(needleFragment);
  if (needle === '') return false;
  // Ensure segment boundaries: needle must appear at the start, after '/',
  // or end-of-string. For a bare fragment like "src/gate" we additionally
  // allow start-of-string to handle "<home>/src/gate" without a leading slash.
  const re = new RegExp(
    '(^|/)' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|/)'
  );
  return re.test(haystackNorm);
}

// ---------- inert-prose stripping (shared by every command matcher) ----------

/**
 * Shell separators that start a new command. Shared by the prose stripper
 * (to find the command consuming a heredoc), the gh matcher (to tokenize
 * per command), and opaque-exec (a read verb only exempts the segment it
 * leads).
 */
const CMD_SEPARATORS = /(?:&&|\|\||[;&|\n\r])/;

/**
 * Blank out the argument of -m / --message before matching.
 *
 * A commit message is prose the agent wrote, not a command the shell will
 * run, but the matchers see one flat string and cannot tell the difference.
 * Without this, committing a fix whose message explains the fix trips the
 * rule the fix added, which happened within a minute of shipping it.
 *
 * Inertness is decided PER REGION by shell semantics, not per command:
 *   - single-quoted argument: no expansion is possible inside single quotes
 *     (sh and PowerShell agree), so the region is inert whatever it
 *     contains, and is always blanked.
 *   - double-quoted argument: `$(...)`, `${...}` and backticks DO execute
 *     inside double quotes, so the region is blanked only when the region
 *     itself contains none of them. `git commit -m "$(curl -d @secrets ...)"`
 *     stays visible because the shell runs the curl.
 *
 * The previous version bailed on expansion syntax anywhere in the COMMAND,
 * so one markdown backtick in a commit message un-stripped the whole string
 * and the matchers scanned the prose as if it were code. Verified live
 * 2026-07-24: a commit into a repo with NO remote was denied twice, first by
 * push-protected, then after rewording by publish, both times on words in
 * its own message. See KNOWN-LIMITS 26.
 *
 * Only the message argument is blanked. Stripping all quoted text would be
 * simpler and would hide `bash -c "git push origin main"` from the matcher,
 * trading a harmless false positive for a real miss.
 */
function stripMessageArgs(cmd) {
  return cmd
    .replace(/(-m|--message)(\s+|=)'[^']*'/g, "$1 ''")
    .replace(/(-m|--message)(\s+|=)"(?:[^"\\]|\\.)*"/g,
      (region, flag) => (/\$\(|\$\{|`/.test(region) ? region : flag + ' ""'));
}

/**
 * Blank heredoc BODIES that are provably inert prose.
 *
 * A body is blanked only when ALL of these hold, each anchored in shell
 * semantics rather than guesswork:
 *
 *   1. The command consuming the heredoc LEADS its segment and is a known
 *      prose consumer: `git commit|tag|notes|merge` (message input), `cat`,
 *      `tee` (text to stdout or a file). This is an allowlist ON PURPOSE,
 *      and the polarity is the load-bearing part: a consumer not on the
 *      list keeps its body VISIBLE, so `bash <<EOF`, `node <<EOF`,
 *      `git apply <<EOF`, and every interpreter that ships next year stay
 *      scanned. A gap in this list is a false positive, never a silent miss.
 *   2. The rest of the line after the heredoc operator has no pipe. A body
 *      piped onward (`cat <<'EOF' | bash`) is executed by the next command,
 *      so it stays visible.
 *   3. Either the delimiter is quoted (<<'EOF': the shell performs no
 *      expansion in the body, by definition) or the body contains no
 *      expansion syntax. An unquoted-delimiter body carrying `$(...)` runs
 *      that substitution, so it stays visible.
 *
 * Writing prose to a file that is LATER executed is not a hole here: the
 * write is inert, and the later execution is its own command, seen whole by
 * opaque-exec and the rest of the rules.
 *
 * PowerShell here-strings (@'...'@) are NOT stripped; they stay visible and
 * can still over-match. That keeps this change on the noisy side of the
 * line for the shell this engine understands least.
 */
function stripHeredocBodies(cmd) {
  if (!cmd.includes('<<')) return cmd;
  const PROSE_CONSUMER_LEAD = /^\s*(?:git\s+(?:commit|tag|notes|merge)\b|cat\b|tee\b)/;
  const HEREDOC_OP = /<<(-?)\s*(?:(["'])([A-Za-z_][A-Za-z0-9_]*)\2|([A-Za-z_][A-Za-z0-9_]*))/;
  const lines = cmd.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEREDOC_OP);
    if (!m) continue;
    const stripTabs = m[1] === '-';
    const quotedDelim = m[2] !== undefined;
    const delim = quotedDelim ? m[3] : m[4];
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      let t = lines[j].replace(/\r$/, '');
      if (stripTabs) t = t.replace(/^\t+/, '');
      if (t === delim) { end = j; break; }
    }
    if (end === -1) continue; // unterminated: leave everything visible
    const lead = lines[i].slice(0, m.index);
    const tail = lines[i].slice(m.index + m[0].length);
    // The consumer is the last command on the line before the operator.
    const leadSeg = lead.split(CMD_SEPARATORS).pop() || '';
    const bodyInert = quotedDelim || !/\$\(|\$\{|`/.test(lines.slice(i + 1, end).join('\n'));
    if (PROSE_CONSUMER_LEAD.test(leadSeg) && !tail.includes('|') && bodyInert) {
      for (let j = i + 1; j < end; j++) lines[j] = '';
    }
    i = end; // never re-scan a body for heredoc openers of its own
  }
  return lines.join('\n');
}

/**
 * The one entry point every command matcher uses to get its text. One choke
 * point, not a per-matcher opt-in: the 2026-07-24 false positives existed
 * because stripping lived only in the two matchers that had been burned
 * (publish, egress-other) while push-force and push-protected read the raw
 * string. A preprocessing step an individual rule can forget to call is a
 * defect factory. Every command matcher below starts here.
 */
function matchableCommand(toolInput) {
  const raw = typeof toolInput?.command === 'string' ? toolInput.command : '';
  if (raw === '') return '';
  return stripMessageArgs(stripHeredocBodies(raw));
}

// ---------- self-mod matcher ----------

// SELF_MOD_PATH_FRAGMENTS was deleted 2026-07-26. It was declared here and
// referenced nowhere in the repo, and it enforced nothing: three entries that
// read like the authoritative core list sitting immediately above the live one
// in selfModFragmentsForBase(). The hazard was not the dead code, it was that
// adding a path to it would FEEL like protection and buy none, which is the
// most expensive kind of wrong a security list can be. Live list below.

/**
 * Build the set of self-mod fragments that depend on baseDir (Lotor home).
 */
function selfModFragmentsForBase(baseDir) {
  return [
    '.claude/settings.json',
    // Repo source that decides what the gate permits. This set must stay in
    // step with core-paths.js CORE_DIRS/CORE_FILES (the list a grant may never
    // cover). They drifted: core-paths protected chain, store and grant while
    // this list did not, so the grant verifier, the hash chain and the store
    // could be rewritten with no signature — through any tool, in any mode.
    // Found 2026-07-24 when an edit to src/store landed unsigned. A drift-guard
    // test now asserts these two lists agree. See KNOWN-LIMITS 21.
    'src/gate/',
    'src/policy/',
    'src/chain/',
    'src/store/',
    'src/grant/',
    // Added 2026-07-26 alongside core-paths.js CORE_DIRS. Charters authorize a
    // reviewed plan once instead of N commands; sub-charters carve narrower
    // scopes from a signed parent. Editing the enumeration hash, the coverage
    // check or the narrowing proof would mint authority rather than spend it.
    // The module was written the night before with no signature at all, since
    // a new directory under src/ is grantable by default. The drift guard
    // could not catch that: both lists were wrong together.
    'src/charter/',
    'src/home.js',
    'src/registration.js',
    // Core bin scripts by exact name, so `/usr/bin/...` and `node_modules/.bin`
    // are not swept in. Hook binaries are additionally matched by regex below.
    'bin/approve.js',
    'bin/setup.js',
    'bin/mode.js',
    'bin/gate.js',
    'bin/view.js',
    normalizePath(path.join(baseDir, 'keys')) + '/',
    normalizePath(path.join(baseDir, 'receipts')) + '/',
    normalizePath(path.join(baseDir, 'policy.json'))
  ];
}

/**
 * Check whether an Edit/Write/NotebookEdit tool_input hits the self-mod rule.
 */
function isSelfModEdit(toolName, toolInput, baseDir) {
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'NotebookEdit') {
    return false;
  }
  const fp = normalizePath(toolInput?.file_path || '');
  if (fp === '') return false;

  // bin/hook-*.js
  if (/(\/|^)bin\/hook-[^/]+\.js$/.test(fp)) {
    return true;
  }

  const fragments = selfModFragmentsForBase(baseDir);
  for (const frag of fragments) {
    if (frag.endsWith('/')) {
      if (pathContainsFragment(fp, frag) || fp.startsWith(frag)) return true;
    } else {
      // exact file (e.g. policy.json) or fragment
      if (pathContainsFragment(fp, frag) || fp === frag || fp.endsWith('/' + frag)) return true;
    }
  }
  return false;
}

/**
 * Check whether a command string hits the self-mod rule: any of the self-mod
 * path fragments appearing as a substring in the command.
 *
 * Named `Command` rather than `Bash` since 2026-07-24. This matcher only ever
 * looked at `toolInput.command` and never at the tool name, so gating it
 * behind `toolName === 'Bash'` in the dispatcher below meant a second shell
 * (PowerShell on Windows, where it is the primary shell) could rewrite the
 * gate, the policy, the hooks, and delete the chain, all unsigned. That was a
 * live defect, not an obfuscation an adversary had to reach for: the default
 * configuration did not enforce. See KNOWN-LIMITS 21.
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSelfModCommand(toolInput, baseDir) {
  // Inert prose is stripped first, same as every other command matcher: a
  // single-quoted commit message that merely NAMES a protected path is not a
  // command that touches it. Anything executable (a double-quoted $(...) or
  // an interpreter-fed heredoc) survives the strip and is matched whole.
  const cmd = matchableCommand(toolInput);
  if (cmd === '') return false;
  const cmdNorm = normalizePath(cmd);

  // Lotor-specific artifact basenames are unambiguous. Gate them in any
  // spelling, so `rm ~/.lotor/keys/chain.key` is caught even though the
  // absolute-path fragments below only match the absolute spelling. A trailing
  // '.' is a terminator too: Windows strips trailing dots from a path's last
  // component, so `chain.key.` resolves to the real file (KNOWN-LIMITS 22).
  if (/(^|[/\s'"=(])(chain\.jsonl|chain\.key|approval-nonces\.log)([\s'"),;.]|$)/.test(cmdNorm)) {
    return true;
  }

  const fragments = selfModFragmentsForBase(baseDir);
  for (const frag of fragments) {
    if (cmdNorm.includes(frag)) return true;
  }

  // The keys/, receipts/ and policy.json under LOTOR_HOME were protected above
  // only by their ABSOLUTE path (and even then only with a trailing slash, so
  // `rm -rf <home>/receipts` on the dir itself missed). A tilde / $HOME /
  // relative spelling, or deleting the home dir wholesale, slipped through and
  // could destroy the chain unsigned (KNOWN-LIMITS 22). Any reference to the
  // Lotor home is self-mod-relevant: it can delete the home (`rm -rf ~/.lotor`),
  // a child (receipts/keys), or read a protected file. Gate the reference. The
  // terminator classes include '.' because Windows strips trailing dots, so
  // `Remove-Item -Recurse -Force ~/.lotor.` resolves to the real home.
  const home = normalizePath(os.homedir());
  const baseNorm = normalizePath(baseDir);
  const lotorRel = baseNorm.startsWith(home + '/') ? baseNorm.slice(home.length + 1) : null;
  const refsLotorHome =
    cmdNorm.includes(baseNorm) ||
    (lotorRel != null &&
      new RegExp(`(^|[/\\s'"=(])${escapeRegExp(lotorRel)}([/\\s'"),;.]|$)`).test(cmdNorm)) ||
    /(^|[/\s'"=(])\.lotor([/\s'"),;.]|$)/.test(cmdNorm) ||
    // The LOTOR_HOME env var (honored by src/home.js) IS the home on a custom
    // install; gate its spellings so a custom-home store is not deletable
    // unsigned. Default installs leave it unset, so this never fires there.
    // Includes the cmd.exe %LOTOR_HOME% spelling alongside the shell $-forms.
    /(\$\{?(env:)?lotor_home\}?|%lotor_home%)/.test(cmdNorm);
  if (refsLotorHome) return true;

  // bin/hook-*.js anywhere in the command
  if (cmdNorm.match(/bin\/hook-[^/\s'"]+\.js/)) return true;
  return false;
}

export function isSelfMod(toolName, toolInput, baseDir) {
  // A command-carrying tool is checked by its command string regardless of
  // the tool's name. This mirrors isCommandTool() used by every other command
  // rule: the guarantee has to hold for whatever shell the harness exposes,
  // not for a hardcoded allowlist of one. An edit tool is checked by its
  // file_path. A tool can in principle be both; check the command first.
  if (typeof toolInput?.command === 'string' && toolInput.command.trim() !== '') {
    return isSelfModCommand(toolInput, baseDir);
  }
  return isSelfModEdit(toolName, toolInput, baseDir);
}

// ---------- mode-change matcher ----------

/**
 * Detects an invocation of the mode-switch CLI (bin/mode.js), however it's
 * spelled: `npm run mode -- <name>` or a direct `node bin/mode.js`. Hard-
 * wired to gate in every preset (RULE_TABLE above) because a mode switch
 * changes what every OTHER rule requires; letting an agent flip it
 * unsupervised would make the whole preset system decorative.
 */
export function isModeChange(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (cmd === '') return false;
  if (/\bnpm\s+run\s+mode\b/.test(cmd)) return true;
  if (/\bbin[\\/]mode\.js\b/.test(cmd)) return true;
  return false;
}

/**
 * Detect `git push` with --force / --force-with-lease / -f. Guard against
 * false positives: -f must be its own token (not a substring of --follow
 * or a longer flag), and it must be in a context that means "force push",
 * which we approximate as: the -f appears anywhere in a `git push` command
 * that is NOT attached to another single-letter flag.
 *
 * Matches on the prose-stripped command (matchableCommand): this rule and
 * push-protected predate stripping and read the raw string, so a commit
 * message that merely SAID "git push --force" denied a local commit
 * (2026-07-24, live). See KNOWN-LIMITS 26.
 */
export function isPushForce(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (!/\bgit\s+push\b/.test(cmd)) return false;
  if (/--force\b/.test(cmd)) return true;
  if (/--force-with-lease\b/.test(cmd)) return true;
  // -f as a standalone token: surrounded by whitespace or end of command.
  // Reject "-fx" or "X-f" by requiring token boundaries.
  if (/(^|\s)-f(\s|$)/.test(cmd)) return true;
  return false;
}

// ---------- push-protected matcher ----------

/**
 * Detect `git push` with an explicit `main` or `master` ref. A bare
 * `git push` (no ref argument) does NOT match.
 */
export function isPushProtected(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (!/\bgit\s+push\b/.test(cmd)) return false;
  // Match `git push <ref>` or `git push <remote> <ref>` where ref is main/master.
  // We require the main/master token to appear as a standalone word after `git push`.
  // Using a simple approach: the command contains `git push` followed somewhere
  // by `main` or `master` as a word.
  const after = cmd.split(/\bgit\s+push\b/)[1] || '';
  return /\b(main|master)\b/.test(after);
}

// ---------- publish matcher ----------

/**
 * The specific, named publish shapes keep their own rule so the denial
 * message says "ships a release" rather than the generic egress line. The
 * general net for every OTHER authenticated gh mutation is
 * usesAuthedRemoteClient() under egress-other, which evaluates after this.
 */
export function isPublish(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (cmd === '') return false;
  return /\bgh\s+pr\s+merge\b/.test(cmd)
    || /\bnpm\s+publish\b/.test(cmd)
    || /\bgh\s+release\s+create\b/.test(cmd);
}

// ---------- egress-other matcher ----------

/**
 * True if the command's host is clearly localhost (i.e. the gate should not
 * fire for in-machine traffic). Looks for `localhost` or `127.0.0.1` as
 * a standalone token, OR the URL host portion of an http(s):// form.
 */
function isLocalhostTarget(cmd) {
  if (/\blocalhost\b/i.test(cmd)) return true;
  if (/\b127\.0\.0\.1\b/.test(cmd)) return true;
  // http://localhost:port or https://localhost/...
  if (/https?:\/\/localhost[:/]/i.test(cmd)) return true;
  if (/https?:\/\/127\.0\.0\.1[:/]/.test(cmd)) return true;
  return false;
}

function hasHttpMethodFlag(cmd) {
  // curl: -X POST/PUT/DELETE, --request POST/PUT/DELETE
  if (/(^|\s)(-X|--request)\s+(POST|PUT|DELETE|PATCH)\b/i.test(cmd)) return true;
  // PowerShell: -Method Post/Put/Delete (Invoke-WebRequest)
  if (/(^|\s)-Method\s+(Post|Put|Delete|Patch)\b/i.test(cmd)) return true;
  return false;
}

function hasDataFlag(cmd) {
  // curl: -d, --data, --data-raw, --data-binary, --data-urlencode
  if (/(^|\s)(-d|--data|--data-raw|--data-binary|--data-urlencode)\b/.test(cmd)) return true;
  if (/(^|\s)--form\b/.test(cmd)) return true;
  if (/(^|\s)-F\b/.test(cmd)) return true; // curl form shorthand
  if (/(^|\s)-T\b/.test(cmd)) return true; // curl --upload-file shorthand
  if (/(^|\s)--upload-file(=|\s|$)/.test(cmd)) return true; // curl upload, long form of -T
  // wget uploads (KNOWN-LIMITS 21: these were unrecognised)
  if (/(^|\s)--post-file(=|\s|$)/.test(cmd)) return true;
  if (/(^|\s)--post-data(=|\s|$)/.test(cmd)) return true;
  // PowerShell: -Body, -InFile
  if (/(^|\s)-Body\b/.test(cmd)) return true;
  if (/(^|\s)-InFile\b/i.test(cmd)) return true;
  return false;
}

function usesEgressTool(cmd) {
  if (/\bcurl\b/.test(cmd)) return true;
  if (/\bwget\b/.test(cmd)) return true;
  if (/\bInvoke-WebRequest\b/i.test(cmd)) return true;
  if (/\biwr\b/.test(cmd)) return true;
  // Invoke-RestMethod / irm: the standard PowerShell call for JSON APIs, and
  // the sibling of Invoke-WebRequest. Its absence here was an oversight, not
  // a decision (KNOWN-LIMITS 21). curl.exe / wget.exe on Windows fall out of
  // the \bcurl\b / \bwget\b boundaries already since the boundary is before
  // the dot.
  if (/\bInvoke-RestMethod\b/i.test(cmd)) return true;
  if (/\birm\b/.test(cmd)) return true;
  return false;
}

function usesRemoteCopyTool(cmd) {
  if (/\bssh\s+/.test(cmd)) return true;
  if (/\bscp\s+/.test(cmd)) return true;
  if (/\brsync\s+/.test(cmd)) return true;
  return false;
}

/**
 * Publishing to a remote host is egress, whatever the transport. push-force
 * and push-protected cover the dangerous SHAPES of a push; this catches the
 * ordinary one, which still ships the working tree off the machine. The
 * specific rules evaluate first, so a force push still reports as push-force.
 */
function usesRemotePublishTool(cmd) {
  if (/\bgit\s+push\b/.test(cmd)) return true;
  if (/\bgit\s+remote\s+add\b/.test(cmd)) return true;
  if (/\bgh\s+(pr|release|gist|repo)\s+create\b/.test(cmd)) return true;
  return false;
}

function isRemoteCopyTarget(cmd) {
  // ssh/scp/rsync with a `host:` or `user@host` remote form.
  // The `user@host` form is sufficient on its own (no trailing colon required),
  // because the user portion of an SSH connection argument always implies
  // the remote.
  if (/\b[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+/.test(cmd)) return true; // user@host
  // scp/rsync host:path (look for a host token ending with ':' followed by a path char)
  if (/\b[a-zA-Z0-9._-]+:\//.test(cmd)) return true; // host:/path
  if (/\b[a-zA-Z0-9._-]+:~\//.test(cmd)) return true; // host:~/...
  return false;
}

/**
 * gh is an authenticated remote API client. It holds the user's GitHub
 * credential, so every invocation that is not a known read is a write to a
 * remote surface the user owns — repo metadata, visibility, releases,
 * secrets, workflows — with no further prompt from anything. Verified live
 * 2026-07-24: `gh repo edit --description` changed a public repo with no
 * gate, while a plain `git push` to the same repo would have gated. The rule
 * set knew git's transports and not git's vendor CLI.
 *
 * The structure of this matcher is the fix, not the membership of a list:
 * WRITE verbs are not enumerated, because four gauntlet rounds (2026-07-24)
 * proved that shape leaks one verb per round. READ verbs are enumerated
 * instead, and everything else — edit, delete, set, merge, api, and every
 * subcommand gh ships next year — gates by default. A gap in the read list
 * is a false positive, never a silent miss.
 *
 * `api` is deliberately not on the read list: it is the raw escape hatch
 * (any endpoint, any method, and a `-f` field silently turns the GET into a
 * POST), so it always gates.
 *
 * Known noise, accepted: a global flag whose VALUE precedes the subcommand
 * (`gh --repo o/r pr view`) counts the value as an action word and gates a
 * read. That costs a signature; the inverse shape would cost a miss.
 */
const GH_READ_ONLY_WORDS = new Set([
  'view', 'list', 'status', 'checks', 'diff', 'search', 'browse',
  'clone', 'download', 'watch', 'help', 'version', 'completion'
]);

function usesAuthedRemoteClient(cmd) {
  for (const segment of cmd.split(CMD_SEPARATORS)) {
    const tokens = segment.split(/\s+/).filter(Boolean)
      .map(t => t.replace(/^["']|["']$/g, '').replace(/\.exe$/i, ''));
    const at = tokens.findIndex(t => t.toLowerCase() === 'gh');
    if (at === -1) continue;
    const words = [];
    for (let j = at + 1; j < tokens.length && words.length < 2; j++) {
      if (tokens[j].startsWith('-')) continue; // flags name no subcommand
      words.push(tokens[j].toLowerCase());
    }
    // A bare `gh`, `gh --version`, or `gh` as someone else's argument
    // (`brew install gh`, `which gh`) names no remote action.
    if (words.length === 0) continue;
    if (!words.some(w => GH_READ_ONLY_WORDS.has(w))) return true;
  }
  return false;
}

export function isEgressOther(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (cmd === '') return false;
  if (usesRemoteCopyTool(cmd) && isRemoteCopyTarget(cmd)) return true;
  if (usesRemotePublishTool(cmd)) return true;
  if (usesAuthedRemoteClient(cmd)) return true;
  if (usesEgressTool(cmd) && (hasHttpMethodFlag(cmd) || hasDataFlag(cmd)) && !isLocalhostTarget(cmd)) {
    return true;
  }
  return false;
}

// ---------- destructive matcher ----------

// Path SEGMENTS that mark scratch space, matched as whole segments and never
// as substrings. The earlier version tested `t.includes(frag)`, so `temp`
// matched inside `templates`, `attempts` and `contemplation`, and a recursive
// force delete of any of those was exempted with no warning and no receipt.
// Segment equality means `templates` splits to a segment `templates`, which is
// not `temp`, so it gates. See KNOWN-LIMITS 21.
const DESTRUCTIVE_ALLOW_SEGMENTS = new Set(['tmp', 'temp', 'scratchpad', 'mktemp']);

// Lexically resolve '.' and '..' (no filesystem, no symlinks). A '..' that
// escapes above the start simply drops, so `/tmp/../etc` resolves to `etc`.
function normalizeSegments(target) {
  const out = [];
  for (const seg of target.split(/[/\\]+/).filter(Boolean)) {
    if (seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

// Allowlisted when any resolved segment is scratch space. Normalizing '.' and
// '..' first is the fix: `rm -rf /tmp/../etc` resolves to `etc` (no scratch
// segment) and gates, where the pre-fix any-segment check saw `tmp` and exempted
// it. A legitimately nested scratch dir (`/home/me/scratchpad/run-1`) still has a
// scratch segment after normalization and stays exempt. See KNOWN-LIMITS 21.
function destructiveAllowlisted(target) {
  const segs = normalizeSegments(target.toLowerCase());
  return segs.some(seg => DESTRUCTIVE_ALLOW_SEGMENTS.has(seg));
}

/**
 * Heuristic: pull the "target" out of an rm -rf / Remove-Item command.
 * For `rm -rf <path>` or `rm -fr <path>` we capture the first non-flag arg.
 * For PowerShell `Remove-Item -Recurse -Force <path>` we capture the first
 * non-flag arg.
 */
function extractDestructiveTarget(cmd) {
  // Normalize: split on whitespace, collect bare tokens.
  // Strip quoted regions roughly: split on whitespace, then unquote.
  const tokens = cmd.split(/\s+/).map(t => t.replace(/^["']|["']$/g, ''));

  // Detect rm with a recursive+force flag combo. A flag is a single token
  // that starts with `-`. We accept -r, -R, -rf, -fr, -Rf, -fR, --recursive,
  // --force, and any combo. The flag token must be a full argument (preceded
  // by whitespace or start-of-string, followed by whitespace or end-of-string).
  // Walk the tokens to check both flag classes are present.
  const hasRecursiveFlag = tokens.some(tok =>
    tok === '--recursive' || (tok.startsWith('-') && tok !== '--force' && /[rR]/.test(tok))
  );
  const hasForceFlag = tokens.some(tok =>
    tok === '--force' || (tok.startsWith('-') && /[fF]/.test(tok))
  );
  if (/\brm\b/.test(cmd) && hasRecursiveFlag && hasForceFlag) {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === 'rm') continue;
      if (tok.startsWith('-')) continue;
      return tok;
    }
    return null;
  }

  // Remove-Item -Recurse -Force <path>
  if (/\bRemove-Item\b/i.test(cmd) && /-Recurse/i.test(cmd) && /-Force/i.test(cmd)) {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === 'Remove-Item') continue;
      if (tok.startsWith('-')) continue;
      return tok;
    }
    return null;
  }

  return null;
}

export function isDestructive(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (cmd === '') return false;

  const hasRmRf = /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*[rR])/.test(cmd)
    || /\brm\s+--recursive\b/.test(cmd);
  const hasRiRecurseForce = /\bRemove-Item\b/i.test(cmd) && /-Recurse/i.test(cmd) && /-Force/i.test(cmd);

  if (!hasRmRf && !hasRiRecurseForce) return false;

  const target = extractDestructiveTarget(cmd);
  if (target == null) return true; // rm -rf with no path is still destructive
  return !destructiveAllowlisted(target);
}

// ---------- scope-escalation matcher ----------

export function isScopeEscalation(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (cmd === '') return false;
  return /\bschtasks(\.exe)?\s+\/create\b/i.test(cmd)
    || /\bRegister-ScheduledTask\b/i.test(cmd)
    || /\bsc\s+create\b/i.test(cmd)
    || /\bNew-Service\b/i.test(cmd)
    || /\bcrontab\b/.test(cmd);
}

// ---------- opaque-exec matcher ----------

/**
 * True when a command hands control to a local script the engine cannot read.
 *
 * This is the second half of the 2026-07-22 deploy incident. Widening the
 * tool-name guard made PowerShell visible, but the command that actually
 * shipped 1.3 MB off the machine was `.\deploy\deploy.ps1 -PiHost pi@...`.
 * There is no `ssh` or `scp` token in that string. The egress lives inside
 * the script, one indirection away, where no regex over the command line can
 * reach it.
 *
 * Pattern matching cannot solve this: knowing what a script does means
 * reading the script, and by then it has already been handed the machine. So
 * the honest posture for a gate is that an unreadable action is an
 * unverified action. "I cannot tell what this does" must not silently mean
 * "allow" on a tool whose entire promise is that nothing leaves unsigned.
 *
 * Deliberately narrow: only shell and batch scripts, only when invoked as
 * the command. It fires on the class of thing that wraps arbitrary egress,
 * not on every binary.
 */
// A negative continuation assertion, NOT an allowlist of terminators. Two prior
// rounds closed one terminator at a time (`&`/`\r`, then `)`/backtick) and each
// left the next one open: a no-space redirect (`./deploy.ps1>log`) still slipped.
// "Extension not followed by another filename char" closes `>` `>>` `<` and every
// future terminator at once. See KNOWN-LIMITS 21 (the enumeration-leak lesson).
const SCRIPT_EXT = /\.(ps1|sh|bash|zsh|bat|cmd)(?![a-z0-9_-])/i;

// A command that only READS a script is not handing over control. The verb
// must LEAD its segment, not appear anywhere in it. The earlier version
// tested the whole command for `\btype\b`, `\bls\b` etc., and a hyphenated
// parameter supplies its own word boundary: `.\deploy.ps1 -Type full` was
// read as containing the verb `type` and exempted, so the rule created for
// the deploy incident was defeated by an ordinary parameter name. Anchoring
// to the start of the segment means the verb has to be the command, not an
// argument. See KNOWN-LIMITS 21.
const READ_ONLY_LEAD =
  /^\s*(?:cat|less|more|head|tail|grep|rg|ls|dir|stat|wc|type|Get-Content|gc|Select-String|sls)\b/i;

// CMD_SEPARATORS (shared) is defined with the inert-prose helpers above: a
// read verb only exempts the segment it leads. `Get-Content a.ps1 &&
// ./evil.ps1` executes evil.ps1 in a later segment, which is not led by a
// read verb, so it gates.

export function isOpaqueExec(toolInput) {
  const cmd = matchableCommand(toolInput);
  if (cmd === '') return false;
  for (const segment of cmd.split(CMD_SEPARATORS)) {
    if (!SCRIPT_EXT.test(segment)) continue;      // no script in this segment
    if (READ_ONLY_LEAD.test(segment)) continue;   // this segment only reads one
    return true;                                   // a script is being executed
  }
  return false;
}

// ---------- command-tool detection ----------

/**
 * True when a tool call carries a shell command this engine should inspect.
 *
 * This deliberately keys on the SHAPE of the input, not on an allowlist of
 * tool names. The previous version hardcoded `toolName === 'Bash'`, which
 * meant every command rule below was blind to every other shell the harness
 * exposes. On a Windows host, where the primary shell is PowerShell, that is
 * the shell most work actually runs through: a deploy could ship megabytes
 * off the machine, or `rm -rf` a served directory, and no rule would look at
 * it. Naming the next shell explicitly would only move the hole.
 *
 * Inspecting anything with a command string trades a small false-positive
 * risk for closing a whole class of false negative. For a gate that is the
 * correct direction: warning about something harmless costs a keystroke,
 * missing real egress costs the guarantee the product is sold on.
 */
function isCommandTool(toolName, toolInput) {
  return typeof toolInput?.command === 'string' && toolInput.command.trim() !== '';
}

// ---------- top-level evaluate ----------

/**
 * Evaluate toolName + toolInput against the policy.
 * Returns { ruleId, mode } for the FIRST matching rule, or null.
 * A rule whose mode is "off" or unrecognized never matches.
 */
function evaluate(toolName, toolInput, policy, baseDir) {
  const modes = (policy && policy.modes) || DEFAULT_POLICY.modes;

  // Normalize mode lookup: only 'gate', 'warn', 'off' are valid. Anything
  // else is treated as 'off' for safety (defense in depth: a malformed
  // policy.json must not be able to escalate the gate into a "silly" mode
  // that this evaluator silently honors).
  function modeOf(ruleId) {
    const v = modes[ruleId];
    return (v === 'gate' || v === 'warn' || v === 'off') ? v : 'off';
  }

  // Rule 1: self-mod
  if (modeOf('self-mod') !== 'off' && isSelfMod(toolName, toolInput, baseDir)) {
    return { ruleId: 'self-mod', mode: modeOf('self-mod') };
  }
  // Rule 1b: mode-change — protects the mode switch itself, so a preset
  // cannot be flipped unsupervised regardless of what else is set to off.
  if (modeOf('mode-change') !== 'off' && isCommandTool(toolName, toolInput) && isModeChange(toolInput)) {
    return { ruleId: 'mode-change', mode: modeOf('mode-change') };
  }
  // Rule 2: push-force
  if (modeOf('push-force') !== 'off' && isCommandTool(toolName, toolInput) && isPushForce(toolInput)) {
    return { ruleId: 'push-force', mode: modeOf('push-force') };
  }
  // Rule 3: push-protected
  if (modeOf('push-protected') !== 'off' && isCommandTool(toolName, toolInput) && isPushProtected(toolInput)) {
    return { ruleId: 'push-protected', mode: modeOf('push-protected') };
  }
  // Rule 4: publish
  if (modeOf('publish') !== 'off' && isCommandTool(toolName, toolInput) && isPublish(toolInput)) {
    return { ruleId: 'publish', mode: modeOf('publish') };
  }
  // Rule 5: egress-other
  if (modeOf('egress-other') !== 'off' && isCommandTool(toolName, toolInput) && isEgressOther(toolInput)) {
    return { ruleId: 'egress-other', mode: modeOf('egress-other') };
  }
  // Rule 5b: opaque-exec. Runs after egress-other so a command with a
  // readable egress verb reports that more specific reason first.
  if (modeOf('opaque-exec') !== 'off' && isCommandTool(toolName, toolInput) && isOpaqueExec(toolInput)) {
    return { ruleId: 'opaque-exec', mode: modeOf('opaque-exec') };
  }
  // Rule 6: destructive
  if (modeOf('destructive') !== 'off' && isCommandTool(toolName, toolInput) && isDestructive(toolInput)) {
    return { ruleId: 'destructive', mode: modeOf('destructive') };
  }
  // Rule 7: scope-escalation
  if (modeOf('scope-escalation') !== 'off' && isCommandTool(toolName, toolInput) && isScopeEscalation(toolInput)) {
    return { ruleId: 'scope-escalation', mode: modeOf('scope-escalation') };
  }
  // Rule 8: spend is "off" in v1; no matcher defined.
  return null;
}

// ---------- policy.json load ----------

function isReadableFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    // Probe-read to ensure readability (covers EACCES).
    fs.readFileSync(p, 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Load policy.json, resolving a herding-mode name to its full expansion.
 *
 * `mode` is the source of truth when present and recognized; `modes` is the
 * derived, human-readable expansion, kept in the file for diffability. A
 * file with no `mode` field, or one that doesn't name a known preset, falls
 * back to LEGACY_V1_DEFAULTS for anything it doesn't itself specify — an
 * existing hand-tuned install behaves exactly as it did before herding
 * modes existed, and loads with mode "custom". A file that DOES name a
 * preset but has been hand-edited away from that preset's exact expansion
 * also resolves to "custom": the name should never claim a shape the file
 * no longer has.
 */
function loadPolicy(baseDir) {
  const policyPath = path.join(baseDir, 'policy.json');

  if (!isReadableFile(policyPath)) {
    // First-use write of the default. Ensure baseDir exists.
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      fs.writeFileSync(policyPath, JSON.stringify(DEFAULT_POLICY, null, 2) + '\n', { mode: 0o644 });
    } catch (e) {
      // Could not write — fall through to returning defaults in memory.
    }
    return defaultPolicyCopy();
  }

  let parsed;
  try {
    const text = fs.readFileSync(policyPath, 'utf8');
    parsed = JSON.parse(text);
  } catch (e) {
    // Malformed: return defaults without overwriting the file.
    return defaultPolicyCopy();
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.modes || typeof parsed.modes !== 'object') {
    return defaultPolicyCopy();
  }

  const presetModes = (typeof parsed.mode === 'string' && MODE_NAMES.includes(parsed.mode))
    ? expandMode(parsed.mode)
    : null;
  const fallback = presetModes || LEGACY_V1_DEFAULTS;

  // Merge: known rule ids take from parsed (if a valid mode string), missing
  // or invalid ones fall back. Unknown rule ids in the file are ignored.
  const merged = { ...fallback };
  for (const k of RULE_IDS) {
    const v = parsed.modes[k];
    if (v === 'gate' || v === 'warn' || v === 'off') {
      merged[k] = v;
    }
  }

  let resolvedMode;
  if (presetModes) {
    const matchesPreset = RULE_IDS.every(k => merged[k] === presetModes[k]);
    resolvedMode = matchesPreset ? parsed.mode : 'custom';
  } else {
    resolvedMode = 'custom';
  }

  return { version: parsed.version || 1, mode: resolvedMode, modes: merged };
}

export {
  DEFAULT_POLICY,
  RULE_IDS,
  MODE_NAMES,
  RULE_INFO,
  expandMode,
  loadPolicy,
  evaluate,
  normalizePath,
  pathContainsFragment
};
