import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { importCopilotTranscript } from '../src/copilot-transcript.js';
import { readCopilotJournal, assertCopilotImplicitEnvironment } from '../src/copilot-transcript-reader.mjs';
import { compareAuditRuns } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
const sessionId = '11111111-1111-4111-8111-111111111111';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const privateCanary = 'PRIVATE_REASONING_OPAQUE_LOGIN_SECRET';
const page = (events, extra = {}) => ({ events, cursor: 'cursor-one', cursorStatus: 'ok', hasMore: false, ...extra });
function events() {
  return [
    { id: 'start-event', type: 'session.start', timestamp: '2026-11-10T00:00:00Z', data: { sessionId, copilotVersion: '1.0.107', producer: 'desktop' } },
    { id: 'opaque-native-user', type: 'user.message', timestamp: '2026-11-10T00:00:01Z', data: { content: 'PUBLIC QUESTION', transformedContent: privateCanary, attachments: [{ content: privateCanary }] } },
    { id: 'opaque-native-assistant', type: 'assistant.message', timestamp: '2026-11-10T00:00:02Z', data: { content: 'PUBLIC ANSWER', model: 'observed-model', reasoningText: privateCanary, encryptedContent: privateCanary, opaque: privateCanary, toolRequests: [{ arguments: privateCanary }] } },
    { id: 'tool-event', type: 'tool.execution_complete', data: { content: privateCanary, output: privateCanary } },
    { type: 'session.resume', data: { content: privateCanary } },
    { type: 'session.shutdown', data: { content: privateCanary } },
  ];
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copilot-transcript-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, 'import') };
}
function reader(pages = [page(events())], mutate = value => value) {
  return async ({ directory, sessionId, signal }) => {
    let index = 0;
    const result = await readCopilotJournal(async params => { assert.equal(params.sessionId, sessionId); assert.equal(params.direction, 'forward'); assert.equal(params.max, 200); return pages[index++]; }, {
      sessionId, signal, savePage: (file, raw) => writeFile(join(directory, file), raw, { flag: 'wx', mode: 0o600 }),
    });
    return mutate({ ...result, sessionId, runtime: { version: '1.0.999-fixture', protocolVersion: 3, login: privateCanary }, shutdown: { sdkStopJoined: true, childrenClosed: true }, nativeOutputBytes: 0 });
  };
}

test('public SDK page import preserves native IDs/times and private raw evidence; no private fields reach report or source-loss reopen', async t => {
  const f = await fixture(t), run = await importCopilotTranscript({ sessionId }, { ...f, readJournal: reader() });
  assert.equal(run.status, 'partial'); assert.equal(run.profile.profileName, 'Imported Copilot'); assert.deepEqual(run.clientIdentity, { client: 'copilot' });
  for (const key of ['environmentBinding', 'nativeReference', 'usage', 'model', 'account', 'checks']) assert.equal(Object.hasOwn(run, key), false);
  assert.equal(run.source.kind, 'copilot-sdk-persisted-import'); assert.equal(run.source.decoder, '@github/copilot-sdk@1.0.29');
  assert.deepEqual(run.source.readerRuntime, { version: '1.0.999-fixture', protocolVersion: 3 });
  assert.deepEqual(run.source.observedModels, ['observed-model']);
  const raw = await readFile(join(f.directory, 'raw-page-01.json'));
  assert.equal(run.source.rawSourceSha256, sha(raw)); assert.match(raw.toString(), new RegExp(privateCanary));
  const projected = await readFile(join(f.directory, 'sdk-messages.jsonl'), 'utf8');
  assert.equal(run.source.projectionSha256, sha(projected)); assert.equal(projected.includes(privateCanary), false);
  assert.equal(JSON.stringify(run).includes(privateCanary), false);
  const replay = run.sessionReplay.sessions[0];
  assert.deepEqual(replay.events.map(x => x.itemId), ['opaque-native-user', 'opaque-native-assistant']);
  assert.deepEqual(replay.events.map(x => x.timestamp), ['2026-11-10T00:00:01.000Z', '2026-11-10T00:00:02.000Z']);
  assert.deepEqual(replay.events.map(x => x.turnId), [null, null]);
  assert.equal(replay.events[1].body, 'PUBLIC ANSWER'); assert.equal(replay.status, 'partial');
  assert.equal((await stat(f.directory)).mode & 0o077, 0); assert.equal((await stat(join(f.directory, 'raw-page-01.json'))).mode & 0o077, 0);
  const other = structuredClone(run); other.id = randomUUID();
  const comparison = compareAuditRuns(run, other);
  const spawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = () => assert.fail('Export/reopen must not start native processes');
  try {
    const exported = await exportAuditReport(comparison, { output: join(f.root, 'report.json'), includeReplayContent: true });
    await rm(f.directory, { recursive: true });
    const reopened = await readAuditReport(exported.evidencePath);
    assert.match(JSON.stringify(reopened), /PUBLIC ANSWER/); assert.equal(JSON.stringify(reopened).includes(privateCanary), false);
    assert.match(JSON.stringify(reopened), /opaque-native-assistant/);
  } finally { childProcess.ChildProcess.prototype.spawn = spawn; }
});

