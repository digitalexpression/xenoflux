# Concurrent profile desktop development

Updated: 2026-10-09. Branch: `codex/concurrent-profiles`, based on `60d6f612`.

The user authorized development and requested the clean concurrent model without
legacy switching, restoration, backward compatibility or migration support. Native
testing is deferred because another long-running Codex session must remain open.
No native launch, focus, shutdown, installation, live profile deletion or publication
was performed during development.

Default keeps Codex's standard paths, including `~/.codex`. Named profiles use fixed
homes under `~/.xfx/profiles` by default. Separate AppKit launchers (`Codex · NAME`)
forward activation to a process-specific desktop instance. The signed vendor app is
not copied or modified. Each profile is exclusive across its managed CLI and desktop;
different profiles can run concurrently.

The legacy alias engine, paired-path transactions, activation plans, desktop picker,
`desktop current`, `restore`, no-name `recover`, retired flags, release recovery
helpers and alias-recorded history repair were removed. Copy journals now require
the current v3 format. Named-instance and interrupted CLI/sign-in recovery remain.
Historical metadata is not consulted. Existing profile data need not be deleted to
simplify the code and was left untouched. Read-only inspection found ordinary
Default home/UI directories and a restored historical selection record.

Current operations share a short `.operation` guard. Per-home reservations and exact
instance-owner markers prevent maintenance from quitting named desktops. Removal
and unbinding preserve nonclosed or unreadable desktop journals even if a run lock
is missing; a closed journal can release only its matching leftover control marker.

Implementation commit: `c5a5636`. Verification passed: `npm run check`, `npm test`
(344 tests), `git diff --check`, and scoped static reviews after the removal guard fix.
Fixtures cover two desktop and two CLI profiles alongside an original desktop,
exact-process control, interrupted launches, stale reservations, and maintenance
exclusion. The unchanged production Swift helper was compiled previously in a
disposable controller without execution. These checks do not prove native behavior.

Current candidate:
`release-artifacts/concurrent-profiles-clean-2026-10-09/xenoflux-0.3.0-rc.7.tgz`.
Its manifest records `c5a5636` and package/dependency hashes. Detached offline package
smoke passed, including installed-command, current copy/undo, named-desktop routing
and launcher-generation fixtures, and disposable installation lifecycle. The fake
compiler/helper did not launch a native client. Earlier concurrent-profile candidates
are superseded by this build. Installed xfx remains unchanged.

Next action: when the user is ready, invoke the extracted candidate with disposable
profiles and follow `docs/CONCURRENT-DESKTOPS.md`. Verify native Cmd+Tab, effective
profile routing, sign-in, Finder/Dock reopen, and graceful quit/cancellation while
preserving the ordinary desktop. Record exact versions and observed outcomes before
claiming native concurrency support.
