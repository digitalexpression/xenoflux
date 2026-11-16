import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { withProfileOperation } from './desktop-instances.js';
import { resolveHome } from './homes.js';
import { discoverCodexExecutable } from './launcher.js';
import { acquire, exists, release } from './metadata.js';
import { resolveNativeSettingsHome } from './native-copy.js';
import { nativePath } from './node-runtime.js';
import { assertNoLegacyAuditLease } from './profile-reservations.js';
import { probeCodexAccount } from './version-probe.js';

const fileIdentity = info => info && [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];

export function createCodexProfileAccounts(store, { defaultUserHome, terminalEnvironment, lockOptions, probe = probeCodexAccount }) {
  const observed = new Map(), active = new Map();
  const shutdown = new AbortController();

  async function select(name) {
    if (name === 'Default') {
      const { home } = await resolveNativeSettingsHome(store, name, { defaultUserHome });
      if (!(await lstat(home)).isDirectory() || await realpath(home) !== home) throw new Error('Default Codex home is unavailable');
      return { id: 'default', home, root: home, userHome: defaultUserHome };
    }
    const { profile, native, environment } = await resolveHome(store, name);
    return { id: profile.id, home: environment.home, root: native.root,
      environmentId: environment.id, userHome: environment.launch.env.HOME };
  }

  const scope = async (profile, binary) => {
    const root = await lstat(profile.root), home = await lstat(profile.home);
    return JSON.stringify([profile, binary, root.dev, root.ino, home.dev, home.ino,
      fileIdentity(await exists(join(profile.home, 'auth.json')))]);
  };

  async function inspect(name) {
    const profile = await select(name);
    const binary = await discoverCodexExecutable(terminalEnvironment);
    const key = await scope(profile, binary);
    const guard = action => withProfileOperation(store, profile.id, lockOptions, action);
    const owner = { kind: 'native-account-status', runId: randomUUID(), host: hostname(),
      pid: process.pid, storePath: store.directory, profileId: profile.id };
    const lock = join(profile.root, '.run-lock');
    const cwd = await mkdtemp(join(await realpath(tmpdir()), 'xfx-codex-account-'));
    let held = false, preserve = false;
    const checkBinding = async () => {
      const current = await select(profile.id === 'default' ? 'Default' : profile.id);
      if (key !== await scope(current, await discoverCodexExecutable(terminalEnvironment)))
        throw new Error('Codex account binding changed. Check sign-in again.');
    };
    try {
      await guard(async () => {
        shutdown.signal.throwIfAborted();
        await checkBinding();
        await assertNoLegacyAuditLease(store.directory, profile.home);
        await acquire(lock, owner, true);
        held = true;
      });
      const result = await probe({ executable: binary.executable, cwd, signal: shutdown.signal,
        env: { PATH: nativePath(terminalEnvironment), HOME: profile.userHome, CODEX_HOME: profile.home,
          CODEX_SQLITE_HOME: profile.home, TMPDIR: cwd } });
      await checkBinding();
      observed.set(profile.id, { ...result, key, checkedAt: Date.now() });
      return { state: result.state };
    } catch (error) {
      preserve = error.code === 'SHUTDOWN_FAILED';
      throw error;
    } finally {
      if (held && !preserve) await guard(() => release(lock, owner));
      if (!preserve) await rm(cwd, { recursive: true });
    }
  }

  return {
    check(name) {
      if (shutdown.signal.aborted) throw new Error('Xenoflux is stopping');
      if (!active.has(name)) active.set(name, inspect(name).finally(() => active.delete(name)));
      return active.get(name);
    },
    async observed(name, id) {
      const result = observed.get(id);
      if (!result) return null;
      try {
        if (result.key !== await scope(await select(name), await discoverCodexExecutable(terminalEnvironment))) return null;
        return { state: result.state, accountLabel: result.accountLabel,
          stale: Date.now() - result.checkedAt >= 5 * 60 * 1000 };
      } catch { return null; }
    },
    async close() {
      shutdown.abort();
      await Promise.allSettled(active.values());
    },
  };
}
