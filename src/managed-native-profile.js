// Native profile preparation and account metadata. The user runs login directly.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { create, find, strictDescendant } from './profiles.js';
import { acquire, privateDirectory, release } from './metadata.js';
import { withProfileOperation } from './desktop-instances.js';
import { assertNoLegacyAuditLease } from './profile-reservations.js';
import { canonicalClaudeDirectory, claudeEnvironment, discoverClaudeExecutable, inspectClaudeExecutable, resolveClaudeProfile } from './claude-profile.js';
import { assertCopilotEnvironment, copilotAccountRoute, COPILOT_SDK_VERSION, inspectCopilotExecutable, resolveCopilotExecutable, resolveCopilotProfile } from './copilot-profile.js';
import { nativePath } from './node-runtime.js';
import { probeClaudeAccount, probeNativeProfileVersion } from './version-probe.js';

export const PROFILE_CLIENT_NAMES = Object.freeze({ codex: 'Codex', 'claude-code': 'Claude Code', copilot: 'Copilot CLI' });
const STOCK_DIR = { 'claude-code': '.claude', copilot: '.copilot' };
const freshnessMs = 5 * 60 * 1000;
const shellWord = value => "'" + value.replaceAll("'", "'\\''") + "'";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = async path => { const s = await lstat(path); return [s.dev, s.ino]; };

function copilotEnv(ambient) {
  assertCopilotEnvironment(ambient);
  return { PATH: nativePath(ambient), HOME: ambient.HOME, USER: ambient.USER, LOGNAME: ambient.LOGNAME };
}

