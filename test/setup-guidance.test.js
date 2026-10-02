import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { inspectSetupGuidance } from '../src/setup-guidance.js';

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}
async function append(path, content) {
  await writeFile(path, `${await readFile(path, 'utf8')}\n${content}`);
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-setup-guidance-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'Source'); create(data, 'Target'); create(data, 'Broken'); });
  const homes = {};
  for (const name of ['Source', 'Target', 'Broken']) {
    const native = await prepareNativeHome({ directory: join(root, name), executable, codexVersion: '0.153.4' });
    await registerHome(store, name, native.root, { executable, version: '0.153.4' });
    homes[name] = native;
  }
  const user = join(root, 'user');
  await mkdir(join(user, '.codex'), { recursive: true, mode: 0o700 });
  return { root, store, user, homes };
}

test('reports exact plugin marketplace identities and conditional manual setup without leaking integration values', async t => {
  const f = await fixture(t), sourceHome = f.homes.Source.home, targetHome = f.homes.Target.home;
  const sourceConfig = `
[plugins."formatter@first-market"]
enabled = false
[plugins."formatter@second-market"]
enabled = true
[mcp_servers.docs]
url = "https://private.example/secret-endpoint"
[mcp_servers.local]
command = "/private/path/with-secret"
[mcp_servers.local.env]
API_TOKEN = "very-secret-token-value"
[hooks]
SessionStart = [{ hooks = [{ type = "command", command = "/private/hook-secret-command" }] }]
state = { internal = "never-print" }
`;
  const targetConfig = `
[plugins."formatter@first-market"]
enabled = false
[plugins."formatter@second-market"]
enabled = false
[mcp_servers.docs]
url = "https://private.example/secret-endpoint"
[mcp_servers.local]
command = "/different/private/path"
[hooks]
SessionStart = [{ hooks = [{ type = "command", command = "/different/private/hook" }] }]
state = { internal = "different-state" }
`;
  await append(join(sourceHome, 'config.toml'), sourceConfig);
  await append(join(targetHome, 'config.toml'), targetConfig);
  const hooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/private/hooks/secret-command' }] }] } };
  await put(join(sourceHome, 'hooks.json'), JSON.stringify(hooks));
  await put(join(targetHome, 'hooks.json'), JSON.stringify(hooks));
  const pluginSource = join(f.root, 'plugin-source');
  await put(join(pluginSource, 'plugin.json'), JSON.stringify({ name: 'formatter', version: '1.2.3' }));
  await put(join(f.homes.Source.userHome, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
    name: 'first-market',
    plugins: [{ name: 'formatter', source: { source: 'local', path: pluginSource } }],
  }));
  // A plausible cache manifest is deliberately irrelevant to source/version evidence.
  await put(join(sourceHome, 'plugins', 'cache', 'first-market', 'formatter', '9.9.9', 'plugin.json'), '{"name":"cached formatter","version":"9.9.9"}');
  const sourceBefore = await readFile(join(sourceHome, 'config.toml'));
  const targetBefore = await readFile(join(targetHome, 'config.toml'));
  const result = await inspectSetupGuidance(f.store, 'Source', 'Target', { defaultUserHome: f.user });

  const pluginRows = result.items.filter(item => item.integration === 'plugin');
  assert.equal(pluginRows.length, 2);
  assert.deepEqual(pluginRows.map(item => item.pluginIdentity).sort(), ['formatter@first-market', 'formatter@second-market']);
  assert.equal(new Set(pluginRows.map(item => item.id)).size, 2);
  const first = pluginRows.find(item => item.pluginIdentity === 'formatter@first-market');
  const second = pluginRows.find(item => item.pluginIdentity === 'formatter@second-market');
  assert.equal(first.status, 'disabled-in-source-config');
  assert.equal(first.enabled, false);
  assert.equal(first.marketplaceSourceType, 'local');
  assert.equal(first.marketplaceLocator, pluginSource);
  assert.equal(first.sourceVersion, '1.2.3');
  assert.equal(first.versionEvidence, 'local-source-manifest');
  assert.equal(first.installedVersion, 'unknown');
  assert.equal(first.destinationStatus, 'same');
  assert.equal(second.status, 'enabled-in-source-config');
  assert.equal(second.destinationStatus, 'different');
  assert.equal(second.marketplaceMetadata, 'unknown');

  const docs = result.items.find(item => item.integration === 'mcp' && item.label === 'MCP · docs');
  const local = result.items.find(item => item.integration === 'mcp' && item.label === 'MCP · local');
  assert.equal(docs.destinationStatus, 'same');
  assert.equal(docs.steps.length, 1);
  assert.equal(local.destinationStatus, 'different');
  const hookConfig = result.items.find(item => item.origin === 'config.toml' && item.integration === 'hooks');
  const hookFile = result.items.find(item => item.origin === 'hooks.json');
  assert.ok(hookConfig);
  assert.equal(hookConfig.destinationStatus, 'different');
  assert.ok(hookFile);
  assert.equal(hookFile.destinationStatus, 'same');
  assert.deepEqual(hookFile.events, ['SessionStart']);
  assert.ok(result.items.every(item => item.setup === true && item.copyable === false && item.category === 'setup'));
  const serialized = JSON.stringify(result);
  for (const secret of ['secret-endpoint', 'private/path', 'very-secret-token-value', 'hook-secret-command', 'never-print', 'different-state', '9.9.9']) {
    assert.equal(serialized.includes(secret), false, `unexpected sensitive or cache-derived value: ${secret}`);
  }
  assert.ok(result.limitations.some(message => message.includes('installation')));
  assert.ok(result.limitations.some(message => message.includes('cache data was not used')));
  assert.deepEqual(await readFile(join(sourceHome, 'config.toml')), sourceBefore);
  assert.deepEqual(await readFile(join(targetHome, 'config.toml')), targetBefore);
});

