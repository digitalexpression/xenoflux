import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createManagedDesktop } from '../src/managed-desktop.js';
import { Store, create } from '../src/profiles.js';
import { acquire, readJSON, record } from '../src/metadata.js';
import { recoverProfileRun } from '../src/profile-recovery.js';

async function fixture(t, vendor = 'copilot') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copilot-desktop-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = new Store(join(base, 'store')), root = join(base, 'profile'), configRoot = join(root, 'config');
  for (const path of [root, configRoot, join(root, 'workspace')]) await mkdir(path, { mode: 0o700 });
  const profile = await store.update(data => {
    const selected = create(data, 'Copilot A', '', 'codex');
    selected.client = vendor === 'claude' ? 'claude-code' : 'copilot';
    selected.native = { root, configRoot, rootMode: 'explicit', environmentId: randomUUID(),
      executable: '/missing/copilot', executableIdentity: '[1,2,3,4,5]', version: '1.0.1' };
    return selected;
  });
  const app = { status: 'available', appKey: 'a'.repeat(64), path: join(base, 'Copilot.app'),
    executable: join(base, vendor === 'claude' ? 'Copilot.app/Contents/MacOS/Claude' : 'Copilot.app/Contents/MacOS/github') };
  const main = { pid: 99999, ppid: 1, uid: process.getuid(), startedAt: 'Fri Nov 13 10:00:00 2026 UTC', executable: app.executable };
  let rows = [], holder = false, busy = false, opened = 0, failOpen = false, installs = 0, checks = 0;
  const runtime = {
    async snapshot() { return structuredClone(rows); },
    async assertResourcesIdle(paths, { allowedProcesses = [] } = {}) {
      assert.equal(new Set(allowedProcesses.map(row => row.pid)).size, allowedProcesses.length,
        'native resource observations require unique process identities');
      checks++;
      if (busy) throw new Error('RESOURCE_BUSY');
      const processes = holder ? rows.filter(row => row.pid === (vendor === 'claude' ? main.pid - 1 : main.pid)) : [];
      if (processes.some(row => !allowedProcesses.some(allowed => allowed.pid === row.pid && allowed.startedAt === row.startedAt && allowed.executable === row.executable)))
        throw new Error('RESOURCE_BUSY');
      return { idle: true, processes };
    },
  };
  let key = app.appKey;
  const stockApps = { async binding(input) {
    installs++;
    if (input.client !== vendor || input.appKey !== key) throw new Error('app identity changed');
    return { ...app };
  } };
  const calls = [];
  const deps = { stockApps, runtime, lockOptions: { lockPath: join(base, 'control') },
    nativeUser: { homedir: base, username: 'fixture' }, environment: { HOME: base, USER: 'fixture', LOGNAME: 'fixture' },
    openTimeoutMs: 2, pollIntervalMs: 1,
    async execFile(command, args, options) {
      calls.push({ command, args, options }); opened++;
      if (failOpen) throw new Error('open failed');
      await writeFile(vendor === 'claude' ? join(root, 'desktop/Cookies') : join(configRoot, 'data.db'), 'fixture database is never read', { mode: 0o600 });
      rows = [...rows, main, ...(vendor === 'claude' ? [{ ...main, pid: main.pid - 1, ppid: main.pid, executable: `${app.path}/renderer` }] : [])]; holder = true;
      return { stdout: '', stderr: '' };
    } };
  const owner = createManagedDesktop(store, deps);
  const report = async () => {
    const claim = await readJSON(join(root, '.run-lock', 'owner.json'));
    return join(root, 'launches', claim.runId, 'report.json');
  };
  return { base, store, profile, root, configRoot, app, main, owner, deps, calls, report,
    get opened() { return opened; }, get installs() { return installs; }, get checks() { return checks; },
    setRows(value) { rows = value; }, setHolder(value) { holder = value; }, setBusy(value) { busy = value; },
    setFailOpen(value) { failOpen = value; }, changeApp() { key = 'b'.repeat(64); } };
}

