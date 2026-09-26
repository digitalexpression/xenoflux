import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopRuntime, DESKTOP_APP, DesktopRuntimeError, inspectDesktopApp, sameDesktopApp } from '../src/desktop-runtime.js';

const fixtureApp = { ...DESKTOP_APP, version: '26.908.70816', build: '9275',
  crashReporter: `${DESKTOP_APP.appPath}/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler` };

const main = { pid: 100, ppid: 1, uid: 501, startedAt: 'Sun Sep 14 10:00:00 2026', executable: DESKTOP_APP.executable };
const child = { pid: 101, ppid: 100, uid: 501, startedAt: 'Sun Sep 14 10:00:01 2026', executable: '/Applications/Codex.app/Contents/Frameworks/Helper' };
const self = { pid: 999, ppid: 1, uid: 501, startedAt: 'Sun Sep 14 09:00:00 2026', executable: '/usr/local/bin/node' };
const fixedApp = async (path, args) => {
  if (args?.some(value => typeof value === 'string' && value.startsWith('/Applications/ChatGPT.app/'))) throw new Error('alternate bundle is absent');
  if (path === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: fixtureApp.bundleId, CFBundleShortVersionString: fixtureApp.version, CFBundleVersion: fixtureApp.build, CFBundleExecutable: 'Codex' }) };
  if (path === '/usr/bin/codesign') {
    assert.deepEqual(args, ['--verify', '--deep', '--strict',
      '-R=identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', DESKTOP_APP.appPath]);
    return { stdout: '' };
  }
  throw new Error(`unexpected command ${path} ${args.join(' ')}`);
};
const crashpad = { ...child, ppid: 1, executable: fixtureApp.crashReporter };
const appOptions = { execFile: fixedApp, readFile: async () => Buffer.from('fixture'), realpath: async () => fixtureApp.crashReporter,
  currentPid: self.pid, userInfo: () => ({ uid: self.uid }) };

test('process inspection pins the locale used to parse process identities', async () => {
  const runtime = createDesktopRuntime({ execFile: async (path, args, options) => {
    assert.equal(path, '/bin/ps'); assert.equal(options.env.LC_ALL, 'C');
    return { stdout: `${main.pid} ${main.ppid} ${main.uid} ${main.startedAt} ${main.executable}\n` };
  } });
  assert.deepEqual(await runtime.snapshot(), [main]);
});

test('discovers updated versions, hashes and framework paths without a release pin', async () => {
  const result = await inspectDesktopApp(appOptions);
  assert.equal(result.bundleId, DESKTOP_APP.bundleId);
  const reporter = fixtureApp.crashReporter.replace('152.0.7977.83', '153.0.8010.48');
  const updated = await inspectDesktopApp({ ...appOptions,
    realpath: async () => reporter, readFile: async () => Buffer.from('updated'),
    execFile: async (path, args) => path === '/usr/bin/plutil'
      ? { stdout: JSON.stringify({ CFBundleIdentifier: DESKTOP_APP.bundleId, CFBundleShortVersionString: '26.915.31029', CFBundleVersion: '9771', CFBundleExecutable: 'Codex' }) }
      : fixedApp(path, args) });
  assert.equal(updated.version, '26.915.31029'); assert.equal(updated.build, '9771');
  assert.equal(updated.crashReporter, reporter); assert.notEqual(updated.asarSha256, result.asarSha256);
  assert.equal(sameDesktopApp(result, updated), true);
});

test('accepts a separately configured signed Codex bundle using its declared executable', async () => {
  const appPath = '/Applications/ChatGPT.app';
  const executable = `${appPath}/Contents/MacOS/ChatGPT`;
  const expected = { appPath, bundleId: DESKTOP_APP.bundleId, executable };
  const crashReporter = `${appPath}/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Helpers/browser_crashpad_handler`;
  const result = await inspectDesktopApp({
    appPath, expected, readFile: async () => Buffer.from('fixture'), realpath: async () => crashReporter,
    execFile: async (path, args) => {
      if (path === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: expected.bundleId,
        CFBundleShortVersionString: '26.915.31029', CFBundleVersion: '9771', CFBundleExecutable: 'ChatGPT' }) };
      assert.equal(path, '/usr/bin/codesign');
      assert.deepEqual(args.at(-1), appPath);
      return { stdout: '' };
    },
  });
  assert.equal(result.executable, executable);
  assert.equal(sameDesktopApp(result, expected), true);
});

test('discovers the verified installed alternate when the public default is absent', async () => {
  const alternatePath = '/Applications/ChatGPT.app';
  const alternateExecutable = `${alternatePath}/Contents/MacOS/ChatGPT`;
  const alternateReporter = `${alternatePath}/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Helpers/browser_crashpad_handler`;
  const inspected = await inspectDesktopApp({
    readFile: async path => {
      if (path.startsWith(DESKTOP_APP.appPath)) throw new Error('default bundle is absent');
      return Buffer.from('alternate fixture');
    },
    realpath: async path => {
      if (path.startsWith(DESKTOP_APP.appPath)) throw new Error('default bundle is absent');
      return alternateReporter;
    },
    execFile: async (path, args) => {
      const target = args.at(-1);
      if (typeof target === 'string' && target.startsWith(DESKTOP_APP.appPath)) throw new Error('default bundle is absent');
      if (path === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: DESKTOP_APP.bundleId,
        CFBundleShortVersionString: '26.915.31029', CFBundleVersion: '9771', CFBundleExecutable: 'ChatGPT' }) };
      assert.equal(path, '/usr/bin/codesign');
      assert.equal(target, alternatePath);
      return { stdout: '' };
    },
  });
  assert.equal(inspected.appPath, alternatePath);
  assert.equal(inspected.executable, alternateExecutable);
});

