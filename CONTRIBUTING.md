# Contribute to Xenoflux

Use the [user guide](docs/GUIDE.md) for behavior and [contracts](docs/CONTRACTS.md)
for invariants. [AGENTS.md](AGENTS.md) routes agent work; [DESIGN.md](DESIGN.md)
owns UI composition. Installed-user docs are README, installation, guide and CLI.
Contributor material stays in the repository and is excluded from npm.

## Checkout and checks

Use macOS with a supported Node version from [installation](docs/INSTALLATION.md#requirements).
Release packaging requires Apple Silicon and arm64 Node. From the checkout:

```sh
npm ci
npm run check
npm run check:native
npm run check:docs
npm test
npx playwright install chromium
npm run check:ui
```

`check` validates JavaScript syntax. `check:native` checks the universal launcher's
source/binary identities, architectures, signature and entitlements. `check:docs`
checks source and packaged links, documentation ownership and package membership.
`check:ui` checks types, design tokens, bundled-build parity and Chromium journeys.

Tests use disposable homes, histories and mocked client/version/process boundaries;
browser journeys drive the real local server/engine. They do not prove real account
sign-in, native activation, credential refresh or reboot behavior. Use
`TMPDIR=/private/tmp` if personal ancestors would affect fixture discovery. Keep
HOME/USER/LOGNAME consistent; pass isolated client/controller paths explicitly.

`dist/ui` is tracked and shipped. After UI changes run `npm run build:ui` and
`node scripts/check-ui-build.mjs`. Run browser/build commands sequentially when
outputs are shared. Failure traces/screenshots are under `test-results/ui-e2e/`;
`npx playwright show-report` opens the HTML report. Preserve failed full-run
results separately from passing targeted reruns.

The explicit synthetic LaunchServices fixture opens only its own windowless app:

```sh
TZ=UTC XFX_NATIVE_PROFILE_OPEN=1 node --test test/native-profile-open.test.js
```

Changed native launch, authentication, approval or shutdown claims need applicable
source-bound native evidence under current authorization. Use disposable profiles,
record installation identities and test preservation/failure paths. Fixture counts
alone do not prove the native journey. Verification excludes 200% browser zoom,
VoiceOver and uncoached participant studies; their absence is not outstanding work.
Keyboard behavior, narrow layouts and both themes remain required.

## Find the implementation

| Responsibility | Entry points |
| --- | --- |
| CLI and local web boundary | `bin/xfx.js`, `src/ui-server.js`, `src/ui-engine.js` |
| Profiles, launch and copying | `src/profiles.js`, `src/profile-launcher.js`, `src/advanced-copy.js`, `src/native-copy.js` |
| Managed Desktop ownership | `src/desktop-instances.js`, `src/desktop-runtime.js` |
| Client execution and ordinary reviews | `src/client-runtime.js`, `src/ui-review-tasks.js`, client runtime adapters |
| Evidence, export and interpretation | `src/audit-store.js`, `src/audit-report.js`, `src/audit-explanation.js` |
| Structured inputs and limits | `src/audit-spec.js`, `src/audit-review.js`, their validation tests |
| UI and bundled assets | `web/src/`, `web/e2e/`, `dist/ui/` |
| Packaging and isolated installation checks | `scripts/local-release.mjs`, `test/local-release.test.js` |

Keep eligibility/accounting/ownership in the shared engine. Client adapters own
protocol and native path/account interpretation. The UI presents supported engine
operations; it does not grow another scheduler, persistence model or validator.
Prefer production schema/constant owners and behavior tests over copied API/SDK
field lists in prose. Retain rationale that a future editor cannot infer from code.

## Prepare public commits

Start short-lived `codex/<task>` topics from the current public baseline. Private
maintainer instructions, assignments and receipts live under ignored `private/`.
Each worktree needs its own optional maintainer context. Public checks must work
without it. Keep checkpoint history local until reorganized into focused public
commits; inspect every outgoing message and file before the first public push.
Deleting a private file in a later commit does not conceal its earlier contents.

```sh
git fetch origin
npm run check:public
```

The history checker rejects currently ignored paths in the index, selected trees
and outgoing commits, including files later deleted. It does not inspect prose
or detect secrets in allowed paths. Review ignore-rule changes and actual package
contents separately. `--base REVISION` selects another reviewed base.

The optional local pre-push hook invokes a reviewed copy of the checker from the
common Git hooks directory with `--pre-push "$1"`. Refresh it when the checker
changes. It reads Git's updates, using the fetched remote main for new refs and
the existing remote tip otherwise. Fetch on missing-base errors. Independent clones
need their own installation; linked worktrees share the hook. Push explicit named
branches/tags. Existing public history is not rewritten by this process.

## Build a release candidate

Commit package inputs and use a clean tracked checkout:

```sh
npm run local-release -- --output /absolute/new/release-directory --smoke
```

The output is a bundled npm tarball, SHA-256/source manifest and installer. It
retains locked SDK dependencies, required peers, native libraries and licenses,
without optional client CLI packages or the development graph. Node and client
CLIs remain external. Ordinary checkout packing is refused; publication uses the
verified generated artifact, not a fresh pack of the checkout.

The smoke runs disposable SDK/install/lifecycle fixtures without real sign-in or
native-home control. Check the actual archive/inventory, default and omitted
optional-dependency installation, served UI/API security and preservation. Use
version/channel metadata from `package.json`, not a version duplicated here.
Any authorized publication must run from a clean checkout whose HEAD equals the
manifest's sourceRevision; verify public hashes and registry gitHead when present.
Build/check success grants no merge, publication or installed-update authority.
Candidate-specific gates and operator receipts belong in private maintainer work.

## Rebuild the native helper

Maintainers need Swift/Xcode Command Line Tools only for this step:

```sh
npm run build:native
npm run check:native
```

Commit Swift source, universal binary and hash manifest together. Runtime/install
paths copy the prebuilt helper and never compile or fall back to local compilation.
Preserve caches used by running instances.

## Keep documentation small

README routes readers; installation owns requirements/channels; the guide owns
normal journeys and known limits; CLI owns terminal recipes; this file owns checks;
contracts owns implementation invariants. Keep one owner and link to it. Channel
notices belong only in README and installation. Record current assignments,
release decisions and raw evidence privately; use public issues for published plans.
Preserve full originals in verified compressed storage before removing them.
