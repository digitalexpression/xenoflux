import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'smol-toml';
import { Store, bind, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { hostname } from 'node:os';
import { validateAuditSpec } from '../src/audit-spec.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { auditSettingsIdentity, compareAuditProfileSettings, observeAuditProfileIdle, resolveAuditExecutionProfile,
  snapshotAuditProfileSettings, parseNativeResourceResult, observeAuditProfileAccess, inspectNativeResources } from '../src/audit-profile.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-profile-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const native = await prepareNativeHome({ directory: join(root, 'native'), executable, codexVersion: '0.162.0' });
  const repository = join(root, 'repo'); await mkdir(repository, { mode: 0o700 });
  const store = new Store(join(root, 'store'));
  await store.update(data => { const profile = create(data, 'Research'); profile.repositories.push({ path: repository }); });
  await registerHome(store, 'Research', native.root, { executable, version: '0.162.0' });
  const profileStore = await readFile(store.file);
  return { root, executable, native, repository, store, profileStore };
}

test('named execution profile reuses the bound home and keeps only approved environment variables', async t => {
  const f = await fixture(t);
  const profile = await resolveAuditExecutionProfile(f.store, 'Research', { repository: f.repository });
  assert.equal(profile.profileName, 'Research');
  assert.equal(profile.profileId, (await f.store.read()).profiles[0].id);
  assert.equal(profile.home, f.native.home);
  assert.equal(profile.userHome, f.native.userHome);
  assert.equal(profile.nativeRoot, f.native.root);
  assert.equal(profile.reservationRoot, f.native.root);
  assert.equal(profile.environmentId, (await f.store.read()).profiles[0].native.environmentId);
  assert.equal(profile.bindingRepository, f.repository);
  assert.equal(profile.executable, f.executable);
  assert.equal(profile.version, '0.162.0');
  assert.equal(profile.env.CODEX_HOME, f.native.home);
  assert.equal(profile.env.CODEX_SQLITE_HOME, f.native.home);
  assert.equal(profile.env.HOME, f.native.userHome);
  assert.deepEqual(Object.keys(profile.env).sort(), ['CODEX_HOME', 'CODEX_SQLITE_HOME', 'HOME', 'PATH', 'TEMP', 'TMP', 'TMPDIR'].sort());
  const other = join(f.root, 'other'); await mkdir(other, { mode: 0o700 });
  await assert.rejects(resolveAuditExecutionProfile(f.store, 'Research', { repository: other }), { code: 'profile-repository-unbound' });
  assert.deepEqual(await readFile(f.store.file), f.profileStore);
});

