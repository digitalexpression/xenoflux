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

`open` prepares a private copy of the verified installed app named `Codex · NAME`,
with its own bundle identity and the original icon and resources. The bootstrap
sets the profile's home, SQLite, user-home and UI-data paths, then replaces itself
with Codex in the same PID. There is no persistent companion application.
Opening a running profile focuses its recorded instance. The profile app can be
opened through Finder or kept in the Dock; its bootstrap asks Xenoflux to reserve
the profile before starting Codex. Profile sign-in and settings stay with that
profile. The installed app remains unchanged.

Only the bootstrap, copied main executable and outer app are signed locally.
The main receives the Electron runtime grants for JIT, unsigned executable memory
and loading libraries across signing identities. Frameworks and nested helper
apps retain their original publisher signatures and bytes. The bootstrap has no
entitlements, and the copied main does not claim OpenAI's identity or app groups.
Deep signature verification checks the resulting app without re-signing nested
code. An owned stopped copy made with an earlier signing policy refreshes on the
next CLI open; Finder requires that refresh before launching it.

The first launch requires Xcode Command Line Tools for the small AppKit helper.
Generated apps and records live under `CONTROLLER/desktop-instances`, outside
native homes. The copy attempts filesystem cloning where available and otherwise
copies files; it never hardlinks the installed app. Renaming a profile changes its
app label after the desktop stops and is next prepared. A later CLI open refreshes
a stopped copy when the verified installed app or bootstrap changes. If Finder
requests an outdated copy, open it with `xfx desktop open NAME` to refresh it first.

## Isolation and recovery

The Default profile paths remain fixed. Named desktop operations do not change
them or close other clients. A profile's `.run-lock` prevents its managed CLI
and desktop from running at the same time. Different profile homes can run
concurrently. A short operation lock serializes changes to Xenoflux desktop
state. Raw Codex processes can bypass Xenoflux reservations, so open and cleanup
also inspect the selected profile's resource handles.

Preserved vendor helper signatures also retain their application-group
entitlements. Separate filesystem routes do not establish that helpers avoid
shared macOS group state; verify that boundary alongside Default preservation
during real native acceptance.

The CLI native launch uses the application instance returned by macOS for that
request. Finder launches verify their bootstrap's exact PID and controller
parentage, then wait for that same process to become the profile's Codex binary.
Neither route adopts unrelated or preexisting processes. A private receipt
binds the process to its requested profile paths. Focus, close, and recovery
verify the receipt and recorded process identity. The AppKit helper checks the
executable and launch time before activating or requesting a graceful quit.
Control from inside the target process ancestry is refused.

Close treats exited zombie process rows as stopped and waits for remaining
recorded processes and profile handles to drain before
releasing the reservation. Timeouts, reused identities, detached helpers, or
ambiguous launches preserve the record and reservation. If an app is quit
normally outside Xenoflux, `open NAME` can reconcile its stopped, idle record.
For an interrupted launch or close, run `desktop recover NAME` after
the instance stops. Recovery validates its binding, journal and reservation
owner, checks remaining processes and open handles, and releases only its own
reservation. It does not close or launch apps.

## Deferred native acceptance

Development checks use mocked native operations and disposable homes. On macOS,
locally signed fixtures verify compilation, nested framework/helper signatures,
fixed-path routing and same-PID bootstrap execution. An opt-in, windowless AppKit
fixture also exercises the real LaunchServices path, loads a signed framework,
checks its macOS application name and identity, and exits automatically:

```sh
XFX_NATIVE_PROFILE_OPEN=1 node --test test/native-profile-open.test.js
```

That fixture uses a synthetic vendor app. Real Codex sign-in, profile data,
Dock/Cmd+Tab labels and activation still require the acceptance checks below.

When native testing is authorized, use disposable profiles with recognizable
settings and fresh chats. Verify:

- Two profile desktops stay open alongside the ordinary Codex desktop, with
  separate profile home, SQLite, UI-data and enabled diagnostic-log targets.
- Each profile adds exactly one app entry in Dock and Cmd+Tab, named
  `Codex · NAME`, with the Codex icon, and focuses the correct window.
- Reopening from Finder and the Dock retains the intended profile and history.
- Two additional CLI profiles run simultaneously with their own homes.
- Closing one desktop preserves other clients; normal quit, cancelled quit,
  interrupted opening and stopped-instance recovery preserve ownership.

Record the exact desktop/backend versions and observed outcomes before claiming
native concurrency support. Retest native launch and activation after app updates.

The user's native opens on 2026-10-11 failed after the bootstrap started Codex.
Crash reports and kernel logs showed library validation rejecting the re-signed
Codex Framework. The earlier deep signer removed its publisher identity, while
the locally signed main lacked the grant needed to load it. Static signature
checks and an AppKit-only fixture had missed this runtime failure.

A disposable headless experiment reproduced that exact rejection with the real
Codex framework, then loaded it successfully with the library-validation grant.
Signing only the copied main and bootstrap also passed deep strict verification
while preserving the framework's bytes and OpenAI Team ID. Nesting an entirely
untouched vendor app was tested as an alternative, but macOS restored the generic
vendor application name after exec, so it did not meet the profile identity goal.
These experiments did not launch real Codex or change installed/live profile
state. Real Codex launch and the full Dock/Cmd+Tab acceptance remain pending.