test('first process observation resolves the installed alternate before ancestry and client checks', async () => {
  const appPath = '/Applications/ChatGPT.app';
  const executable = `${appPath}/Contents/MacOS/ChatGPT`;
  const reporter = `${appPath}/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Helpers/browser_crashpad_handler`;
  const discovery = () => ({
    readFile: async path => {
      if (path.startsWith(DESKTOP_APP.appPath)) throw new Error('default bundle is absent');
      return Buffer.from('fixture');
    },
    realpath: async path => {
      if (path.startsWith(DESKTOP_APP.appPath)) throw new Error('default bundle is absent');
      return reporter;
    },
    execFile: async (path, args) => {
      const target = args.at(-1);
      if (typeof target === 'string' && target.startsWith(DESKTOP_APP.appPath)) throw new Error('default bundle is absent');
      if (path === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleIdentifier: DESKTOP_APP.bundleId,
        CFBundleShortVersionString: '26.915.31029', CFBundleVersion: '9771', CFBundleExecutable: 'ChatGPT' }) };
      assert.equal(path, '/usr/bin/codesign'); assert.equal(target, appPath);
      return { stdout: '' };
    },
  });
  const alternateMain = { ...main, executable };
  const hosted = { ...self, ppid: alternateMain.pid };
  const external = createDesktopRuntime({ ...discovery(), currentPid: hosted.pid, processSnapshot: async () => [alternateMain, hosted] });
  await assert.rejects(external.assertExternal(), { code: 'SELF_HOSTED' });

  const clients = createDesktopRuntime({ ...discovery(), currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    processSnapshot: async () => [self, alternateMain] });
  await assert.rejects(clients.prepareClients({ includeDesktop: true }), { code: 'DESKTOP_RUNNING' });
});

test('refuses to select between two verified default bundle candidates', async () => {
  await assert.rejects(inspectDesktopApp({
    readFile: async () => Buffer.from('fixture'),
    realpath: async path => `${path.split('/Contents/Frameworks/')[0]}/Contents/Frameworks/Codex Framework.framework/Versions/153.0.8010.48/Helpers/browser_crashpad_handler`,
    execFile: async (path, args) => {
      if (path === '/usr/bin/plutil') {
        const appPath = args.at(-1).split('/Contents/Info.plist')[0];
        return { stdout: JSON.stringify({ CFBundleIdentifier: DESKTOP_APP.bundleId, CFBundleShortVersionString: '26.915.31029',
          CFBundleVersion: '9771', CFBundleExecutable: appPath.endsWith('/ChatGPT.app') ? 'ChatGPT' : 'Codex' }) };
      }
      assert.equal(path, '/usr/bin/codesign');
      return { stdout: '' };
    },
  }), { code: 'APP_AMBIGUOUS' });
});

test('rejects changed bundle identities, unsafe executable metadata, and escaped framework helpers', async () => {
  for (const overrides of [{ CFBundleIdentifier: 'other.app' }, { CFBundleExecutable: '../Other' }]) {
    await assert.rejects(inspectDesktopApp({ ...appOptions, execFile: async (path, args) => {
      const result = await fixedApp(path, args);
      return path === '/usr/bin/plutil' ? { stdout: JSON.stringify({ ...JSON.parse(result.stdout), ...overrides }) } : result;
    } }), { code: overrides.CFBundleExecutable ? 'APP_INSPECTION_FAILED' : 'APP_IDENTITY_MISMATCH' });
  }
  await assert.rejects(inspectDesktopApp({ ...appOptions, realpath: async () => '/elsewhere/browser_crashpad_handler' }), { code: 'APP_INSPECTION_FAILED' });
});

test('retains only a verified installed orphan crash reporter; every other helper still blocks', async () => {
  let rows = [self, crashpad];
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows });
  assert.deepEqual(await runtime.snapshot(), [crashpad]); // no verified app yet
  await runtime.inspectApp();
  assert.deepEqual(await runtime.snapshot(), []);
  assert.deepEqual(runtime.retainedCrashpad(), [crashpad]);
  assert.deepEqual(await runtime.stop(), []); // must not send a quit to an orphan
  for (const other of [
    { ...crashpad, ppid: main.pid },
    { ...crashpad, uid: 502 },
    { ...crashpad, executable: fixtureApp.crashReporter.replace('152.0.7977.83', '152.0.7977.84') },
    { ...crashpad, executable: fixtureApp.crashReporter + '-unknown' },
  ]) {
    rows = [self, other];
    assert.deepEqual(await runtime.snapshot(), [other]);
    assert.deepEqual(runtime.retainedCrashpad(), []);
  }
  const dependent = { ...self, pid: 102, ppid: crashpad.pid };
  rows = [self, crashpad, dependent];
  assert.deepEqual(await runtime.snapshot(), [crashpad, dependent]);
  await assert.rejects(runtime.stop(), { code: 'DESKTOP_RUNNING' });
});

test('signature failure revokes the retained-helper exception', async () => {
  let valid = true;
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => [self, crashpad],
    execFile: async (path, args) => {
      if (path === '/usr/bin/codesign' && !valid) throw new Error('signature fixture failed');
      return fixedApp(path, args);
    } });
  await runtime.inspectApp(); assert.deepEqual(await runtime.snapshot(), []);
  valid = false;
  await assert.rejects(runtime.inspectApp(), { code: 'APP_SIGNATURE_INVALID' });
  assert.deepEqual(await runtime.snapshot(), [crashpad]);
});

