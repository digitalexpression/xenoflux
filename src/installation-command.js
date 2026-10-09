import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInstallation } from './installation.js';
import { createRamLogs } from './ram-logs.js';
import { createDesktopRuntime } from './desktop-runtime.js';
import { resolveHome } from './homes.js';
import { recoverSelection } from './desktop-selection.js';
import { acquire, release, exists, globalLock } from './metadata.js';
import { userPaths } from './paths.js';
import { checkNode } from './node-runtime.js';

// Installation changes diagnostic log routing only after restoring ordinary
// native paths and taking the same writer reservations as other xfx operations.
export async function installationCommand(store, operation, {
  backgroundPath, userHome = userInfo().homedir, runtime = createDesktopRuntime(),
  source = fileURLToPath(new URL('..', import.meta.url)),
  logs = createRamLogs({ registry: join(userPaths(userHome).ramlogs, 'homes') }),
  installation = createInstallation, nodeCheck = checkNode, lockPath = globalLock(), signal,
} = {}) {
  if (!['install', 'enable', 'disable', 'uninstall', 'recover'].includes(operation)) throw new Error('Unknown installation operation');
  if (operation === 'install') await nodeCheck();
  await runtime.assertExternal();
  const profiles = (await store.read()).profiles.filter(profile => profile.native);
  const homes = await Promise.all(profiles.map(async profile => {
    const { native, environment } = await resolveHome(store, profile.id);
    return { name: profile.name, id: profile.id, home: environment.home, key: environment.id, root: native.root, executable: native.executable };
  }));
  const defaultHome = join(userHome, '.codex');
  if (await exists(defaultHome)) homes.unshift({ name: 'Default', home: defaultHome, key: 'default' });
  if (operation === 'recover') {
    for (const home of homes) if ((await logs.inspect(home)).linked)
      throw new Error(`${home.name}: RAM logs are already linked; inspect status and disable RAM logging before recovery`);
  }
  const cliExecutables = homes.filter(home => home.executable).map(home => home.executable);
  await runtime.prepareClients({ cliExecutables, includeDesktop: true });
  await runtime.assertIdle({ cliExecutables });
  if (await exists(join(store.directory, 'desktop-selection', 'session.json'))
    || await exists(join(store.directory, 'activation', 'manifest.json'))) {
    await recoverSelection(store, { runtime, noOpen: true, defaultUserHome: userHome, signal, lockPath });
  }
  const owner = { kind: 'log-storage', pid: process.pid, host: hostname(), runId: randomUUID(), storePath: store.directory };
  const locks = [lockPath + '.selection', lockPath, ...homes.filter(home => home.root).map(home => join(home.root, '.run-lock'))];
  const held = [];
  const archives = [];
  try {
    for (const path of locks) { await acquire(path, owner, true); held.push(path); }
    await runtime.assertIdle({ cliExecutables, resourcePaths: homes.map(home => home.home) });
    if (operation === 'recover') for (const home of homes) {
      const archive = await logs.archiveHome({ ...home, recoveryRoot: join(userPaths(userHome).ramlogs, 'recovery'), signal });
      if (archive.archived) archives.push({ name: home.name, ...archive });
    }
    const manager = installation({ home: userHome, source,
      prepareLogs: async () => {
        for (const home of homes) {
          try { await logs.prepareHome({ ...home, signal }); }
          catch (error) { throw new Error(`${home.name} (${home.home}): ${error.message}. Inspect xfx ramlogs status before retrying; for conflicting disk/RAM logs use xfx ramlogs recover --close-clients.`, { cause: error }); }
        }
      },
      restoreLogs: async () => { for (const home of homes) await logs.restoreHome({ ...home, signal }); },
    });
    if (operation === 'install') {
      await store.update(() => undefined);
      return await manager.install({ backgroundPath });
    }
    const result = await manager[operation === 'recover' ? 'enable' : operation]({ backgroundPath });
    return operation === 'recover' ? { ...result, archives } : result;
  } catch (error) {
    if (archives.length) throw new Error(`${error.message} Diagnostic archives preserved at ${archives.map(item => item.archive).join(', ')}.`, { cause: error });
    throw error;
  } finally {
    for (const path of held.reverse()) await release(path, owner);
  }
}

// Explicit normal log cleanup can be used on a known owned home without a
// controller. It never imports profile records or modifies native user data.
export async function restoreHomeLogs(home, key, {
  runtime = createDesktopRuntime(), logs = createRamLogs(), lockPath = globalLock(), signal,
} = {}) {
  await runtime.assertExternal();
  await runtime.prepareClients({ includeDesktop: true });
  await runtime.assertIdle({ resourcePaths: [home] });
  const owner = { kind: 'log-storage', pid: process.pid, host: hostname(), runId: randomUUID() };
  const held = [];
  try {
    for (const path of [lockPath + '.selection', lockPath]) { await acquire(path, owner, true); held.push(path); }
    await runtime.assertIdle({ resourcePaths: [home] });
    return await logs.restoreHome({ home, key, signal });
  } finally { for (const path of held.reverse()) await release(path, owner); }
}
