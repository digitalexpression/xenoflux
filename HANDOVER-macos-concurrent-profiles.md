# Concurrent profile desktop development

Updated: 2026-10-09. Branch: `codex/concurrent-profiles`.

The user authorized development while preserving the ordinary running Codex
session. Default keeps standard paths, including `~/.codex`; named profiles use
fixed homes under `~/.xfx/profiles`. Legacy alias switching and migration remain
removed. Current named-instance recovery releases only a stopped instance's
exact reservation.

## Current result

The first native test could select separate profile windows through Cmd+Tab but
showed generic app names, companion launcher entries, and close identity errors.
The replacement copies the verified vendor app into one private `Codex · NAME.app`
with a distinct bundle ID and retained icon/resources. The bootstrap execs its
copied vendor binary in the same PID. Finder uses an exact-PID reservation
handshake; no persistent companion app remains. Stopped copies refresh after
verified source/helper changes. Runtime observation excludes zombies and close
rechecks a target after quit-helper errors while retaining PID-reuse protection.

The copy builder's discovered-source identity bug was fixed in `1bf2a1c`.
The user's next opens failed with `DESKTOP_OPEN_FAILED`; both named journals
remained `opening` with no main and observed stopped. Read-only macOS logs for
19:38:45–19:38:59 local time showed amfid error -424: the ad-hoc signed bootstrap
contained restricted vendor entitlements. LaunchServices failed before main spawn.

The corrected signer gives the bootstrap no entitlements. It clears copied vendor
claims, restores only source-present allow-jit, unsigned-memory and
library-validation runtime grants per executable, then deeply reseals nested
frameworks/helpers and the outer app. Unknown or malformed signing metadata fails
preparation. Native launch errors now retain macOS diagnostics or report timeout.
Swift uses POSIX realpath to match Node's canonical process identity; the native
fixture caught Foundation's `/var` versus `/private/var` path difference.

## Verification

`npm run check`, `npm test` (362 passed, 1 opt-in test skipped), and
`git diff --check` pass. The separately enabled native LaunchServices fixture
passed with the final signer. It uses a windowless, self-terminating fake AppKit
vendor under a temporary directory and proves same-PID exec, exact canonical
receipt, named bundle ID, and fixed profile routes. Nested framework/helper
signature and entitlement regressions also pass. Independent bounded review
found no material issue after the fixes.

Current publisher inspection of `/Applications/ChatGPT.app` passes in both
sandboxed and unsandboxed checks. Earlier transient strict-signature failures
are not the current blocker; their cause remains unresolved. Version
`26.1002.52244`, build `13536`, app.asar SHA-256
`40efd7acdf03a24817fcd7f35684fc2173b154df06774243cb4ab227e36fa915`.
A disposable real-source copy passed production preparation, ownership validation
and deep strict signature verification. Its bootstrap has no entitlements; its
vendor main retains allow-jit and unsigned-memory only. It was not launched.

No installed/default Codex app or live profile app was opened, focused, closed,
replaced or signed by these checks. Live profiles and journals, Default paths,
and installed xfx remain unchanged. Only disposable fixture apps were launched;
they exited naturally and their temporary files were removed.

## Next action

The new local candidate will be under
`release-artifacts/concurrent-profiles-signing-fix-2026-10-09/`; its manifest records
the committed source revision and hashes. It supersedes the discovery-fix package.

Using the existing development CLI helper, recover the stopped RC3 Check and
Advanced Check reservations, then open both again. Follow
`docs/CONCURRENT-DESKTOPS.md`: exactly one named/icon-bearing Dock and Cmd+Tab entry
per profile, correct profile focus/routes, Finder/Dock reopen, graceful close,
and preservation of the ordinary app. Real Codex native acceptance remains
pending; fixture and signature checks do not establish it.
