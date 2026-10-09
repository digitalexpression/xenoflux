# Xenoflux

Xenoflux (`xfx`) is a Codex profile manager for macOS. It keeps named profiles separate, provides guided setup and sign-in, compares selected native settings, copies those settings with an undo record, and can route diagnostic logs to RAM while preserving the native home on disk.

It is a macOS preview and does not bundle Node.js. Use a user-managed Node.js 22.x installation from 22.13.0 onward, or Node.js 23.4.0 or later, available on `PATH`. Node.js 23.0–23.3 is unsupported because its SQLite API still requires an experimental flag.

## Install

For a published npm preview, run this from an external terminal:

```sh
npm exec --yes --package=xenoflux@preview -- xfx install --close-clients
```

This uses npm to obtain the installer, then creates the managed application and launcher described below. It does not require a global npm installation. Add `~/.local/bin` to `PATH`. Use the same command to update to a newer published preview; `xfx install` reinstalls the currently installed version.

Alternatively, build the four-file release bundle from a clean checkout with its dependencies installed:

```sh
npm ci
npm run check
npm test
npm run local-release -- --output /absolute/new/release-directory --smoke
```

The release consists of four files: `xenoflux-VERSION.tgz`, `smol-toml-VERSION.tgz`, `manifest.json`, and `install.mjs`. Copy or download all four files from the same release into one directory. Keep the tarballs compressed; the installer verifies and extracts them. From an external terminal in that directory, run:

```sh
node install.mjs --close-clients
```

Xenoflux installs its application files under `~/.xfx/app`, its controller under `~/.xfx/controller`, native profiles under `~/.xfx/profiles`, RAM-log settings under `~/.xfx/ramlogs`, and the `xfx` launcher at `~/.local/bin/xfx`. Add `~/.local/bin` to `PATH` if it is not already present.

`xfx install --close-clients` reinstalls from an installed bundle. Use `--background-path PATH` to configure the service’s colon-separated executable search directories. `xfx uninstall --close-clients` removes Xenoflux-managed installation files after a graceful client shutdown. These commands, desktop control, and any setting copy that applies changes require an external interactive terminal.

## Profiles

Preview a named profile, then apply the guided setup. Continue sign-in separately if setup was interrupted:

```sh
xfx profile create Research
xfx profile create Research --apply --close-clients
xfx profile signin Research --apply --close-clients
xfx profile list
xfx profile inspect Research
```

Profiles keep their own settings, sign-in, history, and desktop data. Xenoflux does not copy credentials or conversations between them. Guided creation prepares desktop integration and shows the reviewed command to finish it.

To register an existing native profile directory, use `xfx profile register NAME ROOT --codex EXECUTABLE --codex-version VERSION`. Registration creates its profile record after validating the directory. `profile rename`, `profile delete`, and `profile unbind` change registry metadata while preserving native files. Deletion and native unbinding refuse profiles referenced by activation or unfinished operations so restoration remains possible.

For a forcibly interrupted sign-in or CLI run, follow [profile recovery](docs/PROFILE-RECOVERY.md).

Compare the supported native-setting selections before making a copy. `Default` is the built-in profile at Codex’s normal directories. It is a settings source and the desktop restoration destination; named profiles are stored separately.

```sh
xfx compare Default Research --include config,instructions,agents
xfx copy Default Research --include instructions,agents
xfx copy Default Research --include instructions,agents --apply --close-clients
xfx copy undo COPY_ID
xfx copy undo COPY_ID --apply --close-clients
```

Use `xfx profile inspect Default` to inventory discovered settings and resources, including known projects. For a searchable selection of individual supported items, use:

```sh
xfx copy Default Research --advanced
xfx copy Default Research --advanced --apply --close-clients
xfx profile create Research --from Default --advanced --apply --close-clients
```

Create a fresh profile or seed one from selected source items; later copies are
reviewed updates, not synchronization. Advanced mode supports configuration keys,
instruction files, individual agents, standalone skills and rules. All copy entry
points preserve unselected destination items. Selected skill replacement is exact,
including previewed package-local deletions and undo. Plugins, hooks and MCP receive
optional native/manual setup guidance only. See [Advanced copying](docs/ADVANCED-COPY.md)
for controls, compatibility changes, discovery limits and recovery.