test('standalone idle checks verify orphan reporters without caller initialization and still block other clients', async () => {
  let rows = [self, crashpad], verifications = 0;
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows,
    execFile: async (path, args) => {
      if (path === '/usr/bin/codesign') verifications += 1;
      return fixedApp(path, args); // Any quit, launch, or signal command fails.
    } });
  assert.deepEqual(await runtime.assertIdle(), { desktop: [], cli: [], resources: [] });
  assert.equal(verifications, 1);
  assert.deepEqual(runtime.retainedCrashpad(), [crashpad]);
  await runtime.assertIdle();
  assert.equal(verifications, 1);
  rows = [self, crashpad, main];
  await assert.rejects(runtime.assertIdle(), { code: 'DESKTOP_RUNNING' });
  rows = [self, crashpad, { ...self, pid: 555, executable: '/Users/fixture/.vscode/extensions/openai.chatgpt/bin/codex' }];
  await assert.rejects(runtime.assertIdle(), { code: 'CLI_RUNNING' });
});

test('standalone idle checks retain strict reporter identity and app verification requirements', async () => {
  for (const rows of [
    [self, { ...crashpad, ppid: main.pid }],
    [self, { ...crashpad, uid: 502 }],
    [self, crashpad, { ...self, pid: 102, ppid: crashpad.pid }],
  ]) {
    const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows,
      execFile: async () => assert.fail('Nonqualifying processes must not trigger app verification') });
    await assert.rejects(runtime.assertIdle(), { code: 'DESKTOP_RUNNING' });
    assert.deepEqual(runtime.retainedCrashpad(), []);
  }
  for (const failure of ['identity', 'signature']) {
    const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => [self, crashpad],
      ...(failure === 'identity' ? { expected: { ...DESKTOP_APP, bundleId: 'wrong.bundle' } } : {}),
      execFile: async (path, args) => {
        if (failure === 'signature' && path === '/usr/bin/codesign') throw new Error('invalid signature');
        return fixedApp(path, args);
      } });
    await assert.rejects(runtime.assertIdle(), { code: failure === 'identity' ? 'APP_IDENTITY_MISMATCH' : 'APP_SIGNATURE_INVALID' });
    assert.deepEqual(await runtime.snapshot(), [crashpad]);
  }
});

test('standalone idle checks rescan after verification to catch a newly launched desktop', async () => {
  let rows = [self, crashpad];
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows,
    execFile: async (path, args) => {
      if (path === '/usr/bin/codesign') rows = [self, crashpad, main];
      return fixedApp(path, args);
    } });
  await assert.rejects(runtime.assertIdle(), error => {
    assert.equal(error.code, 'DESKTOP_RUNNING');
    assert.deepEqual(error.remainingProcesses, [main]);
    return true;
  });
});

test('stop permits a crash reporter to become an orphan but reports unknown surviving descendants', async () => {
  for (const unknownSurvives of [false, true]) {
    let quitting = false, tick = 0;
    const unknown = { ...self, pid: 102, ppid: main.pid };
    const runtime = createDesktopRuntime({ ...appOptions,
      processSnapshot: async () => quitting
        ? [self, crashpad, ...(unknownSurvives ? [{ ...unknown, ppid: 1 }] : [])]
        : [self, main, { ...crashpad, ppid: main.pid }, unknown],
      execFile: async (path, args) => {
        if (path === '/usr/bin/osascript') { quitting = true; return { stdout: '' }; }
        return fixedApp(path, args);
      }, now: () => tick++, stopTimeoutMs: 3, sleep: async () => {},
    });
    await runtime.inspectApp();
    if (unknownSurvives) await assert.rejects(runtime.stop(), error => {
      assert.equal(error.code, 'DESKTOP_STOP_TIMEOUT');
      assert.deepEqual(error.remainingProcesses, [{ ...unknown, ppid: 1 }]);
      assert.match(error.message, /PID 102 \(parent 1\): \/usr\/local\/bin\/node/);
      return true;
    });
    else assert.deepEqual(await runtime.stop(), []);
    assert.deepEqual(runtime.retainedCrashpad(), [crashpad]);
  }
});

test('open and restore accept retained crash reporters without signaling them', async () => {
  for (const operation of ['open', 'restore']) {
    const calls = [];
    let opened = false;
    const runtime = createDesktopRuntime({ ...appOptions,
      userInfo: () => ({ uid: 501, homedir: '/Users/fixture' }),
      processSnapshot: async () => [self, crashpad, ...(opened ? [main] : [])],
      execFile: async (path, args) => {
        if (path === '/usr/bin/open') { opened = true; calls.push(args); return { stdout: '' }; }
        return fixedApp(path, args);
      } });
    await runtime.inspectApp();
    const plan = { home: '/fixture/home', desktopData: '/fixture/data', env: { HOME: '/fixture/user-home', TMPDIR: '/fixture/tmp' } };
    assert.deepEqual(await runtime[operation](plan), [main]);
    assert.equal(calls.length, 1);
    assert.deepEqual(runtime.retainedCrashpad(), [crashpad]);
  }
});

