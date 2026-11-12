import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverCodexModels, readCodexModels, createClientCatalog, validateCatalogSelection, CATALOG_TTL_MS } from '../src/client-catalog.js';

const model = (name = 'new-model', efforts = ['low', 'max']) => ({ id: name, model: name, displayName: name,
  hidden: false, isDefault: true, supportedReasoningEfforts: efforts?.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
  defaultReasoningEffort: efforts?.[0] ?? null });
function context(root = '/fixture') {
  const profile = { executable: process.execPath, env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root }, launchArgs: [],
    environmentBinding: { client: 'codex', surface: 'cli', executionLocation: 'local', profileId: 'profile-one', rootMode: 'explicit',
      roots: { config: root, runtime: root, user: root, reservation: root }, workspace: root,
      executable: { path: process.execPath, identity: 'fixture-executable', version: null },
      settingsIdentity: { algorithm: 'sha256-file-stat-metadata-v1', digest: 'a'.repeat(64) } } };
  return { profile, workspace: root };
}
async function fixture(t, behavior = '') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-catalog-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const script = join(root, 'server.mjs');
  await writeFile(script, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const log=${JSON.stringify(join(root, 'methods.jsonl'))};
const models=${JSON.stringify([model(), model('sparse', ['max']), model('unknown', null)])};
let page=0, accountCalls=0;
for await (const line of createInterface({input:process.stdin})) {
 const message=JSON.parse(line); appendFileSync(log,JSON.stringify(message)+'\\n');
 ${behavior}
 if(message.method==='initialized') continue;
 let result={};
 if(message.method==='account/read') { accountCalls++; result={account:{type:'chatgpt',email:'fixture@example.test',planType:'plus'}}; }
 if(message.method==='model/list') result=page++===0?{data:models.slice(0,1),nextCursor:'opaque-cursor'}:{data:models.slice(1),nextCursor:null};
 process.stdout.write(JSON.stringify({id:message.id,result})+'\\n');
}
`, { mode: 0o600 });
  const c = context(root); c.profile.launchArgs = [script];
  return { ...c, root, stdoutPath: join(root, 'stdout.jsonl'), stderrPath: join(root, 'stderr.jsonl'),
    methods: async () => (await readFile(join(root, 'methods.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('owned catalog probe paginates without tasks, login, token refresh or policy changes and reaps', async t => {
  const f = await fixture(t);
  let spawned = null;
  const snapshot = await discoverCodexModels({ ...f, onSpawn: async owned => { spawned = owned; } });
  assert.equal(snapshot.status, 'ready');
  assert.equal(spawned.pid, snapshot.process.pid);
  assert.equal(snapshot.process.shutdown.groupTerminated, true);
  assert.equal(snapshot.models.length, 3);
  assert.deepEqual(snapshot.models[1].supportedReasoningEfforts.map(row => row.reasoningEffort), ['max']);
  assert.equal(snapshot.models[2].effortCapability, 'unknown');
  assert.equal(snapshot.scope.account.status, 'unverified');
  assert.equal(JSON.stringify(snapshot).includes('fixture@example.test'), false);
  const messages = await f.methods();
  assert.deepEqual(messages.map(row => row.method), ['initialize', 'initialized', 'account/read', 'model/list', 'model/list', 'account/read']);
  assert.ok(messages.filter(row => row.method === 'account/read').every(row => row.params.refreshToken === false));
  assert.equal(messages[4].params.cursor, 'opaque-cursor');
  assert.equal(validateCatalogSelection(snapshot, { model: 'sparse', reasoningEffort: 'max' }).status, 'unverified');
  assert.throws(() => validateCatalogSelection(snapshot, { model: 'sparse', reasoningEffort: 'xhigh' }), { code: 'catalog-effort-unavailable' });
  assert.throws(() => validateCatalogSelection(snapshot, { model: 'removed' }), { code: 'catalog-model-unavailable' });
  assert.throws(() => validateCatalogSelection(snapshot, { model: 'unknown', reasoningEffort: 'max' }), { code: 'catalog-effort-unavailable' });
  assert.equal(validateCatalogSelection(snapshot, {}).status, 'inherited');
});

test('aggregate effort capability preserves absent, empty and mixed native metadata', async t => {
  for (const [name, rows, expected] of [
    ['absent', [model('unknown', null)], 'unknown'],
    ['empty', [model('none', [])], 'unsupported'],
    ['mixed unknown', [model('none', []), model('unknown', null)], 'unknown'],
    ['advertised option', [model('unknown', null), model('option', ['low'])], 'supported'],
  ]) await t.test(name, async t => {
    const f = await fixture(t, `models.splice(0, models.length, ...${JSON.stringify(rows)});`);
    const snapshot = await discoverCodexModels(f);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.effort, expected);
    assert.equal(snapshot.process.shutdown.groupTerminated, true);
  });
});

test('native interaction, malformed replies, timeout and cancellation all reap the probe', async t => {
  for (const [name, behavior] of [
    ['request', `if(message.method==='initialize'){process.stdout.write(JSON.stringify({id:'approval',method:'item/commandExecution/requestApproval',params:{}})+'\\n');continue;}`],
    ['malformed', `if(message.method==='initialize'){process.stdout.write('not-json\\n');continue;}`],
    ['timeout', `if(message.method==='initialize'){await new Promise(()=>{});}`],
    ['cancel', `if(message.method==='initialize'){await new Promise(()=>{});}`],
  ]) {
    const f = await fixture(t, behavior), controller = new AbortController();
    const timer = name === 'cancel' ? setTimeout(() => controller.abort(), 60) : null;
    const snapshot = await discoverCodexModels({ ...f, signal: controller.signal, timeoutMs: 180 });
    if (timer) clearTimeout(timer);
    assert.notEqual(snapshot.status, 'ready', name);
    assert.equal(snapshot.process.shutdown.groupTerminated, true, name);
    assert.deepEqual(snapshot.models, [], name);
    if (name === 'cancel') assert.equal(snapshot.status, 'cancelled');
    if (name === 'timeout') assert.equal(snapshot.process.status, 'timeout');
    if (name === 'request') assert.equal(snapshot.reason, 'catalog-native-request');
    if (name === 'malformed') assert.equal(snapshot.reason, 'catalog-invalid-response');
    const methods = await f.methods();
    assert.ok(methods.every(row => ['initialize', 'initialized', 'account/read', 'model/list'].includes(row.method)));
  }
});

test('account changes during discovery prevent publication without retaining account details', async t => {
  const f = await fixture(t, `if(message.method==='account/read' && accountCalls>0){process.stdout.write(JSON.stringify({id:message.id,result:{account:{type:'chatgpt',email:'changed@example.test'}}})+'\\n');continue;}`);
  const snapshot = await discoverCodexModels(f);
  assert.equal(snapshot.status, 'unavailable');
  assert.equal(snapshot.reason, 'catalog-account-changed');
  assert.deepEqual(snapshot.models, []);
  assert.equal(JSON.stringify(snapshot.scope).includes('example.test'), false);
});

test('model schema preserves unknown and unsupported efforts and rejects malformed/cyclic pagination', async () => {
  const unknown = await readCodexModels(async () => ({ data: [model('unknown', null), model('none', [])], nextCursor: null }));
  assert.equal(unknown[0].effortCapability, 'unknown');
  assert.equal(unknown[1].effortCapability, 'unsupported');
  for (const response of [null, { data: [] }, { data: [model(), model()] },
    { data: [{ ...model(), supportedReasoningEfforts: ['max'] }] }, { data: [{ ...model(), id: 'bad\nID' }] }]) {
    await assert.rejects(readCodexModels(async () => response));
  }
  let n = 0;
  await assert.rejects(readCodexModels(async () => ({ data: [model(`model-${n++}`)], nextCursor: 'same' })), /Repeated/);
  n = 0;
  await assert.rejects(readCodexModels(async () => ({ data: [model(`model-${n}`)], nextCursor: `cursor-${n++}` })), { code: 'catalog-page-limit' });
});

function ready(c) { return { status: 'ready', scope: { environmentBinding: structuredClone(c.profile.environmentBinding),
  workspace: c.workspace, account: { status: 'unverified', type: 'chatgpt', id: null } },
  source: 'codex-model/list', models: [model()], discoveredAt: new Date(0).toISOString(), capabilities: { models: 'supported', effort: 'supported' } }; }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('cache reads never discover, expire after five minutes and invalidate account/settings/root scope', async () => {
  const c = context(); let clock = 1000, calls = 0;
  const cache = createClientCatalog({ now: () => clock, discover: async () => { calls++; return ready(c); } });
  assert.equal(cache.get(c), null); assert.equal(calls, 0);
  await cache.refresh(c); assert.equal(calls, 1);
  assert.equal(cache.get(c).status, 'ready');
  const copy = cache.get(c); copy.models.length = 0; assert.equal(cache.get(c).models.length, 1);
  for (const changed of [{ ...c, accountScope: 'other-account' }, { ...c, connectionGeneration: 2 },
    { ...c, profile: { ...c.profile, environmentBinding: { ...c.profile.environmentBinding, rootMode: 'implicit' } } }])
    assert.equal(cache.get(changed), null);
  clock += CATALOG_TTL_MS;
  assert.equal(cache.get(c).status, 'stale');
  assert.throws(() => validateCatalogSelection(cache.get(c), { model: 'new-model' }), { code: 'catalog-unavailable' });
  cache.invalidate(c); assert.equal(cache.get(c), null);
});

test('superseded refresh and changes during awaited reconciliation cannot publish late results', async () => {
  const c = context(), pending = [];
  const cache = createClientCatalog({ discover: async () => { const d = deferred(); pending.push(d); return d.promise; } });
  const first = cache.refresh(c); await Promise.resolve(); await Promise.resolve();
  const second = cache.refresh(c); await Promise.resolve(); await Promise.resolve();
  pending[1].resolve(ready(c)); assert.equal((await second).status, 'ready');
  pending[0].resolve(ready(c)); assert.equal((await first).reason, 'catalog-superseded');
  assert.equal(cache.get(c).generation, 2);
  const reconcile = deferred(); let resolutions = 0;
  const scoped = createClientCatalog({ discover: async () => ready(c), resolveContext: async value => ++resolutions === 1 ? value : reconcile.promise });
  const late = scoped.refresh(c); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  scoped.invalidate(c); reconcile.resolve(c);
  assert.equal((await late).reason, 'catalog-superseded'); assert.equal(scoped.get(c), null);
  const changed = createClientCatalog({ discover: async () => ready(c), resolveContext: async value => ({ ...value, accountScope: 'changed' }) });
  assert.equal((await changed.refresh(c)).reason, 'catalog-context-changed');
});


test('cache refuses a changed scope and cancellation after discovery or asynchronous reconciliation', async () => {
  const c = context(), d = deferred();
  const cache = createClientCatalog({ discover: async () => d.promise });
  const refresh = cache.refresh(c);
  await Promise.resolve(); await Promise.resolve();
  c.connectionGeneration = 2;
  d.resolve(ready(c));
  assert.equal((await refresh).reason, 'catalog-context-changed');
  assert.equal(cache.get(c), null);
  const controller = new AbortController();
  const cancelled = createClientCatalog({ discover: async () => { controller.abort(); return ready(c); } });
  assert.equal((await cancelled.refresh(c, { signal: controller.signal })).reason, 'catalog-cancelled');
  assert.equal(cancelled.get(c), null);
});


test('failed refresh retains unknown capability and the last successful age without validating revoked choices', async () => {
  const c = context(); let calls = 0;
  const cache = createClientCatalog({ discover: async () => ++calls === 1 ? ready(c)
    : { ...ready(c), status: 'unavailable', models: [], capabilities: { models: 'unknown', effort: 'unknown' }, reason: 'catalog-timeout' } });
  await cache.refresh(c); await cache.refresh(c);
  const current = cache.get(c);
  assert.equal(current.status, 'unavailable');
  assert.equal(current.capabilities.models, 'unknown');
  assert.equal(current.lastSuccessful.source, 'codex-model/list');
  assert.equal(current.lastSuccessful.discoveredAt, new Date(0).toISOString());
  assert.throws(() => validateCatalogSelection(current, { model: 'new-model' }), { code: 'catalog-unavailable' });
});
