# Concurrent Codex profiles

Development implementation; native acceptance is pending. The built-in
`Default` profile uses Codex's normal paths, including `~/.codex`. Named
profiles use separate native homes under `~/.xfx/profiles` by default. A profile
has one Xenoflux-managed client reservation at a time.

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

`open` starts the requested profile with explicit home, SQLite, user-home and
UI-data routing, then opens its `Codex · NAME` launcher. Opening a running
profile focuses its recorded instance. Each launcher forwards activation to
that process and can be opened through Finder or kept in the Dock. The signed
vendor application is not copied or modified. Profile sign-in and settings stay
with that profile.

The first launch requires Xcode Command Line Tools for the small AppKit helper.
Generated launchers and records live under `CONTROLLER/desktop-instances`,
outside native homes. Renaming a profile changes its launcher label after the
desktop stops and is next prepared.

## Isolation and recovery

The Default profile paths remain fixed. Named desktop operations do not change
them or close other clients. A profile's `.run-lock` prevents its managed CLI
and desktop from running at the same time. Different profile homes can run
concurrently. A short operation lock serializes changes to Xenoflux desktop
state. Raw Codex processes can bypass Xenoflux reservations, so open and cleanup
also inspect the selected profile's resource handles.

The native launch uses the application instance returned by macOS for that
request. It does not adopt unrelated or preexisting processes. A private receipt
binds the process to its requested profile paths. Focus, close, and recovery
verify the receipt and recorded process identity. The AppKit helper checks the
executable and launch time before activating or requesting a graceful quit.
Control from inside the target process ancestry is refused.

Close waits for the recorded process tree and profile handles to drain before
releasing the reservation. Timeouts, reused identities, detached helpers, or
ambiguous launches preserve the record and reservation. If an app is quit
normally outside Xenoflux, `open NAME` can reconcile its stopped, idle record.
For an interrupted named-instance operation, run `desktop recover NAME` after
the instance stops. Recovery validates its binding, journal and reservation
owner, checks remaining processes and open handles, and releases only its own
reservation. It does not close or launch apps.

## Deferred native acceptance

Development checks use mocked native operations and disposable homes. The
Swift helper is compiled but not executed. Installation, live profile changes,
sign-in, and native launches remain outside those checks.

When native testing is authorized, use disposable profiles with recognizable
settings and fresh chats. Verify:

- Two profile desktops stay open alongside the ordinary Codex desktop, with
  separate profile home, SQLite, UI-data and enabled diagnostic-log targets.
- Each named launcher appears in Cmd+Tab and focuses the correct window.
- Reopening from Finder and the Dock retains the intended profile and history.
- Two additional CLI profiles run simultaneously with their own homes.
- Closing one desktop preserves other clients; normal quit, cancelled quit,
  interrupted opening and stopped-instance recovery preserve ownership.

Record the exact desktop/backend versions and observed outcomes before claiming
native concurrency support. Retest native launch and activation after app updates.