test('snapshot includes the exact app tree and keeps an orphaned tracked child visible', async () => {
  let rows = [self, main, child];
  const runtime = createDesktopRuntime({ processSnapshot: async () => rows, currentPid: 999 });
  assert.deepEqual((await runtime.snapshot()).map(row => row.pid), [100, 101]);
  rows = [self, { ...child, ppid: 1 }];
  assert.deepEqual((await runtime.snapshot()).map(row => row.pid), [101]);
  rows = [self];
  assert.deepEqual(await runtime.snapshot(), []);
});

test('parses executable paths with spaces and ignores unrelated non-path ps commands', async () => {
  const raw = [
    '  1 0 0 Sun Sep 14 08:00:00 2026 [kernel_task]',
    '999 1 501 Sun Sep 14 09:00:00 2026 /usr/local/bin/node',
    '100 1 501 Sun Sep 14 10:00:00 2026 /Applications/Codex.app/Contents/MacOS/Codex',
    '101 100 501 Sun Sep 14 10:00:01 2026 /Applications/Codex.app/Contents/Frameworks/Codex Helper',
  ].join('\n');
  const runtime = createDesktopRuntime({ currentPid: 999, execFile: async path => {
    assert.equal(path, '/bin/ps'); return { stdout: raw };
  } });
  assert.deepEqual((await runtime.snapshot()).map(row => row.executable), [main.executable, '/Applications/Codex.app/Contents/Frameworks/Codex Helper']);
  await runtime.assertExternal();
});

test('refuses control when running inside the desktop process ancestry', async () => {
  const runtime = createDesktopRuntime({ processSnapshot: async () => [{ ...main, pid: 20, ppid: 1 }, { ...self, pid: 21, ppid: 20 }], currentPid: 21 });
  await assert.rejects(runtime.assertExternal(), { code: 'SELF_HOSTED' });
});

test('stop uses a graceful fixed Apple event, waits for every descendant, and rejects PID reuse', async () => {
  const calls = []; let step = 0; let tick = 0;
  const initial = [self, main, child];
  const orphan = [self, { ...child, ppid: 1 }];
  const runtime = createDesktopRuntime({
    processSnapshot: async () => [initial, initial, orphan, [self]][Math.min(step++, 3)],
    currentPid: 999, now: () => tick++, sleep: async () => {},
    execFile: async (path, args, options) => { calls.push({ path, args, options }); return { stdout: '' }; },
  });
  assert.deepEqual(await runtime.stop(), []);
  assert.deepEqual(calls[0].args, ['-e', 'tell application id "com.openai.codex" to quit']);
  assert.equal(calls[0].options.env.HOME, undefined);
  assert.equal(calls[0].options.timeout, 60000);

  let reused = 0; let reuseTick = 0;
  const original = [self, main];
  const replacement = [self, { ...main, startedAt: 'Sun Sep 14 11:00:00 2026' }];
  const pidReuse = createDesktopRuntime({
    processSnapshot: async () => [original, original, replacement][Math.min(reused++, 2)],
    currentPid: 999, now: () => reuseTick++, sleep: async () => {}, execFile: async () => ({ stdout: '' }),
  });
  await assert.rejects(pidReuse.stop(), { code: 'PROCESS_IDENTITY_CHANGED' });
});

test('a pending native quit confirmation gets a human-sized timeout and a quit-specific error', async () => {
  for (const killed of [true, false]) {
    const runtime=createDesktopRuntime({processSnapshot:async()=>[self,main],currentPid:999,
    execFile:async(path,args,options)=>{
      assert.equal(path,'/usr/bin/osascript'); assert.equal(options.timeout,60000);
      throw Object.assign(new Error('private native details'),{killed});
    }});
    await assert.rejects(runtime.stop(), error => {
      assert.equal(error.code, killed ? 'DESKTOP_QUIT_TIMEOUT' : 'DESKTOP_QUIT_FAILED');
      assert.deepEqual(error.remainingProcesses, [main]);
      assert.match(error.message, /PID 100/);
      assert.doesNotMatch(error.message, /private native details/);
      return true;
    });
  }
});

test('stop refuses an orphan-only recovered tree and persisted identities retain that orphan', async () => {
  const calls = [];
  const runtime = createDesktopRuntime({ processSnapshot: async () => [self, { ...child, ppid: 1 }], currentPid: 999, execFile: async (...args) => { calls.push(args); return { stdout: '' }; } });
  runtime.seedTracked([child]);
  assert.deepEqual((await runtime.snapshot()).map(row => row.pid), [101]);
  await assert.rejects(runtime.stop(), { code: 'DESKTOP_RUNNING' });
  assert.equal(calls.length, 0);
  assert.throws(() => runtime.seedTracked([{ ...child, executable: '' }]), { code: 'PROCESS_OBSERVATION_INVALID' });
});

test('open supplies only fixed desktop overrides and requires one main process', async () => {
  const calls = []; let count = 0;
  const runtime = createDesktopRuntime({
    processSnapshot: async () => count++ < 2 ? [self] : [self, main, child], currentPid: 999,
    now: () => count, sleep: async () => {}, execFile: async (path, args, options) => { calls.push({ path, args, options }); return { stdout: '' }; },
  });
  const entries = await runtime.open({ home: '/fixture/home', desktopData: '/fixture/electron', env: { HOME: '/fixture/user-home', TMPDIR: '/fixture/tmp' } });
  assert.equal(entries[0].pid, 100);
  assert.deepEqual(calls[0].args, ['-n', '--env', 'CODEX_HOME=/fixture/home', '--env', 'CODEX_ELECTRON_USER_DATA_PATH=/fixture/electron', '--env', 'CODEX_SQLITE_HOME=/fixture/home', '--env', 'HOME=/fixture/user-home', '--env', 'TMPDIR=/fixture/tmp', DESKTOP_APP.appPath, '--args', '--user-data-dir=/fixture/electron']);
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
});

