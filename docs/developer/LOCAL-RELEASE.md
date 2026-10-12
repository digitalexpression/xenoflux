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

## Test global npm installation in isolation

Use a temporary [npm prefix and configuration](https://docs.npmjs.com/cli/v11/using-npm/config/),
HOME, cache and explicit controller.
The PATH below applies only to disposable child commands; it simulates npm's global
bin being available without changing the current shell or startup files. An
explicit `--store` is important because Xenoflux also uses the macOS account home
in some paths; changing HOME alone is not a complete isolation boundary.

Run this in a shell with supported Node.js and npm available. It installs the
published 1.0.0 package, checks the npm-created CLI link and empty isolated profile
list, then uninstalls and removes the temporary files:

```sh
(
  set -eu
  xfx_test_root=$(mktemp -d "${TMPDIR:-/tmp}/xfx-global-test.XXXXXX")
  trap 'rm -rf "$xfx_test_root"' EXIT
  mkdir -p "$xfx_test_root/home"
  : > "$xfx_test_root/npmrc"
  : > "$xfx_test_root/global-npmrc"
  xfx_node_bin=$(dirname "$(command -v node)")
  xfx_npm_bin=$(dirname "$(command -v npm)")

  xfx_test() {
    env -i \
      HOME="$xfx_test_root/home" \
      PATH="$xfx_test_root/prefix/bin:$xfx_node_bin:$xfx_npm_bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      XFX_HOME="$xfx_test_root/controller" \
      npm_config_cache="$xfx_test_root/cache" \
      npm_config_userconfig="$xfx_test_root/npmrc" \
      npm_config_globalconfig="$xfx_test_root/global-npmrc" \
      "$@"
  }

  xfx_test npm install -g xenoflux@1.0.0 \
    --prefix "$xfx_test_root/prefix" --registry https://registry.npmjs.org \
    --ignore-scripts --no-audit --no-fund

  test "$(xfx_test /bin/sh -c 'command -v xfx')" = "$xfx_test_root/prefix/bin/xfx"
  xfx_test xfx --help
  test "$(xfx_test xfx --store "$xfx_test_root/controller" --json profile list)" = '[]'
  test ! -e "$xfx_test_root/home/.xfx/app"
  test ! -e "$xfx_test_root/home/.local/bin/xfx"

  xfx_test npm uninstall -g xenoflux --prefix "$xfx_test_root/prefix" \
    --registry https://registry.npmjs.org --ignore-scripts --no-audit --no-fund
  test ! -e "$xfx_test_root/prefix/bin/xfx"
  printf 'Isolated global install, CLI lookup and uninstall passed.\n'
)

```

`--ignore-scripts` keeps dependency lifecycle hooks out of this smoke check. These
commands do not call `xfx install`, create/sign in to profiles, launch or close
Codex, configure RAM logs, or modify the real npm prefix/configuration. The check
proves package installation and CLI availability, not native profile runtime.
For an unpublished candidate, pack the checkout and substitute its absolute
tarball path for `xenoflux@1.0.0`; native verification remains separate.

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
