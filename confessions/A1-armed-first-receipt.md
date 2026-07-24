# A1 — Armed: your first signed receipt

**State:** open (ongoing)
**Difficulty:** trivial — this is the on-ramp
**Reward:** listed as a verified installer + standing to claim the confession bounties

## What this is

Not a defect bounty. An achievement, and the lowest rung on the board on
purpose. The confession bounties reward finding a hole. This one rewards running
the tool at all. If you have never installed Lotor, start here.

The framing is honest: installing a tool is not a feat of skill, so this does not
pretend to be one. What it is: proof you ran the thing, held by you, in the
tool's own currency. You end up with your own signed receipt that you armed the
gate, and your name goes on the board as a verified installer. That is the
on-ramp, and it is also the first half of every harder bounty here, since
claiming any of those requires a signed receipt too. Clear this rung and the
proof mechanism for the rest is already working on your machine.

## How to earn it

1. Install Lotor and set your approval key (README steps 1 through 4).
2. Register the four hooks (README step 5) and confirm the gate is live:
   `lotor_status` (or `npm run receipts`) should show a session opened.
3. Run one real session and let it close. The `SessionEnd` hook writes and signs
   the receipt.
4. That receipt is the achievement. It shows the gate was armed and a session was
   recorded, on your machine, under your key.

## How to claim

Open a PR (or issue) adding yourself to the verified-installers list, with a
**redacted proof**: a `lotor_status` or `npm run receipts` summary showing the
gate is armed (four hooks registered), the chain verifies intact, and at least
one session opened and closed. Redact the home path and anything about what the
session actually did. The achievement needs proof the gate is armed and
recording, not your private activity. Same redaction discipline the confession
bounties use.

## What you get

- Listed as a verified installer / early adopter. Attribution, not money (the
  first currency across this whole board).
- Standing to claim the confession bounties, with the proof mechanism already
  proven on your machine.
- Your own signed, self-held receipt that you ran a local-first accountability
  layer and it recorded you. Which is, in miniature, the entire pitch.

## The honest note

A receipt proves you armed the gate. It does not prove the gate is bulletproof
(that is what [KNOWN-LIMITS.md](https://github.com/githubscum/lotor/blob/main/KNOWN-LIMITS.md)
is for) and it does not prove you did anything hard. This rung is participation,
not mastery. The mastery rungs are the confessions, and they pay in the same
currency: your name on the thing you found.
