import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { profileCommand } from '../src/profile-command.js';
import { inspectHomeCreation, startHomeSignIn } from '../src/home-create.js';
import { undoCopy } from '../src/native-copy.js';

const app = { appPath: '/fixture/Codex.app', bundleId: 'com.fixture.codex', executable: '/fixture/Codex.app/Contents/MacOS/Codex', version: 'fixture' };

function terminal(replies) {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = output.isTTY = true;
  const prompts = ['Settings:', 'Source profile', 'Numbers or names', 'Type create', 'Type copy', 'Type signin', 'Type register'];
  const seen = new Set(); let text = 0;
  output.on('data', chunk => {
    const value = chunk.toString(); text += value.length;
    for (const prompt of prompts) if (!seen.has(prompt) && value.includes(prompt)) {
      seen.add(prompt); const reply = replies.shift();
      queueMicrotask(() => input.write(`${reply}\n`));
    }
  });
  return { input, output, replies };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-command-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'controller')), base = join(root, 'profiles'), defaultUserHome = join(root, 'default');
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex v0.153.4"; exit 0; fi\nexit 0\n', { mode: 0o700 });
  const defaultCodex = join(defaultUserHome, '.codex'), defaultData = join(defaultUserHome, 'Library', 'Application Support', 'Codex');
  await mkdir(defaultCodex, { recursive: true, mode: 0o700 }); await mkdir(defaultData, { recursive: true, mode: 0o700 });
  await chmod(defaultCodex, 0o700); await chmod(defaultData, 0o700);
  await writeFile(join(defaultCodex, 'config.toml'), 'cli_auth_credentials_store = "file"\nmodel = "default-model"\n', { mode: 0o600 });
  const calls = [];
  const runtime = { assertExternal: async () => calls.push('external'), assertIdle: async () => calls.push('idle'), inspectApp: async () => app };
  const clientRuntime = () => runtime;
  const options = { '--apply': true, '--base': base, '--codex': executable };
  const signin = exitCode => args => startHomeSignIn({ ...args, probe: async () => '0.153.4', ramLogs: { prepareHome: async () => calls.push('ram') }, run: async () => ({ exitCode }) });
  return { root, store, base, defaultUserHome, executable, runtime, clientRuntime, options, calls, signin };
}

test('read-only profile preview leaves registry, profile base, and runtime untouched', async t => {
  const f = await fixture(t), io = terminal([]);
  const result = await profileCommand(f.store, ['create', 'alpha'], { '--base': f.base }, { input: io.input, output: io.output, clientRuntime: f.clientRuntime, defaultUserHome: f.defaultUserHome });
  assert.equal(result.status, 'preview'); assert.equal((await f.store.read()).profiles.length, 0);
  await assert.rejects(stat(f.base), { code: 'ENOENT' }); assert.deepEqual(f.calls, []);
});

test('apply is rejected without an external TTY before runtime or native preparation', async t => {
  const f = await fixture(t), input = new PassThrough(), output = new PassThrough();
  await assert.rejects(profileCommand(f.store, ['create', 'alpha'], f.options, { input, output, clientRuntime: f.clientRuntime, defaultUserHome: f.defaultUserHome }), /external interactive terminal/);
  assert.equal((await f.store.read()).profiles.length, 0); assert.deepEqual(f.calls, []);
});

test('minimal create records a retryable failed login, then signin completes and writes an initial activation plan', async t => {
  const f = await fixture(t), first = terminal(['1', 'create', 'signin']);
  const pending = await profileCommand(f.store, ['create', 'alpha'], f.options, { input: first.input, output: first.output, clientRuntime: f.clientRuntime, signIn: f.signin(4), defaultUserHome: f.defaultUserHome });
  assert.equal(pending.status, 'failed'); assert.equal(pending.login.state, 'failed'); assert.equal(pending.exitCode, 4);
  const retry = terminal(['signin']);
  const completed = await profileCommand(f.store, ['signin', 'alpha'], f.options, { input: retry.input, output: retry.output, clientRuntime: f.clientRuntime, signIn: f.signin(0), defaultUserHome: f.defaultUserHome });
  assert.equal(completed.login.state, 'completed'); assert.equal(completed.desktop, 'initial-activation-pending');
  assert.ok(completed.activationPlan); await stat(completed.activationPlan);
  assert.equal((await inspectHomeCreation({ store: f.store, name: 'alpha', base: f.base })).login.state, 'completed');
  assert.ok(f.calls.includes('external')); assert.ok(f.calls.includes('ram'));
});

