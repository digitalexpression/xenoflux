# Install, update and remove Xenoflux

Audience: users. This guide covers installation, updates and removal.
Contributor checks are in the [developer guide](../developer/README.md).

Profile manager and task comparison for Codex, Claude Code and GitHub Copilot CLI on macOS.

Select `xenoflux@beta` for the opt-in beta channel or `xenoflux@4.0.0-beta.1`
for this exact release. Plain `xenoflux` and `xenoflux@latest` select stable.
Review the [beta scope and limits](APP.md#400-scope-and-limits) before opting in.

## Requirements

- Apple Silicon Mac with macOS 13 or later; run an arm64 Node installation.
  Intel Macs and Node running under Rosetta are unsupported in 4.0.0. The installed Codex app's own
  requirements also apply.
- Node.js 22.15.0 or later in the 22.x line, or Node.js 23.8.0 or later,
  available on `PATH`. Node.js 23.0–23.7 is unsupported.
- The selected native CLI installed separately: Codex, Claude Code or GitHub
  Copilot CLI. Codex discovery uses `PATH`, a registered profile or `--codex`.
  Profiles follow the current selected installation and observed capabilities,
  not a pinned CLI/Desktop version. Versions are retained as provenance.
- The installed Codex desktop app if you use desktop profiles.
- An external interactive terminal for commands that apply native profile or
  managed-installation changes.

Xenoflux does not bundle Node.js. Users do not need a Swift compiler or Xcode
Command Line Tools. The package includes its locked SDK runtime and arm64 native
library; selected client CLIs remain separate installations.
The Node minimum includes the Zstandard decoder needed for compressed Desktop
history. Check `node --version` and update Node separately if needed. Older saved
formats may be unsupported; preserve originals and check the release notes.

## Install globally with npm

```sh
npm install -g xenoflux@beta
xfx --help
```

npm installs the package and links `xfx` into its global executable directory:
`$(npm prefix -g)/bin` on macOS. When that directory is already on `PATH`, `xfx`
is immediately available; no `~/.local/bin` export or `xfx install` step is needed.
If `xfx` is not found, check `npm prefix -g` and your Node installation's global
bin setup. `npm install xenoflux@beta` installs the beta locally; use `npm exec -- xfx`
for that project-local installation.

Global npm installation does not close Codex clients, prepare a profile, enable
RAM logs or create the standalone managed app. Profile setup is a separate step.
The npm tarball includes the locked SDK dependencies and required peers. Optional
SDK CLI binaries are excluded; Xenoflux uses your separately installed native CLIs.
For Codex CLI/Desktop:

```sh
xfx profile create Research --apply --close-clients
xfx desktop open Research
```

For Claude Code or GitHub Copilot CLI, open `xfx ui`, select the client in
**Create profile**, then follow its native sign-in guidance. See the
[account and qualification limits](APP.md#400-scope-and-limits).

Setup may ask to close supported clients before applying changes. The package
includes its launcher; installation does not need Swift compilation.

## Optional managed installation

Use `xfx install` when you want Xenoflux to copy its app and dependencies into
`~/.xfx/app`, create `~/.local/bin/xfx`, and configure the optional RAM-log service.
It installs from the version of xfx you invoke:

```sh
xfx install --close-clients
```

You can also obtain that installer without a global npm installation:

```sh
npm exec --yes --package=xenoflux@beta -- xfx install --close-clients
```

Run managed installation from an external terminal. It may request graceful
client shutdown; it never force-kills arbitrary processes. Close standalone
terminal Codex sessions manually if requested. Its launcher requires
`~/.local/bin` on `PATH`, independently of npm's global bin directory. Keep npm's
global prefix separate from `~/.local` to avoid a launcher collision.

The managed app remains usable independently of npm's package location. The
managed installer uses the terminal's Node search path for the optional RAM-log
login service. If no supported background Node is found, it uses disk logs and
reports RAM logs disabled; see [RAM logs](RAM-LOGS.md).

## Install an offline release bundle

Download all three files from the same beta
[GitHub prerelease](https://github.com/digitalexpression/xenoflux/releases):
`xenoflux-VERSION.tgz`, `manifest.json`, and `install.mjs`. The same npm tarball
contains the SDK runtime and arm64 native library; no separate runtime archive
is required. Your selected native CLIs must be installed separately.
For this release, `VERSION` is `4.0.0-beta.1`; keep the prerelease suffix in
the tarball name. Use its matching manifest and installer.
Place them together in one directory and keep the tarballs compressed. From an
external terminal in that directory:

```sh
node install.mjs --close-clients
```

The installer checks the Apple Silicon target and SHA-256 digest before extracting
the tarball. There is no outer archive to unpack. Keep the three files until installation has been checked. If interruption
leaves `xfx` unavailable, rerun this installer from the same directory.

## Installation locations

| Location | Contents |
| --- | --- |
| `$(npm prefix -g)/lib/node_modules/xenoflux` | npm global package. |
| `$(npm prefix -g)/bin/xfx` | npm global CLI link. |
| `~/.xfx/app` | Optional managed application and dependency files. |
| `~/.local/bin/xfx` | Optional managed CLI launcher. |
| `~/.xfx/controller` | Profile registry and operation records. |
| `~/.xfx/profiles` | Default location for named native profiles. |
| `~/.xfx/ramlogs` | RAM-log service settings and recovery archives. |

## Update or remove

For the npm global installation:

```sh
npm install -g xenoflux@beta
npm uninstall -g xenoflux
```

npm updates or removes its package and CLI link. Profiles and controller data
under `~/.xfx` remain untouched. If a separate managed copy also exists, npm does
not update or remove it. Use `command -v xfx` to see which installation your shell
resolves.

The update command above stays on the beta channel. It does not move npm's
stable `latest` tag or publish anything.

For a managed installation, run its installer from a newer package or offline
bundle to update it. `xfx install --close-clients` reinstalls the version you invoke.
Use `--background-path PATH` for an explicit colon-separated service search path
instead of terminal discovery. Remove managed app, launcher and service files with:

```sh
xfx uninstall --close-clients
```

This preserves profile/controller data and does not remove a global npm package.
If RAM-log setup fails after the managed CLI has been replaced, the error reports
the installed version separately; check `xfx ramlogs status` and retry log setup
rather than reinstalling an already installed CLI.

For contributor verification and fixture limits, see the
[developer checks](../developer/README.md#checkout-and-checks).