test('Desktop opens without a CLI, binds selected database and survives controller restart', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.owner.status(f.profile.id, { installation: f.app }), { state: 'available', appKey: f.app.appKey });
  assert.equal(f.installs, 0, 'polling uses shared installation observation');
  assert.equal((await f.owner.open(f.profile.name, { appKey: f.app.appKey })).state, 'running');
  assert.equal(f.opened, 1);
  assert.deepEqual(f.calls[0].args, ['-n', '-a', f.app.path, '--env', `COPILOT_HOME=${f.configRoot}`]);
  assert.equal(f.calls[0].command, '/usr/bin/open');
  const saved = await readJSON(await f.report());
  assert.equal(saved.phase, 'running'); assert.equal(saved.spawnIntent, true);
  assert.equal(saved.owner.host, hostname()); assert.equal(Object.hasOwn(saved.owner, 'pid'), false);
  const restarted = createManagedDesktop(f.store, f.deps), before = await readFile(await f.report());
  const inspections = f.installs;
  assert.equal((await restarted.status(f.profile.id)).state, 'running');
  assert.deepEqual(await readFile(await f.report()), before);
  assert.equal(f.installs, inspections, 'existing claims never reverify installed signature on polling');
  assert.equal((await restarted.open(f.profile.id, { appKey: f.app.appKey })).state, 'running');
  assert.equal(f.opened, 1);
});

test('normal quit stays reserved until explicit preview and fresh recovery', async t => {
  const f = await fixture(t);
  await f.owner.open(f.profile.id, { appKey: f.app.appKey });
  f.setRows([]); f.setHolder(false);
  const path = await f.report(), before = await readFile(path);
  assert.equal((await f.owner.status(f.profile.id)).state, 'recoverable-stopped');
  assert.deepEqual(await readFile(path), before);
  assert.equal((await f.owner.recover(f.profile.id)).status, 'preview');
  assert.deepEqual(await readFile(path), before);
  const result = await recoverProfileRun(f.store, f.profile.id, { apply: true, managedDesktop: f.owner });
  assert.equal(result.status, 'recovered');
  await assert.rejects(readFile(join(f.root, '.run-lock/owner.json')), { code: 'ENOENT' });
  assert.equal((await readJSON(path)).phase, 'recovered');
  assert.equal((await f.owner.status(f.profile.id, { installation: f.app })).state, 'available');
});

test('live app, reused PID, descendant and foreign holders preserve reservations', async t => {
  for (const scenario of ['live', 'reused', 'descendant', 'holder']) await t.test(scenario, async t => {
    const f = await fixture(t);
    await f.owner.open(f.profile.id, { appKey: f.app.appKey });
    if (scenario === 'reused') f.setRows([{ ...f.main, startedAt: 'replacement' }]);
    if (scenario === 'holder') { f.setRows([]); f.setHolder(false); f.setBusy(true); }
    if (scenario === 'descendant') {
      const path = await f.report(), saved = await readJSON(path);
      const child = { ...f.main, pid: 99998, ppid: f.main.pid, executable: `${f.app.path}/helper` };
      await record(path, { ...saved, processes: [...saved.processes, child] });
      f.setRows([{ ...child, ppid: 1 }]); f.setHolder(false);
    }
    const before = await readFile(join(f.root, '.run-lock/owner.json'));
    const status = await f.owner.status(f.profile.id);
    assert.notEqual(status.state, 'recoverable-stopped');
    try { assert.notEqual((await f.owner.recover(f.profile.id, { apply: true })).status, 'recovered'); } catch { /* refused */ }
    assert.deepEqual(await readFile(join(f.root, '.run-lock/owner.json')), before);
    assert.equal(f.opened, 1);
  });
});