test('restore uses the OS account home and never accepts a running desktop', async () => {
  const calls = [];
  let count = 0;
  const runtime = createDesktopRuntime({ processSnapshot: async () => count++ < 2 ? [self] : [self, main], currentPid: 999, userInfo: () => ({ homedir: '/Users/real-user' }), execFile: async (path, args, options) => { calls.push({ path, args, options }); return { stdout: '' }; }, sleep: async () => {}, now: () => count });
  assert.equal((await runtime.restore())[0].pid, 100);
  assert.deepEqual(calls[0].args, [DESKTOP_APP.appPath]);
  assert.equal(calls[0].options.env.HOME, '/Users/real-user');
  const busy = createDesktopRuntime({ processSnapshot: async () => [self, main], currentPid: 999 });
  await assert.rejects(busy.restore(), { code: 'DESKTOP_RUNNING' });
});

test('writer preflight blocks active desktop and same-user standalone CLI processes', async () => {
  const cli = '/fixture/bin/codex';
  const cliProcess = { ...self, pid: 555, executable: cli };
  const namedCli = { ...self, pid: 556, executable: '/elsewhere/codex-cli' };
  for (const rows of [[self, main], [self, cliProcess], [self, namedCli]]) {
    const runtime = createDesktopRuntime({ processSnapshot: async () => rows, currentPid: self.pid, userInfo: () => ({ uid: self.uid }) });
    await assert.rejects(runtime.assertIdle({ cliExecutables: [cli] }), error => {
      assert.equal(error.code, rows.includes(main) ? 'DESKTOP_RUNNING' : 'CLI_RUNNING');
      assert.equal(error.remainingProcesses.length, 1);
      return true;
    });
  }
});

test('pre-quit check permits desktop-owned Codex but blocks external IDE and terminal clients', async () => {
  const owned = { ...child, executable: '/Applications/Codex.app/Contents/Resources/codex' };
  const ide = { ...self, pid: 555, executable: '/Users/fixture/.vscode/extensions/openai.chatgpt/bin/codex' };
  const terminal = { ...self, pid: 556, executable: '/fixture/bin/codex-cli' };
  let rows = [self, main, owned, { ...ide, pid: 557, uid: 502 }];
  const runtime = createDesktopRuntime({ processSnapshot: async () => rows, currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    execFile: async () => assert.fail('pre-quit check must not launch commands or inspect open resources') });
  assert.deepEqual(await runtime.assertNoOtherClients(), { otherClients: [] });
  rows = [...rows, ide, terminal];
  await assert.rejects(runtime.assertNoOtherClients(), error => {
    assert.equal(error.code, 'CLI_RUNNING'); assert.deepEqual(error.remainingProcesses, [ide, terminal]);
    assert.match(error.message, /VS Code/); return true;
  });
  rows = [self, { ...owned, ppid: 1 }];
  await assert.rejects(runtime.assertIdle(), { code: 'DESKTOP_RUNNING' });
});

test('pre-quit check rejects invalid executable inputs before inspecting processes', async () => {
  const runtime = createDesktopRuntime({ processSnapshot: async () => assert.fail('invalid input must not inspect processes') });
  for (const input of [null, [], { cliExecutables: 'path' }, { cliExecutables: ['relative'] }])
    await assert.rejects(runtime.assertNoOtherClients(input), { code: 'INVALID_OPTIONS' });
});

test('writer preflight ignores foreign CLI users and avoids lsof with no resource paths', async () => {
  let lsof = false;
  const runtime = createDesktopRuntime({ processSnapshot: async () => [self, { ...self, pid: 555, uid: 502, executable: '/fixture/bin/codex' }],
    currentPid: self.pid, userInfo: () => ({ uid: self.uid }), execFile: async path => { if (path === '/usr/sbin/lsof') lsof = true; return { stdout: '' }; } });
  assert.deepEqual(await runtime.assertIdle({ cliExecutables: ['/fixture/bin/codex'] }), { desktop: [], cli: [], resources: [] });
  assert.equal(lsof, false);
});

test('writer preflight reads only explicit resource holder metadata and fails closed', async () => {
  const resource = '/private/var/folders/x/xfx-ram.sqlite';
  const lstat = async () => ({});
  const holder = { ...self, pid: 777, executable: '/usr/local/bin/node' };
  const calls = [];
  const runtime = createDesktopRuntime({ lstat, processSnapshot: async () => [self, holder], currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    execFile: async (path, args, options) => { calls.push({ path, args, options }); return { stdout: 'p777\ncnode\nu501\n' }; } });
  await assert.rejects(runtime.assertIdle({ resourcePaths: [resource] }), error => {
    assert.equal(error.code, 'RESOURCE_BUSY'); assert.deepEqual(error.remainingProcesses, [holder]); return true;
  });
  assert.deepEqual(calls[0].args, ['-nP', '-F', 'pcu', '-a', '--', resource]);
  assert.equal(calls[0].options.env.HOME, undefined);

  const none = createDesktopRuntime({ lstat, processSnapshot: async () => [self], currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    execFile: async () => { throw Object.assign(new Error('none'), { code: 1, stdout: '', stderr: '' }); } });
  assert.deepEqual(await none.assertIdle({ resourcePaths: [resource] }), { desktop: [], cli: [], resources: [] });

  const unavailable = createDesktopRuntime({ lstat, processSnapshot: async () => [self], currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    execFile: async () => { throw Object.assign(new Error('unavailable'), { code: 2, stdout: '', stderr: '' }); } });
  await assert.rejects(unavailable.assertIdle({ resourcePaths: [resource] }), { code: 'RESOURCE_INSPECTION_FAILED' });

  for (const output of [
    { stdout: '', stderr: 'permission warning' },
    { stdout: 'cnode\nu501\n', stderr: '' },
  ]) {
    const malformed = createDesktopRuntime({ lstat, processSnapshot: async () => [self], currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
      execFile: async () => output });
    await assert.rejects(malformed.assertIdle({ resourcePaths: [resource] }), { code: 'RESOURCE_INSPECTION_FAILED' });
  }
});

