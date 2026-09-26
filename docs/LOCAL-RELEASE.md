# Local release

Xenoflux provides a macOS preview bundle and an npm-compatible package. It does not install or bundle Node.js. The target machine needs a user-managed Node.js 22.x executable from 22.13.0 onward, or Node.js 23.4.0 or later, on `PATH`. Node.js 23.0–23.3 is unsupported.

## npm setup

After a preview is published, obtain and run its installer in an external terminal:

```sh
npm exec --yes --package=xenoflux@preview -- xfx install --close-clients
```

This copies the package and its dependency into `~/.xfx/app`, creates `~/.local/bin/xfx`, and configures RAM logs. The managed app remains usable independently of npm's temporary package cache. Add `~/.local/bin` to PATH. Repeat this npm command to obtain a newer preview; plain `xfx install` uses the already installed version.

Use `xfx uninstall --close-clients` to remove the managed app, launcher and service while preserving profile/controller data. There is no global npm package to remove in this setup flow. Avoid installing globally with an npm prefix of `~/.local`: npm's command symlink would collide with the managed launcher. Xenoflux refuses to replace an unmanaged launcher; do not force an overwrite.

The package is macOS-only. For an approved publication, explicitly pass `--tag preview --access public` to `npm publish`, including when publishing a tarball; do not rely on npm honoring the package's publication defaults for every invocation. Publication is a separate maintainer action; generating a tarball or running these local checks does not publish it.

## Four-file bundle

Create a release from a clean tracked source tree:

```sh
npm ci
npm run check
npm test
npm run local-release -- --output /absolute/new/release-directory --smoke
```

The output directory must not exist. The command writes the package tarball, the `smol-toml` dependency tarball, a SHA-256 manifest, and `install.mjs`. `--smoke` installs those artifacts into a disposable directory and checks the installed command and fixture-only lifecycle. It does not sign in, start or quit Codex, mount RAM storage, or use a real native home.

Copy the complete output directory to the target Mac. When downloading release assets, download all four files from the same release into one directory: `xenoflux-VERSION.tgz`, `smol-toml-VERSION.tgz`, `manifest.json`, and `install.mjs`. There is no outer archive to unpack. Keep both tarballs compressed. From an external terminal in that directory, run:

```sh
node install.mjs --close-clients
```

The installer places the application at `~/.xfx/app`, controller data at `~/.xfx/controller`, profiles at `~/.xfx/profiles`, RAM-log settings at `~/.xfx/ramlogs`, and the launcher at `~/.local/bin/xfx`. It is independent of the source checkout after installation.

Use `xfx install --close-clients` to reinstall from an installed bundle, or provide `--background-path PATH` to configure the background RAM-log service’s colon-separated executable search directories. Use `xfx uninstall --close-clients` to remove the managed installation. These commands require an external interactive terminal so Xenoflux can offer a graceful client shutdown.

Keep the four release files until installation has been checked. If interruption during app replacement leaves `xfx` unavailable, rerun `node install.mjs --close-clients` from that directory in an external terminal. A RAM-service setup failure can leave the new CLI installed with disk logs; inspect its status before retrying. Installation does not promise atomic rollback of every completed step.

The automated checks cover package construction and disposable fixtures. Before relying on an installation, complete the manual acceptance on the target Mac: native profile sign-in, a graceful client shutdown, and a reboot with the RAM-log service enabled.

The rc.3 build passed user-operated acceptance on one Mac: native sign-in, client shutdown, paired desktop selection, Dock reopening, Default restoration, copy/undo, RAM routing, and automatic RAM preparation after reboot. That run supplied the terminal PATH explicitly. rc.4 adds automatic terminal-PATH discovery; its fixture checks do not constitute a new live-Mac acceptance run.