test('intentional sign-in deferral stays setup-pending and returned cancellation is distinct', async t => {
  const f = await fixture(t), deferredIo = terminal(['1', 'create', 'later']);
  const deferred = await profileCommand(f.store, ['create', 'deferred'], f.options,
    { input: deferredIo.input, output: deferredIo.output, clientRuntime: f.clientRuntime, signIn: f.signin(0), defaultUserHome: f.defaultUserHome });
  assert.equal(deferred.status, 'setup-pending');
  assert.equal(deferred.login.state, 'pending');

  const cancelledIo = terminal(['signin']);
  const cancelled = await profileCommand(f.store, ['signin', 'deferred'], f.options,
    { input: cancelledIo.input, output: cancelledIo.output, clientRuntime: f.clientRuntime,
      signIn: async () => ({ login: { state: 'cancelled' }, native: { exitCode: null } }), defaultUserHome: f.defaultUserHome });
  assert.equal(cancelled.status, 'cancelled');
});

test('selected Default settings use the retained copy journal and undo contract', async t => {
  const f = await fixture(t), io = terminal(['create', 'copy', 'signin']);
  const result = await profileCommand(f.store, ['create', 'copied'], { ...f.options, '--from': 'Default', '--include': 'config' },
    { input: io.input, output: io.output, clientRuntime: f.clientRuntime, signIn: f.signin(4), defaultUserHome: f.defaultUserHome });
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 4);
  const setup = await inspectHomeCreation({ store: f.store, name: 'copied', base: f.base });
  assert.match(await readFile(join(setup.home, 'config.toml'), 'utf8'), /model = "default-model"/);
  const copyId = result.copy.id;
  assert.ok(copyId, 'Guided setup returns the undoable copy ID');
  const undone = await undoCopy(f.store, copyId, { runtime: f.runtime });
  assert.equal(undone.status, 'undone');
  assert.doesNotMatch(await readFile(join(setup.home, 'config.toml'), 'utf8'), /default-model/);
});

 test('default setup creates the private controller parent on a fresh installation', async t => {
  const f = await fixture(t), store = new Store(join(f.root, 'fresh-xfx', 'controller'));
  const io = terminal(['1', 'create', 'later']);
  const result = await profileCommand(store, ['create', 'fresh'], { '--apply': true, '--codex': f.executable },
    { input: io.input, output: io.output, clientRuntime: f.clientRuntime, signIn: f.signin(0), defaultUserHome: f.defaultUserHome });
  assert.equal(result.status, 'setup-pending');
  assert.equal((await stat(join(f.root, 'fresh-xfx'))).mode & 0o077, 0);
});

test('advanced creation copies one chosen key and retains the undoable operation', async t => {
  const f = await fixture(t), io = terminal(['create', 'copy', 'later']);
  const { inspectProfile } = await import('../src/profile-inventory.js');
  const selectAdvanced = async (store, source) => {
    const inventory = await inspectProfile(store, source, { defaultUserHome: f.defaultUserHome });
    return [inventory.items.find(item => item.transfer?.key === 'model').id];
  };
  const result = await profileCommand(f.store, ['create', 'advanced'], { ...f.options, '--from': 'Default', '--advanced': true },
    { input: io.input, output: io.output, clientRuntime: f.clientRuntime, selectAdvanced, defaultUserHome: f.defaultUserHome });
  assert.equal(result.status, 'setup-pending');
  assert.ok(result.copy.id);
  assert.match(await readFile(join(result.home, 'config.toml'), 'utf8'), /model = "default-model"/);
  assert.match(await readFile(join(result.home, 'config.toml'), 'utf8'), /cli_auth_credentials_store = "file"/);
  await undoCopy(f.store, result.copy.id, { runtime: f.runtime });
  assert.doesNotMatch(await readFile(join(result.home, 'config.toml'), 'utf8'), /default-model/);
});

test('advanced selection cancellation leaves no prepared profile', async t => {
  const f = await fixture(t), io = terminal([]);
  const result = await profileCommand(f.store, ['create', 'cancelled-advanced'], { ...f.options, '--advanced': true },
    { input: io.input, output: io.output, clientRuntime: f.clientRuntime, selectAdvanced: async () => null, defaultUserHome: f.defaultUserHome });
  assert.equal(result.status, 'cancelled');
  assert.equal((await f.store.read()).profiles.length, 0);
  await assert.rejects(stat(f.base), { code: 'ENOENT' });
});

test('advanced source preview does not prepare a destination', async t => {
  const f = await fixture(t), io = terminal([]);
  const result = await profileCommand(f.store, ['create', 'preview-advanced'], { '--advanced': true, '--base': f.base },
    { input: io.input, output: io.output, clientRuntime: f.clientRuntime, selectAdvanced: async () => ['fixture-item'], defaultUserHome: f.defaultUserHome });
  assert.equal(result.status, 'preview');
  assert.deepEqual(result.settings.selection, ['fixture-item']);
  assert.equal((await f.store.read()).profiles.length, 0);
  assert.deepEqual(f.calls, []);
  await assert.rejects(stat(f.base), { code: 'ENOENT' });
});
