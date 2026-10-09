# Concurrent profile desktop development

Updated: 2026-10-09. Branch: `codex/concurrent-profiles`, based on `60d6f612`.

User authorized development and deferred native testing because another long-running
Codex session must remain open. Do not close, focus, launch or reinstall native
clients, change live profiles/aliases/log storage, or publish as part of this work.

Implemented fixed-path desktop instances with per-profile reservations and a
process-specific runtime, named AppKit launchers, CLI commands and disposable
verification. Existing CLI launches are reused. Global alias selection is preserved;
its legacy bundle-wide quit now refuses multiple app mains.

Verification: `npm run check`, `npm test` (515 passing tests), and `git diff --check`
passed. The production launcher builder compiled the Swift helper successfully in
a disposable controller without executing it. Fixtures cover two desktops plus two
CLI profiles alongside an original desktop, exact-process focus/close, failed launch
recovery, journal/receipt changes, and exclusion of legacy quit/installation races.
Independent source review findings were resolved; its last narrow review reported
no remaining material issue. These checks do not prove native Desktop behavior.

The implementation launches the untouched signed vendor app through a macOS request
that returns its exact process, binding `CODEX_HOME`, SQLite, UI data, `HOME` and tmp
to a profile. A separate named regular AppKit launcher forwards activation to it.
Each profile remains exclusive across managed CLI and Desktop clients. Global
control-owner markers prevent legacy bundle-wide quits across controller stores.

Native app inspected during planning: `/Applications/ChatGPT.app`, bundle ID
`com.openai.codex`, version `26.1002.52244`, build `13536`. This is inspection evidence
only. Installed `xfx` and the user's current clients/profiles remain untouched.

Implementation commit: `0e5aca2`. Local candidate:
`release-artifacts/concurrent-profiles-2026-10-09/xenoflux-0.3.0-rc.7.tgz`.
Its `manifest.json` records the source revision and package/dependency hashes.
`npm run local-release -- --output <candidate-directory> --smoke` passed the detached
offline installed-package fixtures and installation lifecycle. The new package smoke
also checks desktop inventory, profile routing plans and generated launcher bundles
using a fake compiler; neither that fake helper nor any native client is executed.
No global install, app replacement, native launch, profile change or publication occurred.

Native Cmd+Tab, effective profile routing, sign-in, Finder/Dock reopen and graceful
quit/cancellation remain deferred until the user is ready. Use the acceptance cases
in `docs/CONCURRENT-DESKTOPS.md` with disposable profiles; do not change the live
session to claim readiness.
