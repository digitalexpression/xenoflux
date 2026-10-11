# Concurrent profile desktop development

Updated: 2026-10-11. Branch: `codex/concurrent-profiles`.

## Goal and authority

Multiple Codex CLI/Desktop profiles must retain fixed routes and recognizable
profile names in Dock/Cmd+Tab. Default keeps standard paths, including
`~/.codex`; named profiles use homes under `~/.xfx/profiles`. Preserve the user's
long-running ordinary Codex session. Local development and disposable checks are
authorized; the user will test real profile desktops afterward. Legacy alias
switching and migration remain removed. Current instance recovery releases only
a stopped instance's exact reservation.

## Observed failure

Both RC3 Check and Advanced Check failed again on 2026-10-11. Their journals
remain `opening`, with no main process and observed stopped. The user's latest
recovery/open commands ran around 07:44 local time. Read-only crash reports
`ChatGPT-2026-10-11-074411.ips` and `ChatGPT-2026-10-11-074437.ips`, plus kernel logs,
showed Codex started and aborted while loading Codex Framework. Library validation
rejected the locally re-signed framework for a main executable without a matching
Team ID. Static/deep signature checks and the old AppKit-only launch fixture had
missed this runtime failure.

An alternative placed the entirely untouched vendor app inside a named outer
launcher. Actual vendor signatures and all bundle bytes survived outer signing,
but the disposable AppKit launch reported the nested generic vendor name and
bundle identity, including one second after exec. This misses the Cmd+Tab goal
and was not integrated.

## Current implementation

The signer now signs only the entitlement-free bootstrap, the copied main host
with JIT/unsigned-memory/disable-library-validation runtime grants, and the outer
profile-labelled bundle. It does not use `--deep` for signing. Nested frameworks,
helper apps and other vendor code retain their publisher signatures and bytes.
Deep strict verification still checks the full result. The previous entitlement
scraping and nested re-signing pipeline was deleted.

A signing-policy marker makes old owned copies stale on preparation. CLI open
refreshes a stopped copy; Finder refuses an outdated copy until CLI refresh.
Old-policy records still validate for current-instance recovery. Same-PID exec,
fixed profile routes, exact process identity, one app per profile and existing
close/recovery guards remain in place.

## Evidence and limits

A disposable copy prepared by the final production signer passed deep strict
signature verification. Its real Codex Framework bytes and OpenAI Team ID
`2DC432GLL2` were preserved. A headless C host reproduced the same library
validation error without the required entitlement, then loaded that actual
framework successfully with it. This loaded the framework without starting Codex.

The enhanced opt-in LaunchServices fixture passed. Its temporary AppKit main now
loads an independently signed dylib, checks the native running application name
`Codex · Native Fixture` and distinct bundle ID, checks same-PID exec and profile
routes, then exits naturally. It would catch the missing runtime grant that the
previous fixture missed. Nested helper/framework bytes and signature identities,
and old-policy refresh/recovery behavior, have focused regression coverage.

`npm run check` and `git diff --check` pass. The complete suite passed with
`node --test --test-concurrency=2 test/*.test.js` (362 passed, 1 opt-in test skipped).
The opt-in LaunchServices test passed separately. The initial unrestricted
parallel suite hit existing short fixture RPC/version timeouts while the heavy
real-source experiment ran; it was rerun with two test files at a time without
changing timeout behavior.

No installed/default Codex app or live profile app was opened, focused, closed,
replaced or signed by this work. Real named profiles and journals remain unchanged.
Real Codex GUI launch, account sign-in, profile data and Dock/Cmd+Tab interaction
remain pending. Framework loading and fake-AppKit behavior do not establish full
native acceptance. Preserved vendor helpers retain application-group grants;
their use of shared macOS state requires native observation alongside Default
preservation. The existing generated-app replacement can fail closed after an
abrupt interruption between app rename and owner-marker replacement; backups
retain the old generated app, but reservation recovery does not repair that cache.
This signing change does not add a general cache-recovery protocol.

## Next action

Use the existing `xfx_dev` helper against this checkout. Recover the stopped
RC3 Check reservation and open that one profile first; CLI open will rebuild its
old-policy copy. Confirm its window appears and its Dock/Cmd+Tab entry has the
profile name and Codex icon. Then test Advanced Check alongside it and the
ordinary app, following `docs/CONCURRENT-DESKTOPS.md` for focus, reopen, close and
Default preservation. If launch fails again, inspect the new exact-time crash
rather than extending the timeout or repeating recovery/open loops.
