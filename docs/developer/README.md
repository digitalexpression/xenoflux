# Develop Xenoflux

Audience: contributors and maintainers. [User guides](../README.md#user-guides)
cover installation and normal commands; this directory covers changing the source.

## Checkout and checks

Use a supported Node.js version on macOS. From the repository root:

```sh
npm ci
npm run check
npm run check:native
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
- [Active roadmap](ROADMAP.md) delivers Codex CLI/Desktop on macOS first, through
  product and package acceptance; UI and other providers are assessed afterward.
- [Current capability assessment](PROFILE-AUDIT-ASSESSMENT.md) maps that goal to
  source evidence, gaps and proposed changes; it is not implementation approval.
- [Profile copy policy](PROFILE-COPY-POLICY.md) defines creation/copy/review behavior.
- [Audit acceptance](AUDIT-ACCEPTANCE.md) records the 2.0.0 release, bounded
  installation verification and evidence limits.
- [Release process](LOCAL-RELEASE.md) covers clean-source packaging, detached smoke
  checks and explicit publication.
Detailed operational handovers and raw receipts remain in private engineering
records; they are not part of the published documentation package.

Keep operational instructions in `docs/user` and implementation, verification and
publication instructions in `docs/developer`. Update the [documentation index](../README.md)
and links when moving a guide. Keep dated investigation results in the handover,
not in the user quickstart. Documentation changes do not authorize live installation,
profile mutation or client closure.
