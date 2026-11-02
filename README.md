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

## Open the app

The local browser app targets the upcoming **3.0.0 major release**; it is not in
the published 2.1.0 package. Development builds currently provide:

```sh
xfx ui
```

Create empty or from-source profiles, run a task comparison and read its report
in a local browser app. The candidate also supports setup/session comparisons
and external review import. From a report, start an ordinary AI review with a
selected profile and read its captured response. See
[The Xenoflux app](docs/user/APP.md).

## Documentation

- **Users:** [The app](docs/user/APP.md), [Profiles](docs/user/PROFILES.md), [Desktop](docs/user/DESKTOP.md),
  [Copy settings](docs/user/ADVANCED-COPY.md), [Recovery](docs/user/PROFILE-RECOVERY.md)
  and [RAM logs](docs/user/RAM-LOGS.md).
- **Developers:** [Development](docs/developer/README.md),
  [Release process](docs/developer/LOCAL-RELEASE.md),
  [Desktop implementation](docs/developer/DESKTOP-IMPLEMENTATION.md)
  and [Copy policy](docs/developer/PROFILE-COPY-POLICY.md).

The [documentation index](docs/README.md) includes the active roadmap and public release records.

## License

[MIT](LICENSE).
