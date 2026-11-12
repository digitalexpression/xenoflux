import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store, create } from '../src/profiles.js';
import { inspectClaudeExecutable, resolveClaudeProfile } from '../src/claude-profile.js';
import { inspectCopilotExecutable } from '../src/copilot-profile.js';
import { managedNativeProfiles } from '../src/managed-native-profile.js';
import { resolveProfileExecutionProfile, recheckProfileExecutionProfile } from '../src/audit-profile.js';

async function setup(t, client) {
  const root = await realpath(await mkdtemp('/private/tmp/xfx-native-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ['bin', 'managed', 'managed/config', 'managed/workspace', 'stock', 'user'].map(part => join(root, part));
  for (const path of paths) await mkdir(path, { mode: 0o700 });
  const [bin, reservation, configRoot, workspace, stock, userHome] = paths;
  const command = join(bin, client === 'claude-code' ? 'claude' : 'copilot');
  const oldExecutable = join(root, 'native-v1'), currentExecutable = join(root, 'native-v2'), nextExecutable = join(root, 'native-v3');
  for (const [index, executable] of [oldExecutable, currentExecutable, nextExecutable].entries())
    await writeFile(executable, '#!/bin/sh\nexit ' + (90 + index) + '\n', { mode: 0o700 });
  const inspect = client === 'claude-code' ? inspectClaudeExecutable : inspectCopilotExecutable;
  const registered = await inspect(oldExecutable);
  await symlink(currentExecutable, command);
  const store = new Store(join(root, 'controller'));
  const selected = await store.update(data => {
    const profile = create(data, 'Upgrade', '', client);
    profile.repositories = [{ path: workspace }];
    profile.native = { root: reservation, configRoot, rootMode: 'explicit', environmentId: randomUUID(),
      executable: oldExecutable, executableIdentity: registered.executableIdentity, version: '1.0.0' };
    return profile;
  });
  const original = await readFile(store.file, 'utf8');
  await rm(oldExecutable);
  const terminalEnvironment = { ...process.env, PATH: bin + ':/usr/bin:/bin' };
  const defaultUserHome = client === 'copilot' ? homedir() : userHome;
  const options = { defaultUserHome, terminalEnvironment, repository: workspace };
  const switchExecutable = async () => { await unlink(command); await symlink(nextExecutable, command); };
  return { root, store, selected, original, command, currentExecutable, nextExecutable, options, inspect,
    reservation, configRoot, workspace, stock, switchExecutable };
}

test('managed Claude follows the current CLI while an executable change invalidates its prepared action', async t => {
  const f = await setup(t, 'claude-code');
  const profile = await resolveClaudeProfile({ selected: f.selected, ...f.options });
  assert.equal(profile.executable, f.currentExecutable);
  assert.equal(profile.version, null);
  assert.equal(profile.versionSource, 'unavailable');
  assert.equal(profile.env.CLAUDE_CONFIG_DIR, f.configRoot);
  assert.equal(profile.rootMode, 'explicit');
  assert.equal(profile.bindingRepository, f.workspace);
  const selected = { name: f.selected.name, client: 'claude-code' };
  const preview = await resolveProfileExecutionProfile(f.store, selected, f.options);
  await f.switchExecutable();
  await assert.rejects(recheckProfileExecutionProfile(f.store, preview, f.options), { code: 'profile-preview-changed' });
  const fresh = await resolveProfileExecutionProfile(f.store, selected, f.options);
  assert.equal(fresh.executable, f.nextExecutable);
  await writeFile(f.nextExecutable, '#!/bin/sh\nexit 97\n', { mode: 0o700 });
  await assert.rejects(recheckProfileExecutionProfile(f.store, fresh, f.options), { code: 'profile-preview-changed' });
  assert.equal(await readFile(f.store.file, 'utf8'), f.original);
});

test('managed Copilot requalifies the current CLI and runtime without inheriting the registered version', async t => {
  const f = await setup(t, 'copilot');
  let runtimeVersion = '99.1.0', launches = 0;
  const service = managedNativeProfiles({ store: f.store, profilesBase: join(f.root, 'profiles'), ...f.options,
    lockOptions: { lockPath: join(f.root, 'operation') },
    resolveStockCopilot: async () => ({ home: f.stock, rootMode: 'implicit', ...await f.inspect(await realpath(f.command)) }),
    readCopilotAccount: async () => { launches++; return { state: 'signed-in', route: 'gh-cli', version: runtimeVersion, token: 'fixture-account' }; },
  });
  const options = { ...f.options, profileResolvers: { copilot: service.qualifiedCopilot } };
  const selected = { name: f.selected.name, client: 'copilot' };
  await assert.rejects(resolveProfileExecutionProfile(f.store, selected, options), { code: 'copilot-account-unverified' });
  const status = await service.check(f.selected.name, 'copilot');
  assert.equal(status.accountScope, 'shared');
  const preview = await resolveProfileExecutionProfile(f.store, selected, options);
  assert.equal(preview.executable, f.currentExecutable);
  assert.equal(preview.version, runtimeVersion);
  assert.equal(preview.versionSource, 'observed');
  assert.equal(preview.environmentBinding.executable.version, runtimeVersion);
  await f.switchExecutable();
  await assert.rejects(recheckProfileExecutionProfile(f.store, preview, options), { code: 'copilot-account-unverified' });
  runtimeVersion = '100.0.0';
  await service.check(f.selected.name, 'copilot');
  await assert.rejects(recheckProfileExecutionProfile(f.store, preview, options), { code: 'profile-preview-changed' });
  const fresh = await resolveProfileExecutionProfile(f.store, selected, options);
  assert.equal(fresh.executable, f.nextExecutable);
  assert.equal(fresh.version, runtimeVersion);
  assert.equal(fresh.home, f.configRoot);
  assert.equal(fresh.reservationRoot, f.reservation);
  assert.equal(fresh.rootMode, 'explicit');
  assert.equal(launches, 4);
  assert.equal(await readFile(f.store.file, 'utf8'), f.original);
});

test('an executable switch during account checking cannot publish a scope qualification', async t => {
  const f = await setup(t, 'copilot');
  const service = managedNativeProfiles({ store: f.store, profilesBase: join(f.root, 'profiles'), ...f.options,
    lockOptions: { lockPath: join(f.root, 'operation') },
    resolveStockCopilot: async () => ({ home: f.stock, rootMode: 'implicit', ...await f.inspect(await realpath(f.command)) }),
    readCopilotAccount: async () => { await f.switchExecutable(); return { state: 'signed-in', route: 'gh-cli', version: '99.1.0', token: 'fixture-account' }; },
  });
  await assert.rejects(service.check(f.selected.name, 'copilot'), /Stock Copilot does not match/);
  const fresh = await service.resolveProfile('copilot', f.selected);
  assert.equal(await service.observed(fresh), null);
  await assert.rejects(lstat(join(f.reservation, '.run-lock')), { code: 'ENOENT' });
  assert.equal(await readFile(f.store.file, 'utf8'), f.original);
});
