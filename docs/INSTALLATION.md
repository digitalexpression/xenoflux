# Install, update and remove Xenoflux

Choose stable with `xenoflux@latest` or the opt-in channel with `xenoflux@beta`.
Plain `xenoflux` also selects stable. These guides describe the 4.0 line, currently
in beta; stable features may differ. Check the
[known limits](GUIDE.md#supported-clients-and-known-limits) before choosing.

## Requirements

- Apple Silicon Mac, macOS 13 or later, with arm64 Node. Intel/Rosetta Node is
  unsupported. The selected native apps' own requirements also apply.
- Node.js 22.15.0 or later in the 22.x line, or 23.8.0 or later, on PATH.
  Node.js 23.0–23.7 is unsupported; compressed history needs the Zstandard decoder.
- The selected Codex, Claude Code or GitHub Copilot CLI installed separately.
  Codex Desktop is also needed for managed Codex desktop profiles.
- An external interactive terminal for native profile or managed-install changes.

The package includes its locked SDK runtime, native library and prebuilt launcher.
It does not bundle Node or the client CLIs. Users need no Swift compiler or Xcode.
Profiles follow the current selected installation; versions are provenance.

## Install with npm

Run one install command:

| Channel | Install |
| --- | --- |
| Stable | `npm install -g xenoflux@latest` |
| Opt-in beta | `npm install -g xenoflux@beta` |

For an exact version, use its full version, such as `xenoflux@4.0.0-beta.1`.
Then open the app:

```sh
xfx --help
xfx ui
```

npm links `xfx` under `$(npm prefix -g)/bin` on macOS. Put that directory on PATH
if the command is missing. No separate `xfx install` step is required. A local
`npm install xenoflux@latest` can be used through `npm exec -- xfx`; substitute
`@beta` to choose that channel.

npm installation does not close native clients, sign in or create profiles.
Continue in the [user guide](GUIDE.md), or use the [CLI recipes](CLI.md).

## Optional managed installation

To install the version of xfx you invoke into `~/.xfx/app`:

```sh
xfx install --close-clients
```

Without a global installation:

```sh
npm exec --yes --package=xenoflux@latest -- xfx install --close-clients
```

Use `--package=xenoflux@beta` instead to install the beta channel.

Run this from an external terminal. It may request graceful shutdown; close
standalone Codex terminal sessions manually when asked. It never force-kills
arbitrary processes. Its launcher uses `~/.local/bin`, independently of npm's
bin directory. Keep npm's prefix separate from `~/.local` to avoid collisions.

The managed app remains usable independently of npm's package location. Optional
RAM-log setup uses a supported background Node discovered from the terminal PATH;
without one, installation uses disk logs and reports RAM logs disabled. See
[diagnostic log routing](CLI.md#diagnostic-log-routing) for status and recovery.

## Install an offline bundle

Download `xenoflux-VERSION.tgz`, `manifest.json` and `install.mjs` from the same
[GitHub release](https://github.com/digitalexpression/xenoflux/releases).
Choose a stable release or an opt-in prerelease and preserve the full version,
including any beta suffix, in `VERSION`. No separate SDK
runtime archive is needed. Keep the three files together and the tarball compressed.
From an external terminal in that directory:

```sh
node install.mjs --close-clients
```

The installer checks the target and SHA-256 before extraction. Keep the files
until installation is checked. If interruption leaves `xfx` unavailable, rerun
that same installer. Node and the chosen native CLIs are still prerequisites.

## Update or remove

Repeat your chosen [npm install command](#install-with-npm) to update or switch
channels. To remove the npm installation:

```sh
npm uninstall -g xenoflux
```

These commands update/remove npm's package and link, preserving `~/.xfx` profiles
and controller data. They do not update/remove a separate managed copy. The update
uses the selected channel and changes no registry tags. Use `command -v xfx` to
identify the executable your shell resolves.

Update a managed copy using a newer package/bundle's installer. `xfx install`
reinstalls the version invoked. Remove its app, launcher and services with
`xfx uninstall --close-clients`; profiles/controller data and global npm remain.
`--background-path PATH` selects an explicit service search path.

If CLI replacement succeeds but RAM setup fails, the error distinguishes those
outcomes. Check `xfx ramlogs status` and repair log routing instead of reinstalling.

| Path | Owner/content |
| --- | --- |
| `$(npm prefix -g)/lib/node_modules/xenoflux` and `$(npm prefix -g)/bin/xfx` | npm package and executable link |
| `~/.xfx/app`, `~/.local/bin/xfx` | Optional managed app and launcher |
| `~/.xfx/controller`, `~/.xfx/profiles` | Registry/operation records and default named-profile location |
| `~/.xfx/ramlogs` | Optional diagnostic service settings and recovery archives |