test('per-trial executable override is validated and never changes the saved native binding', async t => {
  const f = await fixture(t), alternate = join(f.root, 'codex-alt');
  await writeFile(alternate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const profile = await resolveAuditExecutionProfile(f.store, { name: 'Research', executable: alternate, version: '0.163.1', skills: ['review-helper'] },
    { repository: f.repository, probe: async () => null });
  assert.equal(profile.executable, alternate);
  assert.equal(profile.version, null);
  assert.equal(profile.executableSource, 'explicit-per-trial');
  assert.equal(profile.versionSource, 'unavailable');
  assert.equal(profile.requestedVersion, '0.163.1');
  assert.deepEqual(profile.skills, ['review-helper']);
  assert.deepEqual(await readFile(f.store.file), f.profileStore);
  await writeFile(alternate, '#!/bin/sh\nprintf "codex-cli 99.1.0\\n"\n', { mode: 0o700 });
  const observed = await resolveAuditExecutionProfile(f.store, { name: 'Research', executable: alternate },
    { repository: f.repository, probe: async () => '99.1.0' });
  assert.equal(observed.version, '99.1.0');
  assert.equal(observed.versionSource, 'observed');
  assert.deepEqual(await readFile(f.store.file), f.profileStore);
  const spec = validateAuditSpec({ schemaVersion: 1, repository: f.repository, revision: 'HEAD', task: 'Fixture',
    profiles: [{ name: 'Research', executable: alternate }, { name: 'Other', executable: alternate }] });
  assert.equal(Object.hasOwn(spec.profiles[0], 'version'), false);
  await assert.rejects(resolveAuditExecutionProfile(f.store, { name: 'Research', executable: f.repository, version: '0.1.0' }, { repository: f.repository }), /regular file/);
});

test('explicit executable version probing propagates unsafe shutdown and cancellation', async t => {
  const f = await fixture(t), alternate = join(f.root, 'codex-alt');
  await writeFile(alternate, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  for (const code of ['SHUTDOWN_FAILED', 'CANCELLED']) {
    const failure = Object.assign(new Error('private probe detail'), { code });
    await assert.rejects(resolveAuditExecutionProfile(f.store, { name: 'Research', executable: alternate },
      { repository: f.repository, probe: async () => { throw failure; } }), error => error === failure);
  }
});

test('native config overrides are narrowly validated, normalized, and retained per execution profile', async t => {
  const f = await fixture(t);
  const nativeConfig = { forced_login_method: 'chatgpt', plan_mode_reasoning_effort: 'low', model_reasoning_effort: 'low' };
  const spec = validateAuditSpec({ schemaVersion: 1, repository: f.repository, revision: 'HEAD', task: 'Fixture',
    profiles: [{ name: 'Research', nativeConfig }, { name: 'Other' }] });
  assert.deepEqual(spec.profiles[0].nativeConfig, { forced_login_method: 'chatgpt', model_reasoning_effort: 'low', plan_mode_reasoning_effort: 'low' });
  const profile = await resolveAuditExecutionProfile(f.store, spec.profiles[0], { repository: f.repository });
  assert.deepEqual(profile.nativeConfig, spec.profiles[0].nativeConfig);
  assert.deepEqual(await readFile(f.store.file), f.profileStore);
  for (const bad of [{ model_reasoning_effort: 'turbo' }, { forced_login_method: 'other' }, { profile: 'changed' }, { model: '' }]) {
    assert.throws(() => validateAuditSpec({ schemaVersion: 1, repository: f.repository, revision: 'HEAD', task: 'Fixture',
      profiles: [{ name: 'Research', nativeConfig: bad }, { name: 'Other' }] }));
  }
});

test('Default needs an existing trusted repository entry and explicit executable', async t => {
  const f = await fixture(t), userHome = join(f.root, 'user');
  await mkdir(userHome, { mode: 0o700 });
  const home = join(userHome, '.codex'); await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'config.toml'), `${stringify({ projects: { [f.repository]: { trust_level: 'trusted' } } })}\n`, { mode: 0o600 });
  await writeFile(join(home, 'auth.json'), '{"token":"must-not-be-read-or-returned"}\n', { mode: 0o600 });
  const input = { name: 'Default', executable: f.executable, version: '0.162.0' };
  const profile = await resolveAuditExecutionProfile(f.store, input, { repository: f.repository, defaultUserHome: userHome });
  assert.equal(profile.profileId, 'default');
  assert.equal(profile.profileName, 'Default');
  assert.equal(profile.home, home);
  assert.equal(profile.userHome, userHome);
  assert.equal(profile.nativeRoot, null);
  assert.equal(profile.reservationRoot, home);
  assert.equal(profile.bindingRepository, f.repository);
  assert.equal(profile.env.CODEX_HOME, home);
  assert.equal(profile.env.OPENAI_API_KEY, undefined);
  await assert.rejects(resolveAuditExecutionProfile(f.store, 'Default', { repository: f.repository, defaultUserHome: userHome }), /explicit Codex executable/);
  await writeFile(join(home, 'config.toml'), `${stringify({ projects: { [f.repository]: { trust_level: 'untrusted' } } })}\n`, { mode: 0o600 });
  await assert.rejects(resolveAuditExecutionProfile(f.store, input, { repository: f.repository, defaultUserHome: userHome }), /existing trusted repository entry/);
});

