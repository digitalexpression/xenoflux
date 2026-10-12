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
- An external interactive terminal for installation and commands that apply changes.

Xenoflux does not bundle Node.js. Its prebuilt launcher supports Apple Silicon and
Intel Macs; users do not need a Swift compiler or Xcode Command Line Tools.
Version 1.0.0 is the first stable release. Migration from older previews is unsupported.

## Install from npm

```sh
npm exec --yes --package=xenoflux@latest -- xfx install --close-clients
```

Installation may request graceful shutdown of supported clients; it never
force-kills arbitrary processes. Close standalone terminal Codex sessions manually
if requested. Add `~/.local/bin` to `PATH` so the installed `xfx` command is available.
No global npm installation is required. Avoid a global npm prefix of `~/.local`,
which would collide with Xenoflux's managed launcher.

The managed app remains usable independently of npm's temporary package cache.
Installation uses the terminal's Node search path for the optional RAM-log login
service. If no supported background Node is found, it uses disk logs and reports
RAM logs disabled; see [RAM logs](RAM-LOGS.md).

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

## Installed locations

| Location | Contents |
| --- | --- |
| `~/.xfx/app` | Managed application and dependency files. |
| `~/.local/bin/xfx` | CLI launcher. |
| `~/.xfx/controller` | Profile registry and operation records. |
| `~/.xfx/profiles` | Default location for named native profiles. |
| `~/.xfx/ramlogs` | RAM-log service settings and recovery archives. |

## Update or remove

Repeat the npm installation command to obtain a newer published release.
`xfx install --close-clients` instead reinstalls the currently installed version.
Use `--background-path PATH` when you need an explicit colon-separated service
search path instead of terminal discovery.

```sh
xfx uninstall --close-clients
```

Uninstall removes managed application, launcher and service files while preserving
profile/controller data. If RAM-log setup fails after the CLI has been replaced,
the error reports the installed version separately; check `xfx ramlogs status`
and retry log setup rather than reinstalling an already installed CLI.
