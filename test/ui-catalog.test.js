import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiCatalog } from '../src/ui-catalog.js';
import { acquire, readJSON, record } from '../src/metadata.js';

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
  const f = await fixture(t); const owner = { kind: 'review-task', runId: randomUUID() };
  await acquire(f.lock, owner, true); const before = await readFile(join(f.lock, 'owner.json'));
  await assert.rejects(f.service.refresh(f.input()), /locked/);
  assert.deepEqual(await readFile(join(f.lock, 'owner.json')), before); assert.equal(f.calls(), 0);
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
