# Desktop implementation and verification

Audience: developers and reviewers. For normal commands and recovery, see the
[user desktop guide](../user/DESKTOP.md).

## Profile apps and the packaged launcher

Each private `Codex · NAME.app` contains the verified vendor app's resources,
a profile bundle identity and the packaged AppKit bootstrap. The bootstrap sets
fixed profile paths, then execs the vendor binary without changing its PID.
Generated apps and records live under `CONTROLLER/desktop-instances`; the copy
uses filesystem cloning when available and never hardlinks the installed app.
Current cache misses or stopped stale caches are prepared by CLI `desktop open`;
running opens use their pinned app and helper before current-package loading.
Finder/Dock launches reserve their profile but cannot refresh the executing app.

Desktop retains the logged-in macOS account's normal `HOME` so Security.framework
can find the login keychain. An isolated Desktop `HOME` caused the native
"Keychain Not Found" prompt. Xenoflux does not create or reset keychains or change
their search lists. CLI launches still use an isolated `user-home`. Desktop
resources discovered through the account home remain account-wide; the explicit
Codex and UI-data routes provide the profile storage boundary.

Only the bootstrap, copied main executable and outer app are signed locally.
The main receives the Electron runtime grants for JIT, unsigned executable memory
and loading libraries across signing identities. Frameworks and nested helper
apps retain their original publisher signatures and bytes. The bootstrap has no
entitlements, and the copied main does not claim OpenAI's identity or app groups.
Deep signature verification checks the resulting app without re-signing nested
code. An owned stopped copy made with an earlier signing policy is refreshed on
the next CLI open.

Users do not need Swift or Xcode Command Line Tools. The package ships a prebuilt
launcher for arm64 and x86_64 Macs (macOS 13 or later). Preparation verifies its
source and binary hashes and copies it into a private cache keyed by binary hash;
it never falls back to local compilation. Older helper entries remain available
for running instances. macOS's built-in `codesign` still signs customized profile
apps when their cache is missing or stale.

When the Swift source changes, package maintainers run `npm run build:native` on
a Mac with Xcode Command Line Tools, then `npm run check:native`. Commit the
universal binary and its manifest with the source. There are no compilation hooks
on install or pack. The check validates source and binary hashes, architectures,
and signature. A missing, stale, or damaged shipped helper requires a corrected
xfx package rather than a compiler on the user's Mac.
Renaming a profile changes its app label after the desktop stops and is next
prepared. CLI open detects changes
to the verified installed app, bootstrap, or signing policy and refreshes the
stopped copy. Finder and Dock launches cannot refresh a stale copy; use CLI open
to refresh it.

## Process identity and isolation boundaries

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
executable and kernel process start time before activating or requesting a graceful quit.
Native receipts use the same kernel timestamp source as `ps`, and process records
use explicit UTC timestamps. Process inspection uses an English UTF-8 locale so
macOS preserves Unicode executable paths. A mismatch reports both identities and
preserves the reservation.
Control from inside the target process ancestry is refused.

Close treats exited zombie process rows as stopped and waits for remaining
recorded processes and profile handles to drain before
releasing the reservation. After graceful quit, an unavailable `ps` command label
with the same PID, UID and start time keeps close waiting; it is never adopted
or controlled. Timeouts, reused identities, detached helpers, or
ambiguous launches preserve the record and reservation. If an app is quit
normally outside Xenoflux, `open NAME` can reconcile its stopped, idle record.
For an interrupted launch or close, run `desktop recover NAME` after
the instance stops. Recovery validates its binding, journal and reservation
owner, checks remaining processes and open handles, and releases only its own
reservation. It does not close or launch apps.

## Verification and native acceptance

Development checks use mocked native operations and disposable homes. On macOS,
locally signed fixtures verify packaged bootstrap execution, nested framework/helper signatures,
fixed-path routing and same-PID bootstrap execution. An opt-in, windowless AppKit
fixture also exercises the real LaunchServices path, loads a signed framework,
checks its macOS application name and identity, compares native/kernel/`ps`
timestamps across the shipped prebuilt bootstrap, exercises automatic controller preparation,
open, repeated-open focus, stopped-instance reopen and fixture close,
rejects a quit with the wrong start time, and exits automatically:

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

## Known native failure modes

- Re-signing nested vendor frameworks broke library validation. Preserve their
  publisher signatures and give only the copied main the required Electron grants;
  static signature checks alone did not reveal that runtime failure.
- An isolated Desktop HOME caused "Keychain Not Found". Desktop resolves the
  logged-in account HOME; CLI keeps its isolated user-home.
- ASCII process output mangled Unicode app paths and caused receipt mismatches.
  Observe processes with UTF-8 output and compare kernel-derived start times.

The user confirmed concurrent open and correct repeat-open focus on 2026-10-11.
The 2026-10-12 follow-up verified the packaged launcher, opened two comparison profiles and repeated each open with unchanged process
identity and start time. Final observations reported both running. Exact results, dated
investigations and the 1.0.0 publication record live in the
[concurrent profile handover](HANDOVER-macos-concurrent-profiles.md). This evidence does not establish current
process state or the remaining native acceptance checks above.
