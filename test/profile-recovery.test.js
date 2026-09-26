import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { createHome, startHomeSignIn } from '../src/home-create.js';
import { launchHome } from '../src/launcher.js';
import { recoverProfileRun } from '../src/profile-recovery.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-profile-recovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'homes'), store = new Store(join(root, 'controller'));
  await mkdir(base, { mode: 0o700 });
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const made = await createHome({ store, name: 'Research', base, executable, version: '0.153.4' });
  return { root, base, store, made, executable, lockPath: join(root, 'desktop-lock') };
}
const runtime = (idle = async () => {}) => ({ assertExternal: async () => {}, assertIdle: idle });
const opts = (f, extra = {}) => ({ lockPath: f.lockPath, defaultUserHome: join(f.root, 'native-default'),
  runtime: runtime(), isAlive: () => false, ...extra });
async function interruptedLogin(f) {
  await assert.rejects(startHomeSignIn({ store: f.store, name: 'Research', base: f.base,
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
  const retried = await startHomeSignIn({ store: f.store, name: 'Research', base: f.base,
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

test('desktop reservation blocks profile recovery without touching either record', async t => {
  const f = await fixture(t); await interruptedLogin(f);
  await mkdir(f.lockPath, { mode: 0o700 });
  await assert.rejects(recoverProfileRun(f.store, 'Research', opts(f, { apply: true })), /Desktop selection is reserved/);
  await access(join(f.made.root, '.run-lock'));
  assert.equal(JSON.parse(await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).phase, 'login-running');
});

test('recovers standalone CLI lock only with matching run report', async t => {
  const f = await fixture(t), lock = join(f.made.root, '.run-lock');
  const ramLogs = { prepareHome: async () => {} };
  const interrupted = await launchHome(f.store, 'Research', { probe: async () => '0.153.4', ramLogs,
    run: async () => { const error = new Error('shutdown uncertain'); error.code = 'SHUTDOWN_FAILED'; throw error; } });
  assert.equal(interrupted.status, 'incomplete');
  const result = await recoverProfileRun(f.store, 'Research', opts(f, { apply: true }));
  assert.equal(result.kind, 'interactive-cli');
  await assert.rejects(access(lock), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(f.made.root, '.xfx-home-setup.json'), 'utf8')).phase, 'registered');
  const retry = await launchHome(f.store, 'Research', { probe: async () => '0.153.4', ramLogs,
    run: async () => ({ exitCode: 0, signal: null }) });
  assert.equal(retry.status, 'exited');
});
