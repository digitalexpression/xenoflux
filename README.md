# Xenoflux

Compare what Codex, Claude Code or GitHub Copilot CLI did on the same task, using
independent profiles and inspectable evidence in a local macOS browser app.

Choose a release channel:

| Channel | Install |
| --- | --- |
| Stable | `npm install -g xenoflux@latest` |
| Opt-in beta | `npm install -g xenoflux@beta` |

These guides describe the 4.0 line, currently in beta; stable features may differ.
[Installation](docs/INSTALLATION.md) covers requirements, version selection,
updates and removal.

After installation:

```sh
xfx ui
```

Create or select two profiles, compare a task, inspect responses/checks/replay,
and optionally request an AI review of the frozen report. Existing sessions can
also be compared without starting another model task. Each comparison can use
the same profile on both sides or mix supported CLI clients.

Reports distinguish observations, verification and reviewer judgments. Missing
evidence stays visible; one pair does not establish a universal winner.

| Read | For |
| --- | --- |
| [User guide](docs/GUIDE.md) | Profiles, comparisons, reports, reviews and recovery |
| [CLI recipes](docs/CLI.md) | Terminal workflows, experiments and external reviews |
| [Contributing on GitHub](https://github.com/digitalexpression/xenoflux/blob/main/CONTRIBUTING.md) | Source changes, checks and architecture |

[GitHub releases](https://github.com/digitalexpression/xenoflux/releases) and
[package metadata](package.json) identify distributed versions.

[MIT license](LICENSE).
