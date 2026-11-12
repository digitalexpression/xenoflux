# Develop Xenoflux

Audience: contributors and maintainers. [User guides](../README.md#user-guides)
cover normal operation; this directory covers changing the source.

Keep eligibility, ownership and accounting in the shared engine. The UI presents
engine/report data and only supported operations. Serve bundled assets/API on
loopback, validate session/Host/Origin, and render native content as untrusted
text. Use the app guide for workflows and DESIGN.md for interaction rules.

## Checkout and checks

Use a supported Node.js version on macOS. Release packaging targets Apple Silicon
with arm64 Node; see the
[installation requirements](../user/INSTALLATION.md#requirements).
From the repository root:

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
Tests use disposable fixtures and mocked native clients; synthetic bootstrap
fixtures may compile and sign only their own bundles. They do not establish
real account sign-in, Desktop activation or reboot/RAM-service behavior.

Use a temporary directory outside personal configuration ancestors, such as
`TMPDIR=/private/tmp` on macOS. Keep process HOME, USER and LOGNAME consistent
with the native account context; pass disposable client/controller paths through
the fixtures rather than changing only the process HOME. Expand displayed `~`
prefixes before filesystem assertions.

`check:ui` verifies types, design tokens and bundled-build parity, then runs
Chromium journeys against the real local server/engine with disposable native-style
homes, histories and exports. Mock client/version/process observation, not API
responses. These checks do not establish live native integration.

`dist/ui` is tracked and packaged. After UI changes, run `npm run build:ui` and
`node scripts/check-ui-build.mjs`. `test:ui` rebuilds and runs browser journeys.
Run browser/build commands sequentially when they share output directories.
Playwright failure artifacts are under `test-results/ui-e2e/`; use
`npx playwright show-report` to inspect them. Preserve failed full-check results
separately from passing targeted reruns.

The opt-in synthetic LaunchServices fixture opens/closes only its own windowless
app on macOS:

```sh
TZ=UTC XFX_NATIVE_PROFILE_OPEN=1 node --test test/native-profile-open.test.js
```

See [Desktop verification](DESKTOP-IMPLEMENTATION.md#verification-and-native-acceptance)
for the limits of this fixture. Real profile/client operations need current
authorization covering their effects and must preserve unrelated clients/data.

## Build a release candidate

The 4.0.0 beta line uses version `4.0.0-beta.1` and npm channel `beta`.
The [beta-exit checklist](AUDIT-ACCEPTANCE.md#beta-exit-checklist) owns the stable
promotion criteria; beta preparation does not complete that future review.

After the required checks, commit all package inputs and build from a clean
tracked checkout:

```sh
npm run local-release -- --output /absolute/new/release-directory --smoke
```

The output is one self-contained npm tarball, a schema-3 SHA-256 manifest and
`install.mjs`. Both npm and the standalone installer use the same tarball.
Node.js and the selected native CLIs remain external requirements. The builder
stages the locked SDK dependency graph, including required peers and the arm64
Koffi library, without optional SDK CLI packages or development dependencies.
It preserves dependency files and licenses; source/type/map pruning is deferred.

The development manifest is private and ordinary checkout `npm pack` is refused.
Use the generated tarball for any separately authorized publication; publishing
the checkout would bypass the verified bundle. The builder records the committed
source identity and refuses tracked changes or untracked package inputs.
Review its generated `package.json`: the prerelease version and
`publishConfig.tag: "beta"` must agree with the manifest and artifact filename.
For any later approved publication, use that exact tarball with npm `--tag beta`
and a GitHub prerelease. Leave stable `latest` unchanged; a GitHub prerelease
label alone does not select npm's distribution channel.
`--smoke` checks disposable installation and lifecycle fixtures; it does not
qualify real native accounts, tasks or credential refresh. Building or passing
checks does not authorize publication, merging or installed updates.

## Change the native launcher

The package contains a signed universal arm64/x86_64 launcher. Maintainer rebuilds
need Swift and Xcode Command Line Tools:

```sh
npm run build:native
npm run check:native
```

Keep Swift source, binary and manifest consistent. Normal installation/profile
preparation copy the prebuilt helper and never compile it. Preserve pinned caches
needed by running instances.

## Contracts

- [Product goal](AUDIT-GOAL.md): behavior, scope and provider-version policy.
- [Acceptance criteria](AUDIT-ACCEPTANCE.md): observable verification requirements.
- [Client and review implementation](REVIEW-TASK-IMPLEMENTATION.md): client identity,
  catalogs, runtime ownership, persistence and recovery.
- [Profile copy policy](PROFILE-COPY-POLICY.md): transfer eligibility and Undo.
- [Desktop implementation](DESKTOP-IMPLEMENTATION.md): signed launch and isolation.
- [Roadmap](ROADMAP.md): product direction and supported boundaries.

Keep private execution records, local acceptance results and operational grants
outside public source. Reusable verification commands and behavior limits belong
here; historical receipts do not authorize new effects.
