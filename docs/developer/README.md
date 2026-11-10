# Develop Xenoflux

Audience: contributors and maintainers. [User guides](../README.md#user-guides)
cover installation and normal commands; this directory covers changing the source.

The UI presents shared engine/report data; keep eligibility and accounting in the
engine. Serve bundled assets/API on loopback, validate API session/Host/Origin and
expose only supported operations. Use the app guide for workflows and checkout
`DESIGN.md` for interaction rules. Render native content as untrusted text; never
execute embedded instructions or markup.

## Checkout and checks

Use a supported Node.js version on macOS. From the repository root:

```sh
npm ci
npm run check
npm run check:native
npm run check:docs
npm test
npx playwright install chromium
npm run check:ui
```

`check` validates JavaScript syntax. `check:native` verifies the packaged universal
helper's source/binary hashes, architectures, signature and lack of entitlements.
The tests use disposable fixtures and mocked clients; native bootstrap fixtures
may compile synthetic code and sign only their disposable bundles. They do not
establish real profile sign-in, Dock behavior or reboot/RAM-service success.

If a managed environment places its temporary directory inside the account home,
run fixture checks with `TMPDIR=/private/tmp` on macOS. This keeps project-ancestor
discovery away from personal configuration. UI export folders can be displayed
with `~`; filesystem assertions must expand that prefix before reading files.

`check:ui` verifies types, design tokens and bundled-build parity, then runs Chromium
journeys against the real local server and engine. Each test uses disposable
native-style homes, SQLite histories and export files; it checks visible results
and actual filesystem effects without
mocking API responses. Native executable version checks use a fixture executable,
and the copy runtime sees an isolated process table so it cannot control the
developer's clients. These checks do not establish live Codex integration.

`test:ui` rebuilds and runs only the browser journeys. `dist/ui` is tracked because
the app serves it and npm packages it; rebuild and verify it with
`npm run build:ui` and `node scripts/check-ui-build.mjs` after
UI source changes. Browser failures retain screenshots, server errors and
Playwright traces under `test-results/ui-e2e/`; `npx playwright show-report`
opens the HTML report. Run Playwright commands sequentially: separate runs that
share `test-results/ui-e2e/` can race while cleaning traces and produce a
trace-cleanup failure. CI uploads failure evidence. The CLI/engine fixture and
security suites remain in `npm test`; UI-only unit/component tests have been
replaced by these browser journeys. Report full-suite failures separately from
targeted reruns: a passing targeted rerun resolves that case, but does not turn
the original full-suite run into a clean pass.

The opt-in LaunchServices fixture runs only when explicitly enabled on macOS:

```sh
TZ=UTC XFX_NATIVE_PROFILE_OPEN=1 node --test test/native-profile-open.test.js
```

It opens and closes its own windowless synthetic app. It does not control existing
Codex instances. See [Desktop implementation and verification](DESKTOP-IMPLEMENTATION.md)
for what that fixture proves and which checks require authorized native acceptance.

## Prepare native acceptance

The checkout-only `scripts/native-profile-ui-acceptance.mjs` harness automates
empty/selected profile creation, cancel, selected setting/skill copy and exact
Undo. Its default/help and grant-check paths do not start acceptance. Execution
requires a separately approved, source-bound manifest and an independent
Terminal with passing real client/idle guards before each mutation. It retains
screenshots, a browser trace, filesystem/journal checks and shutdown receipts.
An ambiguous in-flight request prevents automatic server termination. The engine
suite exercises the journey using disposable homes and a fake version executable;
that result does not replace native acceptance or a human usability check.

Ordinary review follows the [review contract](REVIEW-TASK-IMPLEMENTATION.md).
Retained results belong in their versioned release records; current authorization
governs any real execution.

For an explicitly uncapped **non-series** experiment, set both `limits.runMs`
and `limits.experimentMs` to JSON `null` in its CLI spec. Omitting a limit retains
the normal default. Cancellation, output bounds and setup/check timeouts still
apply; reports retain the null limits and the UI omits a timed percentage.
The Runs form still offers finite durations, and series retain their per-trial
budgets. `nativeConfig["features.multi_agent"]: false` disables delegation through
the native startup configuration; its effective native behavior needs acceptance.

## Change the native launcher

The package already contains a signed universal arm64/x86_64 launcher. Only
maintainers need Swift and Xcode Command Line Tools. After changing its Swift source:

```sh
npm run build:native
npm run check:native
```

Commit the Swift source, binary and manifest together. Normal installation and
profile preparation copy the prebuilt helper; they never compile it. Keep running
instances' pinned caches intact when changing preparation behavior.

## Contracts and release records

Use the [roadmap checkpoint](ROADMAP.md#current-work-and-stop-condition) to start
active work. Follow only the references needed for that slice:

- [Goal](AUDIT-GOAL.md): product behavior, acceptance and evolution policy.
- [Client support plan](CLIENT-SUPPORT-PLAN.md) defines the planned architecture,
  client/surface interfaces and slice acceptance.
- [Review implementation](REVIEW-TASK-IMPLEMENTATION.md): ordinary execution,
  durable task/API/recovery.
- [Profile copy policy](PROFILE-COPY-POLICY.md): transfer behavior and eligibility.
- [Acceptance index](AUDIT-ACCEPTANCE.md): compact release summaries and evidence limits.
- [Release process](LOCAL-RELEASE.md): packaging and approved publication.
- [Historical references](../README.md#historical-references): dated assessments and plans.

Completed records and experiments live in [history](history/README.md). Private
operational receipts remain outside public source; consult only for a specific gap.

## Maintenance boundaries

Follow the [release guide](LOCAL-RELEASE.md#documentation-ownership-and-release-closeout)
for documentation ownership, archival summaries and package boundaries. Illustrative
`output/design/` material is neither accepted UI nor verification. Apply the
[evolution policy](AUDIT-GOAL.md#evolution-and-provider-version-policy) when retiring
contracts; retain meaningful supported-behavior coverage.