test('writer preflight handles an absent resource without running lsof', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-missing-resource-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resource = join(root, 'unmounted-volume', 'logs_2.sqlite');
  const runtime = createDesktopRuntime({ processSnapshot: async () => [self],
    currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    execFile: async () => assert.fail('an absent resource must not be passed to lsof') });
  assert.deepEqual(await runtime.assertIdle({ resourcePaths: [resource] }), { desktop: [], cli: [], resources: [] });
});

test('writer preflight still checks existing resources and rechecks absent resources on each call', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-resource-handles-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, 'missing.sqlite'), present = join(root, 'present.sqlite');
  await writeFile(present, 'fixture');
  const holder = { ...self, pid: 777, executable: '/usr/local/bin/node' }, inspected = [];
  const runtime = createDesktopRuntime({ processSnapshot: async () => [self, holder],
    currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    execFile: async (path, args) => {
      assert.equal(path, '/usr/sbin/lsof'); inspected.push(args.slice(5));
      return { stdout: 'p777\ncnode\nu501\n', stderr: '' };
    } });
  await assert.rejects(runtime.assertIdle({ resourcePaths: [missing, present] }), { code: 'RESOURCE_BUSY' });
  assert.deepEqual(inspected, [[present]]);
  await writeFile(missing, 'new fixture');
  await assert.rejects(runtime.assertIdle({ resourcePaths: [missing, present] }), { code: 'RESOURCE_BUSY' });
  assert.deepEqual(inspected[1], [missing, present]);
});

test('resource metadata failures and lsof races are never treated as absent files', async () => {
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
    const runtime = createDesktopRuntime({ processSnapshot: async () => [self],
      currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
      lstat: async () => { throw Object.assign(new Error('unreadable'), { code }); },
      execFile: async () => assert.fail('metadata failure must stop before lsof') });
    await assert.rejects(runtime.assertIdle({ resourcePaths: ['/fixture/log.sqlite'] }), { code: 'RESOURCE_INSPECTION_FAILED' });
  }
  const runtime = createDesktopRuntime({ processSnapshot: async () => [self],
    currentPid: self.pid, userInfo: () => ({ uid: self.uid }), lstat: async () => ({}),
    execFile: async () => { throw Object.assign(new Error('removed during inspection'), { code: 1, stdout: '', stderr: 'No such file or directory' }); } });
  await assert.rejects(runtime.assertIdle({ resourcePaths: ['/fixture/log.sqlite'] }), { code: 'RESOURCE_INSPECTION_FAILED' });
});

test('an existing dangling resource symlink still requires handle inspection', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-resource-link-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const link = join(root, 'link.sqlite');
  await symlink(join(root, 'missing.sqlite'), link);
  let calls = 0;
  const runtime = createDesktopRuntime({ processSnapshot: async () => [self],
    currentPid: self.pid, userInfo: () => ({ uid: self.uid }),
    execFile: async () => { calls++; throw Object.assign(new Error('dangling link'), { code: 1, stdout: '', stderr: 'No such file or directory' }); } });
  await assert.rejects(runtime.assertIdle({ resourcePaths: [link] }), { code: 'RESOURCE_INSPECTION_FAILED' });
  assert.equal(calls, 1);
});

test('writer preflight rejects malformed executable and resource path lists before inspection', async () => {
  const runtime = createDesktopRuntime({ processSnapshot: async () => [self], currentPid: self.pid, userInfo: () => ({ uid: self.uid }) });
  for (const input of [null, { cliExecutables: ['relative'] }, { resourcePaths: ['/safe', 'bad'] }, { cliExecutables: 'no' }])
    await assert.rejects(runtime.assertIdle(input), { code: 'INVALID_OPTIONS' });
});

const codeMain = { pid: 700, ppid: 1, uid: 501, startedAt: 'Sun Sep 14 10:10:00 2026', executable: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' };
const codeClient = { pid: 701, ppid: 700, uid: 501, startedAt: 'Sun Sep 14 10:10:01 2026', executable: '/Users/fixture/.vscode/extensions/openai.chatgpt/bin/codex' };
const codePlist = JSON.stringify({ CFBundleIdentifier: 'com.microsoft.VSCode', CFBundleExecutable: 'Electron', CFBundleName: 'Visual Studio Code' });

test('prepareClients asks once and gracefully quits only the verified VS Code ancestor', async () => {
  let rows = [self, codeMain, codeClient]; const calls = []; const confirmations = [];
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows, currentPid: self.pid,
    confirmCloseClients: async clients => { confirmations.push(clients); return true; },
    execFile: async (path, args) => {
      if (path === '/usr/bin/plutil' && args[4].startsWith('/Applications/Visual Studio Code.app')) return { stdout: codePlist };
      if (path === '/usr/bin/osascript') { calls.push(args); rows = [self]; return { stdout: '' }; }
      return fixedApp(path, args);
    } });
  const result = await runtime.prepareClients({ cliExecutables: [codeClient.executable], includeDesktop: false });
  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0][0].name, 'Visual Studio Code');
  assert.equal(confirmations[0][0].appPath, '/Applications/Visual Studio Code.app');
  assert.deepEqual(calls, [['-e', 'if application "/Applications/Visual Studio Code.app" is running then tell application "/Applications/Visual Studio Code.app" to quit']]);
  assert.equal(result.clients.length, 1);
});