test('idle observation is targeted, treats a lock or open resources as busy, and failures as unknown', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const inspected = [];
  assert.deepEqual(await observeAuditProfileIdle(profile, { inspectResources: async paths => { inspected.push(paths); return []; } }), { status: 'idle' });
  assert.deepEqual(inspected[0].map(path => path.split('/').at(-1)), ['config.toml']);
  assert.deepEqual(await observeAuditProfileIdle(profile, { inspectResources: async () => [123] }), { status: 'busy', reason: 'profile-files-open' });
  assert.deepEqual(await observeAuditProfileIdle(profile, { inspectResources: async () => { throw new Error('denied'); } }), { status: 'unknown', reason: 'resource-inspection-failed' });
  await mkdir(join(profile.reservationRoot, '.run-lock'), { mode: 0o700 });
  assert.deepEqual(await observeAuditProfileIdle(profile), { status: 'busy', reason: 'profile-reservation-present' });
  const owner = { runId: 'run-1', experimentId: 'exp-1', profileId: profile.profileId };
  await writeFile(join(profile.reservationRoot, '.run-lock', 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  let postReservationInspection = 0;
  assert.deepEqual(await observeAuditProfileIdle(profile, { reservationOwner: { ...owner, runId: 'other-run' },
    inspectResources: async () => { postReservationInspection += 1; return []; } }),
  { status: 'busy', reason: 'profile-reservation-present' });
  assert.equal(postReservationInspection, 0);
  assert.deepEqual(await observeAuditProfileIdle(profile, { reservationOwner: owner,
    inspectResources: async paths => { postReservationInspection += 1; assert.ok(paths.length); return []; } }), { status: 'idle' });
  assert.equal(postReservationInspection, 1);
  await rm(join(profile.reservationRoot, '.run-lock'), { recursive: true });
  await symlink(f.native.home, join(f.native.home, 'state_5.sqlite'));
  assert.deepEqual(await observeAuditProfileIdle(profile), { status: 'unknown', reason: 'resource-inspection-failed' });
});

test('native lsof file descriptor rows parse and nonempty exit-1 output remains busy evidence', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const target = join(profile.home, 'config.toml');
  const rows = `p123\nccodex\nu${process.getuid()}\nf cwd\nn${target}\nf 4r\nn${target}\n`;
  const complete = parseNativeResourceResult(rows, [target]);
  assert.deepEqual(complete, { pids: [123], records: 1, clients: [{ pid: 123, command: 'codex', uid: process.getuid(), paths: [target] }], partial: false });
  const partial = parseNativeResourceResult(rows, [target], { exitCode: 1, stderr: '' });
  assert.deepEqual(partial, { ...complete, partial: true });
  assert.deepEqual(await observeAuditProfileIdle(profile, { inspectResources: async () => partial }),
    { status: 'busy', reason: 'profile-files-open' });
  assert.deepEqual(parseNativeResourceResult('', [target], { exitCode: 1, stderr: '' }),
    { pids: [], records: 0, clients: [], partial: false });
  assert.throws(() => parseNativeResourceResult(`${rows}unsupported\n`, [target], { exitCode: 1, stderr: '' }));
  assert.throws(() => parseNativeResourceResult(rows, [target], { exitCode: 1, stderr: 'permission warning' }));
  assert.deepEqual(await observeAuditProfileIdle(profile, { inspectResources: async () => { throw new Error('malformed result'); } }),
    { status: 'unknown', reason: 'resource-inspection-failed' });
});

test('native resource inspection queries each existing path independently and rejects ambiguous rows', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const paths = [join(profile.home, 'config.toml'), join(profile.home, 'auth.json')], calls = [];
  const safeRow = `p123\nccodex\nu${process.getuid()}\nf 4r\nn${paths[0]}\n`;
  const observed = await inspectNativeResources(paths, { runExecFile: async (_file, args) => {
    const path = args.at(-1); calls.push(path);
    if (path === paths[1]) throw Object.assign(new Error(), { code: 1, stdout: '', stderr: '' });
    return { stdout: safeRow, stderr: '' };
  } });
  assert.deepEqual(calls, paths);
  assert.deepEqual(observed, { pids: [123], records: 1,
    clients: [{ pid: 123, command: 'codex', uid: process.getuid(), paths: [paths[0]] }], partial: false });
  await assert.rejects(inspectNativeResources([paths[0]], { runExecFile: async () => {
    throw Object.assign(new Error(), { code: 1, stdout: safeRow, stderr: '' });
  } }), /inspection failed/);
});