test('occupied claims, existing app, unsafe root and stale appKey refuse before invocation', async t => {
  for (const scenario of ['claim', 'app', 'permissions', 'appKey']) await t.test(scenario, async t => {
    const f = await fixture(t);
    if (scenario === 'claim') await acquire(join(f.root, '.run-lock'), { kind: 'interactive-cli', runId: randomUUID() }, true);
    if (scenario === 'app') f.setRows([f.main]);
    if (scenario === 'permissions') await chmod(f.configRoot, 0o755);
    if (scenario === 'appKey') f.changeApp();
    await assert.rejects(f.owner.open(f.profile.id, { appKey: f.app.appKey }));
    assert.equal(f.opened, 0);
  });
});

test('failed launch retains durable starting record and refuses blind retry or recovery', async t => {
  const f = await fixture(t); f.setFailOpen(true);
  await assert.rejects(f.owner.open(f.profile.id, { appKey: f.app.appKey }), /open failed/);
  const path = await f.report(), saved = await readJSON(path);
  assert.equal(saved.phase, 'starting'); assert.equal(saved.spawnIntent, true);
  assert.equal((await f.owner.status(f.profile.id)).state, 'uncertain');
  assert.equal((await f.owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'uncertain');
  assert.equal((await f.owner.recover(f.profile.id, { apply: true })).state, 'uncertain');
  assert.equal(f.opened, 1); assert.deepEqual(await readJSON(path), saved);
});

test('root replacement and corrupt or foreign journals preserve the exact claim', async t => {
  for (const scenario of ['root', 'corrupt', 'foreign']) await t.test(scenario, async t => {
    const f = await fixture(t); await f.owner.open(f.profile.id, { appKey: f.app.appKey });
    const path = await f.report(), before = await readFile(join(f.root, '.run-lock/owner.json'));
    f.setRows([]); f.setHolder(false);
    if (scenario === 'root') { await rename(f.configRoot, `${f.configRoot}-old`); await mkdir(f.configRoot, { mode: 0o700 }); }
    if (scenario === 'corrupt') await writeFile(path, '{', { mode: 0o600 });
    if (scenario === 'foreign') await record(path, { ...(await readJSON(path)), binding: { profileId: 'foreign' } });
    assert.equal((await f.owner.status(f.profile.id)).state, 'blocked');
    await assert.rejects(f.owner.recover(f.profile.id, { apply: true }));
    assert.deepEqual(await readFile(join(f.root, '.run-lock/owner.json')), before);
  });
});

test('missing selected database proof and ambiguous new mains preserve starting reservation', async t => {
  for (const scenario of ['database', 'ambiguous']) await t.test(scenario, async t => {
    const f = await fixture(t);
    const owner = createManagedDesktop(f.store, { ...f.deps, async execFile() {
      f.setRows(scenario === 'ambiguous' ? [f.main, { ...f.main, pid: f.main.pid + 1 }] : [f.main]);
      f.setHolder(false);
      return { stdout: '', stderr: '' };
    } });
    if (scenario === 'ambiguous') await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), /ambiguous/);
    else assert.equal((await owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'uncertain');
    assert.equal((await readJSON(await f.report())).phase, 'starting');
    assert.equal((await owner.status(f.profile.id)).state, 'uncertain');
  });
});

test('ambient root or token overrides are refused without reserving or opening', async t => {
  const f = await fixture(t);
  for (const environment of [{ ...f.deps.environment, COPILOT_HOME: '' }, { ...f.deps.environment, GITHUB_TOKEN: 'fixture-token' }]) {
    const owner = createManagedDesktop(f.store, { ...f.deps, environment });
    await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), /ambient Copilot/);
    assert.equal(f.opened, 0);
    await assert.rejects(readFile(join(f.root, '.run-lock/owner.json')), { code: 'ENOENT' });
  }
});