test('labels destination state unknown for unreadable configuration and missing for known absence', async t => {
  const f = await fixture(t), sourceHome = f.homes.Source.home;
  await append(join(sourceHome, 'config.toml'), '[mcp_servers.docs]\nurl="https://private.example"\n');
  await append(join(f.homes.Broken.home, 'config.toml'), '[mcp_servers]\ndocs="unsupported server shape"\n');
  const unknown = await inspectSetupGuidance(f.store, 'Source', 'Broken', { defaultUserHome: f.user });
  assert.equal(unknown.items.find(item => item.integration === 'mcp').destinationStatus, 'unknown');
  const missing = await inspectSetupGuidance(f.store, 'Source', 'Target', { defaultUserHome: f.user });
  assert.equal(missing.items.find(item => item.integration === 'mcp').destinationStatus, 'missing');
  assert.equal(JSON.stringify(unknown).includes('private.example'), false);
});

test('omits malformed personal marketplace metadata and preserves unknown plugin source/version', async t => {
  const f = await fixture(t);
  await append(join(f.homes.Source.home, 'config.toml'), '[plugins."private-helper@personal"]\nenabled=true\n');
  await put(join(f.homes.Source.userHome, '.agents', 'plugins', 'marketplace.json'), '{"plugins": []}');
  const result = await inspectSetupGuidance(f.store, 'Source', null, { defaultUserHome: f.user });
  const plugin = result.items.find(item => item.integration === 'plugin');
  assert.equal(plugin.pluginIdentity, 'private-helper@personal');
  assert.equal(plugin.marketplaceMetadata, 'unknown');
  assert.equal(plugin.marketplaceSourceType, 'unknown');
  assert.equal(plugin.sourceVersion, undefined);
  assert.equal(plugin.installedVersion, 'unknown');
  assert.equal(result.items.some(item => item.integration === 'hooks'), false);
  assert.ok(result.limitations.some(message => message.includes('local source manifest or version is unknown')));
});