test('native access allows open resources and reports stable client identities without touching settings', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const resource = join(profile.home, 'config.toml'), beforeConfig = await readFile(resource);
  const client = { pid: 811, ppid: 1, uid: process.getuid(), startedAt: 'Thu Oct 15 10:00:00 2026 UTC', executable: '/Applications/Codex.app/Contents/MacOS/Codex' };
  const inspectResources = async paths => ({ pids: paths.includes(resource) ? [client.pid] : [], records: 1,
    clients: [{ pid: client.pid, command: 'Codex', uid: client.uid, paths: [resource] }], partial: false });
  const first = await observeAuditProfileAccess(profile, { store: f.store, inspectResources, processSnapshot: async () => [client] });
  const second = await observeAuditProfileAccess(profile, { store: f.store, expectedClients: first.clients,
    inspectResources: async () => ({ pids: [], records: 0, clients: [], partial: false }), processSnapshot: async () => [client] });
  assert.equal(first.status, 'ready');
  assert.deepEqual(first.clients, [client]);
  assert.deepEqual(second.clients, first.clients);
  assert.equal(first.sourceReservation, null);
  assert.deepEqual(await readFile(resource), beforeConfig);
  assert.deepEqual(await readFile(f.store.file), f.profileStore);
});

test('Default home may use the existing non-writable 0755 directory mode', async t => {
  const f = await fixture(t), home = join(f.root, 'default-home');
  await mkdir(home, { mode: 0o755 });
  const result = await observeAuditProfileAccess({ profileId: 'default', home, reservationRoot: home, nativeRoot: null }, {
    store: f.store, inspectResources: async () => ({ pids: [], records: 0, clients: [], partial: false }),
    processSnapshot: async () => [],
  });
  assert.equal(result.status, 'ready');
});

test('access trusts a matching running desktop journal even when its creator PID is gone', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const desktopRoot = join(f.store.directory, 'desktop-instances'); await mkdir(desktopRoot, { mode: 0o700 });
  const journalPath = join(desktopRoot, `${profile.profileId}.json`), runId = '11111111-2222-4333-8444-555555555555';
  const owner = { kind: 'desktop-instance', host: hostname(), pid: 987654, runId, storePath: f.store.directory,
    profileId: profile.profileId, journalPath };
  const identity = { pid: 811, ppid: 1, uid: process.getuid(), startedAt: 'Thu Oct 15 10:00:00 2026 UTC', executable: '/Applications/Codex.app/Contents/MacOS/Codex' };
  const staleHelper = { ...identity, pid: identity.pid + 1, executable: '/Users/test/desktop-helper' };
  const state = { schemaVersion: 1, kind: 'desktop-instance', profileId: profile.profileId, runId, owner, phase: 'running',
    plan: { profileId: profile.profileId, nativeRoot: profile.nativeRoot, home: profile.home }, main: identity, processes: [identity, staleHelper] };
  await writeFile(journalPath, JSON.stringify(state), { mode: 0o600 });
  const lockPath = join(profile.reservationRoot, '.run-lock'); await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  const check = await observeAuditProfileAccess(profile, { store: f.store,
    inspectResources: async paths => ({ pids: paths.includes(join(profile.home, 'config.toml')) ? [identity.pid] : [], records: 1,
      clients: [], partial: false }), processSnapshot: async () => [identity] });
  assert.equal(check.status, 'ready');
  assert.deepEqual(check.clients, [identity]);
  assert.deepEqual(check.sourceReservation, { kind: 'desktop-instance', runId, profileId: profile.profileId,
    host: hostname(), journalPath, phase: 'running' });
  const foreignClient = { ...identity, pid: identity.pid + 1 };
  const mismatch = await observeAuditProfileAccess(profile, { store: f.store,
    inspectResources: async () => ({ pids: [foreignClient.pid], records: 1, clients: [], partial: false }),
    processSnapshot: async () => [identity, foreignClient] });
  assert.equal(mismatch.status, 'blocked');
  assert.equal(mismatch.reason, 'unattributed-native-client');
  assert.deepEqual(JSON.parse(await readFile(join(lockPath, 'owner.json'))), owner);
});

