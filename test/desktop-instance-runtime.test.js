import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopInstanceRuntime, targetStartSeconds } from '../src/desktop-instance-runtime.js';
import { DESKTOP_APP } from '../src/desktop-runtime.js';

const self = { pid: 10, ppid: 1, uid: 501, startedAt: 'Fri Oct  9 10:00:00 2026', executable: '/usr/bin/node' };
const caller = { pid: 20, ppid: 10, uid: 501, startedAt: 'Fri Oct  9 10:00:01 2026', executable: DESKTOP_APP.executable };
const ownMain = { pid: 30, ppid: 1, uid: 501, startedAt: 'Fri Oct  9 10:00:02 2026', executable: DESKTOP_APP.executable };
const helper = '/fixture/Launcher.app/Contents/MacOS/Launcher';
const plan = { home: '/fixture/home', desktopData: '/fixture/data', temporary: '/fixture/tmp', userHome: '/Users/test', app: { ...DESKTOP_APP } };
const inspected = async () => ({ ...DESKTOP_APP });
const opts = extra => ({ currentPid: 10, userInfo: () => ({ uid: 501, homedir: '/Users/test' }), inspectApp: inspected, ...extra });

test('request receipt selects the opened main while ignoring simultaneous unrelated mains', async () => {
  let call, reads = 0;
  const child = { ...ownMain, pid: 31, ppid: 30, executable: '/fixture/Codex Helper' };
  const unrelated = { ...ownMain, pid: 40, startedAt: 'Fri Oct  9 10:00:04 2026' };
  const rt = createDesktopInstanceRuntime(opts({
    processSnapshot: async () => ++reads === 1 ? [self, caller] : [self, caller, ownMain, child, unrelated],
    execFile: async (file, args, options) => { call = { file, args, options }; return { stdout: JSON.stringify({ pid: ownMain.pid, executable: ownMain.executable, startSeconds: Number(targetStartSeconds(ownMain.startedAt)) }), stderr: '' }; },
  }));
  const result = await rt.open(plan, { helperExecutable: helper });
  assert.deepEqual(result, { main: ownMain, processes: [ownMain, child] });
  assert.equal(call.file, helper);
  assert.deepEqual(call.args, ['--open-app', DESKTOP_APP.appPath, '--home', '/fixture/home', '--desktop-data', '/fixture/data', '--user-home', '/Users/test', '--temporary', '/fixture/tmp', '--target-executable', DESKTOP_APP.executable]);
  assert.equal(call.options.timeout, 15000);
  assert.equal(call.options.env.HOME, '/Users/test');
});

test('a receipt naming a preexisting main is refused', async () => {
  let calls = 0;
  const rt = createDesktopInstanceRuntime(opts({
    processSnapshot: async () => [self, caller, ownMain],
    execFile: async () => { calls++; return { stdout: JSON.stringify({ pid: ownMain.pid, executable: ownMain.executable, startSeconds: Number(targetStartSeconds(ownMain.startedAt)) }), stderr: '' }; },
  }));
  await assert.rejects(rt.open(plan, { helperExecutable: helper }), { code: 'DESKTOP_OPEN_PREEXISTING' });
  assert.equal(calls, 1);
});

test('invalid helper receipt cannot be replaced by process-delta attribution', async () => {
  let reads = 0;
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => ++reads === 1 ? [self, caller] : [self, caller, ownMain],
    execFile: async () => ({ stdout: 'not json', stderr: '' }) }));
  await assert.rejects(rt.open(plan, { helperExecutable: helper }), { code: 'DESKTOP_OPEN_RECEIPT_INVALID' });
});

test('open refuses a plan bound to a different inspected app before launching', async () => {
  let calls = 0;
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => [self, caller], execFile: async () => { calls++; return { stdout: '' }; } }));
  await assert.rejects(rt.open({ ...plan, app: { ...DESKTOP_APP, appPath: '/other/Codex.app' } }, { helperExecutable: helper }), { code: 'APP_IDENTITY_CHANGED' });
  assert.equal(calls, 0);
});

test('focus and graceful close target exact pid, executable, and start identity', async () => {
  const calls = [];
  let rows = [self, caller, ownMain];
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => rows,
    execFile: async (...args) => { calls.push(args); return { stdout: '' }; }, sleep: async () => { rows = [self, caller]; } }));
  await rt.focus(ownMain, { helperExecutable: helper });
  const closed = await rt.close(ownMain, { helperExecutable: helper });
  assert.equal(closed.status, 'stopped');
  assert.equal(calls[0][0], helper);
  assert.deepEqual(calls[0][1], ['--focus-pid', '30', '--target-executable', DESKTOP_APP.executable, '--target-start-seconds', targetStartSeconds(ownMain.startedAt)]);
  assert.deepEqual(calls[1][1], ['--quit-pid', '30', '--target-executable', DESKTOP_APP.executable, '--target-start-seconds', targetStartSeconds(ownMain.startedAt)]);
});

test('pid reuse and caller-ancestor targets are rejected before invoking helper', async () => {
  let calls = 0;
  const reused = { ...ownMain, startedAt: 'Fri Oct  9 10:02:00 2026' };
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => [self, caller, reused], execFile: async () => { calls++; } }));
  await assert.rejects(rt.focus(ownMain, { helperExecutable: helper }), { code: 'PROCESS_IDENTITY_CHANGED' });
  assert.equal(calls, 0);
  const ancestorRt = createDesktopInstanceRuntime(opts({ currentPid: 99, processSnapshot: async () => [caller, { ...self, pid: 99, ppid: caller.pid }], execFile: async () => { calls++; } }));
  await assert.rejects(ancestorRt.focus(caller, { helperExecutable: helper }), { code: 'SELF_HOSTED' });
  assert.equal(calls, 0);
});

