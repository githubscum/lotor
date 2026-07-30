# CLAUDE.md — working in this repo

This is Lotor: a local-first receipt layer and gate for agent sessions. Its own thesis is structural, not behavioral — a rule enforced by code holds regardless of which model is enforcing it; a rule left to a model's judgment produces a different experience every time a different model runs it. That applies to how you, the agent working in this repo, behave when the gate fires.

## When the gate blocks you

The `PreToolUse` hook denies with exit code 2 and prints a fixed-shape message: a plain-English title (with the rule id as a technical suffix), what matched, any agent-stated purpose labelled as unverified, why it matters, how risky it is, exactly what the signature does and does not cover, and one command that runs as printed (`npm run approve -- --request <id>`). That message is designed to stand on its own. Read cold, by a human who has read none of this file, it should still be enough to decide.

Your job around that message has four beats. Do all four, in order, every time:

1. **Stage first.** Never let the gate be the first thing the owner hears about. If you are about to do something you expect to be gated (editing a `bin/*.js` hook, `src/policy/`, `src/gate/`, `.claude/settings.json`, or anything else self-mod protects), say so before you attempt it, and prefer writing the artifact somewhere reviewable first when that is practical.

2. **Give the path.** If a file was created or changed, state its path so the owner can open and read it themselves, before a signature is requested. Do not ask for a signature on something the owner has not had the chance to see.

3. **Relay, do not rewrite.** When the gate denies, paste its stderr output as-is. Do not summarize it, soften it, translate its risk language into something gentler, or decide on the owner's behalf that a warning doesn't apply this time. The message was written to be complete; your job is to deliver it, not edit it.

4. **Wait.** No retry loop, no alternate route around the block, no quietly finding an unprotected path that achieves the same end. State plainly what stays undone until it is signed, then stop and let the owner act.

## Why this is in the repo, not just in your instructions

This file travels with the code. Any agent — this session, a different model, a future one — that opens this repo reads the same four beats. The alternative, leaving the ceremony to be reconstructed from context each time, is exactly the inconsistency this system exists to remove from everything else it touches.

## Scope

This contract governs sessions working inside this repository. The gate itself is registered user-globally (see the README's install steps), so it fires in every repo on this machine — but only a session working here has this file loaded. Outside this repo, the printed denial message is what has to carry the weight alone, which is why its own completeness matters more than these four beats do.
