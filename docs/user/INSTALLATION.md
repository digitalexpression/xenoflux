# Install, update and remove Xenoflux

Audience: users. Building and publishing packages is covered in the
[developer release guide](../developer/LOCAL-RELEASE.md).

## Requirements

- macOS 13 or later for the packaged launcher; the installed Codex app's own
  requirements also apply.
- Node.js 22.13.0 or later in the 22.x line, or Node.js 23.4.0 or later,
  available on `PATH`. Node.js 23.0–23.3 is unsupported.
- A supported Codex CLI executable to create or run CLI profiles, discovered
  through `PATH`, a registered profile or an explicit `--codex` path.
- The installed Codex desktop app if you use desktop profiles.
- An external interactive terminal for commands that apply native profile or
  managed-installation changes.

Xenoflux does not bundle Node.js. Its prebuilt launcher supports Apple Silicon and
Intel Macs; users do not need a Swift compiler or Xcode Command Line Tools.
Version 1.0.0 is the first stable release. Migration from older previews is unsupported.

## Install globally with npm

```sh
npm install -g xenoflux
xfx --help
```

npm installs the package and links `xfx` into its global executable directory:
`$(npm prefix -g)/bin` on macOS. When that directory is already on `PATH`, `xfx`
is immediately available; no `~/.local/bin` export or `xfx install` step is needed.
If `xfx` is not found, check `npm prefix -g` and your Node installation's global
bin setup. Plain `npm install xenoflux` installs locally; use `npm exec -- xfx`
for that project-local installation.

Global npm installation does not close Codex clients, prepare a profile, enable
RAM logs or create the standalone managed app. Profile setup is a separate step:

```sh
xfx profile create Research --apply --close-clients
xfx desktop open Research
```

Setup may ask to close supported clients before applying changes. The package
includes its launcher; installation does not need Swift compilation.

## Optional managed installation

Use `xfx install` when you want Xenoflux to copy its app and dependency into
`~/.xfx/app`, create `~/.local/bin/xfx`, and configure the optional RAM-log service.
It installs from the version of xfx you invoke:

```sh
xfx install --close-clients
```

You can also obtain that installer without a global npm installation:

```sh
npm exec --yes --package=xenoflux@latest -- xfx install --close-clients
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

Download all four files from the same [GitHub release](https://github.com/digitalexpression/xenoflux/releases):
`xenoflux-VERSION.tgz`, `smol-toml-VERSION.tgz`, `manifest.json`, and `install.mjs`.
Place them together in one directory and keep the tarballs compressed. From an
external terminal in that directory:

```sh
node install.mjs --close-clients
```

The installer verifies and extracts the tarballs. There is no outer archive to
unpack. Keep the four files until installation has been checked. If interruption
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
npm install -g xenoflux@latest
npm uninstall -g xenoflux
```

npm updates or removes its package and CLI link. Profiles and controller data
under `~/.xfx` remain untouched. If a separate managed copy also exists, npm does
not update or remove it. Use `command -v xfx` to see which installation your shell
resolves.

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

For a disposable verification of the npm global flow, see
[the developer isolated-install check](../developer/LOCAL-RELEASE.md#test-global-npm-installation-in-isolation).
