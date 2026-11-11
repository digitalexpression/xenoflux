# Xenoflux

Profile manager and task comparison for Codex, Claude Code and GitHub Copilot CLI on macOS.

## Install

Run in an external terminal:

```sh
npm install -g xenoflux
```

## Create a profile

For Codex CLI/Desktop, replace `Research` with your profile name:

```sh
xfx profile create Research --apply --close-clients
xfx desktop open Research
```

Profile setup guides sign-in and may ask to close Codex clients; npm installation
does not. Repeated `desktop open` focuses the running profile. To preview setup first,
run `xfx profile create Research` without `--apply`.

npm's global bin directory must already be on `PATH`. You need supported Node.js
and the selected native CLI installed separately; Codex desktop profiles also need
Codex desktop. For Claude Code and GitHub Copilot CLI, choose the client in the
app’s **Create profile** flow and follow its native sign-in guidance. See
[Installation](docs/user/INSTALLATION.md) for requirements,
managed/offline setup and updates, and [Profiles](docs/user/PROFILES.md) to continue an
interrupted sign-in. Use `xfx --help` for all commands.

## Open the app

The local browser app supports:

```sh
xfx ui
```

Create empty or from-source profiles for any of the three CLI clients, run a
same-client or mixed-client task comparison and read its report
in a local browser app. It also supports setup/session comparisons
and external review import. From a report, start an ordinary AI review with a
selected profile and read its captured response. See
[The Xenoflux app](docs/user/APP.md), including its
[4.0.0 limits](docs/user/APP.md#400-scope-and-limits).

For version and distribution identity, see the [package manifest](package.json),
[GitHub releases](https://github.com/digitalexpression/xenoflux/releases) and
[npm package](https://www.npmjs.com/package/xenoflux).

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
