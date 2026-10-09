# Concurrent Codex desktop profiles

Development implementation; native acceptance is pending. Each named desktop and
CLI instance uses its profile's existing native home. A profile has one managed
client reservation at a time. Configuration overlays supplied by Codex's native
`--profile` option are separate from Xenoflux native homes. The `Default` profile
uses Codex's standard paths, including `~/.codex`. Named profiles use
`~/.xfx/profiles` by default, but creation or registration may choose another base.
An existing alias selection may remain active until explicitly restored.

## Commands

```sh
xfx desktop open NAME --dry-run
xfx desktop open NAME
xfx desktop list --observe
xfx desktop focus NAME
xfx desktop close NAME
xfx desktop recover NAME --dry-run
xfx desktop recover NAME
```

`open` starts a desktop using explicit profile home, SQLite, user-home and UI-data routing,
then opens a named `Codex · NAME` launcher. Opening it again focuses the recorded
instance. The launcher remains present while its target lives and forwards
activation to that process. Its generated application path is returned by `open`
and `list`; it can be opened through Finder or kept in the Dock. The vendor's
signed app is not copied or modified. Native sign-in and settings remain owned by
each profile under [the profile copy policy](PROFILE-COPY-POLICY.md).

The first launch requires Xcode Command Line Tools for its AppKit helper. The
source and compiled-helper hashes key a private controller cache. Generated
applications and records live under `CONTROLLER/desktop-instances`, outside the
native homes. Profile renames take effect in the launcher when it is next prepared
after its desktop stops. A running launcher retains its original display label.

Named profile desktops leave the default path aliases unchanged. Restore any active
legacy selection before opening a named desktop. For an unfinished selection, run
no-name `recover --no-open` first, then restore. The legacy `switch`, `pick`, `activate`,
`activation-plan` and `add-target` selection commands are retired; `current`,
`restore` and no-name `recover` remain to inspect or reconcile existing selection
state. A legacy desktop reservation is shared across controller stores, so an active
selection in another store also blocks named opening until it is restored.

## Ownership and recovery

Each instance reserves the existing profile `.run-lock`. A short desktop-operation
guard serializes native opens and excludes alias switching during changes; it does
not prevent other profiles from remaining active. Private global control-owner
markers exclude bundle-wide legacy operations while named instances remain reserved;
closing or recovering an instance removes only its own marker. CLI launches retain their existing
independent per-profile locks. Unmanaged processes can bypass Xenoflux reservations,
so opening and cleanup also inspect the selected profile's resource handles.

The native launch uses the exact application returned by macOS for that request;
unrelated new processes and preexisting mains are never adopted. A private,
write-once receipt binds that process to the requested profile's paths. Focus and
close require the journal to match that receipt and check the recorded PID,
executable, user and start time. The native
helper checks the application executable and launch time again before activating
or requesting a graceful quit. Invoking control from inside the target's process
ancestry is refused. No force kill or bundle-ID quit is used for concurrent instances.

Closing waits for the recorded app process tree to drain and for profile handles to
be idle before releasing its reservation. A native quit confirmation may need a
response in Codex. Timeout, reused identities, or detached helpers preserve the
record and reservation. List output distinguishes saved state from live process
observation; neither proves effective runtime configuration.

If the app was quit normally outside Xenoflux, `open NAME` can reconcile its stopped,
idle record before reopening. For an interrupted named-instance operation, use
`desktop recover NAME` once that instance has stopped. For an interrupted legacy
selection, use no-name `desktop recover`; `desktop restore` returns to the standard
default paths. Named-instance recovery validates the original binding,
journal and exact reservation owner, checks remaining processes and open handles,
and releases only its own reservation without closing other clients or launching
anything. Legacy `recover --no-open` requires clients already stopped and does
not reopen Codex. An ambiguous launch preserves ownership; newly observed but unattributed
desktop mains block cleanup until they have stopped. Preserve records when identity
or ownership cannot be established.

## Deferred native acceptance

The user has an ongoing session that must stay open. Development checks use mocked
native operations and disposable homes. The Swift helper is compiled without being
executed. Installation, live-profile changes, sign-in, and native launches are
outside those checks.

When native testing is authorized, use disposable profiles with recognizable
settings and fresh chats. Verify:

- Two profile desktops stay open alongside the original session, with separate
  profile home, SQLite, UI-data and enabled diagnostic-log targets.
- Each named launcher is selectable in Cmd+Tab and focuses the correct Codex
  window. Check this explicitly; extra launcher icons alone are insufficient.
- Reopening from Finder and the Dock retains the intended profile and history.
- Two additional CLI profiles run simultaneously, without changing the original
  session or either desktop's paths.
- Closing one desktop preserves the other clients; normal quit, cancelled quit,
  interrupted opening and stopped-instance recovery preserve ownership correctly.

Record the exact desktop/backend versions and observed outcomes before claiming
native concurrency support. Retest native launch and activation after app updates.
