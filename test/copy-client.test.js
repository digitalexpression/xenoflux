import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, realpath, rm, chmod, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { planCopy, applyCopy, undoCopy, planUndo, validateAdvancedSelection } from '../src/native-copy.js';
import { inspectCopyProfile } from '../src/copy-client.js';

async function put(path, data, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data, { mode });
}
async function fixture(t, clientId) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copy-client-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, 'user'), directory = join(root, 'store');
  await mkdir(user, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const profiles = [], bindings = {};
  for (const name of ['Source', 'Target']) {
    const reservation = join(root, name), home = join(reservation, 'config');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const id = name.toLowerCase();
    profiles.push({ id, name, client: clientId, native: { root: reservation } });
    bindings[name] = { client: clientId, surface: 'cli', executionLocation: 'local', profileId: id, rootMode: 'explicit',
      roots: { config: home, reservation, user, runtime: null }, workspace: null,
      executable: { path: join(root, 'never-launched'), identity: 'fixture', version: '1.0.0' }, settingsIdentity: null };
  }
  const store = { directory, read: async () => ({ profiles }) }, calls = [];
  const options = { clientId, sourceBinding: bindings.Source, targetBinding: bindings.Target, defaultUserHome: user,
    lockPath: join(root, 'lock'), runtime: { prepareClients: async value => calls.push(value), assertIdle: async () => {} } };
  const source = bindings.Source.roots.config, target = bindings.Target.roots.config;
  const instruction = clientId === 'claude-code' ? 'CLAUDE.md' : 'copilot-instructions.md';
  const rules = clientId === 'claude-code' ? 'rules' : 'instructions';
  async function inventory() { return inspectCopyProfile(store, 'Source', { clientId, binding: bindings.Source, defaultUserHome: user }); }
  async function select(kind, label) {
    const selected = (await inventory()).items.find(item => item.copyable && item.transfer?.kind === kind && (!label || item.label === label));
    assert.ok(selected, kind + ':' + label); return selected.id;
  }
  return { root, user, source, target, store, calls, options, bindings, profiles, instruction, rules, inventory, select };
}
for (const clientId of ['claude-code', 'copilot']) {
  test(`${clientId}: selected fields, definitions and exact skill replacement use common copy/Undo`, async t => {
    const f = await fixture(t, clientId);
    await put(join(f.source, 'settings.json'), { model: 'source-model', theme: 'dark', env: { TOKEN: 'SOURCE-SECRET' }, hooks: { Start: 'SOURCE-HOOK' }, enabledPlugins: { 'sample@market': true } });
    const original = '{"model":"old","theme":"light","env":{"TOKEN":"TARGET-SECRET"},"permissions":{"allow":["original"]},"unknownNumber":9007199254740993,"mcpServers":{"existing":{"command":"keep"}}}\n';
    await put(join(f.target, 'settings.json'), original, 0o640);
    await put(join(f.source, f.instruction), 'Fresh guidance.\n');
    await put(join(f.source, 'agents', 'review.md'), '---\nname: reviewer\ndescription: Review code\n---\nReview carefully.\n');
    await put(join(f.source, f.rules, 'nested', 'style.md'), 'Keep it simple.\n');
    await put(join(f.target, 'agents', 'destination-only.md'), 'Keep this agent.');
    await put(join(f.source, 'skills', 'tool', 'SKILL.md'), 'Tool skill.\n');
    await put(join(f.source, 'skills', 'tool', 'run.sh'), '#!/bin/sh\necho safe\n', 0o700);
    await put(join(f.source, 'skills', 'tool', 'image.bin'), Buffer.from([0, 128, 255]));
    await put(join(f.target, 'skills', 'tool', 'SKILL.md'), 'Old skill.');
    await put(join(f.target, 'skills', 'tool', 'obsolete.sh'), '#!/bin/sh\n', 0o750);
    await put(join(f.target, 'skills', 'other', 'SKILL.md'), 'Unselected.');
    await put(join(f.source, 'auth.json'), 'SOURCE-CREDENTIALS');
    await put(join(f.target, 'auth.json'), 'TARGET-CREDENTIALS');
    const selection = await Promise.all(['config', 'instruction', 'agent', 'rule', 'skill'].map(kind => f.select(kind, kind === 'config' ? 'model' : undefined)));
    const options = { ...f.options, selection };
    const beforeStore = await readdir(f.store.directory), sourceBefore = await readFile(join(f.source, 'settings.json'));
    const preview = await planCopy(f.store, 'Source', 'Target', options);
    const seed = await validateAdvancedSelection(f.store, 'Source', selection, { clientId, binding: f.bindings.Source });
    assert.ok(seed.items.some(item => item.changes.some(change => change.path === 'settings.json:model')));
    assert.deepEqual(await readdir(f.store.directory), beforeStore); assert.equal(f.calls.length, 0);
    assert.ok(preview.changes.some(c => c.path === 'skills/tool/obsolete.sh' && c.action === 'remove'));
    assert.equal(JSON.stringify(preview).includes('SOURCE-SECRET'), false);
    const applied = await applyCopy(f.store, 'Source', 'Target', { ...options, expectedHash: preview.hash });
    assert.equal(applied.status, 'applied'); assert.equal(f.calls.length, 0, 'native copy refuses active clients without preparing or closing them');
    const afterText = await readFile(join(f.target, 'settings.json'), 'utf8');
    assert.equal(afterText, original.replace('"old"', '"source-model"'));
    const after = JSON.parse(afterText);
    assert.deepEqual(after, { ...JSON.parse(original), model: 'source-model' });
    assert.equal((await stat(join(f.target, 'settings.json'))).mode & 0o777, 0o640);
    assert.equal((await stat(join(f.target, 'skills/tool/run.sh'))).mode & 0o777, 0o700);
    assert.equal(await readFile(join(f.target, 'auth.json'), 'utf8'), 'TARGET-CREDENTIALS');
    assert.deepEqual(await readFile(join(f.source, 'settings.json')), sourceBefore);
    await assert.rejects(stat(join(f.target, 'skills/tool/obsolete.sh')), { code: 'ENOENT' });
    const undo = await planUndo(f.store, applied.id);
    await undoCopy(f.store, applied.id, { ...f.options, expectedHash: undo.hash });
    assert.equal(await readFile(join(f.target, 'settings.json'), 'utf8'), original);
    assert.equal((await stat(join(f.target, 'skills/tool/obsolete.sh'))).mode & 0o777, 0o750);
    assert.equal(await readFile(join(f.target, 'skills/other/SKILL.md'), 'utf8'), 'Unselected.');
    assert.equal(await readFile(join(f.target, 'agents/destination-only.md'), 'utf8'), 'Keep this agent.');
    await assert.rejects(stat(join(f.target, f.instruction)), { code: 'ENOENT' });
    await assert.rejects(stat(join(f.target, f.rules)), { code: 'ENOENT' });
  });
  test(`${clientId}: empty, identical, cancellation and stale previews preserve state`, async t => {
    const f = await fixture(t, clientId);
    await put(join(f.source, 'settings.json'), { model: 'same' }); await put(join(f.target, 'settings.json'), { model: 'same' });
    const selection = [await f.select('config', 'model')];
    for (const selected of [[], selection]) assert.equal((await applyCopy(f.store, 'Source', 'Target', { ...f.options, selection: selected })).status, 'unchanged');
    assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.store.directory), []);
    await put(join(f.source, 'settings.json'), { model: 'new' });
    const preview = await planCopy(f.store, 'Source', 'Target', { ...f.options, selection });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', { ...f.options, selection, signal: controller.signal }), /cancelled/);
    assert.deepEqual(await readdir(f.store.directory), []);
    await chmod(join(f.source, 'settings.json'), 0o640);
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', { ...f.options, selection, expectedHash: preview.hash }), /preview changed/);
    await chmod(join(f.source, 'settings.json'), 0o600);
    await put(join(f.source, 'settings.json'), { model: 'newer' });
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', { ...f.options, selection, expectedHash: preview.hash }), /preview changed/);
    assert.deepEqual(JSON.parse(await readFile(join(f.target, 'settings.json'))), { model: 'same' });
  });
  test(`${clientId}: failure compensation, uncertain recovery, interrupted Undo and edits`, async t => {
    const f = await fixture(t, clientId);
    await put(join(f.source, 'settings.json'), { model: 'new' }); await put(join(f.target, 'settings.json'), { model: 'old' });
    await put(join(f.source, f.instruction), 'Instructions.');
    const selection = [await f.select('config', 'model'), await f.select('instruction')], options = { ...f.options, selection };
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', { ...options, checkpoint: async () => { throw new Error('after write'); } }), /prior settings were restored/);
    assert.deepEqual(JSON.parse(await readFile(join(f.target, 'settings.json'))), { model: 'old' });
    let blocked = false;
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', { ...options,
      checkpoint: async () => { blocked = true; throw new Error('after write'); },
      runtime: { assertIdle: async () => { if (blocked) throw new Error('owner active'); } } }), /Copy incomplete/);
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', options), /interrupted settings copy/);
    const lock = join(f.bindings.Target.roots.reservation, '.run-lock');
    assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'))).kind, 'native-copy-pending');
    await undoCopy(f.store, 'pending', f.options);
    await assert.rejects(stat(lock), { code: 'ENOENT' });
    const applied = await applyCopy(f.store, 'Source', 'Target', options);
    await assert.rejects(undoCopy(f.store, applied.id, { ...f.options, checkpoint: async () => { throw new Error('undo interrupted'); } }), /undo interrupted/);
    await undoCopy(f.store, 'pending', f.options);
    const again = await applyCopy(f.store, 'Source', 'Target', options);
    await put(join(f.target, 'settings.json'), { model: 'user-edit' });
    await assert.rejects(undoCopy(f.store, again.id, f.options), /refusing to overwrite/);
    assert.deepEqual(JSON.parse(await readFile(join(f.target, 'settings.json'))), { model: 'user-edit' });
  });
  test(`${clientId}: source Default, missing settings and category copy preserve unrelated state`, async t => {
    const f = await fixture(t, clientId), home = join(f.user, clientId === 'claude-code' ? '.claude' : '.copilot');
    await put(join(home, 'settings.json'), { model: 'stock', theme: 'dark', env: { TOKEN: 'NEVER-COPY' } });
    const options = { ...f.options, sourceBinding: undefined, include: ['config'] };
    const preview = await planCopy(f.store, 'Default', 'Target', options);
    assert.ok(preview.items.some(item => item.label === 'model'));
    const applied = await applyCopy(f.store, 'Default', 'Target', { ...options, expectedHash: preview.hash });
    assert.deepEqual(JSON.parse(await readFile(join(f.target, 'settings.json'))), { model: 'stock', theme: 'dark' });
    await undoCopy(f.store, applied.id, f.options);
    await assert.rejects(stat(join(f.target, 'settings.json')), { code: 'ENOENT' });
  });
  test(`${clientId}: plugin components stay grouped and unsupported definitions cannot transfer`, async t => {
    const f = await fixture(t, clientId), plugin = join(f.source, ...(clientId === 'claude-code' ? ['plugins/cache/market/sample/1'] : ['installed-plugins/sample']));
    await put(join(plugin, clientId === 'claude-code' ? '.claude-plugin/plugin.json' : 'plugin.json'), { name: 'sample', version: '1.0.0' });
    await put(join(plugin, 'skills/tool/SKILL.md'), 'Plugin skill'); await put(join(plugin, 'agents/owned.md'), 'Plugin agent');
    await put(join(f.source, 'settings.json'), { hooks: { Start: 'never copy' }, enabledPlugins: { 'sample@market': true } });
    await put(join(f.source, 'agents/unsafe.md'), '---\nname: unsafe\nmcpServers: inline\n---\nAgent.');
    const inventory = await f.inventory();
    assert.ok(inventory.items.some(item => item.category === 'plugin' && !item.copyable));
    assert.equal(inventory.items.some(item => item.category !== 'plugin' && (item.provider || item.scope === 'plugin')), false);
    assert.ok(inventory.items.filter(item => item.category === 'plugin').every(item => item.setup && item.steps[0].includes('Install only if wanted and absent')));
    assert.equal(inventory.items.some(item => item.copyable && ['hook','mcp','plugin'].includes(item.category)), false);
    const unsafe = await f.select('agent');
    await assert.rejects(planCopy(f.store, 'Source', 'Target', { ...f.options, selection: [unsafe] }), /ownership/);
    const pluginId = inventory.items.find(item => item.category === 'plugin').id;
    await assert.rejects(planCopy(f.store, 'Source', 'Target', { ...f.options, selection: [pluginId] }), /no longer available or copyable/);
    await put(join(f.source, 'skills/tool/SKILL.md'), 'Safe.'); await put(join(f.source, 'skills/tool/hooks.json'), { hooks: {} });
    const skill = await f.select('skill');
    await assert.rejects(planCopy(f.store, 'Source', 'Target', { ...f.options, selection: [skill] }), /Native state or integration/);
    assert.deepEqual(await readdir(f.store.directory), []);
  });
  test(`${clientId}: unsafe settings and changed bindings/owners are refused`, async t => {
    const f = await fixture(t, clientId);
    await put(join(f.source, 'settings.json'), { model: 'safe' }); await put(join(f.target, 'settings.json'), { model: 'old' });
    const selection = [await f.select('config', 'model')], options = { ...f.options, selection };
    await assert.rejects(planCopy(f.store, 'Source', 'Target', { ...options, targetBinding: undefined }), /resolved environment binding/);
    await assert.rejects(planCopy(f.store, 'Source', 'Target', { ...options, targetBinding: { ...f.bindings.Target, client: clientId === 'copilot' ? 'claude-code' : 'copilot' } }), /client does not match/);
    for (const body of ['{"model":"a","model":"b"}', '{/* comment */"model":"a"}', '{"model":"a","unknown":{"x":1,"x":2}}']) {
      await put(join(f.target, 'settings.json'), body);
      await assert.rejects(planCopy(f.store, 'Source', 'Target', options), /ownership|JSON|property name/);
    }
    await put(join(f.target, 'settings.json'), { model: { secret: 'DO-NOT-PREVIEW' } });
    await assert.rejects(planCopy(f.store, 'Source', 'Target', options), /Unsupported destination value/);
    await put(join(f.target, 'settings.json'), { model: 'old' });
    await chmod(join(f.source, 'settings.json'), 0o666);
    await assert.rejects(planCopy(f.store, 'Source', 'Target', options), /no longer available or copyable/);
    await chmod(join(f.source, 'settings.json'), 0o600);
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', { ...options, runtime: { assertIdle: async () => { throw new Error('active execution owner'); } } }), /active execution owner/);
    const reserved = join(f.bindings.Target.roots.reservation, '.run-lock');
    await mkdir(reserved, { mode: 0o700 });
    await assert.rejects(applyCopy(f.store, 'Source', 'Target', options), /lock|already/i);
    assert.ok((await stat(reserved)).isDirectory());
    assert.deepEqual(await readdir(f.store.directory), []);
    await put(join(f.source, 'agents/link.md'), 'placeholder'); await rm(join(f.source, 'agents/link.md'));
    await symlink(join(f.source, 'settings.json'), join(f.source, 'agents/link.md'));
    const unsafe = (await f.inventory()).items.find(item => item.label === 'link.md');
    assert.equal(unsafe.copyable, false);
  });
}
