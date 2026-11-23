import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm, readFile, access } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiCatalog } from '../src/ui-catalog.js';
import { acquire, readJSON, record } from '../src/metadata.js';
import { acquireNativeParticipant, readProfileOwners } from '../src/profile-reservations.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { resolve, promise }; };
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ui-catalog-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const store = { directory: join(root, 'store') };
  const profile = { profileId: randomUUID(), profileName: 'Research', cwd: root, home, reservationRoot: home,
    environmentBinding: { client: 'codex', surface: 'cli', executionLocation: 'local', profileId: 'fixture-profile', rootMode: 'explicit',
      roots: { config: home, runtime: home, user: root, reservation: home }, workspace: root,
      executable: { path: '/bin/codex', identity: 'fixture', version: null },
      settingsIdentity: { algorithm: 'sha256-file-stat-metadata-v1', digest: 'a'.repeat(64) } } };
  profile.environmentBinding.profileId = profile.profileId;
  let calls = 0;
  const native = { pid: 999999, processIdentity: { pid: 999999, host: 'fixture', started: 'fixture' } };
  const stopped = { ...native, status: 'exited', exitCode: 0, shutdown: { groupTerminated: true } };
  const result = () => ({ status: 'ready', source: 'codex-model/list', scope: { environmentBinding: structuredClone(profile.environmentBinding),
    workspace: root, account: { status: 'unverified', type: 'chatgpt', id: null } },
    models: [{ id: 'fixture', model: 'fixture', supportedReasoningEfforts: [], isDefault: true }],
    capabilities: { models: 'supported', effort: 'unknown' }, discoveredAt: new Date().toISOString(), process: stopped });
  const context = { lockOptions: { lockPath: join(root, 'guard') }, resolveProfile: async () => structuredClone(profile),
    discover: async options => { calls++; await options.onSpawn(native); return result(); }, ...overrides };
  const service = createUiCatalog({ store, context });
  t.after(() => service.close());
  return { root, home, store, profile, native, stopped, result, context, service, calls: () => calls,
    input: () => ({ requestId: randomUUID(), profile: 'Research', workspace: root }),
    receipt: requestId => join(store.directory, 'catalog-probes', requestId, 'probe.json'),
    lock: join(home, '.run-lock') };
}

test('duplicate refresh starts one probe, checkpoints ownership before discovery and releases stopped process', async t => {
  const gate = deferred(), entered = deferred(); let f, calls = 0;
  f = await fixture(t, { discover: async options => {
    calls++;
    await options.onSpawn(f.native);
    assert.equal(options.runtimeDirectory, join(f.store.directory, 'catalog-probes', input.requestId));
    const receipt = await readJSON(f.receipt(input.requestId));
    assert.equal(receipt.status, 'running'); assert.deepEqual(receipt.process, f.native);
    assert.equal((await readJSON(join(f.lock, 'owner.json'))).runId, input.requestId);
    entered.resolve(); await gate.promise; return f.result();
  } });
  const input = f.input(), first = f.service.refresh(input), second = f.service.refresh(input);
  assert.equal(first, second);
  await entered.promise;
  assert.throws(() => f.service.refresh({ ...input, workspace: '/other' }), { code: 'catalog-request-mismatch' });
  gate.resolve(); assert.equal((await first).status, 'ready'); assert.equal(calls, 1);
  await assert.rejects(access(f.lock), { code: 'ENOENT' });
  assert.equal((await readJSON(f.receipt(input.requestId))).released, true);
  assert.equal((await f.service.get(input)).status, 'ready'); assert.equal(calls, 1);
});

test('cancel and close during pending profile selection prevent all discovery and reservations', async t => {
  for (const action of ['cancel', 'close']) {
    const gate = deferred(); let calls = 0;
    const f = await fixture(t, { resolveProfile: async () => gate.promise, discover: async () => { calls++; assert.fail('must not discover'); } });
    const input = f.input(), refresh = f.service.refresh(input);
    const rejected = assert.rejects(refresh, error => ['catalog-cancelled', 'stopping'].includes(error.code));
    const stopping = action === 'cancel' ? f.service.cancel(input) : f.service.close();
    gate.resolve(f.profile);
    await rejected;
    if (action === 'cancel') assert.equal((await stopping).status, 'cancelled'); else await stopping;
    assert.equal(calls, 0); await assert.rejects(access(f.lock), { code: 'ENOENT' });
  }
});

test('busy exclusive reservation stays byte-identical and never starts discovery', async t => {
  const f = await fixture(t); const owner = { kind: 'native-signin', runId: randomUUID() };
  await acquire(f.lock, owner, true); const before = await readFile(join(f.lock, 'owner.json'));
  await assert.rejects(f.service.refresh(f.input()), { code: 'catalog-profile-busy', status: 409 });
  assert.deepEqual(await readFile(join(f.lock, 'owner.json')), before); assert.equal(f.calls(), 0);
});

