import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access, stat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Store } from '../src/profiles.js';
import { createHome, startHomeSignIn } from '../src/home-create.js';
import { launchHome } from '../src/launcher.js';
import { recoverProfileRun } from '../src/profile-recovery.js';
import { acquireCopilotAccount } from '../src/copilot-account-lock.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'homes'), store = new Store(join(root, 'controller'));
  await mkdir(base, { mode: 0o700 });
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const made = await createHome({ store, name: 'Research', base, executable, version: '0.153.4' });
  return { root, base, store, made, executable, terminalEnvironment: { PATH: root + ':/usr/bin:/bin' }, lockPath: join(root, 'desktop-lock') };
}
const runtime = (idle = async () => {}) => ({ assertExternal: async () => {}, assertIdle: idle });
const opts = (f, extra = {}) => ({ lockPath: f.lockPath, defaultUserHome: join(f.root, 'native-default'),
  runtime: runtime(), isAlive: () => false, ...extra });
async function interruptedLogin(f) {
  await assert.rejects(startHomeSignIn({ store: f.store, name: 'Research', base: f.base, terminalEnvironment: f.terminalEnvironment,
    probe: async () => '0.153.4', ramLogs: { prepareHome: async () => {} },
    run: async () => { const error = new Error('shutdown uncertain'); error.code = 'SHUTDOWN_FAILED'; throw error; } }),
  { code: 'SHUTDOWN_FAILED' });
}

test('recovers stale sign-in, then permits sign-in retry', async t => {
  const f = await fixture(t); await interruptedLogin(f);
  const registryBefore = await stat(f.store.file);
  const preview = await recoverProfileRun(f.store, 'Research', opts(f));
  assert.equal(preview.status, 'preview');
  assert.equal((await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).includes('login-running'), true);
  const result = await recoverProfileRun(f.store, 'Research', opts(f, { apply: true }));
  assert.equal(result.status, 'recovered');
  const registryAfter = await stat(f.store.file);
  assert.deepEqual([registryAfter.ino, registryAfter.mtimeMs], [registryBefore.ino, registryBefore.mtimeMs]);
  await assert.rejects(access(join(f.made.root, '.run-lock')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).phase, 'login-cancelled');
  const retried = await startHomeSignIn({ store: f.store, name: 'Research', base: f.base, terminalEnvironment: f.terminalEnvironment,
    probe: async () => '0.153.4', ramLogs: { prepareHome: async () => {} }, run: async () => ({ exitCode: 0 }) });
  assert.equal(retried.login.state, 'completed');
});

test('releases a stale sign-in lock after its terminal marker was already committed', async t => {
  const f = await fixture(t); await interruptedLogin(f);
  const markerPath = join(f.made.root, '.xfx-home-setup.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  await writeFile(markerPath, JSON.stringify({ ...marker, phase: 'login-completed' }, null, 2) + '\n', { mode: 0o600 });
  await recoverProfileRun(f.store, 'Research', opts(f, { apply: true }));
  assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).phase, 'login-completed');
  await assert.rejects(access(join(f.made.root, '.run-lock')), { code: 'ENOENT' });
});

test('recovers a pre-login lock without changing the prepared marker', async t => {
  const f = await fixture(t), markerPath = join(f.made.root, '.xfx-home-setup.json');
  const before = await readFile(markerPath, 'utf8');
  await interruptedLogin(f);
  // A hard exit after lock acquisition and before the first marker write leaves
  // this same owner record alongside the original registered marker.
  await writeFile(markerPath, before, { mode: 0o600 });
  const result = await recoverProfileRun(f.store, 'Research', opts(f, { apply: true }));
  assert.equal(result.marker, 'unchanged');
  assert.equal(result.setupPhase, 'registered');
  assert.equal(await readFile(markerPath, 'utf8'), before);
  await assert.rejects(access(join(f.made.root, '.run-lock')), { code: 'ENOENT' });
});