test('app change before dispatch leaves an explicitly recoverable reservation and preserves a foreign replacement', async t => {
  for (const foreign of [false, true]) await t.test(foreign ? 'foreign replacement' : 'known not dispatched', async t => {
    const f = await fixture(t);
    let verifications = 0;
    const foreignOwner = { kind: 'interactive-cli', host: hostname(), pid: 77777, runId: randomUUID() };
    const owner = createManagedDesktop(f.store, { ...f.deps, stockApps: { async binding() {
      if (++verifications === 1) return { ...f.app };
      if (foreign) await record(join(f.root, '.run-lock/owner.json'), foreignOwner);
      throw new Error('signed app identity changed before dispatch');
    } } });
    await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), /identity changed/);
    assert.equal(f.opened, 0);
    if (foreign) {
      assert.equal((await owner.status(f.profile.id)).state, 'blocked');
      await assert.rejects(owner.recover(f.profile.id, { apply: true }), /foreign or unresolved/);
      assert.deepEqual(await readJSON(join(f.root, '.run-lock/owner.json')), foreignOwner);
    } else {
      const path = await f.report(), before = await readJSON(path);
      assert.equal(before.phase, 'prepared'); assert.equal(before.spawnIntent, false);
      assert.equal((await owner.status(f.profile.id)).state, 'recoverable-stopped');
      assert.deepEqual(await readJSON(path), before, 'polling retains the prepared journal');
      assert.equal((await owner.recover(f.profile.id)).status, 'preview');
      assert.equal((await owner.recover(f.profile.id, { apply: true })).status, 'recovered');
      assert.equal((await readJSON(path)).phase, 'recovered');
      assert.equal((await readJSON(path)).spawnIntent, false);
      assert.equal((await owner.status(f.profile.id, { installation: f.app })).state, 'available');
      assert.equal((await f.owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'running');
      assert.equal(f.opened, 1, 'only the fresh explicitly requested Open dispatches');
    }
  });
});


test('Claude status is readonly, open prepares Desktop storage and proves renderer ownership beside another instance', async t => {
  const f = await fixture(t, 'claude');
  const desktop = join(f.root, 'desktop');
  assert.equal((await f.owner.status(f.profile.id, { installation: f.app })).state, 'available');
  await assert.rejects(readFile(desktop), { code: 'ENOENT' });
  const unrelated = { ...f.main, pid: 88888 };
  f.setRows([unrelated]);
  assert.equal((await f.owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'running');
  assert.deepEqual(f.calls[0].args, ['-n', '-a', f.app.path, '--env', `CLAUDE_CONFIG_DIR=${f.configRoot}`, '--args', `--user-data-dir=${desktop}`]);
  const saved = await readJSON(await f.report());
  assert.equal(saved.kind, 'claude-desktop'); assert.equal(saved.binding.identities.length, 4);
  assert.equal(saved.processes.length, 2); assert.equal(saved.processes.some(row => row.pid === unrelated.pid), false);
  assert.equal((await f.owner.status(f.profile.id)).state, 'running');
  await assert.rejects(f.owner.recover(f.profile.id, { apply: true }).then(result => {
    assert.notEqual(result.status, 'recovered'); throw new Error('still live');
  }), /still live/);
  f.setRows([unrelated]); f.setHolder(false);
  assert.equal((await recoverProfileRun(f.store, f.profile.id, { apply: true, managedDesktop: f.owner })).status, 'recovered');
});

test('Claude claimed Desktop directory is never recreated after disappearance or replacement', async t => {
  for (const replace of [false, true]) await t.test(String(replace), async t => {
    const f = await fixture(t, 'claude'); await f.owner.open(f.profile.id, { appKey: f.app.appKey });
    const desktop = join(f.root, 'desktop'); await rename(desktop, `${desktop}-old`);
    if (replace) await mkdir(desktop, { mode: 0o700 });
    const owner = await readFile(join(f.root, '.run-lock/owner.json'));
    assert.equal((await f.owner.status(f.profile.id)).state, 'blocked');
    await assert.rejects(f.owner.open(f.profile.id, { appKey: f.app.appKey }));
    await assert.rejects(f.owner.recover(f.profile.id, { apply: true }));
    assert.deepEqual(await readFile(join(f.root, '.run-lock/owner.json')), owner);
    if (!replace) await assert.rejects(readFile(desktop), { code: 'ENOENT' });
  });
});

test('Claude main/file without a renderer storage holder and ambiguous new mains preserve intent', async t => {
  for (const ambiguous of [false, true]) await t.test(String(ambiguous), async t => {
    const f = await fixture(t, 'claude');
    const owner = createManagedDesktop(f.store, { ...f.deps, async execFile() {
      await writeFile(join(f.root, 'desktop/Cookies'), 'fixture', { mode: 0o600 });
      f.setRows([f.main, ...(ambiguous ? [{ ...f.main, pid: 99997 }] : [])]);
      return { stdout: '' };
    } });
    if (ambiguous) await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), /ambiguous/);
    else assert.equal((await owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'uncertain');
    assert.equal((await readJSON(await f.report())).spawnIntent, true);
    assert.equal((await owner.recover(f.profile.id, { apply: true })).state, 'uncertain');
  });
});

