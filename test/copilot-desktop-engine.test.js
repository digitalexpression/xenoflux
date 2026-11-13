import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, create } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copilot-engine-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'store')), base = join(root, 'profiles');
  await mkdir(base, { mode: 0o700 });
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
  let appLists = 0, state = 'available';
  const calls = [];
  const managedDesktop = {
    async status(name, options) { calls.push({ action: 'status', name, options }); return state === 'available'
      ? options?.installation ? { state, appKey: options.installation.appKey } : { state: 'unavailable', reason: 'No observation' }
      : { state, reason: 'Preserve the reservation' }; },
    async open(name, options) { calls.push({ action: 'open', name, options }); return { state: 'running' }; },
    async recover(name, options) { calls.push({ action: 'recover', name, options }); return state === 'recoverable-stopped'
      ? { state: 'released', status: 'recovered' } : { state, reason: 'Preserve the reservation' }; },
  };
  const provider = createEngineProvider({ store, defaultUserHome: root, profilesBase: base,
    managedDesktop, stockApps: { locations: [], async list() { appLists++; return [app, { ...app, client: 'claude' }]; } },
    desktopSurface: { async list() { return { instances: [] }; }, async inspect() { throw new Error('fixture unavailable'); } },
    discoveryContext: { desktopLocations: [], stockLocations: [], async inspectDesktop() { throw new Error('fixture unavailable'); } },
    runContext: { terminalEnvironment: { HOME: root, USER: 'fixture', LOGNAME: 'fixture', PATH: '/fixture/no-cli' } },
  });
  t.after(() => provider.close());
  return { provider, profiles, calls, app, setState(value) { state = value; }, get appLists() { return appLists; } };
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

test('explicit vendor opens forward expected app identity', async t => {
  const f = await fixture(t);
  const result = await f.provider.clientAction({ name: 'Copilot A', action: 'open-desktop', appKey: f.app.appKey });
  assert.equal(result.status, 'success');
  assert.deepEqual(f.calls.at(-1), { action: 'open', name: f.profiles[0].id, options: { appKey: f.app.appKey } });
  assert.equal((await f.provider.clientAction({ name: 'Claude', action: 'open-desktop', appKey: f.app.appKey })).status, 'success');
  assert.deepEqual(f.calls.at(-1), { action: 'open', name: f.profiles[2].id, options: { appKey: f.app.appKey } });
});

test('stopped reservation exposes explicit recovery, live refusal is neutral, account check is excluded', async t => {
  const f = await fixture(t); f.setState('recoverable-stopped');
  const card = (await f.provider.profiles()).profiles.find(profile => profile.name === 'Copilot A');
  assert.deepEqual(card.clientActions, [{ id: 'recover-desktop', label: 'Release closed Desktop reservation' }]);
  assert.ok(card.moreMenu.every(item => /Finish the active client or recover/.test(item.disabledReason)));
  assert.equal((await f.provider.clientAction({ name: 'Copilot A', action: 'recover-desktop' })).status, 'success');
  assert.deepEqual(f.calls.at(-1), { action: 'recover', name: f.profiles[0].id, options: { apply: true } });
  f.setState('running');
  const running = (await f.provider.profiles()).profiles.find(profile => profile.name === 'Copilot A');
  assert.match(running.desktop.text, /using this profile’s storage/);
  assert.match(running.desktop.text, /Desktop sign-in and task execution are unverified/);
  assert.equal((await f.provider.clientAction({ name: 'Copilot A', action: 'recover-desktop' })).status, 'neutral');
  await assert.rejects(f.provider.profileAccount({ name: 'Copilot A', client: 'copilot' }), /reservation before checking sign-in/);
});
