# Xenoflux

A Codex profile manager for macOS.

## Install

Run in an external terminal:

```sh
npm install -g xenoflux
```

## Create a profile

Replace `Research` with your profile name:

```sh
xfx profile create Research --apply --close-clients
xfx desktop open Research
```

Profile setup guides sign-in and may ask to close Codex clients; npm installation
does not. Repeated `desktop open` focuses the running profile. To preview setup first,
run `xfx profile create Research` without `--apply`.

npm's global bin directory must already be on `PATH`. You need supported Node.js
and a Codex CLI executable; desktop profiles also need Codex desktop. See
[Installation](docs/user/INSTALLATION.md) for requirements,
managed/offline setup and updates, and [Profiles](docs/user/PROFILES.md) to continue an
interrupted sign-in. Use `xfx --help` for all commands.

## Documentation

- **Users:** [Profiles](docs/user/PROFILES.md), [Desktop](docs/user/DESKTOP.md),
  [Copy settings](docs/user/ADVANCED-COPY.md), [Recovery](docs/user/PROFILE-RECOVERY.md)
  and [RAM logs](docs/user/RAM-LOGS.md).
- **Developers:** [Development](docs/developer/README.md),
  [Release process](docs/developer/LOCAL-RELEASE.md),
  [Desktop implementation](docs/developer/DESKTOP-IMPLEMENTATION.md)
  and [Copy policy](docs/developer/PROFILE-COPY-POLICY.md).

The [documentation index](docs/README.md) includes developer handovers and release records.

## License

[MIT](LICENSE).
