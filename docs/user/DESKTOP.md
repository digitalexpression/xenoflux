# Desktop profiles

Audience: users. Run desktop controls from an external interactive terminal.

## Open or focus

```sh
xfx desktop open Research
xfx desktop open OtherProfile
xfx desktop list --observe
```

`open` creates or refreshes a stopped profile's `Codex · NAME.app` shortcut when
needed, then launches the OpenAI-signed Desktop app for that profile. Opening a
running profile focuses that same instance. Named operations keep Default's
normal paths and leave other clients running. Different profiles can run
concurrently; the same profile cannot use the managed CLI and desktop together.

Each profile uses fixed Codex, SQLite, UI-data and temporary paths. Desktop keeps
the account HOME for login-keychain access; account-wide resources can remain
shared. Xenoflux does not copy credentials, reset keychains or change their search
lists. Filesystem separation does not guarantee all native resources are isolated.

The package includes the launcher. Open the `applicationPath` reported by
`desktop open NAME` in Finder, or drag that app from Finder to the applications
side of the Dock to pin it. Click **Codex · NAME** to open or focus that profile.
The running Desktop app has its own **ChatGPT** Dock tile. Use the named shortcut
for profile-specific reopening and `desktop close NAME` for profile-specific quit.
If a shortcut becomes stale, refresh it through `desktop open NAME` in a terminal.
Renaming takes effect on the shortcut after the profile stops and is next prepared.

## Observe, focus or close

```sh
xfx desktop list --observe
xfx desktop focus Research
xfx desktop close Research
```

In observed output, `observed.status` and its process list show what the process
check found. You may quit Codex normally. Observed listing and review Start
reconcile a confirmed-stopped Desktop reservation automatically; `open` also
reconciles it before reopening. Uncertain helpers or file holders preserve the
reservation. A concurrent ordinary review keeps its own reservation when Desktop
quits; review cancellation does not close Desktop. New Desktop launch while a
review owns the profile remains blocked.

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
profile, `xfx desktop prepare NAME` creates or refreshes its shortcut;
`xfx desktop refresh NAME` is an alias. These commands refuse running profiles.
`--dry-run` previews routing without preparing, signing or launching.

For implementation details and the recorded native-test boundaries, see the
[developer desktop reference](../developer/DESKTOP-IMPLEMENTATION.md).