test('access tolerates an unchanged valid stale desktop reservation only when all owned processes and resource holders are absent', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const desktopRoot = join(f.store.directory, 'desktop-instances'); await mkdir(desktopRoot, { mode: 0o700 });
  const journalPath = join(desktopRoot, `${profile.profileId}.json`), runId = '11111111-2222-4333-8444-555555555556';
  const owner = { kind: 'desktop-instance', host: hostname(), pid: 987654, runId, storePath: f.store.directory,
    profileId: profile.profileId, journalPath };
  const identity = { pid: 987653, ppid: 1, uid: process.getuid(), startedAt: 'Tue Oct 13 05:48:25 2026 UTC', executable: '/Users/test/Codex.app/Contents/MacOS/ChatGPT' };
  const helper = { ...identity, pid: 987652, executable: '/Users/test/desktop-helper' };
  const state = { schemaVersion: 1, kind: 'desktop-instance', profileId: profile.profileId, runId, owner, phase: 'running',
    plan: { profileId: profile.profileId, nativeRoot: profile.nativeRoot, home: profile.home }, main: identity, processes: [identity, helper] };
  const journalBytes = Buffer.from(JSON.stringify(state)); await writeFile(journalPath, journalBytes, { mode: 0o600 });
  const lockPath = join(profile.reservationRoot, '.run-lock'); await mkdir(lockPath, { mode: 0o700 });
  const ownerBytes = Buffer.from(JSON.stringify(owner)); await writeFile(join(lockPath, 'owner.json'), ownerBytes, { mode: 0o600 });
  const inspectResources = async () => ({ pids: [], records: 0, clients: [], partial: false });
  const stale = await observeAuditProfileAccess(profile, { store: f.store, inspectResources, processSnapshot: async () => [] });
  assert.equal(stale.status, 'ready');
  assert.deepEqual(stale.clients, []);
  assert.equal(stale.sourceReservation.phase, 'stopped-owner-observed');
  assert.deepEqual(await readFile(journalPath), journalBytes);
  assert.deepEqual(await readFile(join(lockPath, 'owner.json')), ownerBytes);

  const liveHelper = helper;
  const blocked = await observeAuditProfileAccess(profile, { store: f.store, inspectResources,
    processSnapshot: async () => [liveHelper] });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'desktop-main-not-live');
  assert.deepEqual(await readFile(journalPath), journalBytes);
  assert.deepEqual(await readFile(join(lockPath, 'owner.json')), ownerBytes);
});

test('access returns unavailable when desktop process identities change during observation', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const desktopRoot = join(f.store.directory, 'desktop-instances'); await mkdir(desktopRoot, { mode: 0o700 });
  const journalPath = join(desktopRoot, `${profile.profileId}.json`), runId = '11111111-2222-4333-8444-555555555557';
  const owner = { kind: 'desktop-instance', host: hostname(), pid: 987654, runId, storePath: f.store.directory,
    profileId: profile.profileId, journalPath };
  const identity = { pid: 987653, ppid: 1, uid: process.getuid(), startedAt: 'Tue Oct 13 05:48:25 2026 UTC', executable: '/Users/test/Codex.app/Contents/MacOS/ChatGPT' };
  const nextIdentity = { ...identity, pid: identity.pid + 1, startedAt: 'Wed Oct 14 05:48:25 2026 UTC' };
  const state = { schemaVersion: 1, kind: 'desktop-instance', profileId: profile.profileId, runId, owner, phase: 'running',
    plan: { profileId: profile.profileId, nativeRoot: profile.nativeRoot, home: profile.home }, main: identity, processes: [identity] };
  const journalBytes = Buffer.from(JSON.stringify(state)); await writeFile(journalPath, journalBytes, { mode: 0o600 });
  const lockPath = join(profile.reservationRoot, '.run-lock'); await mkdir(lockPath, { mode: 0o700 });
  const ownerBytes = Buffer.from(JSON.stringify(owner)); await writeFile(join(lockPath, 'owner.json'), ownerBytes, { mode: 0o600 });
  const changed = { ...state, main: nextIdentity, processes: [nextIdentity] };
  const changedBytes = Buffer.from(JSON.stringify(changed));
  const result = await observeAuditProfileAccess(profile, { store: f.store,
    inspectResources: async () => ({ pids: [], records: 0, clients: [], partial: false }),
    processSnapshot: async () => { await writeFile(journalPath, changedBytes, { mode: 0o600 }); return []; } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'profile-access-inspection-failed');
  assert.deepEqual(await readFile(journalPath), changedBytes);
  assert.deepEqual(await readFile(join(lockPath, 'owner.json')), ownerBytes);
});

