# Desktop implementation and verification

Current launcher/ownership contract. Commands: [Desktop guide](../user/DESKTOP.md).
Build/update procedure: [developer guide](README.md#change-the-native-launcher).
Desktop capabilities are independent: app opening, session navigation/import,
managed-profile isolation and automated execution each need their own supported
route and evidence. CLI fixtures do not establish desktop account isolation or
exact-session handoff. The rules below describe Codex Desktop; managed
Claude/Copilot desktop profiles and automation are outside current scope.

Ordinary stock Claude/Copilot opening is independent of managed profiles. The
`stock-desktop-apps.js` boundary checks fixed canonical app paths, bundle IDs,
vendor signing teams, executable identity and app build before `open -a`.
An updated/replaced app invalidates the reviewed identity. It sends no prompt,
selects no account or logical surface, and exposes no import, session-control or
cloud-cancellation operation. Finding an installed app establishes no account isolation or session association.

## Signed Desktop execution

- The controller opens the verified OpenAI-signed vendor app through LaunchServices
  with the selected profile's routes, or focuses its recorded instance. Preserve
  the vendor identity, signature and entitlements; never re-sign its executable/helpers.
- Records and managed launcher artifacts live under `CONTROLLER/desktop-instances`.
  Open prepares missing/stale stopped launchers automatically; running instances keep
  pinned helpers/caches. Process identity belongs to the signed vendor app.
- Ship the macOS 13+ arm64/x86_64 helper with source/binary hash verification and a
  private cache keyed by binary hash. Keep helpers needed by running instances.
  No install/pack compilation or local-compiler fallback; damaged helpers require
  a corrected package. Maintainer rebuild commands belong in the developer guide.
- Desktop keeps the account `HOME` for login-keychain access; CLI keeps isolated
  `user-home`. Do not create/reset keychains or change search lists. Explicit
  Codex/SQLite/UI-data routes separate profile storage, not all account/group state.

## Process identity and isolation boundaries

- Use the app instance returned for that launch; reject unrelated/preexisting processes.
  Launcher-originated requests also verify exact caller PID and controller parentage. Private
  receipts bind the profile paths; focus/quit verify executable and kernel start time.
  Use the same start-time source as `ps`, UTC records and English UTF-8 process output.
  Identity mismatches and control from the target's own ancestry are refused.
- Quit only the validated target. Treat exited zombies as stopped; otherwise track
  recorded/new/reparented descendants and wait for profile handles to drain.
  An unavailable command label with the same PID/UID/start still keeps close waiting.
  Timeouts, reused identities or uncertain ownership preserve records/reservations.
- Observed listing, review Start and open may reconcile a confirmed normal quit.
  Verified execution participants retain their own handles/reservations; other holders
  block cleanup. The [review contract](REVIEW-TASK-IMPLEMENTATION.md#execution-with-the-selected-profiles-settings)
  owns shared participation. Recovery validates binding, journal, owner, stopped
  processes and handles, releasing only its own reservation without launching/quitting apps.

## Verification and native acceptance

Mocked/disposable checks and the opt-in synthetic LaunchServices fixture cover
routing, lifecycle and identity guards; they do not prove real Codex sign-in,
Dock/Cmd+Tab activation, data isolation or reboot behavior. Fixture invocation is
in the [developer guide](README.md#checkout-and-checks).

When native testing is authorized, use disposable profiles and record exact app/backend
versions. Cover CLI launch/repeat-open focus, two profile-routed vendor instances
alongside ordinary Codex, two independent CLI profiles, profile/SQLite/UI/log
routing and Default preservation. Check graceful/cancelled quit, late helpers,
interrupted open and stopped recovery without disturbing other clients. Retest changed launch/activation paths after vendor updates; use the
[acceptance criteria](AUDIT-ACCEPTANCE.md) without inferring unobserved behavior.
