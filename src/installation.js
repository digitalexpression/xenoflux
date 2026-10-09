import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { checkNode, BACKGROUND_PATH, nativePath } from './node-runtime.js';
import { userPaths } from './paths.js';
import { readLogSettings as readSettings, writeLogSettings as writeSettings } from './log-storage.js';

const executeFile = promisify(execFile);
const APP_MARKER = '.xfx-install.json';
const APP_OWNER = 'com.xenoflux.app.v1';
const ENTRY_MARKER = '# xenoflux-managed-entry-v1';
const SERVICE = 'com.xenoflux.ramlogs';

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function absent(error) { return error?.code === 'ENOENT'; }

function privateOwned(stat, directory, label) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error(`${label} must be a private path owned by this user`);
}

async function fileText(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (absent(error)) return null; throw error; }
}

async function kind(path) {
  try { return await lstat(path); }
  catch (error) { if (absent(error)) return null; throw error; }
}

async function atomicFile(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx', mode });
  await rename(temporary, path);
}

function servicePlist(paths, environment) {
  const args = ['/usr/bin/env', 'node', join(paths.app, 'bin', 'xfx.js'), 'ramlogs', 'ensure'];
  const strings = args.map(value => `    <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${SERVICE}</string>\n  <key>ProgramArguments</key>\n  <array>\n${strings}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key>\n    <string>${xml(environment.HOME)}</string>\n    <key>PATH</key>\n    <string>${xml(environment.PATH)}</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>\n`;
}

/**
 * Installs the self-contained xfx package and its optional login-time RAM-log job.
 * Callbacks keep native-home selection and persistent settings under the CLI's owner.
 */
export function createInstallation({ home, source = new URL('..', import.meta.url), pathsFor = userPaths,
  execute = executeFile, runService = executeFile, check = checkNode,
  readLogSettings, writeLogSettings, prepareLogs = async () => {}, restoreLogs = async () => {},
  serviceLoaded, uid = process.getuid?.() ?? userInfo().uid } = {}) {
  const sourceRoot = source instanceof URL ? fileURLToPath(source) : source;
  const defaultEnv = { ...process.env, HOME: home ?? userInfo().homedir };

  function paths(env) {
    const home = env?.HOME;
    if (typeof home !== 'string' || !home || /[\0\r\n]/.test(home)) throw new Error('A valid HOME is required');
    return pathsFor(home);
  }

  function backgroundEnv(env, backgroundPath) {
    const PATH = nativePath({ PATH: backgroundPath ?? BACKGROUND_PATH });
    return { HOME: env.HOME, PATH };
  }

  const settingsFor = env => (readLogSettings ?? (options => readSettings(options)))({ home: env.HOME, env });
  const saveSettings = (value, env) => (writeLogSettings ?? ((settings, options) => writeSettings(settings, options)))(value, { home: env.HOME });

  async function ownedApp(app) {
    const stat = await kind(app);
    if (!stat) return false;
    privateOwned(stat, true, `Application path ${app}`);
    let marker;
    try {
      const markerPath = join(app, APP_MARKER);
      privateOwned(await lstat(markerPath), false, `Application marker ${markerPath}`);
      marker = JSON.parse(await readFile(markerPath, 'utf8'));
    }
    catch { throw new Error(`Refusing application path not owned by Xenoflux: ${app}`); }
    if (marker.owner !== APP_OWNER) throw new Error(`Refusing application path not owned by Xenoflux: ${app}`);
    return true;
  }

  async function ownedEntry(bin) {
    const stat = await kind(bin);
    if (!stat) return false;
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())
      || !(await readFile(bin, 'utf8')).startsWith(`#!/bin/sh\n${ENTRY_MARKER}\n`))
      throw new Error(`Refusing entry path not owned by Xenoflux: ${bin}`);
    return true;
  }

  async function install({ env = defaultEnv, backgroundPath } = {}) {
    const node = await check({ env, execute }); // Validate the caller's Node before changing anything.
    const target = paths(env);
    await ownedApp(target.app);
    await ownedEntry(target.bin);
    await mkdir(target.root, { recursive: true, mode: 0o700 });
    privateOwned(await lstat(target.root), true, `Xenoflux root ${target.root}`);
    const stage = `${target.app}.stage-${randomUUID()}`;
    const previous = `${target.app}.previous-${randomUUID()}`;
    let installedVersion = 'the requested version';
    let appInstalled = false;
    let launcherInstalled = false;
    try {
      await mkdir(stage, { mode: 0o700 });
      for (const name of ['bin', 'src', 'LICENSE', 'package.json']) {
        await cp(join(sourceRoot, name), join(stage, name), { recursive: true, force: false, errorOnExist: true });
      }
      await mkdir(join(stage, 'node_modules'), { mode: 0o700 });
      const dependencyRoot = dirname(dirname(createRequire(join(sourceRoot, 'package.json')).resolve('smol-toml')));
      const dependency = JSON.parse(await readFile(join(dependencyRoot, 'package.json'), 'utf8'));
      const manifest = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
      installedVersion = manifest.version;
      if (dependency.name !== 'smol-toml' || dependency.version !== manifest.dependencies['smol-toml'])
        throw new Error('The installed TOML dependency does not match the package manifest');
      await cp(dependencyRoot, join(stage, 'node_modules', 'smol-toml'),
        { recursive: true, force: false, errorOnExist: true });
      await writeFile(join(stage, APP_MARKER), `${JSON.stringify({ owner: APP_OWNER, schemaVersion: 1 })}\n`, { flag: 'wx', mode: 0o600 });
      await execute('node', [join(stage, 'bin', 'xfx.js'), '--help'], { env });
      const hadApp = await ownedApp(target.app);
      if (hadApp) await rename(target.app, previous);
      try { await rename(stage, target.app); }
      catch (error) { if (hadApp) await rename(previous, target.app); throw error; }
      appInstalled = true;
      if (hadApp) await rm(previous, { recursive: true, force: true });
      await atomicFile(target.bin, `#!/bin/sh\n${ENTRY_MARKER}\nexec node ${shellQuote(join(target.app, 'bin', 'xfx.js'))} "$@"\n`, 0o700);
      launcherInstalled = true;
      const ram = await enable({ env, backgroundPath, allowUnsupported: true });
      return { app: target.app, bin: target.bin, node, ramStartup: ram.ramStartup, enabled: ram.enabled };
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      if (appInstalled && !launcherInstalled) {
        throw new Error(`Xenoflux ${installedVersion} app is installed at ${target.app}, but installation did not complete before launcher setup finished. ${error.message}`, { cause: error });
      }
      if (appInstalled && launcherInstalled) {
        throw new Error(`Xenoflux ${installedVersion} is installed, but RAM-log setup failed. ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  async function isServiceLoaded(target, environment) {
    if (serviceLoaded) return serviceLoaded({ label: SERVICE, uid, paths: target, env: environment });
    try { await runService('/bin/launchctl', ['print', `gui/${uid}/${SERVICE}`], { env: environment }); return true; }
    catch (error) {
      if (error.code === 113) return false; // launchctl: service not found in this GUI domain.
      throw new Error('Unable to inspect the RAM-log login service; preserving installation state', { cause: error });
    }
  }

  async function assertOwnedService(target, environment) {
    const content = await fileText(target.launchAgent);
    if (content === null) return false;
    privateOwned(await lstat(target.launchAgent), false, `Service plist ${target.launchAgent}`);
    const encoded = /<key>PATH<\/key>\s*<string>([^<]+)<\/string>/.exec(content)?.[1];
    const path = encoded?.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'").replaceAll('&amp;', '&');
    if (!path || nativePath({ PATH: path }) !== path || content !== servicePlist(target, { HOME: environment.HOME, PATH: path }))
      throw new Error(`Refusing service plist not owned by Xenoflux: ${target.launchAgent}`);
    return { environment: { HOME: environment.HOME, PATH: path } };
  }

  async function enable({ env = defaultEnv, backgroundPath, allowUnsupported = false } = {}) {
    const target = paths(env);
    if (!await ownedApp(target.app)) throw new Error('Install xfx before enabling RAM logs');
    // Fresh settings use the caller's PATH. Preserve a working saved PATH,
    // but rediscover Node from this terminal if that installation moved.
    const settings = await settingsFor(env);
    const candidates = [backgroundPath ?? settings.backgroundPath];
    if (backgroundPath === undefined) candidates.push(env.PATH);
    let serviceEnv;
    let ramStartup;
    for (const candidate of new Set(candidates)) {
      try {
        serviceEnv = backgroundEnv(env, candidate);
        ramStartup = { enabled: true, node: await check({ env: serviceEnv, execute }) };
        break;
      } catch (error) { ramStartup = { enabled: false, reason: error.message }; }
    }
    if (!ramStartup.enabled) {
      await disable({ env });
      if (!allowUnsupported) {
        throw new Error(`RAM-log enable failed; logs remain in disk mode. ${ramStartup.reason}. Run xfx ramlogs status to confirm the installation state before retrying.`,
          { cause: new Error(ramStartup.reason) });
      }
      return { enabled: false, ramStartup };
    }
    const ownedPlist = await assertOwnedService(target, serviceEnv);
    const loaded = await isServiceLoaded(target, serviceEnv);
    if (!ownedPlist && loaded) throw new Error(`Refusing loaded service without an owned plist: ${SERVICE}`);
    let prepared = false;
    try {
      prepared = true;
      await prepareLogs({ env, paths: target });
      await atomicFile(target.launchAgent, servicePlist(target, serviceEnv));
      await saveSettings({ enabled: true, backgroundPath: serviceEnv.PATH }, env);
      if (loaded)
        await runService('/bin/launchctl', ['bootout', `gui/${uid}/${SERVICE}`], { env: serviceEnv });
      await runService('/bin/launchctl', ['bootstrap', `gui/${uid}`, target.launchAgent], { env: serviceEnv });
      return { enabled: true, ramStartup, plist: target.launchAgent };
    } catch (error) {
      // A failed explicit enable is an error, not a successful disk-mode
      // installation. Undo its routing before recording a disabled retry state.
      try {
        const ownService = await assertOwnedService(target, serviceEnv);
        if (ownService && await isServiceLoaded(target, serviceEnv))
          await runService('/bin/launchctl', ['bootout', `gui/${uid}/${SERVICE}`], { env: serviceEnv });
        if (prepared) await restoreLogs({ env, paths: target });
        if (ownService) await rm(target.launchAgent);
        await saveSettings({ enabled: false, backgroundPath: serviceEnv.PATH }, env);
      } catch (cleanup) {
        throw new Error(`RAM-log enable failed and cleanup also failed: ${cleanup.message}`, { cause: error });
      }
      throw new Error(`RAM-log enable failed; disk logs restored. ${error.message}`, { cause: error });
    }
  }

  async function disable({ env = defaultEnv } = {}) {
    const target = paths(env), settings = await settingsFor(env);
    const serviceEnv = backgroundEnv(env, settings.backgroundPath);
    const ownedPlist = await assertOwnedService(target, serviceEnv);
    const loaded = await isServiceLoaded(target, serviceEnv);
    if (!ownedPlist && loaded)
      throw new Error(`Refusing loaded service without an owned plist: ${SERVICE}`);
    await restoreLogs({ env, paths: target });
    if (ownedPlist) {
      if (loaded)
        await runService('/bin/launchctl', ['bootout', `gui/${uid}/${SERVICE}`], { env: serviceEnv });
      await rm(target.launchAgent, { force: false });
    }
    await saveSettings({ enabled: false, backgroundPath: settings.backgroundPath }, env);
    return { enabled: false };
  }

  async function status({ env = defaultEnv } = {}) {
    const target = paths(env), settings = await settingsFor(env);
    const serviceEnv = backgroundEnv(env, settings.backgroundPath);
    const app = await ownedApp(target.app).catch(error => ({ error: error.message }));
    const entry = await ownedEntry(target.bin).catch(error => ({ error: error.message }));
    const plist = await assertOwnedService(target, serviceEnv).catch(error => ({ error: error.message }));
    const loaded = await isServiceLoaded(target, serviceEnv);
    return { installed: app === true && entry === true, app, entry, settings,
      service: { plist: Boolean(plist && !plist.error), loaded, foreignLoaded: (!plist || Boolean(plist.error)) && loaded, ...(plist?.error ? { error: plist.error } : {}) } };
  }

  async function uninstall({ env = defaultEnv } = {}) {
    const target = paths(env), settings = await settingsFor(env);
    await disable({ env });
    if (await ownedEntry(target.bin)) await rm(target.bin, { force: false });
    if (await ownedApp(target.app)) await rm(target.app, { recursive: true, force: false });
    return { uninstalled: true, preserved: [target.controller, target.profiles, target.ramlogs], previousSettings: settings };
  }

  return { install, enable, disable, status, uninstall, servicePlist };
}