test('foreign or malformed profile reservations remain blocked and are never reclaimed', async t => {
  const f = await fixture(t), profile = await resolveAuditExecutionProfile(f.store, 'Research');
  const lockPath = join(profile.reservationRoot, '.run-lock'); await mkdir(lockPath, { mode: 0o700 });
  const ownerPath = join(lockPath, 'owner.json'), foreign = { kind: 'audit-experiment', pid: process.pid };
  await writeFile(ownerPath, JSON.stringify(foreign), { mode: 0o600 });
  const blocked = await observeAuditProfileAccess(profile, { store: f.store, inspectResources: async () => assert.fail('foreign lock should stop preflight') });
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(JSON.parse(await readFile(ownerPath)), foreign);
  await writeFile(ownerPath, '{malformed', { mode: 0o600 });
  const malformed = await observeAuditProfileAccess(profile, { store: f.store });
  assert.equal(malformed.status, 'blocked');
  assert.equal(await readFile(ownerPath, 'utf8'), '{malformed');
});

test('settings snapshots compare bounded metadata without exposing fingerprints or reading source bodies', async t => {
  const f = await fixture(t);
  const settings = join(f.native.home, 'AGENTS.md');
  await writeFile(settings, 'private guidance body\n', { mode: 0o600 });
  const beforeBytes = await readFile(settings), beforeStore = await readFile(f.store.file);
  const before = await snapshotAuditProfileSettings({ home: f.native.home, userHome: f.native.userHome });
  assert.equal(before.status, 'ready');
  assert.equal(before.persistence, 'process-local');
  assert.doesNotMatch(JSON.stringify(before), /private guidance|[a-f0-9]{64}/i);
  assert.deepEqual(compareAuditProfileSettings({ ...before }, before), { status: 'unavailable', changedPaths: [] });
  assert.deepEqual(compareAuditProfileSettings(before, await snapshotAuditProfileSettings({ home: f.native.home, userHome: f.native.userHome })),
    { status: 'unchanged', changedPaths: [] });
  await writeFile(settings, 'changed private guidance body\n', { mode: 0o600 });
  assert.deepEqual(compareAuditProfileSettings(before, await snapshotAuditProfileSettings({ home: f.native.home, userHome: f.native.userHome })),
    { status: 'changed', changedPaths: ['$CODEX_HOME/AGENTS.md'] });
  assert.deepEqual(await readFile(f.store.file), beforeStore);
  assert.notDeepEqual(await readFile(settings), beforeBytes);
  const authPath = join(f.native.home, 'auth.json');
  await writeFile(authPath, '{"private":"auth-before"}', { mode: 0o600 });
  const beforeAuth = await snapshotAuditProfileSettings({ home: f.native.home, userHome: f.native.userHome });
  await writeFile(authPath, '{"private":"auth-after-longer"}', { mode: 0o600 });
  const afterAuth = await snapshotAuditProfileSettings({ home: f.native.home, userHome: f.native.userHome });
  assert.deepEqual(compareAuditProfileSettings(beforeAuth, afterAuth), { status: 'changed', changedPaths: ['$CODEX_HOME/auth.json'] });
  assert.doesNotMatch(JSON.stringify([beforeAuth, afterAuth]), /auth-before|auth-after/);
  await assert.rejects(access(join(f.native.root, '.run-lock')), { code: 'ENOENT' });
});

