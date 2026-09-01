/**
 * src/views/reconcile.js
 *
 * The bearing between a charter's declared items and what the chain recorded.
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE bin/retcon.js
 *   Two reasons, and the second is the honest one.
 *
 *   It belongs here. core-paths.js excludes src/views from the non-delegable
 *   core on the stated grounds that rendering "can mislead a human reader,
 *   which is a real risk, but it cannot change what is permitted". This code
 *   compares two lists and formats the answer. It has no authority.
 *
 *   And it could be WRITTEN AND TESTED without a signature, where bin/ could
 *   not. That was the deciding factor at 00:30 with the operator asleep, and
 *   saying so is more useful than pretending it was purely architectural. It
 *   also happens to be the better structure, which is the only reason it was
 *   done rather than deferred.
 *
 * WHAT KNOWN-LIMITS 38 ACTUALLY WAS
 *   The old code built its observed set by calling canonicalizeItem() on a
 *   gated-action receipt's `action`. Charter items are objects; that field is
 *   a bare tool-name string (src/gate/index.js:144). canonicalizeItem throws
 *   on a string, into an empty catch, so the observed set was ALWAYS EMPTY and
 *   every charter reported all items unattempted and nothing undeclared. Both
 *   directions wrong, confidently.
 *
 * THE COVERAGE FACT THAT SHAPES EVERYTHING BELOW
 *   A gated-action receipt carries the tool and never the target (limit 36).
 *   A session receipt carries file paths in `touched` and never commands.
 *   Therefore:
 *
 *     a declared FILE item   can be reconciled, against touched paths
 *     a declared COMMAND item cannot be reconciled, by anything in the chain
 *
 *   The old output collapsed the second case into "declared and never
 *   attempted", which is a confident wrong answer. Here it is its own outcome.
 *
 * IT PRESENTS. IT DOES NOT DETECT.
 *   Unchanged from the retcon's own header. Receipts carry which tools ran and
 *   a digest of params, never intent. Four outcomes are reported and three of
 *   them are shades of "the record cannot say", which is the truthful shape of
 *   this comparison rather than a hedge.
 */

/** Lowercase, forward slashes, no trailing separator. */
function norm(p) {
  if (typeof p !== 'string' || p === '') return '';
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * How do two paths match, if at all? Returns 'exact', 'suffix', or null.
 *
 * The suffix case is needed because a charter is written by a human in relative
 * form ("bin/retcon.js") while `touched` carries whatever the harness recorded,
 * which is usually absolute.
 *
 * STATED AS A LIMITATION RATHER THAN LEFT TO BE FOUND: a suffix match can match
 * two genuinely different files that share a tail, for example the same relative
 * path inside two checkouts. It cannot resolve, because a charter may name a
 * file that does not exist yet and a chain may be read on a different machine
 * than wrote it (limit 9). The failure direction is a FALSE CONFIRMATION,
 * which is the wrong direction.
 *
 * WHY THIS RETURNS A KIND AND NOT A BOOLEAN (2026-08-31, limit 38 narrowed).
 * It used to return true for both, and the caller printed one word, "confirmed",
 * over both. That made the strong case and the ambiguous case indistinguishable
 * in the only place a reader looks. The kind is carried through to the report so
 * the reader can tell which one they were handed. The ambiguity itself is not
 * fixed and cannot be; what is fixed is reporting it as though it were not there.
 */
function pathMatch(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === '' || y === '') return null;
  if (x === y) return 'exact';
  if (x.endsWith('/' + y) || y.endsWith('/' + x)) return 'suffix';
  return null;
}

/** The file path a charter item names, or '' if it names none. */
function itemPath(item) {
  const p = item?.params || {};
  return typeof p.file_path === 'string' ? p.file_path
       : typeof p.path === 'string' ? p.path
       : '';
}

/** The command a charter item names, or '' if it names none. */
function itemCommand(item) {
  const c = item?.params?.command;
  return typeof c === 'string' ? c : '';
}

/**
 * Compare a charter against a reconstructed window.
 *
 * @param {Object} charter  { items: [{ id, action, params }] }
 * @param {Object} r        the retcon fold. Uses `toolsSeen` (Map tool->count),
 *                          `touchedPaths` (Set of path strings) and `sessions`
 *                          (Map, used only to know whether path evidence exists
 *                          at all).
 * @returns {{
 *   confirmed: Array, noEvidence: Array, unreconcilable: Array,
 *   undetermined: Array, toolsNotDeclared: Array<{tool: string, n: number}>,
 *   pathEvidenceAvailable: boolean
 * }}
 */