test('a bounded probe shares a verified Desktop and CLI reservation and releases only its own membership', async t => {
  const gate = deferred(), entered = deferred(); let f;
  const nativeOwners = [];
  f = await fixture(t, { observeAccess: async (profile, { store, allowInteractivePeers }) => {
    assert.equal(profile.profileId, f.profile.profileId);
    assert.equal(store, f.store);
    assert.equal(allowInteractivePeers, true);
    return { status: 'ready', nativeOwners };
  }, discover: async options => {
    await options.onSpawn(f.native);
    assert.equal(options.runtimeDirectory, join(f.store.directory, 'catalog-probes', input.requestId));
    entered.resolve();
    await gate.promise;
    return f.result();
  } });
  const common = { profileId: f.profile.profileId, home: f.home, storePath: f.store.directory, host: hostname(), pid: process.pid };
  const desktop = { ...common, kind: 'desktop-instance', runId: randomUUID() };
  const cli = { ...common, kind: 'interactive-cli', membershipVersion: 1, runId: randomUUID(),
    client: 'codex', environmentId: randomUUID(), reportPath: join(f.root, 'cli-report.json') };
  await acquireNativeParticipant(f.home, desktop);
  await acquireNativeParticipant(f.home, cli, desktop);
  nativeOwners.push(desktop, cli);
  const input = f.input(), refresh = f.service.refresh(input);
  try {
    await Promise.race([entered.promise, refresh]);
    const { owner } = await readJSON(f.receipt(input.requestId));
    assert.equal(owner.membershipVersion, 1);
    assert.deepEqual(await readProfileOwners(f.home), [...nativeOwners, owner]);
  } finally { gate.resolve(); }
  assert.equal((await refresh).status, 'ready');
  assert.deepEqual(await readProfileOwners(f.home), nativeOwners);
});

test('an unverified Desktop reservation cannot be shared by a catalog probe', async t => {
  const f = await fixture(t, { observeAccess: async () => ({ status: 'ready', nativeOwners: [] }) });
  const owner = { kind: 'desktop-instance', runId: randomUUID(), profileId: f.profile.profileId,
    home: f.home, storePath: f.store.directory, host: hostname(), pid: process.pid };
  await acquireNativeParticipant(f.home, owner);
  await assert.rejects(f.service.refresh(f.input()), { code: 'catalog-profile-busy', status: 409 });
  assert.equal(f.calls(), 0);
  assert.deepEqual(await readProfileOwners(f.home), [owner]);
});

test('catalog reads and refreshes use the same selected repository through reconciliation', async t => {
  let f;
  const resolutions = [];
  f = await fixture(t, { allowUntrustedRepository: true, resolveProfile: async (_store, _name, options) => {
    resolutions.push(options);
    return { ...structuredClone(f.profile), bindingRepository: f.root };
  } });
  const input = f.input();
  assert.equal((await f.service.get(input)).status, 'unavailable');
  assert.equal((await f.service.refresh(input)).status, 'ready');
  assert.ok(resolutions.length > 2);
  assert.ok(resolutions.every(options => options.repository === f.root && options.allowUntrustedRepository));
  assert.equal(f.calls(), 1);
});

test('a concurrent refresh for the same scope reuses one probe and a queued request can cancel', async t => {
  const finish = deferred(), entered = deferred(); let f, calls = 0;
  f = await fixture(t, { discover: async () => {
    calls++; entered.resolve(); await finish.promise; return f.result();
  } });
  const running = f.service.refresh(f.input()); await entered.promise;
  const queued = f.input(), cancelled = f.service.refresh(queued);
  const expectedCancellation = assert.rejects(cancelled, { code: 'catalog-cancelled' });
  const follower = f.service.refresh(f.input());
  try {
    assert.equal((await f.service.cancel(queued)).status, 'cancelled');
    await expectedCancellation;
  } finally { finish.resolve(); }
  assert.equal((await running).status, 'ready');
  assert.equal((await follower).status, 'ready');
  assert.equal(calls, 1);
  await assert.rejects(access(f.lock), { code: 'ENOENT' });
});