test('persistable settings identity is stable for matching metadata and unavailable for copied snapshots', async t => {
  const f = await fixture(t), profile = { home: f.native.home, userHome: f.native.userHome };
  const first = await snapshotAuditProfileSettings(profile), second = await snapshotAuditProfileSettings(profile);
  assert.equal(first.status, 'ready');
  assert.deepEqual(auditSettingsIdentity(first), auditSettingsIdentity(second));
  assert.equal(auditSettingsIdentity({ ...first }), null);

  const source = join(f.native.home, 'AGENTS.md');
  await writeFile(source, 'version one\n', { mode: 0o600 });
  const before = await snapshotAuditProfileSettings(profile);
  const beforeIdentity = auditSettingsIdentity(before);
  await writeFile(source, 'version two has different size\n', { mode: 0o600 });
  const after = await snapshotAuditProfileSettings(profile);
  assert.notDeepEqual(auditSettingsIdentity(after), beforeIdentity);
  assert.doesNotMatch(JSON.stringify([before, after, beforeIdentity, auditSettingsIdentity(after)]), /version one|version two/);
});

test('settings snapshots fingerprint bounded internal and external skill packages and reject broad, cyclic, or unsafe links', async t => {
  const f = await fixture(t), profile = { home: f.native.home, userHome: f.native.userHome, nativeRoot: f.native.root };
  const packageRoot = join(f.native.root, 'skill-packages', 'review-helper');
  await mkdir(packageRoot, { recursive: true, mode: 0o700 });
  const instructions = join(packageRoot, 'SKILL.md');
  await writeFile(instructions, 'private skill instructions\n', { mode: 0o600 });
  const homeSkills = join(f.native.userHome, '.agents', 'skills');
  await mkdir(homeSkills, { recursive: true, mode: 0o700 });
  const alias = join(homeSkills, 'review-helper');
  await symlink(packageRoot, alias);
  const before = await snapshotAuditProfileSettings(profile);
  assert.equal(before.status, 'ready');
  await writeFile(instructions, 'changed private skill instructions\n', { mode: 0o600 });
  const after = await snapshotAuditProfileSettings(profile);
  assert.equal(after.status, 'ready');
  assert.deepEqual(compareAuditProfileSettings(before, after),
    { status: 'changed', changedPaths: ['$HOME/.agents/skills/review-helper/SKILL.md'] });

  const cycle = join(packageRoot, 'cycle');
  await symlink(packageRoot, cycle);
  const cyclic = await snapshotAuditProfileSettings(profile);
  assert.equal(cyclic.status, 'unavailable');
  assert.equal(cyclic.reason, 'settings-symlink-cycle');
  await rm(cycle);

  const outsidePackage = await mkdtemp(join(tmpdir(), 'xfx-shared-skill-'));
  t.after(() => rm(outsidePackage, { recursive: true, force: true }));
  const outsideSkill = join(outsidePackage, 'SKILL.md');
  await writeFile(outsideSkill, 'shared skill instructions\n', { mode: 0o444 });
  await chmod(outsidePackage, 0o555);
  const externalAlias = join(homeSkills, 'external-package');
  await symlink(outsidePackage, externalAlias);
  const external = await snapshotAuditProfileSettings(profile);
  assert.equal(external.status, 'ready');
  await chmod(outsideSkill, 0o644);
  await writeFile(outsideSkill, 'changed shared skill instructions\n', { mode: 0o644 });
  const externalChanged = await snapshotAuditProfileSettings(profile);
  assert.equal(externalChanged.status, 'ready');
  assert.deepEqual(compareAuditProfileSettings(external, externalChanged),
    { status: 'changed', changedPaths: ['$HOME/.agents/skills/external-package/SKILL.md'] });
  await rm(externalAlias);
  await chmod(outsidePackage, 0o700);

  const broadTarget = f.root;
  await writeFile(join(broadTarget, 'SKILL.md'), 'broad marker\n', { mode: 0o600 });
  const broadAlias = join(homeSkills, 'broad-skill');
  await symlink(broadTarget, broadAlias);
  const broad = await snapshotAuditProfileSettings(profile);
  assert.equal(broad.status, 'unavailable');
  assert.equal(broad.reason, 'settings-symlink-outside-authorized-roots');
  await rm(broadAlias);

  const unsafePackage = join(f.native.root, 'unsafe-package');
  await mkdir(unsafePackage, { mode: 0o777 });
  await chmod(unsafePackage, 0o777);
  await symlink(unsafePackage, externalAlias);
  const unsafe = await snapshotAuditProfileSettings(profile);
  assert.equal(unsafe.status, 'unavailable');
  assert.equal(unsafe.reason, 'settings-symlink-target-unsafe');
});
