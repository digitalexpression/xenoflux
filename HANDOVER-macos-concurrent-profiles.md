# Concurrent profile desktop development

Updated: 2026-10-09. Branch: `codex/concurrent-profiles`.

The user authorized development of concurrent profiles, preserving the running
ordinary Codex session. Default keeps standard paths, including `~/.codex`; named
profiles use fixed homes under `~/.xfx/profiles`. The legacy alias switch/restore
engine and migration support remain removed. Current named-instance recovery is
retained to release only a stopped instance's exact reservation.

## Current result

The first user-operated native test opened RC3 Check and Advanced Check alongside
the ordinary app. Cmd+Tab selected their windows, but each profile added a persistent
blank-icon launcher beside a generically named ChatGPT process. Both close commands
reported `PROCESS_IDENTITY_CHANGED`. Supplied recording and process journals were
inspected read-only. No user app was opened, focused, closed, replaced or signed by
this development turn; live profile homes and installed xfx remain untouched.

The revised implementation copies the verified installed vendor app into one private
`Codex · NAME.app` per profile, retaining its icon/resources and assigning a distinct
bundle ID. The Swift bootstrap execs its copied vendor binary in the same PID with
fixed profile paths. Finder launches first obtain an exact-PID reservation handshake
from the controller. There is no persistent companion app. CLI opens refresh stopped
copies after verified app/helper changes; Finder refuses a copy that needs refresh.
Copied apps are locally signed and validated against private ownership/content
records. Closing does not depend on the current installed source still being present.

Runtime observation excludes exited zombie rows and close rechecks a target after a
quit-helper error, draining recorded live children when the main has already exited.
Live executable changes and PID reuse still preserve ownership and fail control.
Only the interrupted prototype record shape remains readable for close/recovery;
opening a still-live prototype instance refuses to create a second app.

## Verification and blocker

`npm run check`, `npm test` (359 tests) and `git diff --check` pass. A macOS fixture compiled the real
Swift source, copied/signed/deep-verified a disposable fake vendor app, validated and
reused it, and directly executed the bootstrap. The fake vendor proved fixed path
routing and same PID after exec. No LaunchServices GUI operation was invoked. Static
review findings for unique bundle ID acceptance, quit-helper exit races and stale
copy reuse were fixed and rechecked. Tests now use isolated maintenance guard paths
instead of consulting the user's live reserved instances.

The installed `/Applications/ChatGPT.app` fails strict signature verification both
as a bundle and as its main executable, and codesign reports an invalid entitlements
blob. Its Info.plist, executable and app.asar hashes stayed unchanged during checks.
It was not copied or repaired. This blocks a real-source build/launch check; the
fixture does not prove Cmd+Tab names, icon count, sign-in or native LaunchServices.

The next user test failed with `APP_IDENTITY_MISMATCH` before an instance opened.
The copy builder incorrectly passed the fixed `/Applications/Codex.app` identity
to its second inspection of the discovered `/Applications/ChatGPT.app`. It now
verifies against the already discovered plan identity using the same injectable
system I/O. Regression coverage exercises that default verifier, publisher rejection
and invalid signature rejection. One plain inspector call reported success, but
repeated inspector/direct checks still failed strict signature verification;
the cause of that one-off success is unresolved. No signature check was bypassed.

## Next action

The original named-app implementation is `7e05de5`; the discovered-source identity
fix is a later commit. The updated local candidate is under
`release-artifacts/concurrent-profiles-discovery-fix-2026-10-09/`; its manifest
records the source revision and hashes. The prior native-fix package is superseded.
Once a verified installed app
is available and the user is ready for native testing, recover the stopped RC3 Check
and Advanced Check prototype records, then open them with the revised development
CLI. Follow `docs/CONCURRENT-DESKTOPS.md`: exactly one named/icon-bearing Dock and
Cmd+Tab entry per profile, correct profile paths and focus, Finder/Dock reopen,
graceful close/recovery, and preservation of the ordinary running app. Native
acceptance remains pending; do not claim it from process lists or fixture tests.
