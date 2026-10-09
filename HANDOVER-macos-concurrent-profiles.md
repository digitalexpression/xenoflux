# Concurrent profile desktop development

Updated: 2026-10-09. Branch: `codex/concurrent-profiles`, based on `60d6f612`.

User authorized development and deferred native testing because another long-running
Codex session must remain open. Do not close, focus, launch or reinstall native
clients, change live profiles/aliases/log storage, or publish as part of this work.

Implemented fixed-path desktop instances with per-profile reservations and a
process-specific runtime, named AppKit launchers, CLI commands and disposable
verification. Existing CLI launches are reused. The user subsequently requested
retiring legacy desktop switching so Default keeps its ordinary paths. Public
`switch`, desktop `pick`, `activate`, `activation-plan` and `add-target` now reject
requests before store lookup or client work. Guided setup creates no activation
plan; it offers `desktop open NAME` after sign-in. The obsolete desktop picker and
generated switch helper were removed. Historical readers/transactions and
`current`, `restore`, no-name `recover` remain for existing state.

Named planning/opening requires active or interrupted legacy selections restored
first, including a selection reserved by another controller store. This is a code
gate, not an automatic migration. Existing live aliases have not been restored.

Verification: `npm run check`, `npm test` (513 passing tests), and `git diff --check`
passed after retirement. Compatibility recovery tests are retained; the removed
picker's tests were replaced by public command retirement, guided setup and legacy
selection gate checks. The production launcher builder compiled the unchanged Swift helper successfully in
a disposable controller without executing it. Fixtures cover two desktops plus two
CLI profiles alongside an original desktop, exact-process focus/close, failed launch
recovery, journal/receipt changes, and exclusion of legacy quit/installation races.
Independent source review findings were resolved; its last narrow review reported
no remaining material issue, including the retirement entry points and retained
recovery flow. These checks do not prove native Desktop behavior.

The implementation launches the untouched signed vendor app through a macOS request
that returns its exact process, binding `CODEX_HOME`, SQLite, UI data, `HOME` and tmp
to a profile. A separate named regular AppKit launcher forwards activation to it.
Each profile remains exclusive across managed CLI and Desktop clients. Global
control-owner markers prevent legacy bundle-wide quits across controller stores.

Native app inspected during planning: `/Applications/ChatGPT.app`, bundle ID
`com.openai.codex`, version `26.1002.52244`, build `13536`. This is inspection evidence
only. Installed `xfx` and the user's current clients/profiles remain untouched.

Initial implementation commit: `0e5aca2`. Its older candidate under
`release-artifacts/concurrent-profiles-2026-10-09` predates retirement. Rebuild the
current candidate under `release-artifacts/concurrent-profiles-default-paths-2026-10-09`; use the new manifest's revision
and package/dependency hashes. The initial detached package smoke passed offline
installed-package fixtures and installation lifecycle. The package smoke
also checks desktop inventory, profile routing plans and generated launcher bundles
using a fake compiler; neither that fake helper nor any native client is executed.
No global install, app replacement, native launch, profile change or publication occurred.

Native Cmd+Tab, effective profile routing, sign-in, Finder/Dock reopen and graceful
quit/cancellation remain deferred until the user is ready. Use the acceptance cases
in `docs/CONCURRENT-DESKTOPS.md` with disposable profiles; do not change the live
session to claim readiness.
