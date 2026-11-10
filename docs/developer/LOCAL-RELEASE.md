# Build and publish a release

Audience: maintainers. Users should follow [Installation](../user/INSTALLATION.md)
to obtain a published npm package or offline bundle.

The [roadmap](ROADMAP.md#current-work-and-stop-condition) links current release evidence;
the [package manifest](../../package.json) owns the checkout version.
The stable npm tag is `latest`. Publication and changes to installed user state
require the applicable explicit request; building a bundle or passing checks
does not authorize either action.

## Release policy

The [goal](AUDIT-GOAL.md#evolution-and-provider-version-policy) owns breaking-change
and compatibility policy. Release notes must name removed commands, features,
formats and any fresh-start requirement. Preserve original user data and historical
artifacts; do not relabel earlier candidates as new verification. The
[roadmap](ROADMAP.md#current-work-and-stop-condition) links current release evidence.

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
npm run check:docs
npx playwright install chromium
npm run check:ui
npm test
npm run local-release -- --output /absolute/new/release-directory --smoke
```

The output directory must not exist. The command produces the Xenoflux npm
tarball, `xenoflux-runtime-VERSION-darwin-ARCH.tgz`, a schema-2 SHA-256 manifest
and `install.mjs`. The runtime archive retains the installed, locked dependency
tree, including required peers and the matching Koffi native library. The
builder archives installed dependency files directly with tar, preserving
package metadata and license files. It stages the tree with an offline npm
install from those local tarballs and a fresh cache. Optional SDK CLI binaries
and development dependencies are excluded.
Users supply their selected native CLIs separately. Build the offline bundle
with the target Node architecture on macOS. The installer checks the
architecture and both artifact checksums before staging. Use the installer
shipped with each bundle.

The npm tarball remains the publication artifact and resolves its dependencies
through npm during a normal install. The runtime archive is for the detached
installer. `--smoke` checks SDK imports and the managed installation lifecycle
in disposable directories. Both the npm and managed shell entries must
serve their bundled HTML, JavaScript and CSS and refuse unauthenticated API
requests. The managed check runs outside the package directory with a disposable
home/controller and mocked native service callbacks. It does not sign in, start or quit real Codex, mount
RAM storage, or use a real native home. The manifest records the exact source commit,
artifact hashes and smoke result. Dependency archiving does not invoke npm
lifecycle hooks or retain builder account ownership in tar headers. The
application pack and detached npm install use `--ignore-scripts`.

## Public source and package boundary

Review the complete outgoing commit range and both tarballs before sharing.
Keep internal operational receipts and audit handovers in private storage; preserve
their originals before producing explicitly sanitized summaries. Public summaries
retain outcomes, failed controls and coverage limits without personal paths, private
project identities, native session identifiers, full prompts or runtime state.
Credential redaction alone does not remove ordinary identifying metadata.

`docs/knowledge/` contains local engineering notes. Keep it untracked, ignored,
absent from outgoing public commit history and excluded from the package.

The package manifest includes reviewed documentation paths explicitly. Do not
replace this with the entire documentation directory: ignored or newly added
internal records can otherwise enter npm packages. The package-boundary regression
uses synthetic private canaries; also inspect the real packed file list and content.
Use a fresh public branch with sanitized changes from the outset; do not push
private candidate commits and delete their contents in a later commit. Existing
shared history is a separate boundary and is not rewritten by local preparation.

## Documentation ownership and release closeout

Keep one active roadmap for status, the goal for behavior/acceptance, feature
contracts for implementation and versioned release records for source-bound
results. Dated assessments and plans remain historical. Update the documentation
index and explicit package allowlist when public guides move; verify membership
and local inline links in the actual packed files with `npm run check:docs`.

At closeout, keep a compact summary: date/outcome, merged/tested revision, artifact
checksums, npm/GitHub identities, any installed executable, final checks, failed
controls and limits. Preserve full originals/raw receipts privately; tags and
published artifacts remain unchanged. Keep required syntax, native-helper,
full-suite, package-smoke and applicable CI checks.

## Test global npm installation in isolation

Use a temporary [npm prefix and configuration](https://docs.npmjs.com/cli/v11/using-npm/config/),
HOME, cache and explicit controller.
The PATH below applies only to disposable child commands; it simulates npm's global
bin being available without changing the current shell or startup files. An
explicit `--store` is important because Xenoflux also uses the macOS account home
in some paths; changing HOME alone is not a complete isolation boundary.

Run this in a shell with supported Node.js and npm available. Set
`XFX_RELEASE_VERSION` to the exact published release being verified. This installs
that package, checks the npm-created CLI link and empty disposable profile list,
then uninstalls and removes the temporary files. It is post-publication
verification; the detached bundle smoke above verifies an unpublished candidate.

```sh
(
  set -eu
  : "${XFX_RELEASE_VERSION:?Set the exact published xfx release to verify}"
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

  xfx_test npm install -g "xenoflux@$XFX_RELEASE_VERSION" \
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
tarball path for `xenoflux@$XFX_RELEASE_VERSION`; native verification remains separate.

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
and [audit acceptance](AUDIT-ACCEPTANCE.md) for reviewed evidence and its limits.
