import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { Store } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';

test('Profiles displays only account labels scoped to the selected Codex home and drops changed observations', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-accounts-')));
  const executable = join(base, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const store = new Store(join(base, 'store'));
  const homes = {};
  for (const name of ['First', 'Second']) {
    const home = await prepareNativeHome({ directory: join(base, name), executable, codexVersion: '0.153.4' });
    await registerHome(store, name, home.root, { executable, version: '0.153.4' });
    await writeFile(join(home.home, 'auth.json'), '{}', { mode: 0o600 });
    homes[name] = home;
  }

  let checked = 0;
  const provider = createEngineProvider({ store, defaultUserHome: base, lockOptions: { lockPath: join(base, 'operation') },
    runContext: { terminalEnvironment: { PATH: base + ':/usr/bin:/bin' } },
    desktopSurface: { async list() { return { instances: [] }; } },
    observeClients: async () => ({ cli: { state: 'unknown', text: '' }, desktop: { state: 'unknown', text: '' } }),
    accountContext: { async probeCodexAccount({ env, executable: selectedExecutable }) {
      ++checked;
      const home = Object.values(homes).find(home => home.home === env.CODEX_HOME);
      assert.ok(home);
      assert.equal(selectedExecutable, executable);
      await access(join(home.root, '.run-lock', 'owner.json'));
      return { state: 'signed-in', accountLabel: home === homes.First ? 'first@example.test' : 'second@example.test' };
    } },
  });
  t.after(async () => { await provider.close(); await rm(base, { recursive: true, force: true }); });
  const card = async name => (await provider.profiles()).profiles.find(profile => profile.name === name);

  assert.equal((await card('First')).account, undefined);
  assert.equal(checked, 0, 'reading inventory does not start a native account check');
  for (const name of Object.keys(homes)) {
    assert.deepEqual(await provider.profileAccount({ name, client: 'codex' }), { state: 'signed-in' });
  }
  assert.deepEqual((await card('First')).account, { label: 'first@example.test', lastChecked: false });
  assert.deepEqual((await card('Second')).account, { label: 'second@example.test', lastChecked: false });
  await mkdir(join(homes.First.root, '.run-lock'), { mode: 0o700 });
  await assert.rejects(provider.profileAccount({ name: 'First', client: 'codex' }), /locked/);
  assert.equal((await card('First')).account.label, 'first@example.test');
  await writeFile(join(homes.First.home, 'auth.json'), '{"changed":true}');
  assert.equal((await card('First')).account, undefined);
  assert.equal((await card('Second')).account.label, 'second@example.test');
});
