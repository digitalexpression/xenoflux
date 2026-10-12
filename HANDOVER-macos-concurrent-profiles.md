# Concurrent profile desktop development

Updated: 2026-10-12. Branch: `main`; `codex/concurrent-profiles` merged through PR #4.

## Goal and authority

Multiple fixed-profile CLI/Desktop instances, one recognizable `Codex · NAME`
Dock/Cmd+Tab entry per Desktop profile. Default retains normal paths including
`~/.codex`; named Codex/UI data remains under `~/.xfx/profiles`. Preserve the
ordinary long-running Codex session. Local source work and disposable checks are
authorized; the user supplied the real-profile acceptance below and explicitly
authorized PR merge and GitHub/npm publication. Publication completed without
live profile/app/keychain mutation, client closure or installation.

## Native open/focus acceptance on 2026-10-12

The user ran the packaged launcher check successfully, then opened RC3 Check and
Advanced Check and repeated each open. Terminal output recorded:

| Profile | First open | PID | Start seconds | Repeated open |
| --- | --- | --- | --- | --- |
| RC3 Check | opened at 09:43:03 UTC | 66357 | 1791798183 | focused, same PID/start |
| Advanced Check | opened at 09:43:41 UTC | 67811 | 1791798221 | focused, same PID/start |

The final `desktop list --observe` reported both instances running, with their
own profile-labelled executable paths and descendant processes, and
`liveHomeChanged: false`. Before opening, the old journal entries still said
running but process observation reported stopped with no processes for either
old PID (1836 and 3106). These were fresh launches from stopped records; the
commands did not close a live instance.

This establishes actual concurrent startup and repeat-open focus using the
current checkout after packaged-launcher validation. The transcript alone does
not measure compilation/signing calls or prove all sign-in/data isolation,
Dock/Cmd+Tab, Intel execution, or Default-preservation checks. No agent-side
live-profile operation was performed to record these results.

## Version 1.0.0 merged and published

