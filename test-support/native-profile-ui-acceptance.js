import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { nativeClient } from '../src/profile-command.js';

export async function createNativeProfileUiAcceptanceFixture({ staticRoot = join(process.cwd(), 'dist', 'ui') } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-native-ui-journey-')));
  const versionLog = join(root, 'version-probes.log');
  let server, admissionChecks = 0;
  try {
    const executable = join(root, 'fake-codex');
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'probe\\n' >> '${versionLog}'; printf "codex 0.153.4\\n"; exit 0; fi\nexit 99\n`, { mode: 0o700 });
    const controller = join(root, 'controller'); await mkdir(controller, { mode: 0o700 });
    const store = new Store(controller), serverLogs = [];
    const reportsRoot = join(root, 'reports'), defaultUserHome = join(root, 'default-user-home');
    await mkdir(join(defaultUserHome, '.codex'), { recursive: true, mode: 0o700 });
    const provider = createEngineProvider({ store, reportsRoot, defaultUserHome, profilesBase: join(root, 'profiles'),
      lockOptions: { lockPath: join(root, 'global.lock'), concurrentLockPath: join(root, 'desktop.lock') },
      copyRuntime: () => createDesktopRuntime({ concurrentLockPath: join(root, 'desktop.lock'),
        processSnapshot: async () => [{ pid: process.pid, ppid: 1, uid: process.getuid(), startedAt: 'fixture', executable: process.execPath }] }),
      resolveClient: signal => nativeClient(store, { '--codex': executable }, signal),
    });
    server = await startUiServer({ provider, staticRoot, log: message => serverLogs.push(message) });
    let stopped = false;
    const stopServer = async () => { if (!stopped) { await server.close(); stopped = true; server = null; } return stopped; };
    return { root, store, url: server.launchUrl, serverLogs, admitMutation: async () => { admissionChecks++; },
      mutationAdmissionCount: () => admissionChecks,
      countVersionProbes: async () => {
        try { return (await (await import('node:fs/promises')).readFile(versionLog, 'utf8')).trim().split('\n').filter(Boolean).length; }
        catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
      },
      stopServer,
      close: async ({ retainRoot = false } = {}) => { await stopServer(); if (!retainRoot) await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    if (server) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