test('same-user filtering, timeout evidence, and numeric start conversion are bounded', async () => {
  const foreign = { ...ownMain, pid: 70, uid: 502 };
  const child = { ...ownMain, pid: 32, ppid: 30, executable: '/fixture/renderer' };
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => [self, caller, ownMain, child, foreign],
    execFile: async () => ({ stdout: '' }), now: (() => { let n = 0; return () => n++; })(), sleep: async () => {} }));
  assert.deepEqual(await rt.snapshot(), [self, caller, ownMain, child]);
  await assert.rejects(rt.close(ownMain, { helperExecutable: helper }), e => e.code === 'DESKTOP_CLOSE_TIMEOUT' && e.remainingProcesses.some(r => r.pid === 32));
  assert.match(targetStartSeconds(ownMain.startedAt), /^\d+$/);
  assert.throws(() => targetStartSeconds('garbage'), { code: 'PROCESS_OBSERVATION_INVALID' });
});

test('idle resource inspection ignores sibling profile handles and rejects target handles', async () => {
  const home = '/fixture/profiles/selected', sibling = '/fixture/profiles/other';
  let lsofOutput = `p20\ncCodex\nu501\nn${sibling}/config.toml\n`;
  const holder = { pid: 90, ppid: 1, uid: 501, startedAt: 'Fri Oct  9 10:10:00 2026', executable: DESKTOP_APP.executable };
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => [self, holder],
    lstat: async path => ({ isDirectory: () => path === home, isSymbolicLink: () => false }), realpath: async path => path,
    execFile: async (file, args) => { assert.equal(file, '/usr/sbin/lsof'); assert.deepEqual(args.slice(0, 8), ['-nP', '-Fpcun', '-u', '501', '-a', '+D', home]); return { stdout: lsofOutput, stderr: '' }; },
  }));
  assert.deepEqual(await rt.assertResourcesIdle([home]), { idle: true, processes: [] });
  lsofOutput = `p90\ncCodex\nu501\nn${home}/config.toml\n`;
  await assert.rejects(rt.assertResourcesIdle([home]), { code: 'RESOURCE_BUSY' });
});

test('resource inspection treats absent paths as idle and incomplete lsof evidence as a refusal', async () => {
  const missing = createDesktopInstanceRuntime(opts({ lstat: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); } }));
  assert.deepEqual(await missing.assertResourcesIdle(['/fixture/missing']), { idle: true, processes: [] });
  const home = '/fixture/home';
  const broken = createDesktopInstanceRuntime(opts({ lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    realpath: async path => path, execFile: async () => { throw Object.assign(new Error(), { code: 1, stdout: '', stderr: 'lsof: permission denied' }); } }));
  await assert.rejects(broken.assertResourcesIdle([home]), { code: 'RESOURCE_INSPECTION_FAILED' });
  const unobserved = createDesktopInstanceRuntime(opts({ lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    realpath: async path => path, execFile: async () => ({ stdout: 'p999\ncCodex\nu501\nn/fixture/home/config.toml\n', stderr: '' }),
    processSnapshot: async () => [self] }));
  await assert.rejects(unobserved.assertResourcesIdle([home]), { code: 'RESOURCE_INSPECTION_FAILED' });
});

test('observe retains tracked app-server identity after the main exits', async () => {
  const server = { pid: 33, ppid: 30, uid: 501, startedAt: 'Fri Oct  9 10:00:03 2026', executable: '/fixture/app-server' };
  let rows = [self, ownMain, server];
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => rows, execFile: async () => ({ stdout: '' }) }));
  rows = [self, { ...server, ppid: 1 }];
  const result = await rt.observe(ownMain, { trackedProcesses: [ownMain, server] });
  assert.equal(result.status, 'running');
  assert.equal(result.orphaned, true);
  assert.deepEqual(result.processes.map(row => row.pid), [33]);
});

test('observe keeps a formerly owned helper that escaped the live main tree', async () => {
  const server = { pid: 33, ppid: 55, uid: 501, startedAt: 'Fri Oct  9 10:00:03 2026', executable: '/fixture/app-server' };
  const unrelated = { pid: 55, ppid: 1, uid: 501, startedAt: 'Fri Oct  9 10:00:06 2026', executable: '/fixture/unrelated' };
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => [self, ownMain, server, unrelated] }));
  const result = await rt.observe(ownMain, { trackedProcesses: [ownMain, server] });
  assert.equal(result.status, 'running');
  assert.equal(result.orphaned, true);
  assert.deepEqual(result.processes.map(row => row.pid), [30, 33]);
});

test('closing one profile ignores another profile and its separately tracked launcher', async () => {
  const other = { ...ownMain, pid: 40, startedAt: 'Fri Oct  9 10:00:04 2026' };
  const launcher = { pid: 50, ppid: self.pid, uid: 501, startedAt: 'Fri Oct  9 10:00:05 2026', executable: '/fixture/launcher' };
  let rows = [self, ownMain, other];
  const rt = createDesktopInstanceRuntime(opts({ processSnapshot: async () => rows,
    execFile: async (file) => {
      if (file === '/usr/bin/open') rows = [...rows, launcher];
      return { stdout: '' };
    }, sleep: async () => { rows = [self, other, launcher]; } }));
  await rt.observe(ownMain);
  await rt.observe(other);
  assert.deepEqual(await rt.openLauncher({ launcherApp: '/fixture/Launcher.app', launcherExecutable: launcher.executable }, ownMain), launcher);
  assert.equal((await rt.close(ownMain, { helperExecutable: helper })).status, 'stopped');
  assert.deepEqual(rows.map(row => row.pid), [10, 40, 50]);
});