[PR #4](https://github.com/digitalexpression/xenoflux/pull/4) passed both macOS
CI jobs (Node 22.13.0 and 24) on its final head
`2f91c8d2e3d2f96c57e95d85240f00863b7f4caa`. It was squash-merged into main on
2026-10-12 at 13:31:46 Europe/Bucharest (10:31:46 UTC), producing
`f35a08478f1f4244a4e22f40af2781a8a6eb6fd9`.

[GitHub release v1.0.0](https://github.com/digitalexpression/xenoflux/releases/tag/v1.0.0)
was published on 2026-10-12 at 13:33:15 Europe/Bucharest (10:33:15 UTC), as a
stable release, not a draft or prerelease. Its tag targets the merged commit above.
It includes all four verified assets:

- `xenoflux-1.0.0.tgz`
- `smol-toml-1.9.0.tgz`
- `manifest.json`
- `install.mjs`

[npm xenoflux@1.0.0](https://www.npmjs.com/package/xenoflux/v/1.0.0) is publicly
available under the `latest` tag; `preview` remains at `0.3.0-rc.7`. After npm
processing completed, the public version/tag and downloaded tarball were verified.
The npm download matched the GitHub asset and release manifest SHA-256:
`762b197136363998507559da4d3c3257ee0806ca702298fab4e1d3927efb3e87`.
The npm SHA-1 is `76c0cf762e1f7a144769905bd776c635311c2e4d`.

The final bundle was built from the merged commit under
`release-artifacts/1.0.0`, replacing the earlier branch candidates as the release
of record. Its manifest pins that exact source revision, records dependency and
package hashes, and reports a passed detached offline installed-package and
installation-lifecycle smoke check. `npm run check:native` also passed on the
merged source; the local suite had 385 passes and one opt-in native skip. The
published tag and artifacts remain tied to the release commit; subsequent
handover-only commits do not alter the published package.

Release scope confirmed by the user on 2026-10-12: 1.0.0 is the first stable
release. Migration from older preview installations is unsupported and is not a
release requirement. The review findings about removed paired restore/resume
paths and v1/v2 copy-journal recovery are therefore out of scope, not blockers.
Do not reintroduce legacy compatibility or inspect/mutate live installations to
implement a migration. Current v3 journal validation and cached running-instance
preservation remain in place. Native acceptance limits above remain distinct
from the successful open/focus test and publication.

The user's running instances were not closed or installed over. Temporary npm
authentication files used for publication were removed; existing npm configuration
was left unchanged. Release artifacts are ignored local outputs, not PR contents.

## Prebuilt launcher package

The package now ships `src/native/XfxProfileLauncher`, a signed universal Mach-O
for arm64 and x86_64 targeting macOS 13, with a source/binary hash manifest.
Runtime preparation verifies the packaged bytes and copies them; it never calls
Swift or falls back to a compiler. Maintainers explicitly run `npm run build:native`
after Swift changes and `npm run check:native` before packaging. Install/pack hooks
do not compile anything. Customized profile apps still use macOS codesign on a
cache miss or refresh; valid cached apps are reused.

Private helper entries use binary hashes so a new package cannot overwrite a
legacy or running instance's pinned helper. The live open/focus path is unchanged
and bypasses current-package loading. No real profile/app, journal, keychain,
installation or running instance was modified during this work.

Verification: 385 full-suite tests passed, with the opt-in native fixture skipped;
the separate native fixture passed open, repeat-open focus, stopped reopen and
close using the shipped launcher. Six tests also passed from an offline packed
and detached package, confirming packaged bytes/mode, compiler-free preparation,
cache reuse, legacy helper preservation and invalid-package refusal. Syntax,
manifest/architecture/signature/entitlement checks and diff checks passed. Native
execution was verified on Apple Silicon; the Intel slice was cross-built and
inspected, not executed on Intel hardware. Release generation requires these
package inputs to be tracked and the source tree clean.

## Single-command cached opens

The latest user request supersedes the explicit preparation workflow: normal
users run only `desktop open NAME`. Open first focuses a verified running
instance without loading or refreshing the cache. Otherwise it reconciles a
validated stopped journal and its own reservation, loads a valid cached app,
and prepares or refreshes only on `PROFILE_APP_PREPARE_REQUIRED` or
`PROFILE_APP_REFRESH_REQUIRED`. Ownership, integrity and signature failures
remain refusals. A dead operation guard is released only for the exact same
host/store/profile/journal; live and foreign guards stay untouched. Missing
run-locks can be reconciled only for stopped instances, never live ones.

`desktop prepare NAME`, `desktop refresh NAME`, and `desktop recover NAME` remain
explicit maintenance/debugging tools. Cached apps are reused on normal opens;
first opens and stale stopped caches copy the prebuilt helper and sign as needed. A Finder
bootstrap cannot refresh its executing bundle and asks for CLI open instead.
Preparation also refuses raw processes executing from that profile's app root.

The user reported a repeated RC3 open with `RESOURCE_INSPECTION_FAILED` after
opening PID 76877. A read-only host check found that recorded process stopped and
all five profile-resource lsof calls idle (exit 1, empty stdout/stderr). The earlier
failure was not reproduced; no crash or focus failure is established by that
observation. Resource inspection now reports the stage/path and bounded reason
without dumping arbitrary process output or resource contents. Its fail-closed
semantics remain unchanged. No live profile preparation, recovery, launch,
signing or closure was performed by this development turn.

Verification: 379 full-suite checks passed with the opt-in native test skipped.
The separate host-permission native fixture passed automatic cache-miss
preparation, LaunchServices open, same-PID repeated-open focus, stopped-journal
reconciliation and cached reopen without another preparation, wrong-start quit
refusal, and controller close of its own synthetic app. The successful retry
cleaned up its disposable files. Its kernel/native/ps timestamps agreed.
`npm run check` and `git diff --check` passed. Independent source review found no
actionable automatic-open defect. Logs: `/private/tmp/xfx-auto-open-tests.log`
and `/private/tmp/xfx-auto-open-native.log`.

User acceptance on 2026-10-11: RC3 Check opened as PID 1836 and Advanced Check
as PID 3106. Repeated opens returned `focused` with the same PID and start time
for each profile; `desktop list --observe` reported both running with their own
app paths and descendants. The user confirmed focus reached the correct instance.
This establishes real concurrent open and repeated-open focus. Full Dock/Cmd+Tab
labels, sign-in, data isolation and Default preservation still require their
separate acceptance checks.

## Current result and causes

The previous signer fix (4d7fc7e) preserved nested vendor code and allowed the
user's RC3 Check GUI to open. The user cancelled a “Keychain Not Found” prompt;
Xenoflux still returned `DESKTOP_OPEN_RECEIPT_MISMATCH`.

Two causes now have bounded reproductions:

- An interaction-disabled, read-only `SecKeychainCopyDefault` probe returned
  -25307 under a disposable HOME, and success with the normal login-keychain
  path under the account HOME. No credentials were read and no keychain setting
  changed. Desktop now derives HOME from the macOS account; CLI keeps its
  isolated user-home. Explicit Codex, SQLite, UI-data and temporary routes stay
  profile-specific. Account-home discovery remains account-wide.
- The full native controller fixture failed on an identical PID/UID/start:
  native receipt path `Codex · NAME` versus ASCII-locale ps path
  `Codex M-BM-7 NAME`. A disposable sleep binary reproduced that rendering.
  Process inspection now uses English UTF-8 and explicit UTC timestamps.

The native receipt and focus/quit helper use kernel process start time, matching
ps, rather than NSRunningApplication.launchDate. Delayed bootstrap tests did not
show different clock values; Unicode rendering was the demonstrated mismatch.
Errors now include the expected and observed identity without credential data.
Finder still requires exact bootstrap PID/UID/start and same-PID exec.

The full native close check also reproduced a quitting process briefly shown by
ps as `S (Codex)` with unchanged PID/UID/start. The local ps manual describes this
fallback when argv is unavailable. After graceful quit, close only waits through
that uncertain label; it never adopts or controls it and never releases ownership
until the process disappears. Different lifetimes/executable paths fail closed;
a timeout preserves the last verified identity and reservation.

## Verification and limits

The updated opt-in fixture passed under a controller `TZ=UTC` on this Bucharest
Mac. It exercises production controller open/focus/close, delayed same-PID exec,
native profile name and bundle ID, independent framework loading, fixed Codex/UI
routes and account HOME, and matching kernel/native/UTC-ps start seconds. A quit
with the wrong start time is refused. It observed the actual `(Codex)` shutdown
fallback and then closed successfully. Disposable fixtures exit automatically.
The normal bootstrap signing/routing tests passed, including inherited foreign
HOME rejection. Final verification passed:

- `TZ=UTC XFX_NATIVE_PROFILE_OPEN=1 node --test --test-concurrency=2 test/*.test.js`:
  all 370 tests passed, including the native fixture; no skips.
- `npm run check` and `git diff --check` passed.
- Independent review caught late shutdown-child tracking and timeout evidence
  gaps; both were repaired with regressions and confirmed in the final review.

Installed/default Codex, real profile apps, journals and keychains were unchanged.
The actual Default main was previously read-only observed as PID 57327. The user
subsequently reported RC3 running as PID 84299 with its profile-labelled executable.
These are past observations; inspect current journals and resource handles before
any explicitly authorized cleanup. Do not infer stopped/idle from an absent GUI.

Real profile sign-in, separate data, account-home discovery, vendor helper group
state, Dock/Cmd+Tab activation/reopen and Default preservation remain native
acceptance work. The signer retains nested publisher signatures/application-group
grants. Generated-app replacement still has its previously documented abrupt
interruption window; this work adds no cache migration/recovery framework.

## Next action

Use the existing xfx_dev helper against this checkout. Already prepared valid
apps need only `desktop open NAME`; a running instance is focused. Use `desktop
prepare NAME` for an absent app and `desktop refresh NAME` for a stale stopped
app. Recover any interrupted target reservation after its resources are idle.
Do not close the user's running instances for this work. The remaining native
acceptance checks are in `docs/CONCURRENT-DESKTOPS.md`; do not reset keychain
defaults or claim full profile isolation from the synthetic fixture.