test('Claude scoped reparented crash reporters block release; unrelated roots do not', async t => {
  for (const scenario of ['selected', 'unrelated', 'ambiguous', 'unreadable', 'reused']) await t.test(scenario, async t => {
    const f = await fixture(t, 'claude');
    await f.owner.open(f.profile.id, { appKey: f.app.appKey });
    const helper = { ...f.main, pid: 99995, ppid: 1, executable: join(f.app.path, 'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler') };
    f.setRows([helper]); f.setHolder(false);
    const owner = createManagedDesktop(f.store, { ...f.deps, async execFile(command, args, options) {
      assert.equal(command, '/bin/ps'); assert.equal(options.maxBuffer, 16384);
      if (scenario === 'unreadable') throw new Error('ps unavailable');
      if (scenario === 'reused') f.setRows([{ ...helper, startedAt: 'replacement' }]);
      return { stdout: `${helper.executable} --database=${scenario === 'unrelated' ? join(f.base, 'other desktop') : join(f.root, 'desktop')}/Crashpad${scenario === 'ambiguous' ? ' --database=/another' : ''} --annotation=fixture\n` };
    } });
    const claim = await readFile(join(f.root, '.run-lock/owner.json'));
    if (scenario === 'unrelated') assert.equal((await owner.recover(f.profile.id, { apply: true })).status, 'recovered');
    else {
      assert.notEqual((await owner.status(f.profile.id)).state, 'recoverable-stopped');
      try { assert.notEqual((await owner.recover(f.profile.id, { apply: true })).status, 'recovered'); } catch { /* retained */ }
      assert.deepEqual(await readFile(join(f.root, '.run-lock/owner.json')), claim);
    }
  });
});