The preview is read-only. A copy or undo records its backup and refuses to overwrite an intervening native change. Restore the desktop to `Default` before applying a copy. The category-based copy surface excludes skills, plugins, MCP configuration, credentials, histories, and repository files. Advanced mode adds standalone skills and rules; it does not copy native history or integrations.

## Desktop profiles and recovery

The `Default` profile uses Codex's standard paths, including `~/.codex`. By default, named profiles use isolated homes under `~/.xfx/profiles`; profile creation and registration can use another chosen base path. An older alias selection may remain active until you explicitly restore it. Use an external terminal for desktop recovery; Xenoflux never force-kills arbitrary processes.

```sh
xfx desktop open Research
xfx desktop list --observe
xfx desktop focus Research
xfx desktop close Research
xfx desktop current --observe
xfx desktop restore --close-clients
xfx desktop recover --no-open
```

The legacy `desktop switch`, `desktop pick`, `desktop activate`, `desktop activation-plan` and `desktop add-target` commands are retired. New named-profile desktops use `desktop open NAME`; `current`, `restore` and the no-name `recover` remain for an existing legacy selection. Restore an active legacy selection before opening a named desktop. For an unfinished selection, use `desktop recover --no-open`, then restore. Recovery with `--no-open` requires all clients to be stopped already and does not reopen Codex.

## Concurrent desktops

Open separate named profiles alongside an existing Codex session:

```sh
xfx desktop open Research --dry-run
xfx desktop open Research
xfx desktop open Personal
xfx desktop list --observe
xfx desktop focus Research
xfx desktop close Personal
```

Each managed instance keeps fixed profile storage paths and an exclusive reservation.
Opening a running profile focuses it. Other profiles can run concurrently in the CLI
or desktop; the same profile cannot run in both at once. These commands do not change
the default aliases or close other clients, and can run from an existing Codex chat.
Closing a profile refuses to target a Codex process that hosts the invoking command.

An owned launcher named `Codex · PROFILE` forwards activation to that profile's
Codex process. The first open compiles its small AppKit helper with the installed
Xcode Command Line Tools, then reuses it. The vendor app is left intact. Native
Cmd+Tab, Dock reopening, and profile routing remain acceptance checks pending on
the target Mac; fixture checks and helper compilation do not establish them.

`xfx desktop recover NAME` releases only a stopped instance's verified reservation;
it does not quit or reopen an app. For an existing alias selection, use the no-name
`xfx desktop recover` command. See [concurrent desktop operation](docs/CONCURRENT-DESKTOPS.md)
for the test boundary and recovery details.

## RAM logs

RAM logs are optional and disposable at reboot. Only diagnostic logs move; native settings, sign-in data, conversations, and state databases remain on disk. Xenoflux prepares native log routing only after it confirms the relevant clients are idle.

```sh
xfx ramlogs status
xfx ramlogs enable --close-clients
xfx ramlogs disable --close-clients
```

Installation discovers Node through the invoking terminal's `PATH` and saves that search path locally for the RAM-log login service. A working saved service path is reused; if it no longer resolves a supported Node, install/enable retry with the current terminal's path. An explicit `--background-path PATH` overrides discovery. If no supported background Node is found, Xenoflux installs with RAM logs disabled and continues to use disk logs. After changing your Node installation, retry with `xfx ramlogs enable --close-clients`.

See [RAM logs](docs/RAM-LOGS.md) and [local release](docs/LOCAL-RELEASE.md) for operational details.

## Verification

`npm run check` performs JavaScript syntax checks. `npm test` uses disposable fixtures and mocked native clients; it does not mount a RAM volume, quit an application, or modify a real native home. A real profile sign-in, client shutdown, and reboot/RAM-service check remain manual acceptance steps on the target Mac.

## License

Xenoflux is licensed under the [MIT License](LICENSE).