test('missing native IDs/timestamps remain unknown, only data.content text is selected', async t => {
  const f = await fixture(t), run = await importCopilotTranscript({ sessionId }, { ...f, readJournal: reader([page([
    { type: 'user.message', data: { content: 'PUBLIC TEXT' } },
    { type: 'assistant.message', data: { content: { type: 'text', text: privateCanary }, transformedContent: privateCanary } },
  ])]) });
  const [user, assistant] = run.sessionReplay.sessions[0].events;
  assert.equal(Object.hasOwn(user, 'itemId'), false); assert.equal(user.timestamp, null);
  assert.equal(assistant.body, null); assert.equal(assistant.bodyReason, 'non-text-content');
  assert.equal(JSON.stringify(run).includes(privateCanary), false);
});

test('cursor pagination is sequential, terminal only; expiry, reuse, caps and cancellation do not fall back', async () => {
  const calls = [], pages = [page([], { hasMore: true }), page(events(), { cursor: 'cursor-two' })];
  const result = await readCopilotJournal(async p => { calls.push(p); return pages[calls.length - 1]; }, { sessionId, savePage: async () => {} });
  assert.equal(result.complete, true); assert.equal(calls[0].cursor, undefined); assert.equal(calls[1].cursor, 'cursor-one');
  await assert.rejects(readCopilotJournal(async () => page([], { cursorStatus: 'expired' }), { sessionId, savePage: async () => {} }));
  await assert.rejects(readCopilotJournal(async () => page([], { hasMore: true }), { sessionId, savePage: async () => {} }));
  let count = 0;
  await assert.rejects(readCopilotJournal(async () => page([], { hasMore: true, cursor: `cursor-${++count}` }), { sessionId, savePage: async () => {} })); assert.equal(count, 8);
  await assert.rejects(readCopilotJournal(async () => page([{ type: 'assistant.message', data: { content: 'x'.repeat(8 * 1024 * 1024) } }]), { sessionId, savePage: async () => {} }));
  const controller = new AbortController(); controller.abort(); let read = false;
  await assert.rejects(readCopilotJournal(async () => { read = true; }, { sessionId, signal: controller.signal, savePage: async () => {} })); assert.equal(read, false);
  count = 0; await assert.rejects(readCopilotJournal(async () => { count++; throw new Error(privateCanary); }, { sessionId, savePage: async () => {} })); assert.equal(count, 1);
});

test('scope, malformed pages, hash mismatch, shutdown and private reader errors reject and roll back only owned directory', async t => {
  const cases = [
    reader([page([{ type: 'session.start', data: { sessionId: randomUUID() } }, ...events()])]),
    reader([page([...events(), { ...events()[1] }])]),
    reader([page(events())], value => ({ ...value, sessionId: randomUUID() })),
    reader([page(events())], value => ({ ...value, shutdown: { sdkStopJoined: true, childrenClosed: false } })),
    reader([page(events())], value => ({ ...value, pages: [{ ...value.pages[0], sha256: '0'.repeat(64) }] })),
    async () => { throw new Error(privateCanary); },
    async ({ directory }) => { await writeFile(join(directory, 'raw-page-01.json'), '{malformed', { mode: 0o600 }); return { complete: true, runtime: { version: '1.0.107', protocolVersion: 3 }, pages: [{ file: 'raw-page-01.json', bytes: 10, sha256: sha('{malformed') }], shutdown: { sdkStopJoined: true, childrenClosed: true } }; },
  ];
  for (const readJournal of cases) {
    const f = await fixture(t);
    await assert.rejects(importCopilotTranscript({ sessionId }, { ...f, readJournal }), error => !error.message.includes(privateCanary) && /Copilot/.test(error.message));
    await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  }
});

