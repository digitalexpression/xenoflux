import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexDesktopSurface } from '../src/desktop-surface.js';
import { observeProfileClients } from '../src/ui-clients.js';

const app = { appPath: '/fixture/Codex.app', bundleId: 'com.openai.codex',
  executable: '/fixture/Codex.app/Contents/MacOS/Codex', version: '1.0', build: '10', asarSha256: 'a'.repeat(64) };

test('surface discovery is read-only and records exact observed app scope without inferring native support', async () => {
  let current = structuredClone(app), inspections = 0;
  const surface = createCodexDesktopSurface(undefined, { runtime: {
    inspectApp: async () => { inspections++; return current; },
    open: () => assert.fail('discovery cannot open'), focus: () => assert.fail('discovery cannot focus'),
  } });
  const first = await surface.inspect();
  assert.deepEqual(first.context.app, app);
  assert.equal(first.context.executionLocation, 'local');
  assert.deepEqual(first.context.backend, { identity: null, build: null });
  assert.deepEqual(first.context.routes, { config: null, data: null, callback: null });
  assert.ok(Object.values(first.capabilities).every(state => state === 'unknown'));
  assert.equal(first.nativeAcceptance, 'pending');
  assert.equal(first.implementation.open, 'supported');
  for (const change of [{ build: '11' }, { asarSha256: 'b'.repeat(64) }, { appPath: '/other/Codex.app' }]) {
    current = { ...app, ...change };
    assert.notEqual((await surface.inspect()).contextKey, first.contextKey, 'changed context cannot reuse qualification');
  }
  current = structuredClone(app);
  first.capabilities.automatedExecution = 'supported';
  assert.equal((await surface.inspect()).capabilities.automatedExecution, 'unknown', 'no cached capability mutation');
  assert.equal(inspections, 5);
});

test('discovery failures never manufacture a supported surface', async () => {
  const failure = Object.assign(new Error('signature changed'), { code: 'APP_SIGNATURE_INVALID' });
  const surface = createCodexDesktopSurface(undefined, { runtime: { inspectApp: async () => { throw failure; } } });
  await assert.rejects(surface.inspect(), error => error === failure);
});

test('profile holder inspection uses the surface process snapshot without discovering or opening an app', async t => {
  const home = await mkdtemp(join(tmpdir(), 'xfx-surface-clients-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'config.toml'), '', { mode: 0o600 });
  let snapshots = 0;
  const desktopSurface = createCodexDesktopSurface(undefined, { runtime: {
    snapshot: async () => { snapshots++; return [{ pid: 10, ppid: 1, executable: app.executable },
      { pid: 11, ppid: 10, executable: '/fixture/codex-app-server' }]; },
    inspectApp: () => assert.fail('holder observation cannot discover app'),
  } });
  const observed = await observeProfileClients(home, { desktopSurface,
    inspect: async targets => { assert.deepEqual(targets, [join(home, 'config.toml')]); return { clients: [{ pid: 11, command: 'codex-app-server' }] }; } });
  assert.equal(snapshots, 1);
  assert.deepEqual(observed.desktop, { state: 'running', text: 'open' });
  assert.equal(observed.cli.state, 'unavailable');
});

test('failed surface snapshot preserves unknown client observation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'xfx-surface-unknown-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const observed = await observeProfileClients(home, {
    desktopSurface: { snapshot: async () => { throw new Error('unavailable'); } },
    inspect: async () => ({ clients: [{ pid: 12, command: 'codex' }] }),
  });
  assert.equal(observed.cli.state, 'unknown');
  assert.equal(observed.desktop.state, 'unknown');
});


test('stock Desktop opening retains its exact existing command and propagates failure', async () => {
  const calls = [];
  const failure = new Error('launch failed');
  const surface = createCodexDesktopSurface(undefined, { runtime: {}, execFile: async (...args) => {
    calls.push(args);
    if (calls.length > 1) throw failure;
  } });
  assert.equal(await surface.openDefault(), undefined);
  assert.deepEqual(calls[0], ['/usr/bin/open', ['-b', 'com.openai.codex'], { timeout: 15000 }]);
  await assert.rejects(surface.openDefault(), error => error === failure);
});