test('cancellation after process startup joins discovery and releases only confirmed shutdown', async t => {
  for (const confirmed of [true, false]) {
    const entered = deferred(); let f;
    f = await fixture(t, { discover: async options => {
      await options.onSpawn(f.native); entered.resolve();
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return { ...f.result(), status: 'cancelled', process: { ...f.stopped, shutdown: { groupTerminated: confirmed } } };
    } });
    const input = f.input(), refresh = f.service.refresh(input); await entered.promise;
    assert.equal((await f.service.cancel(input)).status, confirmed ? 'cancelled' : 'uncertain'); await refresh;
    const saved = await readJSON(f.receipt(input.requestId));
    if (confirmed) { assert.equal(saved.released, true); await assert.rejects(access(f.lock), { code: 'ENOENT' }); }
    else { assert.equal(saved.released, undefined); assert.equal((await readJSON(join(f.lock, 'owner.json'))).runId, input.requestId); }
  }
});

test('shutdown receipt survives changed scope and reconciliation errors so confirmed claims release', async t => {
  for (const mode of ['changed', 'throw']) {
    let f, calls = 0;
    f = await fixture(t, { resolveProfile: async () => {
      calls++;
      if (calls < 4) return structuredClone(f.profile);
      if (mode === 'throw') throw new Error('reconciliation failed');
      const changed = structuredClone(f.profile); changed.environmentBinding.executable.identity = 'changed'; return changed;
    } });
    const input = f.input();
    if (mode === 'throw') await assert.rejects(f.service.refresh(input), /reconciliation failed/);
    else assert.equal((await f.service.refresh(input)).reason, 'catalog-context-changed');
    const saved = await readJSON(f.receipt(input.requestId));
    assert.equal(saved.shutdown.groupTerminated, true); assert.equal(saved.released, true);
    await assert.rejects(access(f.lock), { code: 'ENOENT' });
  }
});

test('failure before native discovery releases claim; ambiguous discovery failure preserves it', async t => {
  let f, resolutions = 0;
  f = await fixture(t, { resolveProfile: async () => {
    if (++resolutions === 3) throw new Error('pre-probe recheck failed'); return structuredClone(f.profile);
  } });
  await assert.rejects(f.service.refresh(f.input()), /pre-probe recheck failed/);
  await assert.rejects(access(f.lock), { code: 'ENOENT' });
  const uncertain = await fixture(t, { discover: async () => { throw new Error('ambiguous startup'); } });
  const input = uncertain.input(); await assert.rejects(uncertain.service.refresh(input), /ambiguous startup/);
  const saved = await readJSON(uncertain.receipt(input.requestId));
  assert.equal(saved.process, null); assert.equal(saved.released, undefined); await access(uncertain.lock);
});

test('restart cancellation only inspects and releases exact stopped owner, preserving uncertainty', async t => {
  for (const status of ['unknown', 'running', 'stopped']) {
    const f = await fixture(t, { discover: async options => {
      await options.onSpawn(f.native); return { ...f.result(), status: 'unavailable', process: { ...f.stopped, shutdown: { groupTerminated: false } } };
    } });
    const input = f.input(); await f.service.refresh(input);
    let inspected = 0;
    const restarted = createUiCatalog({ store: f.store, context: { ...f.context,
      discover: async () => assert.fail('recovery must not discover'),
      observeProcess: async identity => { inspected++; assert.deepEqual(identity, f.native.processIdentity); return { status }; } } });
    t.after(() => restarted.close());
    assert.equal((await restarted.cancel(input)).status, status === 'stopped' ? 'stopped' : 'uncertain');
    assert.equal(inspected, 1);
    if (status === 'stopped') await assert.rejects(access(f.lock), { code: 'ENOENT' }); else await access(f.lock);
  }
});

test('restart cancellation can still release an exact stopped legacy catalog reservation', async t => {
  const f = await fixture(t), input = f.input();
  await mkdir(join(f.store.directory, 'catalog-probes', input.requestId), { recursive: true, mode: 0o700 });
  const owner = { kind: 'catalog-probe', profileId: f.profile.profileId, runId: input.requestId, storePath: f.store.directory };
  await acquire(f.lock, owner, true);
  await record(f.receipt(input.requestId), { kind: 'xfx-catalog-probe', schemaVersion: 1, id: input.requestId,
    owner, root: f.home, environmentBinding: f.profile.environmentBinding, shutdown: { groupTerminated: true } });
  assert.equal((await f.service.cancel(input)).status, 'stopped');
  await assert.rejects(access(f.lock), { code: 'ENOENT' });
});


test('missing or empty workspace uses profile default cwd throughout scope reconciliation', async t => {
  for (const workspace of [undefined, '']) {
    let f; const options = [];
    f = await fixture(t, { resolveProfile: async (_store, _name, value) => {
      options.push(value); return { ...structuredClone(f.profile), bindingRepository: null };
    } });
    const input = { ...f.input(), workspace };
    assert.equal((await f.service.refresh(input)).status, 'ready');
    assert.ok(options.length >= 4);
    assert.ok(options.every(value => !Object.hasOwn(value, 'repository')));
  }
});
