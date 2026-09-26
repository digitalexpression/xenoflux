# RAM logs

Xenoflux can route diagnostic logs to a macOS RAM volume. The logs are disposable at reboot. Native settings, credentials, conversations, histories, and state databases stay on disk.

The installer uses the invoking terminal's `PATH` for a new RAM-log service. Install/enable reuse a working saved path and retry the current terminal's path if the saved Node installation is unavailable or unsupported. `--background-path PATH` takes precedence and is checked without fallback. If discovery cannot resolve a supported Node version, Xenoflux installs with RAM logs disabled and uses disk logs. Retry from an external terminal where Node is available:

```sh
xfx ramlogs status
xfx ramlogs enable --close-clients
```

`xfx install --close-clients --background-path PATH` sets the service’s directory search path for an installation or reinstall. `xfx ramlogs disable --close-clients` disables RAM-log routing and returns to disk logs.

The validated search path is stored only in local settings and the user's login-service plist. The service runs `node` through `/usr/bin/env`; it does not load shell startup files. Version-manager directories can therefore appear in local settings. If that Node version is removed, rerun enable from a terminal with a supported Node to refresh discovery, or explicitly provide the replacement PATH.

After login/reboot, inspect `xfx ramlogs status` before running enable or ensure so a manual repair does not hide a startup failure. The login job is one-shot: it can finish successfully without remaining running. Diagnostic logs are recreated as needed; settings, credentials, and conversation data must remain available on disk.

Routing is prepared only after Xenoflux has checked that the relevant clients are idle. `--close-clients` allows it to offer a graceful shutdown of supported clients; it does not force-kill arbitrary processes, and standalone terminal Codex sessions must be closed manually. If the idle check, service setup, or RAM-volume preparation fails, the operation stops and reports the failure; inspect status before retrying. Returning from RAM to disk starts a fresh diagnostic log. Existing disk-backed logs are preserved.

Automated tests use fixtures and mocked clients. Confirm real routing, client shutdown, and reboot behavior manually on the target Mac before relying on the service.