test('recovery reports the marker reconciled under its guards instead of a stale preview', async t => {
  const f = await fixture(t); await interruptedLogin(f);
  const markerPath = join(f.made.root, '.xfx-home-setup.json');
  const result = await recoverProfileRun(f.store, 'Research', opts(f, { apply: true, runtime: runtime(async () => {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    await writeFile(markerPath, JSON.stringify({ ...marker, phase: 'login-completed' }), { mode: 0o600 });
  }) }));
  assert.equal(result.marker, 'unchanged');
  assert.equal(result.setupPhase, 'login-completed');
});

test('live or foreign owners and active writers block without changing state', async t => {
  const f = await fixture(t); await interruptedLogin(f);
  const lock = join(f.made.root, '.run-lock'), ownerPath = join(lock, 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  const original = await readFile(ownerPath, 'utf8');
  await assert.rejects(recoverProfileRun(f.store, 'Research', opts(f, { isAlive: () => true, apply: true })), /may still be live/);
  assert.equal(await readFile(ownerPath, 'utf8'), original);
  await writeFile(ownerPath, JSON.stringify({ ...owner, host: 'another-host' }), { mode: 0o600 });
  await assert.rejects(recoverProfileRun(f.store, 'Research', opts(f)), /foreign/);
  assert.equal(JSON.parse(await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).phase, 'login-running');
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).host, 'another-host');
});

test('writer-quiescence failure preserves lock and login marker', async t => {
  const f = await fixture(t); await interruptedLogin(f);
  await assert.rejects(recoverProfileRun(f.store, 'Research', opts(f, { apply: true,
    runtime: runtime(async () => { throw new Error('writers remain'); }) })), /writers remain/);
  await access(join(f.made.root, '.run-lock'));
  assert.equal(JSON.parse(await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).phase, 'login-running');
});

test('profile operation reservation blocks stale run recovery without touching either record', async t => {
  const f = await fixture(t); await interruptedLogin(f);
  await mkdir(`${f.lockPath}.operation`, { mode: 0o700 });
  await assert.rejects(recoverProfileRun(f.store, 'Research', opts(f, { apply: true })), /locked/);
  await access(join(f.made.root, '.run-lock'));
  assert.equal(JSON.parse(await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).phase, 'login-running');
});

test('recovers standalone CLI lock only with matching run report', async t => {
  const f = await fixture(t), lock = join(f.made.root, '.run-lock');
  const ramLogs = { prepareHome: async () => {} };
  const interrupted = await launchHome(f.store, 'Research', { terminalEnvironment: f.terminalEnvironment, probe: async () => '0.153.4', ramLogs,
    run: async () => { const error = new Error('shutdown uncertain'); error.code = 'SHUTDOWN_FAILED'; throw error; } });
  assert.equal(interrupted.status, 'incomplete');
  const result = await recoverProfileRun(f.store, 'Research', opts(f, { apply: true }));
  assert.equal(result.kind, 'interactive-cli');
  await assert.rejects(access(lock), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).phase, 'registered');
  const retry = await launchHome(f.store, 'Research', { terminalEnvironment: f.terminalEnvironment, probe: async () => '0.153.4', ramLogs,
    run: async () => ({ exitCode: 0, signal: null }) });
  assert.equal(retry.status, 'exited');
});

