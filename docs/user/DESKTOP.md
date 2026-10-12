# Desktop profiles

Audience: users. Run desktop controls from an external interactive terminal.

## Open or focus

```sh
xfx desktop open Research
xfx desktop open OtherProfile
xfx desktop list --observe
```

`open` creates or refreshes a stopped profile's cached `Codex · NAME.app` when
needed, then launches it. Opening a running profile focuses that same instance
without replacing or signing its cached app. Named operations keep Default's
normal paths and leave other clients running. Different profiles can run
concurrently; the same profile cannot use the managed CLI and desktop together.

Each profile uses fixed Codex, SQLite, UI-data and temporary paths. Desktop keeps
the account HOME for login-keychain access; account-wide resources can remain
shared. Xenoflux does not copy credentials, reset keychains or change their search
lists. Filesystem separation does not guarantee all native resources are isolated.

The package includes the launcher, so Swift compilation is unnecessary. A first
open or stale stopped cache still copies and signs a customized app using macOS's
built-in tools. The installed Codex app remains intact. Keep a profile app in the
Dock or open it in Finder after preparation; if it becomes stale, refresh it through
CLI `desktop open NAME`. Renaming takes effect on its app label after the profile
stops and is next prepared.

## Observe, focus or close

```sh
xfx desktop list --observe
xfx desktop focus Research
xfx desktop close Research
```

In observed output, the top-level status is the saved record; `observed.status`
and its process list show what the process check found. A saved `running` record
can therefore refer to an instance already stopped. `open` can reconcile its
stopped, idle reservation before reopening it.

`close` requests graceful quit of the verified target only. It refuses to control
an instance hosting the invoking command. A failed or incomplete identity/resource
check preserves the reservation; Xenoflux never force-kills arbitrary processes.

## Recover an interrupted desktop operation

```sh
xfx desktop recover Research --dry-run
xfx desktop recover Research
```

Recover only after that instance has stopped. Recovery verifies its journal,
reservation and remaining writers, and releases only its own stopped reservation.
It does not close or launch an app. For interrupted sign-in or a CLI run, use the
separate [profile recovery guide](PROFILE-RECOVERY.md).

## Explicit cache maintenance

Normal use needs only `desktop open`. For diagnostics or maintenance of a stopped
profile, `xfx desktop prepare NAME` creates or refreshes its cached app;
`xfx desktop refresh NAME` is an alias. These commands refuse running profiles.
`--dry-run` previews routing without preparing, signing or launching.

For implementation details and the recorded native-test boundaries, see the
[developer desktop reference](../developer/DESKTOP-IMPLEMENTATION.md).