test('prepareClients walks through a nested Code Helper.app to its verified editor main', async () => {
  const helper = { ...codeMain, pid: 702, ppid: codeMain.pid, executable: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)' };
  let rows = [self, codeMain, helper, { ...codeClient, ppid: helper.pid }]; let quit = false;
  const runtime = createDesktopRuntime({ ...appOptions, closeClients: true, currentPid: self.pid, processSnapshot: async () => rows,
    execFile: async (path, args) => {
      if (path === '/usr/bin/plutil') return { stdout: args[4].includes('Code Helper') ? JSON.stringify({ CFBundleIdentifier: 'com.microsoft.VSCode.helper', CFBundleExecutable: 'Code Helper (Plugin)' }) : codePlist };
      if (path === '/usr/bin/osascript') { quit = true; rows = [self]; return { stdout: '' }; }
      return fixedApp(path, args);
    } });
  await runtime.prepareClients({ cliExecutables: [codeClient.executable] });
  assert.equal(quit, true);
});

test('prepareClients preserves read-only failure without approval, supports decline and preauthorization once', async () => {
  let rows = [self, codeMain, codeClient]; let quits = 0;
  const command = async (path, args) => {
    if (path === '/usr/bin/plutil' && args[4].startsWith('/Applications/Visual Studio Code.app')) return { stdout: codePlist };
    if (path === '/usr/bin/osascript') { quits += 1; rows = [self]; return { stdout: '' }; }
    return fixedApp(path, args);
  };
  const base = { ...appOptions, processSnapshot: async () => rows, currentPid: self.pid, execFile: command };
  await assert.rejects(createDesktopRuntime(base).prepareClients({ cliExecutables: [codeClient.executable] }), { code: 'CLI_RUNNING' });
  await assert.rejects(createDesktopRuntime({ ...base, confirmCloseClients: async () => false }).prepareClients({ cliExecutables: [codeClient.executable] }), { code: 'CANCELLED' });
  rows = [self, codeMain, codeClient];
  const approved = createDesktopRuntime({ ...base, closeClients: true });
  await approved.prepareClients({ cliExecutables: [codeClient.executable] });
  assert.equal(quits, 1);
  rows = [self, codeMain, codeClient];
  await assert.rejects(approved.prepareClients({ cliExecutables: [codeClient.executable] }), { code: 'CLI_RUNNING' });
});

test('prepareClients refuses standalone clients and never quits an unverified editor', async () => {
  const terminal = { ...codeClient, ppid: 1, executable: '/fixture/bin/codex' }; let commands = 0;
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => [self, terminal], currentPid: self.pid,
    execFile: async () => { commands += 1; throw new Error('must not inspect or quit'); } });
  await assert.rejects(runtime.prepareClients({ cliExecutables: [terminal.executable] }), { code: 'CLI_RUNNING' });
  assert.equal(commands, 0);
});

test('prepareClients stops on abort and detects a reused editor PID without a relaunch', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const cancelled = createDesktopRuntime({ ...appOptions, signal: controller.signal, processSnapshot: async () => { calls += 1; return [self]; } });
  await assert.rejects(cancelled.prepareClients(), { code: 'CANCELLED' }); assert.equal(calls, 0);
  let scans = 0;
  const replacement = { ...codeMain, startedAt: 'Sun Sep 14 10:20:00 2026' };
  const reused = createDesktopRuntime({ ...appOptions, currentPid: self.pid, closeClients: true,
    processSnapshot: async () => (++scans < 2 ? [self, codeMain, codeClient] : [self, replacement, codeClient]),
    execFile: async (path, args) => {
      if (path === '/usr/bin/plutil') return { stdout: codePlist };
      assert.fail(`must not quit reused pid: ${path} ${args}`);
    } });
  await assert.rejects(reused.prepareClients({ cliExecutables: [codeClient.executable] }), { code: 'PROCESS_IDENTITY_CHANGED' });
});