async function interruptedNativeSignin(t) {
  const f = await fixture(t);
  const configRoot = join(f.made.root, 'config');
  await mkdir(configRoot, { mode: 0o700 });
  await f.store.update(data => {
    const profile = data.profiles[0];
    profile.client = 'claude-code';
    profile.native.configRoot = configRoot;
    profile.native.rootMode = 'explicit';
  });
  const profile = (await f.store.read()).profiles[0];
  const roots = await Promise.all([configRoot, f.made.root].map(async path => {
    const info = await stat(path);
    return [info.dev, info.ino];
  }));
  const owner = { kind: 'native-signin', runId: randomUUID(), host: hostname(), pid: process.pid,
    storePath: f.store.directory, profileId: profile.id, executable: f.executable,
    executableIdentity: profile.native.executableIdentity, roots, configRoot, userHome: f.root,
    processIdentity: { pid: 2147483646, started: 'fixture-start', command: f.executable, host: hostname() },
    shutdown: { groupTerminated: false } };
  const lock = join(f.made.root, '.run-lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  return { ...f, lock, owner };
}

test('recovers a stopped browser sign-in only after checking native resources', async t => {
  const f = await interruptedNativeSignin(t);
  const registry = await readFile(f.store.file, 'utf8');
  let inspected = false;
  const options = opts(f, { observeProcess: async () => ({ status: 'stopped' }),
    runtime: runtime(async request => {
      assert.ok(request.cliExecutables.includes(f.executable));
      assert.ok(request.resourcePaths.includes(f.owner.configRoot));
      inspected = true;
    }) });
  assert.equal((await recoverProfileRun(f.store, 'Research', options)).kind, 'native-signin');
  await access(f.lock);
  const result = await recoverProfileRun(f.store, 'Research', { ...options, apply: true });
  assert.equal(result.status, 'recovered');
  assert.equal(inspected, true);
  await assert.rejects(access(f.lock), { code: 'ENOENT' });
  assert.equal(await readFile(f.store.file, 'utf8'), registry);
});

test('preserves browser sign-in reservations for live, changed or unknown child identities', async t => {
  const f = await interruptedNativeSignin(t);
  const before = await readFile(join(f.lock, 'owner.json'), 'utf8');
  for (const status of ['running', 'different', 'unknown']) {
    await assert.rejects(recoverProfileRun(f.store, 'Research', opts(f, { apply: true,
      observeProcess: async () => ({ status }) })), /stopped process could not be verified/);
    assert.equal(await readFile(join(f.lock, 'owner.json'), 'utf8'), before);
  }
});

test('preserves browser sign-in reservations if roots or native quiescence change', async t => {
  const f = await interruptedNativeSignin(t);
  const options = opts(f, { apply: true, observeProcess: async () => ({ status: 'stopped' }) });
  await assert.rejects(recoverProfileRun(f.store, 'Research', { ...options,
    runtime: runtime(async () => { throw new Error('native process remains'); }) }), /native process remains/);
  await access(f.lock);
  await writeFile(join(f.lock, 'owner.json'), JSON.stringify({ ...f.owner, roots: [[0, 0], [0, 0]] }), { mode: 0o600 });
  await assert.rejects(recoverProfileRun(f.store, 'Research', options), /ownership or stopped process/);
  await access(f.lock);
});

test('releases the exact shared account claim with a stopped Copilot sign-in', async t => {
  const f = await interruptedNativeSignin(t);
  await f.store.update(data => { data.profiles[0].client = 'copilot'; });
  const account = await acquireCopilotAccount(f.root, { exclusive: true });
  const accountRoot = dirname(account.reference.path);
  t.after(() => rm(accountRoot, { recursive: true, force: true }));
  await account.checkpoint({ pid: 2147483646, spawnIntent: true, processIdentity: f.owner.processIdentity });
  f.owner.accountClaim = account.reference;
  await writeFile(join(f.lock, 'owner.json'), JSON.stringify(f.owner), { mode: 0o600 });
  await account.checkpoint({ shutdown: { groupTerminated: false } });
  const options = opts(f, { apply: true, observeProcess: async () => ({ status: 'stopped' }) });
  await assert.rejects(recoverProfileRun(f.store, 'Research', { ...options,
    runtime: runtime(async () => { throw new Error('native process remains'); }) }), /native process remains/);
  await access(account.reference.path);
  await access(f.lock);
  assert.equal((await recoverProfileRun(f.store, 'Research', options)).status, 'recovered');
  await assert.rejects(access(account.reference.path), { code: 'ENOENT' });
  await assert.rejects(access(f.lock), { code: 'ENOENT' });
});