export function reconcile(charter, r) {
  const items = Array.isArray(charter?.items) ? charter.items : [];
  const touched = r?.touchedPaths instanceof Set ? [...r.touchedPaths] : [];
  const toolsSeen = r?.toolsSeen instanceof Map ? r.toolsSeen : new Map();

  // Path evidence exists only once a session receipt has CLOSED inside the
  // window, because `touched` is written at session end and nowhere else.
  // While a session is still running there is nothing to compare against, and
  // the old code read that empty room and reported it as an empty plan.
  const pathEvidenceAvailable = (r?.sessions instanceof Map ? r.sessions.size : 0) > 0;

  const confirmed = [];
  const noEvidence = [];
  const unreconcilable = [];
  const undetermined = [];

  for (const item of items) {
    const fp = itemPath(item);

    if (fp === '') {
      // A command item, or an item naming neither. Nothing in the chain can
      // answer it: gate receipts have no command string, session receipts have
      // no commands. Reported as its own outcome, never as "never attempted".
      unreconcilable.push({
        item,
        why: itemCommand(item)
          ? 'receipts record no command strings, so a declared command cannot be checked'
          : 'this item names neither a file nor a command'
      });
      continue;
    }

    if (!pathEvidenceAvailable) {
      undetermined.push({ item, why: 'no session has closed in this window, so touched does not exist yet' });
      continue;
    }

    // An exact match, when one exists, is the answer. A tail-only match is
    // still a confirmation, because the relative-charter-versus-absolute-record
    // case is the ordinary one and downgrading it would break what this is for.
    // It is LABELLED rather than downgraded, and the caveat block counts it.
    const exact = [];
    const suffix = [];
    for (const t of touched) {
      const kind = pathMatch(t, fp);
      if (kind === 'exact') exact.push(t);
      else if (kind === 'suffix') suffix.push(t);
    }

    if (exact.length > 0 || suffix.length > 0) {
      const matchKind = exact.length > 0 ? 'exact' : 'suffix';
      const matchedPaths = exact.length > 0 ? exact : suffix;
      // Two distinct recorded paths matching one declared tail is the false
      // confirmation happening in front of us: at most one of them can be it.
      const distinct = new Set(matchedPaths.map(norm)).size;
      confirmed.push({
        item,
        matchedBy: 'touched',
        matchKind,
        matchedPaths,
        ambiguous: matchKind === 'suffix' && distinct > 1
      });
    } else {
      noEvidence.push({ item, why: 'no closed session in this window reported touching it' });
    }
  }

  // A tool used in the window that no declared item names. Coarse ON PURPOSE:
  // the chain knows the tool and not the target (limit 36), so this can say
  // "an Edit happened that no item asked for" and can never say which file.
  const declaredTools = new Set(
    items.map(i => String(i?.action || '')).filter(Boolean)
  );
  const toolsNotDeclared = [];
  for (const [tool, n] of toolsSeen) {
    if (!declaredTools.has(tool)) toolsNotDeclared.push({ tool, n });
  }
  toolsNotDeclared.sort((a, b) => b.n - a.n);

  return {
    confirmed, noEvidence, unreconcilable, undetermined,
    toolsNotDeclared, pathEvidenceAvailable,
    // Counted here so a renderer does not have to know the shape of a
    // confirmation to say the honest thing about it.
    confirmedBySuffixOnly: confirmed.filter(c => c.matchKind === 'suffix').length,
    ambiguousConfirmations: confirmed.filter(c => c.ambiguous).length
  };
}

/**
 * The closing caveat, DERIVED from the counts.
 *
 * KNOWN-LIMITS 39: the previous version printed "This shows that items 3 and 7
 * never ran and that four things ran which were not on the list" as hardcoded
 * prose, regardless of the data, inside the block headed WHAT THIS DOES NOT
 * TELL YOU. In the run that found it, those invented numbers contradicted the
 * computed figures six lines above in the same report.
 *
 * A caveat that invents specifics is worse than no caveat, because a reader who
 * distrusts the numbers will trust the disclaimer. So this states only what was
 * actually counted, and says nothing numeric when there is nothing to say.
 */
export function deviationNote(out) {
  const n = k => (Array.isArray(out?.[k]) ? out[k].length : 0);
  const noEvidence = n('noEvidence');
  const unreconcilable = n('unreconcilable');
  const undetermined = n('undetermined');
  const notDeclared = n('toolsNotDeclared');
  const int = k => (Number.isInteger(out?.[k]) ? out[k] : 0);
  const suffixOnly = int('confirmedBySuffixOnly');
  const ambiguous = int('ambiguousConfirmations');

  const lines = [
    'Receipts carry which tools ran and a digest of their parameters.',
    'They carry no intent, ever. Read any deviation as a question, not a verdict.'
  ];

  const facts = [];
  if (noEvidence > 0) {
    facts.push(`${noEvidence} declared item(s) have no matching path in any closed session`);
  }
  if (undetermined > 0) {
    facts.push(`${undetermined} could not be checked yet because no session has closed in this window`);
  }
  if (unreconcilable > 0) {
    facts.push(`${unreconcilable} cannot be checked by anything in the chain, because receipts record no command strings`);
  }
  if (notDeclared > 0) {
    facts.push(`${notDeclared} tool(s) were used that no declared item names`);
  }
  if (suffixOnly > 0) {
    facts.push(`${suffixOnly} confirmation(s) rest on a path-tail match, not an exact one`);
  }

  if (facts.length === 0) {
    lines.push('Nothing was counted on either side of the comparison here.');
  } else {
    lines.push('This run counted: ' + facts.join('; ') + '.');
  }

  if (unreconcilable > 0 || undetermined > 0) {
    lines.push('An item this cannot check is NOT an item that did not run.');
  }

  // Limit 38's residual, said out loud at the only moment a reader can act on
  // it. Silent when nothing rests on a tail match, per limit 39: this block
  // states what was counted and never what would have sounded good.
  if (suffixOnly > 0) {
    lines.push('A tail match means a path CONSISTENT with the item was touched, never that the declared file was the one. The same relative path in two checkouts matches identically.');
  }
  if (ambiguous > 0) {
    lines.push(`${ambiguous} of those matched more than one distinct recorded path, so at most one of the matches can be the declared file.`);
  }

  return lines.join('\n');
}
