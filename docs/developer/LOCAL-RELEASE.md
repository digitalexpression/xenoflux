# Build and publish a release

Audience: maintainers. Users should follow [Installation](../user/INSTALLATION.md)
to obtain a published npm package or offline bundle.

Version 1.0.0 is the first stable release. Earlier preview migration is unsupported.
The stable npm tag is `latest`. Publication requires an explicit release request;
building a bundle or passing checks does not publish it or authorize installation.

## Prepare the launcher and source

If `src/native/profile-launcher.swift` changed, build on macOS with Xcode Command
Line Tools using `npm run build:native`, then verify with `npm run check:native`.
Commit its source, universal binary and hash manifest together. The release ships
that prebuilt helper; target machines do not need Swift. No install/pack hook compiles it.

Update `package.json` and the root versions in `package-lock.json` together. Commit
all package inputs before packaging; the release command requires a clean tracked
source revision and refuses untracked runtime inputs.

```sh
npm ci
npm run check
npm run check:native
npm test
npm run local-release -- --output /absolute/new/release-directory --smoke
```

The output directory must not exist. The command produces four files: the Xenoflux
tarball, `smol-toml` dependency tarball, SHA-256 manifest and `install.mjs`. `--smoke`
installs them into a disposable directory and checks the detached offline package
and installation lifecycle. It does not sign in, start or quit real Codex, mount
RAM storage, or use a real native home. The manifest records the exact source commit,
artifact hashes and smoke result. Package scripts are ignored during packing.

## Publish approved artifacts

Verify CI on the intended PR head before merging. Build the final bundle from the
merged source so the release tag and manifest identify the same commit. Publish
that tested tarball, explicitly specifying registry, access and stable tag:

```sh
npm publish /absolute/release-directory/xenoflux-VERSION.tgz \
  --registry https://registry.npmjs.org --tag latest --access public --ignore-scripts
```

Replace `VERSION` with the package version. Complete npm's required authentication
and publication confirmation. Do not place credentials in release artifacts.
Create the matching GitHub `vVERSION` stable release at the manifest's source
revision and upload all four files from that bundle. Record user installation
instructions by linking the [installation guide](../user/INSTALLATION.md).

After publication, verify the GitHub tag's target and asset hashes, npm version and
`latest` tag, and public tarball bytes against the manifest. npm processing can delay
public availability after it accepts an upload. Keep published assets and tags tied
to their original source commit; do not rebuild or retag an existing version for a
later documentation-only change.

## Evidence boundary

CI and fixture checks establish the paths they exercise, not all native runtime
behavior. Record actual sign-in, Dock/Cmd+Tab identity, data separation, shutdown,
and reboot/RAM-service results separately when those operations are authorized.
See [Desktop verification](DESKTOP-IMPLEMENTATION.md#verification-and-native-acceptance)
and the [concurrent profile handover](HANDOVER-macos-concurrent-profiles.md) for
dated evidence and remaining limits.
