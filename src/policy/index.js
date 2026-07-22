/**
 * src/policy/index.js
 *
 * PreToolUse policy engine for Lotor's gated-runs hook (v1).
 *
 * The rule TABLE is locked (see gated-runs-policy-2026-07-22.md). The user's
 * policy.json only sets the mode (gate | warn | off) per rule id. There is
 * no user-defined regex in v1.
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

const DEFAULT_POLICY = {
  version: 1,
  modes: {
    'self-mod': 'gate',
    'push-force': 'warn',
    'push-protected': 'warn',
    'publish': 'warn',
    'egress-other': 'warn',
    'destructive': 'warn',
    'scope-escalation': 'warn',
    'spend': 'off'
  }
};

const RULE_IDS = Object.keys(DEFAULT_POLICY.modes);

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

// ---------- self-mod matcher ----------

const SELF_MOD_PATH_FRAGMENTS = [
  '.claude/settings.json',
  'src/gate/',
  'src/policy/',
  // bin/hook-*.js — handled separately as a regex so it matches hook-session-end.js etc.
  // <baseDir>/keys/ and <baseDir>/policy.json — handled with dynamic baseDir.
];

/**
 * Build the set of self-mod fragments that depend on baseDir (Lotor home).
 */
function selfModFragmentsForBase(baseDir) {
  return [
    '.claude/settings.json',
    'src/gate/',
    'src/policy/',
    normalizePath(path.join(baseDir, 'keys')) + '/',
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
 * Check whether a Bash tool_input's command string hits the self-mod rule.
 * Any of the self-mod path fragments appearing as a substring in the command.
 */
function isSelfModBash(toolInput, baseDir) {
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
  if (cmd === '') return false;
  const cmdNorm = normalizePath(cmd);
  const fragments = selfModFragmentsForBase(baseDir);
  for (const frag of fragments) {
    if (frag.endsWith('/')) {
      if (cmdNorm.includes(frag)) return true;
    } else {
      if (cmdNorm.includes(frag)) return true;
    }
  }
  // bin/hook-*.js anywhere in the command
  if (cmdNorm.match(/bin\/hook-[^/\s'"]+\.js/)) return true;
  return false;
}

export function isSelfMod(toolName, toolInput, baseDir) {
  if (toolName === 'Bash') return isSelfModBash(toolInput, baseDir);
  return isSelfModEdit(toolName, toolInput, baseDir);
}

/**
 * Detect `git push` with --force / --force-with-lease / -f. Guard against
 * false positives: -f must be its own token (not a substring of --follow
 * or a longer flag), and it must be in a context that means "force push",
 * which we approximate as: the -f appears anywhere in a `git push` command
 * that is NOT attached to another single-letter flag.
 */
export function isPushForce(toolInput) {
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
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
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
  if (!/\bgit\s+push\b/.test(cmd)) return false;
  // Match `git push <ref>` or `git push <remote> <ref>` where ref is main/master.
  // We require the main/master token to appear as a standalone word after `git push`.
  // Using a simple approach: the command contains `git push` followed somewhere
  // by `main` or `master` as a word.
  const after = cmd.split(/\bgit\s+push\b/)[1] || '';
  return /\b(main|master)\b/.test(after);
}

// ---------- publish matcher ----------

export function isPublish(toolInput) {
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
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
  // PowerShell: -Body
  if (/(^|\s)-Body\b/.test(cmd)) return true;
  return false;
}

function usesEgressTool(cmd) {
  if (/\bcurl\b/.test(cmd)) return true;
  if (/\bwget\b/.test(cmd)) return true;
  if (/\bInvoke-WebRequest\b/i.test(cmd)) return true;
  if (/\biwr\b/.test(cmd)) return true;
  return false;
}

function usesRemoteCopyTool(cmd) {
  if (/\bssh\s+/.test(cmd)) return true;
  if (/\bscp\s+/.test(cmd)) return true;
  if (/\brsync\s+/.test(cmd)) return true;
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

export function isEgressOther(toolInput) {
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
  if (cmd === '') return false;
  if (usesRemoteCopyTool(cmd) && isRemoteCopyTarget(cmd)) return true;
  if (usesEgressTool(cmd) && (hasHttpMethodFlag(cmd) || hasDataFlag(cmd)) && !isLocalhostTarget(cmd)) {
    return true;
  }
  return false;
}

// ---------- destructive matcher ----------

const DESTRUCTIVE_ALLOWLIST = ['/tmp', 'temp', 'scratchpad', 'mktemp'];

function destructiveAllowlisted(target) {
  const t = target.toLowerCase();
  return DESTRUCTIVE_ALLOWLIST.some(frag => t.includes(frag));
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
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
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
  const cmd = typeof toolInput?.command === 'string' ? toolInput.command : '';
  if (cmd === '') return false;
  return /\bschtasks(\.exe)?\s+\/create\b/i.test(cmd)
    || /\bRegister-ScheduledTask\b/i.test(cmd)
    || /\bsc\s+create\b/i.test(cmd)
    || /\bNew-Service\b/i.test(cmd)
    || /\bcrontab\b/.test(cmd);
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
  // Rule 2: push-force
  if (modeOf('push-force') !== 'off' && toolName === 'Bash' && isPushForce(toolInput)) {
    return { ruleId: 'push-force', mode: modeOf('push-force') };
  }
  // Rule 3: push-protected
  if (modeOf('push-protected') !== 'off' && toolName === 'Bash' && isPushProtected(toolInput)) {
    return { ruleId: 'push-protected', mode: modeOf('push-protected') };
  }
  // Rule 4: publish
  if (modeOf('publish') !== 'off' && toolName === 'Bash' && isPublish(toolInput)) {
    return { ruleId: 'publish', mode: modeOf('publish') };
  }
  // Rule 5: egress-other
  if (modeOf('egress-other') !== 'off' && toolName === 'Bash' && isEgressOther(toolInput)) {
    return { ruleId: 'egress-other', mode: modeOf('egress-other') };
  }
  // Rule 6: destructive
  if (modeOf('destructive') !== 'off' && toolName === 'Bash' && isDestructive(toolInput)) {
    return { ruleId: 'destructive', mode: modeOf('destructive') };
  }
  // Rule 7: scope-escalation
  if (modeOf('scope-escalation') !== 'off' && toolName === 'Bash' && isScopeEscalation(toolInput)) {
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
    return { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes } };
  }

  let parsed;
  try {
    const text = fs.readFileSync(policyPath, 'utf8');
    parsed = JSON.parse(text);
  } catch (e) {
    // Malformed: return defaults without overwriting the file.
    return { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes } };
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.modes || typeof parsed.modes !== 'object') {
    return { ...DEFAULT_POLICY, modes: { ...DEFAULT_POLICY.modes } };
  }

  // Merge: known rule ids take from parsed, missing ones default. Unknown
  // modes are ignored (treated as "off" for that rule? No — we just leave
  // them and let evaluate() fall back to default). For v1, the contract is:
  // user sets per-rule mode strings; any unknown value is treated as a
  // non-match by evaluate's truthy check, but to keep this clean we coerce
  // to the set { 'gate', 'warn', 'off' } and let others fall through.
  const merged = { ...DEFAULT_POLICY.modes };
  for (const k of Object.keys(DEFAULT_POLICY.modes)) {
    const v = parsed.modes[k];
    if (v === 'gate' || v === 'warn' || v === 'off') {
      merged[k] = v;
    }
    // else leave as default
  }
  return { version: parsed.version || 1, modes: merged };
}

export {
  DEFAULT_POLICY,
  RULE_IDS,
  loadPolicy,
  evaluate,
  normalizePath,
  pathContainsFragment
};
