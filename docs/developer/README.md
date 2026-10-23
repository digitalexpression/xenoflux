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
```

`check` validates JavaScript syntax. `check:native` verifies the packaged universal
helper's source/binary hashes, architectures, signature and lack of entitlements.
The tests use disposable fixtures and mocked clients; native bootstrap fixtures
may compile synthetic code and sign only their disposable bundles. They do not
establish real profile sign-in, Dock behavior or reboot/RAM-service success.

The opt-in LaunchServices fixture runs only when explicitly enabled on macOS:

```sh
TZ=UTC XFX_NATIVE_PROFILE_OPEN=1 node --test test/native-profile-open.test.js
```

It opens and closes its own windowless synthetic app. It does not control existing
Codex instances. See [Desktop implementation and verification](DESKTOP-IMPLEMENTATION.md)
for what that fixture proves and which checks require authorized native acceptance.

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

- [Shared product goal](AUDIT-GOAL.md) defines profile setup comparison, both audit
  entry paths, optional review, consistency and the direct local workflow.
- [Active roadmap](ROADMAP.md) records the published 2.1.0 release and bounded
  documentation cleanup; work stops before UI or provider assessment.
- [Current capability assessment](PROFILE-AUDIT-ASSESSMENT.md) records the
  versioned 2.1.0 capabilities and evidence limits.
- [Profile copy policy](PROFILE-COPY-POLICY.md) defines creation/copy/review behavior.
- [Audit acceptance](AUDIT-ACCEPTANCE.md) indexes immutable, version-specific
  public release records. [2.1.0](RELEASE-2.1.0.md) records publication and
  installation identities with evidence limits. The [2.0.0 record](AUDIT-ACCEPTANCE-2.0.0-HISTORY.md)
  and exact 2.1.0-era [roadmap](ROADMAP-2.1.0-HISTORY.md) and
  [assessment](PROFILE-AUDIT-ASSESSMENT-2.1.0-HISTORY.md) are historical.
- [Release process](LOCAL-RELEASE.md) covers clean-source packaging, detached smoke
  checks and explicit publication.
Detailed operational handovers and raw receipts remain in private engineering
records; they are not part of the published documentation package.

## Maintenance boundaries

Keep the goal as the outcome contract, one active roadmap as the delivery plan,
the assessment as versioned capability evidence, and release records as the
immutable source/publication/installation receipts. Keep behavior rules with
their implementation changes and update the documentation index and package
allowlist when public documents change. Preserve versioned release artifacts
and historical records; do not rewrite them to reflect later source.

The optional evaluation-isolation test harness remains dormant historical
support because tests still reference it; substantive profile, audit, session
and report fixtures remain active. Legacy series-reader compatibility is also
retained. No production deletion is justified by the current reference review.
Do not expand this into cleanup of unrelated source or configuration.

Illustrative images and prompts remain in `output/design/`, narrowly ignored by
Git and excluded from the package. They are references for a future requested
UI assessment, not implemented controls or evidence of product behavior.

Keep operational instructions in `docs/user` and implementation, verification and
publication instructions in `docs/developer`. Update the [documentation index](../README.md)
and links when moving a guide. Keep dated investigation results in the handover,
not in the user quickstart. Documentation changes do not authorize live installation,
profile mutation or client closure.