test('Claude startup retains a new root-scoped crash reporter without using it as storage proof', async t => {
  const f = await fixture(t, 'claude');
  const helper = { ...f.main, pid: 99995, ppid: 1, executable: join(f.app.path, 'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler') };
  const owner = createManagedDesktop(f.store, { ...f.deps, async execFile(command, args, options) {
    if (command === '/bin/ps') return { stdout: `${helper.executable} --database=${join(f.root, 'desktop/Crashpad')} --annotation=fixture\n` };
    const result = await f.deps.execFile(command, args, options);
    f.setRows([f.main, { ...f.main, pid: f.main.pid - 1, ppid: f.main.pid, executable: `${f.app.path}/renderer` }, helper]);
    return result;
  } });
  assert.equal((await owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'running');
  const saved = await readJSON(await f.report());
  assert.equal(saved.processes.some(row => row.pid === helper.pid), true);
  assert.equal(JSON.stringify(saved).includes('--database='), false);
  f.setRows([helper]); f.setHolder(false);
  assert.equal((await owner.recover(f.profile.id, { apply: true })).state, 'uncertain');
  f.setRows([]);
  assert.equal((await owner.recover(f.profile.id, { apply: true })).status, 'recovered');
});

test('Claude failures, reused identities, unknown holders and foreign claims preserve ownership', async t => {
  for (const scenario of ['dispatch', 'reused', 'holder', 'corrupt', 'foreign']) await t.test(scenario, async t => {
    const f = await fixture(t, 'claude');
    if (scenario === 'dispatch') f.setFailOpen(true);
    if (scenario === 'dispatch') await assert.rejects(f.owner.open(f.profile.id, { appKey: f.app.appKey }), /open failed/);
    else await f.owner.open(f.profile.id, { appKey: f.app.appKey });
    const path = await f.report(), claim = await readFile(join(f.root, '.run-lock/owner.json'));
    f.setRows([]); f.setHolder(false);
    if (scenario === 'reused') f.setRows([{ ...f.main, startedAt: 'replacement' }]);
    if (scenario === 'holder') f.setBusy(true);
    if (scenario === 'corrupt') await writeFile(path, '{', { mode: 0o600 });
    if (scenario === 'foreign') await record(path, { ...(await readJSON(path)), kind: 'copilot-desktop' });
    assert.notEqual((await f.owner.status(f.profile.id)).state, 'recoverable-stopped');
    try { assert.notEqual((await f.owner.recover(f.profile.id, { apply: true })).status, 'recovered'); } catch { /* retained */ }
    assert.deepEqual(await readFile(join(f.root, '.run-lock/owner.json')), claim);
    assert.equal(f.opened, 1);
  });
});

test('Claude prepared startup is explicitly recoverable across app change but never releases a foreign owner', async t => {
  for (const foreign of [false, true]) await t.test(String(foreign), async t => {
    const f = await fixture(t, 'claude'); let inspections = 0;
    const unrelated = { ...f.main, pid: 88888 }; f.setRows([unrelated]);
    const replacement = { kind: 'copilot-desktop', host: hostname(), runId: randomUUID() };
    const owner = createManagedDesktop(f.store, { ...f.deps, stockApps: { async binding() {
      if (++inspections === 1) return f.app;
      if (foreign) await record(join(f.root, '.run-lock/owner.json'), replacement);
      throw new Error('app changed');
    } } });
    await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), /app changed/);
    assert.equal(f.opened, 0);
    if (foreign) {
      assert.equal((await owner.status(f.profile.id)).state, 'blocked');
      await assert.rejects(recoverProfileRun(f.store, f.profile.id, { apply: true, managedDesktop: owner }));
      assert.deepEqual(await readJSON(join(f.root, '.run-lock/owner.json')), replacement);
    } else {
      const path = await f.report(); assert.equal((await readJSON(path)).spawnIntent, false);
      assert.equal((await owner.status(f.profile.id)).state, 'recoverable-stopped');
      assert.equal((await owner.recover(f.profile.id, { apply: true })).status, 'recovered');
      assert.equal((await readJSON(path)).spawnIntent, false);
    }
  });
});

test('Claude Desktop refuses ambient authentication/provider/debug/root overrides before dispatch', async t => {
  const f = await fixture(t, 'claude');
  for (const key of ['CLAUDE_USER_DATA_DIR', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'NODE_OPTIONS', 'ELECTRON_ENABLE_LOGGING', 'DEBUG']) {
    const owner = createManagedDesktop(f.store, { ...f.deps, environment: { ...f.deps.environment, [key]: '' } });
    await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), /ambient/);
    await assert.rejects(readFile(join(f.root, '.run-lock/owner.json')), { code: 'ENOENT' });
  }
  assert.equal(f.opened, 0);
});

