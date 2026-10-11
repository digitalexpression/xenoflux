# Concurrent profile desktop development

Updated: 2026-10-11. Branch: `codex/concurrent-profiles`.

## Goal and authority

Multiple fixed-profile CLI/Desktop instances, one recognizable `Codex · NAME`
Dock/Cmd+Tab entry per Desktop profile. Default retains normal paths including
`~/.codex`; named Codex/UI data remains under `~/.xfx/profiles`. Preserve the
ordinary long-running Codex session. Local source work and disposable checks are
authorized; the user tests real profiles afterward. No live profile/app/keychain
mutation, client closure, installation or publication was performed.

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
The actual Default main was read-only observed as PID 57327. RC3's journal remains
opening with main null; leftover profile helpers/handles may prevent recovery.
Do not infer stopped/idle from the absent GUI alone. Inspect the journal and
resource handles before any explicitly authorized cleanup.

Real profile sign-in, separate data, account-home discovery, vendor helper group
state, Dock/Cmd+Tab activation/reopen and Default preservation remain native
acceptance work. The signer retains nested publisher signatures/application-group
grants. Generated-app replacement still has its previously documented abrupt
interruption window; this work adds no cache migration/recovery framework.

## Next action

Use the existing xfx_dev helper against this checkout. Once RC3 Check is quit and
its resources are idle, recover its interrupted reservation and open it from the
CLI; changed helper source refreshes a stopped owned app. Keep Default running.
Test the keychain prompt, profile name, focus/reopen/close, then Advanced Check
alongside RC3 and Default following `docs/CONCURRENT-DESKTOPS.md`. Do not reset
keychain defaults. If a receipt mismatch remains, its new diagnostics identify
the precise field; investigate that evidence before another launch change.