test('prepareClients maps an abort during the native quit request to cancellation', async () => {
  const controller = new AbortController(); let rows = [self, codeMain, codeClient];
  const runtime = createDesktopRuntime({ ...appOptions, closeClients: true, signal: controller.signal, currentPid: self.pid,
    processSnapshot: async () => rows,
    execFile: async (path, args) => {
      if (path === '/usr/bin/plutil') return { stdout: codePlist };
      if (path === '/usr/bin/osascript') { controller.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
      return fixedApp(path, args);
    } });
  await assert.rejects(runtime.prepareClients({ cliExecutables: [codeClient.executable] }), { code: 'CANCELLED' });
});

test('client preparation refuses missing ancestry, integrated terminals and ambiguous mains before approval', async () => {
  const helper = { ...codeMain, pid: 702, ppid: codeMain.pid,
    executable: '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper' };
  const cases = [
    [[codeMain, codeClient], 'PROCESS_OBSERVATION_INVALID'],
    [[{ ...self, ppid: 987 }, codeMain, codeClient], 'PROCESS_OBSERVATION_INVALID'],
    [[{ ...self, ppid: self.pid }, codeMain, codeClient], 'PROCESS_OBSERVATION_INVALID'],
    [[{ ...self, ppid: helper.pid }, helper, codeMain, codeClient], 'SELF_HOSTED'],
    [[self, codeMain, { ...codeMain, pid: 703 }, codeClient], 'CLI_RUNNING'],
    [[self, { ...codeMain, uid: 502 }, codeClient], 'CLI_RUNNING'],
  ];
  for (const [rows, code] of cases) {
    const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows,
      confirmCloseClients: async () => assert.fail('unsafe targets must fail before confirmation'),
      execFile: async (path, args) => {
        assert.equal(path, '/usr/bin/plutil', 'unsafe targets must never receive a quit');
        return { stdout: args[4].includes('Code Helper') ? '{}' : codePlist };
      } });
    await assert.rejects(runtime.prepareClients(), { code });
  }
});

test('orphaned or ambiguous desktop processes prevent any editor quit during copy preparation', async () => {
  for (const desktop of [[{ ...child, ppid: 1 }], [main, { ...main, pid: 105, uid: 502 }]]) {
    const runtime = createDesktopRuntime({ ...appOptions,
      processSnapshot: async () => [self, codeMain, codeClient, ...desktop],
      confirmCloseClients: async () => assert.fail('no approval for an ineligible desktop'),
      execFile: async (path, args) => {
        if (path === '/usr/bin/plutil' && args[4].includes('Visual Studio Code.app')) return { stdout: codePlist };
        return fixedApp(path, args); // Rejects every lifecycle command.
      } });
    await assert.rejects(runtime.prepareClients({ includeDesktop: true }), { code: 'DESKTOP_RUNNING' });
  }
});

test('native quit cancellation and reparented clients stop without retrying or force-killing', async () => {
  for (const scenario of ['native-cancel', 'timeout', 'orphan-client']) {
    let rows = [self, codeMain, codeClient], tick = 0, quits = 0;
    const runtime = createDesktopRuntime({ ...appOptions, closeClients: true,
      processSnapshot: async () => rows, now: () => tick++, sleep: async () => {}, stopTimeoutMs: 3,
      execFile: async (path, args) => {
        if (path === '/usr/bin/plutil') return { stdout: codePlist };
        assert.equal(path, '/usr/bin/osascript'); quits++;
        assert.match(args[1], /is running then.*to quit$/);
        if (scenario === 'native-cancel') throw new Error('User cancelled Quit');
        if (scenario === 'orphan-client') rows = [self, { ...codeClient, ppid: 1 }];
        return { stdout: '' };
      } });
    await assert.rejects(runtime.prepareClients(), { code: scenario === 'native-cancel' ? 'CLIENT_QUIT_FAILED' : 'CLIENT_QUIT_TIMEOUT' });
    assert.equal(quits, 1);
  }
});

test('a client exiting during confirmation is never relaunched to deliver a quit', async () => {
  let rows = [self, codeMain, codeClient];
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows,
    confirmCloseClients: async () => { rows = [self]; return true; },
    execFile: async path => { assert.equal(path, '/usr/bin/plutil'); return { stdout: codePlist }; } });
  await assert.rejects(runtime.prepareClients(), { code: 'PROCESS_IDENTITY_CHANGED' });
});

test('copy preparation approves desktop and editor together and tolerates normal desktop helper churn', async () => {
  let rows = [self, main, child, codeMain, codeClient], confirmations = 0;
  const quits = [], progress = [];
  const runtime = createDesktopRuntime({ ...appOptions, processSnapshot: async () => rows,
    onProgress: message => progress.push(message.replace(/\n/g, ' ')),
    confirmCloseClients: async apps => {
      confirmations++; assert.deepEqual(apps.map(app => app.name), ['Visual Studio Code', 'Codex']);
      rows = [self, main, { ...child, pid: 103 }, codeMain, codeClient];
      return true;
    },
    execFile: async (path, args) => {
      if (path === '/usr/bin/plutil' && args[4].includes('Visual Studio Code.app')) return { stdout: codePlist };
      if (path === '/usr/bin/osascript') {
        quits.push(args[1]);
        rows = args[1].includes('Visual Studio Code.app') ? rows.filter(row => ![codeMain.pid, codeClient.pid].includes(row.pid)) : [self];
        return { stdout: '' };
      }
      return fixedApp(path, args);
    } });
  await runtime.prepareClients({ includeDesktop: true });
  await runtime.assertIdle();
  assert.equal(confirmations, 1); assert.equal(quits.length, 2);
  assert.ok(progress.some(message => message.includes('Visual Studio Code')));
});

test('copy preparation can cancel a pending Codex desktop quit without force-killing', async () => {
  const controller = new AbortController(); let quits = 0;
  const runtime = createDesktopRuntime({ ...appOptions, closeClients: true, signal: controller.signal,
    processSnapshot: async () => [self, main],
    execFile: async (path, args, options) => {
      if (path === '/usr/bin/osascript') {
        quits++; assert.equal(options.signal, controller.signal); controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return fixedApp(path, args);
    } });
  await assert.rejects(runtime.prepareClients({ includeDesktop: true }), { code: 'CANCELLED' });
  assert.equal(quits, 1);
});