test('Desktop waits for transient incomplete descendant identities without weakening ownership', async t => {
  for (const settles of [true, false]) await t.test(settles ? 'settles' : 'remains incomplete', async t => {
    const f = await fixture(t, 'claude');
    let reads = 0;
    const original = f.deps.runtime.snapshot;
    const runtime = { ...f.deps.runtime, async snapshot() {
      const rows = await original();
      if (f.opened && (!settles || reads++ === 0)) rows.push({ ...f.main, pid: 77770, ppid: f.main.pid, executable: 'Claude Helper' });
      return rows;
    } };
    const owner = createManagedDesktop(f.store, { ...f.deps, runtime, openTimeoutMs: 100 });
    const result = await owner.open(f.profile.id, { appKey: f.app.appKey });
    assert.equal(result.state, settles ? 'running' : 'uncertain');
    assert.equal(f.opened, 1);
    const saved = await readJSON(await f.report());
    assert.equal(saved.phase, settles ? 'running' : 'starting');
    assert.equal(saved.processes.some(row => row.executable === 'Claude Helper'), false);
  });
});

test('startup retries a newly observed owned holder but refuses an unrelated holder', async t => {
  for (const owned of [true, false]) await t.test(String(owned), async t => {
    const f = await fixture(t, 'claude');
    const helper = { ...f.main, pid: 77771, ppid: owned ? f.main.pid : 1, executable: `${f.app.path}/network-helper` };
    let appeared = false;
    const runtime = { ...f.deps.runtime, async assertResourcesIdle(paths, options) {
      if (f.opened && !appeared) {
        appeared = true;
        const rows = await f.deps.runtime.snapshot(); f.setRows([...rows, helper]);
        throw Object.assign(new Error('RESOURCE_BUSY'), { code: 'RESOURCE_BUSY', remainingProcesses: [helper] });
      }
      return f.deps.runtime.assertResourcesIdle(paths, options);
    } };
    const owner = createManagedDesktop(f.store, { ...f.deps, runtime, openTimeoutMs: 100 });
    if (owned) assert.equal((await owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'running');
    else await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), { code: 'RESOURCE_BUSY' });
    assert.equal(f.opened, 1);
    assert.equal((await readJSON(await f.report())).phase, owned ? 'running' : 'starting');
  });
});

test('Claude startup refuses existing selected-root crash reporters and preserves prepared intent for late arrivals', async t => {
  for (const scenario of ['baseline', 'late', 'unrelated']) await t.test(scenario, async t => {
    const f = await fixture(t, 'claude');
    const helper = { ...f.main, pid: 99995, ppid: 1, executable: join(f.app.path, 'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler') };
    if (scenario !== 'late') f.setRows([helper]);
    let inspections = 0;
    const owner = createManagedDesktop(f.store, { ...f.deps,
      stockApps: { async binding(input) {
        if (++inspections === 2 && scenario === 'late') f.setRows([helper]);
        return f.deps.stockApps.binding(input);
      } },
      async execFile(command, args, options) {
        if (command === '/bin/ps') return { stdout: `${helper.executable} --database=${scenario === 'unrelated' ? join(f.base, 'other desktop/Crashpad') : join(f.root, 'desktop/Crashpad')} --annotation=fixture\n` };
        return f.deps.execFile(command, args, options);
      },
    });
    if (scenario === 'unrelated') {
      assert.equal((await owner.open(f.profile.id, { appKey: f.app.appKey })).state, 'running');
      assert.equal(f.opened, 1);
    } else {
      await assert.rejects(owner.open(f.profile.id, { appKey: f.app.appKey }), /selected-root Claude crash reporter/);
      assert.equal(f.opened, 0);
      if (scenario === 'baseline') await assert.rejects(readFile(join(f.root, '.run-lock/owner.json')), { code: 'ENOENT' });
      else {
        const path = await f.report(), saved = await readJSON(path);
        assert.equal(saved.phase, 'prepared'); assert.equal(saved.spawnIntent, false);
        assert.notEqual((await owner.recover(f.profile.id, { apply: true })).status, 'recovered');
        assert.deepEqual(await readJSON(path), saved);
        f.setRows([]);
        assert.equal((await owner.recover(f.profile.id, { apply: true })).status, 'recovered');
      }
    }
  });
});