test('exclusive artifact admission and token rollback preserve preexisting or replaced foreign directories', async t => {
  const f = await fixture(t); await mkdir(f.directory, { mode: 0o700 }); await writeFile(join(f.directory, 'foreign'), 'keep');
  await assert.rejects(importCopilotTranscript({ sessionId }, { ...f, readJournal: reader() })); assert.equal(await readFile(join(f.directory, 'foreign'), 'utf8'), 'keep');
  const g = await fixture(t); let token;
  await assert.rejects(importCopilotTranscript({ sessionId }, { ...g, onArtifactCreated: value => { token = value; }, readJournal: async () => {
    await rename(g.directory, join(g.root, 'original')); await mkdir(g.directory, { mode: 0o700 }); await writeFile(join(g.directory, 'foreign'), 'keep'); throw new Error('reader failed');
  } }));
  assert.ok(token.dev !== undefined && token.ino !== undefined); assert.equal(await readFile(join(g.directory, 'foreign'), 'utf8'), 'keep');
});

test('implicit environment refuses auth/root/provider overrides including empty values', () => {
  assert.doesNotThrow(() => assertCopilotImplicitEnvironment({ HOME: userInfo().homedir, USER: 'same', LOGNAME: 'same' }));
  assert.throws(() => assertCopilotImplicitEnvironment({ HOME: '/unqualified-home' }));
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_HOME', 'COPILOT_DISABLE_KEYTAR', 'COPILOT_PROVIDERS_CONFIG', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_MODEL', 'COPILOT_PROVIDER_FUTURE_OPTION']) {
    for (const value of ['', 'fixture-override']) assert.throws(() => assertCopilotImplicitEnvironment({ [key]: value }));
  }
});

test('native import rejects provider-family overrides before spawning a client and rolls back its snapshot', async t => {
  const f = await fixture(t), key = `COPILOT_PROVIDER_XFX_TEST_${randomUUID().replaceAll('-', '_')}`;
  const spawn = childProcess.ChildProcess.prototype.spawn; let spawned = 0;
  childProcess.ChildProcess.prototype.spawn = () => { spawned++; assert.fail('Provider override must not reach native startup'); };
  process.env[key] = '';
  try {
    await assert.rejects(importCopilotTranscript({ sessionId }, f), /stored-session reader/);
    assert.equal(spawned, 0);
    await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  } finally { delete process.env[key]; childProcess.ChildProcess.prototype.spawn = spawn; }
});

test('actual pinned generated RPC routes the pure reader only to selected persisted-event reads', async () => {
  const spawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = () => assert.fail('RPC fixture must not start a native process');
  try {
    const url = import.meta.resolve('@github/copilot-sdk');
    const { createServerRpc } = await import(new URL('./generated/rpc.js', url));
    const calls = [];
    const rpc = createServerRpc({ sendRequest: async (method, params) => {
      assert.equal(method, 'sessions.readPersistedEvents'); calls.push({ method, params }); return page(events());
    } });
    const result = await readCopilotJournal(params => rpc.sessions.readPersistedEvents(params), { sessionId, savePage: async () => {} });
    assert.equal(result.complete, true); assert.deepEqual(calls, [{ method: 'sessions.readPersistedEvents', params: { sessionId, direction: 'forward', max: 200 } }]);
  } finally { childProcess.ChildProcess.prototype.spawn = spawn; }
});

test('session admission rejects coercible aliases without creating artifacts or invoking a reader', async t => {
  for (const selected of [[sessionId], { toString: () => sessionId }, undefined, null, 'not-a-session']) {
    const f = await fixture(t); let called = false;
    await assert.rejects(importCopilotTranscript({ sessionId: selected }, { ...f, readJournal: async () => { called = true; } }));
    assert.equal(called, false); await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  }
});
