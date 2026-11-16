import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, create } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { acquire, readJSON, release } from '../src/metadata.js';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t, { claudeCli = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copilot-engine-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'store')), base = join(root, 'profiles');
  await mkdir(base, { mode: 0o700 });
  if (claudeCli) await writeFile(join(root, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const profiles = [];
  for (const [name, client] of [['Copilot A', 'copilot'], ['Copilot B', 'copilot'], ['Claude', 'claude-code']]) {
    const path = join(base, name);
    for (const folder of [path, join(path, 'config'), join(path, 'workspace')]) await mkdir(folder, { mode: 0o700 });
    profiles.push(await store.update(data => {
      const profile = create(data, name);
      profile.client = client;
      profile.native = { root: path, configRoot: join(path, 'config'), rootMode: 'explicit', environmentId: randomUUID(),
        executable: '/fixture/missing-cli', executableIdentity: '[1,2,3,4,5]', version: '1.0.1' };
      return profile;
    }));
  }
  const app = { client: 'copilot', status: 'available', path: join(root, 'fixture.app'), appKey: 'a'.repeat(64) };
  let appLists = 0, state = 'available', cliReserved = false;
  const calls = [];
  const managedDesktop = {
    async status(name, options) { calls.push({ action: 'status', name, options }); return state === 'available'
      ? options?.installation ? { state, appKey: options.installation.appKey, ...(cliReserved ? { cliReserved, cliRunning: true } : {}) } : { state: 'unavailable', reason: 'No observation' }
      : { state, reason: 'Preserve the reservation', ...(cliReserved ? { cliReserved, cliRunning: true } : {}) }; },
    async open(name, options) { calls.push({ action: 'open', name, options }); return { state: 'running' }; },
    async focus(name) { calls.push({ action: 'focus', name }); return { state: 'running' }; },
    async close(name) { calls.push({ action: 'close', name }); return { state: 'closed' }; },
    async recover(name, options) {
      calls.push({ action: 'recover', name, options });
      if (state !== 'recoverable-stopped') return { state, reason: 'Preserve the reservation' };
      const path = join(profiles.find(profile => profile.id === name).native.root, '.run-lock');
      await release(path, await readJSON(join(path, 'owner.json')));
      state = 'available';
      return { state: 'released', status: 'recovered' };
    },
  };
  const provider = createEngineProvider({ store, defaultUserHome: root, profilesBase: base,
    profileWatchIntervalMs: 10,
    managedDesktop, stockApps: { locations: [], async list() { appLists++; return [app, { ...app, client: 'claude' }]; } },
    desktopSurface: { async list() { return { instances: [] }; }, async inspect() { throw new Error('fixture unavailable'); } },
    discoveryContext: { desktopLocations: [], stockLocations: [], async inspectDesktop() { throw new Error('fixture unavailable'); } },
    runContext: { terminalEnvironment: { HOME: root, USER: 'fixture', LOGNAME: 'fixture', PATH: claudeCli ? root : '/fixture/no-cli' } },
  });
  t.after(() => provider.close());
  return { provider, profiles, calls, app, setState(value, cli = false) { state = value; cliReserved = cli; }, get appLists() { return appLists; } };
}

test('Copilot cards use one shared installation observation and remain usable without CLI', async t => {
  const f = await fixture(t), result = await f.provider.profiles();
  const copilot = result.profiles.filter(profile => profile.client === 'copilot');
  assert.equal(copilot.length, 2); assert.equal(f.appLists, 1);
  for (const card of copilot) {
    assert.equal(card.state, 'ready'); assert.equal(card.cli.state, 'unavailable');
    assert.equal(card.desktop.state, 'not-running');
    assert.match(card.desktop.text, /startup and profile storage/);
    assert.match(card.desktop.text, /Desktop sign-in and task execution are unverified/);
    assert.deepEqual(card.clientActions, [{ id: 'open-desktop', label: 'Open GitHub Copilot Desktop', appKey: f.app.appKey }]);
    assert.equal(card.moreMenu.some(item => item.id === 'copy'), false);
  }
  assert.deepEqual(result.copySources.copilot, []);
  const claude = result.profiles.find(profile => profile.client === 'claude-code');
  assert.equal(claude.desktop.state, 'not-running');
  assert.deepEqual(claude.clientActions, [{ id: 'open-desktop', label: 'Open Claude Desktop', appKey: f.app.appKey }]);
  await f.provider.profiles();
  assert.equal(f.appLists, 1, 'unchanged cached discovery is shared across polling');
});

test('Desktop reservations are reconciled with no Profiles refresh request', async t => {
  const f = await fixture(t);
  const profile = f.profiles[0], lock = join(profile.native.root, '.run-lock');
  f.setState('recoverable-stopped');
  await acquire(lock, { kind: 'copilot-desktop' });
  const stop = f.provider.watchProfileStops();
  try {
    const deadline = Date.now() + 1000;
    while (!f.calls.some(call => call.action === 'recover') && Date.now() < deadline) await delay(10);
  } finally {
    await stop();
  }
  assert.deepEqual(f.calls.find(call => call.action === 'recover'), {
    action: 'recover', name: profile.id, options: { apply: true, onlyIfStopped: true },
  });
  await assert.rejects(readJSON(join(lock, 'owner.json')), { code: 'ENOENT' });
});

test('explicit vendor opens forward expected app identity', async t => {
  const f = await fixture(t);
  const result = await f.provider.clientAction({ name: 'Copilot A', action: 'open-desktop', appKey: f.app.appKey });
  assert.equal(result.status, 'success');
  assert.deepEqual(f.calls.at(-1), { action: 'open', name: f.profiles[0].id, options: { appKey: f.app.appKey } });
  assert.equal((await f.provider.clientAction({ name: 'Claude', action: 'open-desktop', appKey: f.app.appKey })).status, 'success');
  assert.deepEqual(f.calls.at(-1), { action: 'open', name: f.profiles[2].id, options: { appKey: f.app.appKey } });
});

test('Profiles refresh clears stopped Desktop claims, while a live Desktop offers Show and Close', async t => {
  const f = await fixture(t); f.setState('recoverable-stopped');
  await acquire(join(f.profiles[0].native.root, '.run-lock'), { kind: 'copilot-desktop' });
  const card = (await f.provider.profiles()).profiles.find(profile => profile.name === 'Copilot A');
  assert.deepEqual(card.clientActions, [{ id: 'open-desktop', label: 'Open GitHub Copilot Desktop', appKey: f.app.appKey }]);
  assert.ok(card.moreMenu.every(item => /verifies that its clients have stopped/.test(item.disabledReason)));
  assert.equal(f.calls.some(call => call.action === 'recover'), false);
  const refreshed = (await f.provider.refreshProfiles()).profiles.find(profile => profile.name === 'Copilot A');
  assert.ok(refreshed.moreMenu.every(item => !item.disabledReason));
  assert.deepEqual(f.calls.find(call => call.action === 'recover'), { action: 'recover', name: f.profiles[0].id, options: { apply: true } });
  f.setState('running');
  const running = (await f.provider.profiles()).profiles.find(profile => profile.name === 'Copilot A');
  assert.match(running.desktop.text, /using this profile’s storage/);
  assert.match(running.desktop.text, /Desktop sign-in and task execution are unverified/);
  assert.deepEqual(running.clientActions.map(action => action.id), ['focus-desktop', 'close-desktop']);
  assert.equal((await f.provider.clientAction({ name: 'Copilot A', action: 'focus-desktop' })).status, 'success');
  assert.deepEqual(f.calls.at(-1), { action: 'focus', name: f.profiles[0].id });
  assert.equal((await f.provider.clientAction({ name: 'Copilot A', action: 'close-desktop' })).status, 'success');
  assert.deepEqual(f.calls.at(-1), { action: 'close', name: f.profiles[0].id });
  await assert.rejects(f.provider.profileAccount({ name: 'Copilot A', client: 'copilot' }), /active client before checking sign-in/);
});


test('Claude Profiles offers the other client while account and profile changes remain exclusive', async t => {
  const f = await fixture(t, { claudeCli: true });
  const card = async () => (await f.provider.profiles()).profiles.find(profile => profile.name === 'Claude');
  f.setState('running');
  assert.deepEqual((await card()).clientActions.map(action => action.id), ['open-terminal', 'focus-desktop', 'close-desktop']);
  f.setState('available', true);
  const cliFirst = await card();
  assert.deepEqual(cliFirst.clientActions.map(action => action.id), ['show-terminal', 'open-desktop']);
  assert.equal(cliFirst.cli.state, 'running');
  assert.ok(cliFirst.moreMenu.every(item => item.disabledReason));
  f.setState('running', true);
  assert.deepEqual((await card()).clientActions.map(action => action.id), ['show-terminal', 'focus-desktop', 'close-desktop']);
});
