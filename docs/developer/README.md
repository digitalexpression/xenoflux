# Develop Xenoflux

Audience: contributors and maintainers. [User guides](../README.md#user-guides)
cover installation and normal commands; this directory covers changing the source.

## Checkout and checks

Use a supported Node.js version on macOS. From the repository root:

```sh
npm ci
npm run check
npm run check:native
npm run check:docs
npm test
npx playwright install chromium
npm run test:ui
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

`test:ui` builds the app and runs Chromium journeys against its real local server
and engine. Each test uses disposable native-style homes, SQLite histories and
export files; it checks visible results and actual filesystem effects without
mocking API responses. Native executable version checks use a fixture executable,
and the copy runtime sees an isolated process table so it cannot control the
developer's clients. These checks do not establish live Codex integration.

`check:ui` also verifies types, design tokens and that the bundled build matches
source. `dist/ui` is tracked because the app serves it and npm packages it; rebuild
and verify it with `npm run build:ui` and `node scripts/check-ui-build.mjs` after
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

Ordinary review uses the [implementation contract](REVIEW-TASK-IMPLEMENTATION.md),
not the retired export-review campaign. Its [removal list](REVIEW-TASK-IMPLEMENTATION.md#legacy-removal)
preserves meaningful product coverage; the [roadmap](ROADMAP.md#delivery-order)
orders implementation and verification. Retained native results belong in the
[3.0.0 record](RELEASE-3.0.0.md#retained-verification-and-limits), not a new
acceptance campaign. Current authorization governs any real execution.

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
- [Review implementation](REVIEW-TASK-IMPLEMENTATION.md): ordinary execution,
  durable task/API/recovery and selected legacy removal.
- [Profile copy policy](PROFILE-COPY-POLICY.md): transfer behavior and eligibility.
- [3.1.1 release](RELEASE-3.1.1.md): audit/privacy patch and publication evidence.
- [3.0.0 record](RELEASE-3.0.0.md): source-bound results, performance limits
  and remaining evidence. [Release process](LOCAL-RELEASE.md): packaging/publication.
- [Audit acceptance](AUDIT-ACCEPTANCE.md): immutable release records, including
  [2.1.0](RELEASE-2.1.0.md) and [2.0.0](AUDIT-ACCEPTANCE-2.0.0-HISTORY.md).
- [Capability assessment](PROFILE-AUDIT-ASSESSMENT.md),
  [2.1.0 roadmap](ROADMAP-2.1.0-HISTORY.md) and
  [assessment](PROFILE-AUDIT-ASSESSMENT-2.1.0-HISTORY.md): historical evidence,
  not prerequisites or additional gates for current implementation.

Detailed operational handovers/raw receipts remain private engineering records.
Read them only to resolve a specific evidence gap; historical grants do not renew
live authorization.

## Maintenance boundaries

Update the document that owns a fact rather than copying status or requirements
across guides. Keep the roadmap checkpoint current, feature contracts with their
implementation changes and source-bound results in release records. Preserve
published records/artifacts; update the documentation index and package allowlist
when public documents move. Apply the goal's
[evolution policy](AUDIT-GOAL.md#evolution-and-provider-version-policy) when removing
old contracts and their tests; keep meaningful coverage for supported behavior.

Illustrative images and prompts remain in `output/design/`, narrowly ignored by
Git and excluded from the package. They remain illustrative references, not
accepted designs, implemented controls or evidence of product behavior.

Keep operational instructions in `docs/user` and implementation, verification and
publication instructions in `docs/developer`. Update the [documentation index](../README.md)
and links when moving a guide. Keep dated investigation results in the handover,
not in the user quickstart. Documentation changes do not authorize live installation,
profile mutation or client closure.