export function managedNativeProfiles({ store, profilesBase, defaultUserHome = homedir(),
  terminalEnvironment = process.env, copilotRuntime, lockOptions,
  readCopilotAccount = options => copilotRuntime.accountStatus(options), resolveStockCopilot }) {
  const observations = new Map();

  async function binary(client) {
    if (client === 'claude-code') {
      const userHome = await canonicalClaudeDirectory(defaultUserHome, 'Claude user home');
      const env = claudeEnvironment(terminalEnvironment, { userHome, rootMode: 'implicit' });
      return discoverClaudeExecutable(env);
    }
    return inspectCopilotExecutable(await resolveCopilotExecutable(terminalEnvironment));
  }

  async function createProfile(name, client, selectedBinary) {
    const initial = await binary(client);
    if (!same(initial, selectedBinary)) throw new Error('The selected native executable changed. Review the preview again.');
    const base = profilesBase;
    if (!isAbsolute(base) || resolve(base) !== base || /[\x00-\x1f\x7f]/.test(base)
      || base === store.directory || strictDescendant(base, store.directory) || strictDescendant(store.directory, base)
      || base.split('/').some(part => ['.claude', '.copilot', '.codex', '.agents'].includes(part.toLowerCase())))
      throw new Error('Invalid managed profile directory.');
    await mkdir(dirname(base), { recursive: true, mode: 0o700 });
    await privateDirectory(base, true);
    const created = [];
    try {
      return await store.update(async data => {
        const profile = create(data, name, '', client);
        const root = join(base, profile.id), configRoot = join(root, 'config'), workspace = join(root, 'workspace');
        for (const directory of [root, configRoot, workspace]) {
          await mkdir(directory, { mode: 0o700 });
          created.push(directory);
          await privateDirectory(directory);
        }
        const env = client === 'claude-code'
          ? claudeEnvironment(terminalEnvironment, { userHome: defaultUserHome, home: configRoot, rootMode: 'explicit' })
          : { ...copilotEnv(terminalEnvironment), COPILOT_HOME: configRoot };
        const version = await probeNativeProfileVersion(client, { executable: initial.executable, cwd: workspace, env });
        if (!same(initial, await binary(client))) throw new Error('The selected native executable changed during preparation.');
        profile.native = { root, configRoot, rootMode: 'explicit', environmentId: randomUUID(), version, ...initial };
        return profile;
      });
    } catch (error) {
      // Preserve any bytes the selected CLI may have written and any published binding.
      if (created.length && !(await store.read()).profiles.some(profile => profile.native?.root === created[0]))
        for (const directory of created.reverse()) await rmdir(directory).catch(() => {});
      throw error;
    }
  }

  async function resolveProfile(client, selected, options = {}) {
    const resolver = client === 'claude-code' ? resolveClaudeProfile : resolveCopilotProfile;
    if (selected) {
      if (selected.client !== client || !selected.native) throw new Error('The selected profile has no matching native binding.');
      await privateDirectory(selected.native.root);
      await privateDirectory(selected.native.configRoot);
    }
    return resolver({ selected, sessionOnly: true, defaultUserHome, terminalEnvironment, ...options });
  }

  async function routeIdentity(profile) {
    return Promise.all([profile.home, profile.reservationRoot].map(stamp));
  }

  async function observed(profile) {
    const key = profile.environmentId ?? profile.profileId;
    const value = observations.get(key);
    if (value?.expiresAt > Date.now() && same(value.binary, [profile.executable, profile.executableIdentity])
      && same(value.roots, await routeIdentity(profile))) return value;
    return null;
  }

  async function qualifiedCopilot(options) {
    const profile = await resolveProfile('copilot', options.selected, options);
    if (options.selected) profile.accountQualification = (await observed(profile))?.qualification;
    return profile;
  }

  async function setup(profile) {
    const cwd = join(profile.reservationRoot, 'workspace');
    await privateDirectory(cwd);
    const env = profile.client === 'claude-code'
      ? { ...profile.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } : { ...profile.env, COPILOT_HOME: profile.home };
    const args = profile.client === 'claude-code' ? ['auth', 'login'] : ['--no-auto-update'];
    const command = ['cd', shellWord(cwd), '&& /usr/bin/env -i',
      ...Object.entries(env).map(([key, value]) => shellWord(key + '=' + value)), shellWord(profile.executable), ...args].join(' ');
    return { command, executable: profile.executable, configRoot: profile.home,
      rootMode: profile.rootMode, version: profile.version };
  }

  async function check(name, client) {
    const isDefault = name === 'Default';
    const selected = isDefault ? null : find(await store.read(), name);
    if (selected && selected.client !== client) throw new Error('The selected profile belongs to another client.');
    const key = selected?.native?.environmentId ?? 'default-' + client;
    observations.delete(key);
    const prefix = await realpath(tmpdir());
    const scratch = await mkdtemp(join(prefix, 'xfx-account-status-'));
    const owner = { kind: 'native-account-status', runId: randomUUID(), host: hostname(), pid: process.pid,
      storePath: store.directory, profileId: selected?.id ?? null };
    let lock, held = false, preserve = false, attempted = false;
    const guard = action => withProfileOperation(store, selected.id, { waitMs: 5000, ...lockOptions }, action);
    try {
      let profile;
      if (selected) await guard(async () => {
        const fresh = find(await store.read(), selected.id);
        if (!same(selected.native, fresh.native)) throw new Error('The native profile changed.');
        profile = await resolveProfile(client, fresh, client === 'copilot' ? { workspace: scratch } : {});
        lock = join(profile.reservationRoot, '.run-lock');
        await assertNoLegacyAuditLease(store.directory, profile.home);
        await acquire(lock, owner, true);
        held = true;
      });
      else profile = await resolveProfile(client, null, client === 'copilot' ? { workspace: scratch } : {});
      const roots = await routeIdentity(profile);
      let status, qualification;
      if (client === 'claude-code') {
        const cwd = selected ? join(profile.reservationRoot, 'workspace') : scratch;
        await privateDirectory(cwd);
        status = await probeClaudeAccount({ executable: profile.executable, cwd, env: profile.env });
      } else {
        const read = async (profile, label) => {
          attempted = true;
          const result = await readCopilotAccount({ profile, workspace: scratch,
            stdoutPath: join(scratch, label + '.out'), stderrPath: join(scratch, label + '.err') });
          attempted = false;
          return result;
        };
        const managed = await read(profile, 'selected');
        status = { state: managed.state, route: managed.route };
        if (selected && managed.state === 'signed-in') {
          const stock = await (resolveStockCopilot ?? (options => resolveProfile(client, null, options)))({ workspace: scratch });
          if (stock.executable !== profile.executable || stock.executableIdentity !== profile.executableIdentity
            || stock.home === profile.home || strictDescendant(profile.reservationRoot, stock.home))
            throw new Error('Stock Copilot does not match the selected executable and independent root.');
          const implicit = await read(stock, 'stock');
          if (implicit.state === 'signed-in' && managed.token && implicit.token === managed.token
            && managed.version === implicit.version && managed.version === profile.version) {
            qualification = { scope: 'shared', authType: 'gh-cli', sdk: COPILOT_SDK_VERSION, runtimeVersion: managed.version,
              rootMode: profile.rootMode, executableIdentity: profile.executableIdentity,
              route: copilotAccountRoute(profile.environmentBinding), expiresAt: Date.now() + freshnessMs,
              rootIdentities: roots, accountToken: managed.token };
          } else status = { state: 'unverified' };
        }
      }
      const current = client === 'claude-code' ? await inspectClaudeExecutable(profile.executable) : await inspectCopilotExecutable(profile.executable);
      if (profile.executable !== current.executable || profile.executableIdentity !== current.executableIdentity
        || !same(roots, await routeIdentity(profile))) throw new Error('The native account binding changed during the check.');
      observations.set(key, { ...status, qualification, roots, binary: [profile.executable, profile.executableIdentity],
        expiresAt: qualification?.expiresAt ?? Date.now() + freshnessMs });
      return { ...status, accountScope: client === 'claude-code' ? 'per-root' : qualification ? 'shared' : 'unverified',
        accountIndependence: 'not verified' };
    } catch (error) {
      preserve = error?.code === 'SHUTDOWN_FAILED' || (attempted && error.process?.shutdown.groupTerminated !== true);
      throw error;
    } finally {
      if (held && !preserve) await guard(() => release(lock, owner));
      if (!preserve) await rm(scratch, { recursive: true });
    }
  }

  async function hasStock(client) {
    const path = join(defaultUserHome, STOCK_DIR[client]);
    try { return (await lstat(path)).isDirectory() && await realpath(path) === path; }
    catch { return false; }
  }

  return { binary, createProfile, resolveProfile, qualifiedCopilot, setup, check, observed, hasStock };
}
