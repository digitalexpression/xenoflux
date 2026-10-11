import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { loadPreparedProfileApp, prepareProfileApp, validateProfileApp } from '../src/profile-launcher.js';
import { DESKTOP_APP } from '../src/desktop-runtime.js';
import { createDesktopInstanceRuntime, targetStartSeconds } from '../src/desktop-instance-runtime.js';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { openDesktopInstance, closeDesktopInstance } from '../src/desktop-instances.js';

const execFile = promisify(nodeExecFile);
const enabled = process.platform === 'darwin' && process.env.XFX_NATIVE_PROFILE_OPEN === '1';

function run(executable, args, { timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${executable} timed out after ${timeout}ms: ${stderr || stdout}`));
    }, timeout);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${executable} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function entitlements(path) {
  const result = await execFile('/usr/bin/codesign', ['--display', '--entitlements', ':-', path], { encoding: 'utf8' });
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

async function waitForExit(pid, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Disposable profile app PID ${pid} did not terminate naturally`);
}

async function readReport(path, timeout = 5000, differentFromPid) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(await readFile(path, 'utf8'));
      if (differentFromPid === undefined || report.pid !== differentFromPid) return report;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

test('the desktop controller prepares, opens, focuses and reopens a native profile app', {
  skip: !enabled,
  timeout: 90000,
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-native-profile-open-')));
  let profileId;
  let reportPath, launchRequested = false;
  const launchedPids = new Set();
  t.after(async () => {
    if (!launchRequested) {
      await rm(root, { recursive: true, force: true });
      return;
    }
    if (reportPath) {
      const report = await readReport(reportPath, 5000).catch(() => null);
      if (report && Number.isSafeInteger(report.pid)) launchedPids.add(report.pid);
    }
    if (!launchedPids.size) {
      t.diagnostic(`Leaving disposable native fixture for inspection because its app exit could not be proven: ${root}`);
      return;
    }
    for (const pid of launchedPids) {
      try { await waitForExit(pid, 20000); }
      catch {
        t.diagnostic(`Leaving disposable native fixture for inspection because PID ${pid} did not exit: ${root}`);
        return;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const storeDirectory = join(root, 'store'), sourceApp = join(root, 'vendor', 'Codex.app');
  const contents = join(sourceApp, 'Contents'), macOS = join(contents, 'MacOS'), resources = join(contents, 'Resources');
  await mkdir(storeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(macOS, { recursive: true, mode: 0o700 });
  await mkdir(resources, { recursive: true, mode: 0o700 });

  // A hardened, ad-hoc host cannot load even an ad-hoc framework without the
  // library-validation runtime grant. The old AppKit-only fixture missed this.
  const framework = join(contents, 'Frameworks', 'FakeRuntime.framework');
  const frameworkExecutable = join(framework, 'FakeRuntime');
  const frameworkSource = join(root, 'FakeRuntime.c');
  await mkdir(framework, { recursive: true, mode: 0o700 });
  await writeFile(frameworkSource, 'int xfx_runtime_probe(void) { return 42; }\n', { mode: 0o600 });
  await run('/usr/bin/clang', ['-dynamiclib', frameworkSource, '-o', frameworkExecutable]);
  await writeFile(join(framework, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.synthetic.xfx.runtime</string>
<key>CFBundleExecutable</key><string>FakeRuntime</string>
<key>CFBundlePackageType</key><string>FMWK</string>
</dict></plist>`, { mode: 0o600 });
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', framework]);
  const originalFrameworkBytes = await readFile(frameworkExecutable);

  const vendorSource = join(root, 'FakeCodex.swift');
  const vendorExecutable = join(macOS, 'Codex');
  await writeFile(vendorSource, `import AppKit
import Foundation
import Darwin

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let frameworkURL = Bundle.main.privateFrameworksURL!.appendingPathComponent("FakeRuntime.framework/FakeRuntime")
guard let framework = dlopen(frameworkURL.path, RTLD_LAZY | RTLD_LOCAL) else {
    fatalError("Framework failed to load: \\(String(cString: dlerror()))")
}
defer { dlclose(framework) }
let environment = ProcessInfo.processInfo.environment
let home = environment["CODEX_HOME"]!
let arguments = Array(CommandLine.arguments.dropFirst())
var bsd = proc_bsdinfo()
guard proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &bsd, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size) else { fatalError("No kernel process identity") }
let report: [String: Any] = [
    "pid": getpid(),
    "bundleId": Bundle.main.bundleIdentifier ?? "",
    "runningBundleId": NSRunningApplication.current.bundleIdentifier ?? "",
    "runningName": NSRunningApplication.current.localizedName ?? "",
    "kernelStartSeconds": bsd.pbi_start_tvsec,
    "launchSeconds": Int(floor(NSRunningApplication.current.launchDate!.timeIntervalSince1970)),
    "frameworkLoaded": true,
    "executable": kernelExecutablePath() ?? "",
    "codexHome": home,
    "sqliteHome": environment["CODEX_SQLITE_HOME"] ?? "",
    "desktopData": environment["CODEX_ELECTRON_USER_DATA_PATH"] ?? "",
    "userHome": environment["HOME"] ?? "",
    "temporary": environment["TMPDIR"] ?? "",
    "arguments": arguments
]
let reportURL = URL(fileURLWithPath: home).appendingPathComponent("native-open-result.json")
let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
try data.write(to: reportURL, options: .atomic)
DispatchQueue.main.asyncAfter(deadline: .now() + 15) { app.terminate(nil) }
app.run()

func kernelExecutablePath() -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(getpid(), &buffer, UInt32(buffer.count)) > 0 else { return nil }
    let path = String(cString: buffer)
    return path.withCString { value in
        guard let canonical = realpath(value, nil) else { return nil }
        defer { free(canonical) }
        return String(cString: canonical)
    }
}
`, { mode: 0o600 });
  const moduleCache = join(root, 'swift-module-cache');
  await mkdir(moduleCache, { mode: 0o700 });
  await run('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', moduleCache, '-framework', 'AppKit', vendorSource, '-o', vendorExecutable], { timeout: 60000 });
  await chmod(vendorExecutable, 0o700);
  const infoPath = join(contents, 'Info.plist');
  await writeFile(infoPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Codex</string>
<key>CFBundleDisplayName</key><string>Codex</string>
<key>CFBundleIdentifier</key><string>com.openai.codex</string>
<key>CFBundleExecutable</key><string>Codex</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><false/>
</dict></plist>
`, { mode: 0o600 });
  const archive = Buffer.from('synthetic disposable vendor archive');
  await writeFile(join(resources, 'app.asar'), archive, { mode: 0o600 });
  const restrictedEntitlements = join(root, 'synthetic-vendor.entitlements');
  await writeFile(restrictedEntitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>SYNTHETICTEAM.com.openai.codex</string>
<key>com.apple.developer.team-identifier</key><string>SYNTHETICTEAM</string>
<key>com.apple.security.application-groups</key><array><string>SYNTHETICTEAM.com.openai.codex</string></array>
<key>com.apple.security.app-sandbox</key><true/>
</dict></plist>
`, { mode: 0o600 });
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--entitlements', restrictedEntitlements, vendorExecutable]);
  const originalClaims = await entitlements(vendorExecutable);
  for (const claim of ['SYNTHETICTEAM.com.openai.codex', 'com.apple.developer.team-identifier', 'com.apple.security.application-groups'])
    assert.ok(originalClaims.includes(claim), `source fixture is missing synthetic claim ${claim}`);

  const appPath = await realpath(sourceApp);
  const app = { appPath, bundleId: DESKTOP_APP.bundleId, executable: vendorExecutable,
    asarSha256: createHash('sha256').update(archive).digest('hex') };
  const store = new Store(await realpath(storeDirectory));
  await store.update(data => { profileId = create(data, 'Native Fixture').id; });
  const native = await prepareNativeHome({ directory: join(root, 'profile-native'), executable: vendorExecutable, codexVersion: '0.153.4' });
  await registerHome(store, 'Native Fixture', native.root, { executable: vendorExecutable, version: '0.153.4' });
  // Exercise the native runtime path across a delayed same-PID exec, using
  // kernel and ps timestamps as independent ownership checks.
  const delayedSource = join(root, 'delayed-profile-launcher.swift');
  const source = await readFile(new URL('../src/native/profile-launcher.swift', import.meta.url), 'utf8');
  assert.ok(source.includes('let args = [metadata.vendorExecutable,'));
  await writeFile(delayedSource, source.replace('let args = [metadata.vendorExecutable,',
    'sleep(2)\n    let args = [metadata.vendorExecutable,'), { mode: 0o600 });
  const launcherOptions = {
    source: delayedSource,
    verifyOriginal: async sourcePath => ({ ...app, appPath: sourcePath }),
  };
  const home = native.home, desktopData = native.desktopData;
  reportPath = join(home, 'native-open-result.json');
  let receipt;
  let preparations = 0;
  let prepared;
  const runtime = createDesktopInstanceRuntime({ inspectApp: async () => app,
    execFile: async (path, args, options) => {
      assert.ok(!(path === '/usr/bin/xcrun' && args.includes('swiftc')), 'opening must not compile the Swift helper');
      assert.ok(!(path === '/usr/bin/codesign' && args.includes('--sign')), 'opening must not sign the prepared app');
      if (args[0] === '--open-app') launchRequested = true;
      const result = await execFile(path, args, options);
      if (path === prepared?.helperExecutable && args[0] === '--open-app') receipt = JSON.parse(result.stdout.trim());
      if (path === '/bin/ps' && receipt) {
        const row = result.stdout.split('\n').find(line => line.trim().startsWith(`${receipt.pid} `));
        if (row?.includes('(Codex)')) t.diagnostic(`Shutdown ps row: ${row.trim()}`);
      }
      return result;
    },
  });
  const prepareLauncher = async (targetStore, plan) => {
    preparations++;
    prepared = await prepareProfileApp(targetStore, plan, launcherOptions);
    return prepared;
  };
  const loadLauncher = (targetStore, plan) => loadPreparedProfileApp(targetStore, plan, launcherOptions);
  const controllerOptions = { runtime, prepareLauncher, loadLauncher,
    lockPath: join(root, 'desktop.lock'), launcherEnvironment: {},
    validateApp: (targetStore, plan, application) => validateProfileApp(targetStore, plan, application, launcherOptions),
    ramLogs: { prepareHome: async () => {} } };
  const opened = await openDesktopInstance(store, 'Native Fixture', controllerOptions);
  assert.equal(opened.status, 'opened');
  assert.equal(preparations, 1, 'the first cache miss must prepare the profile app through the controller');
  const preparedApp = await loadPreparedProfileApp(store,
    { profileId, name: 'Native Fixture', nativeRoot: native.root, app }, launcherOptions);
  const copiedClaims = await entitlements(preparedApp.application.executable);
  assert.ok(copiedClaims.includes('com.apple.security.cs.disable-library-validation'),
    'the locally signed main must be allowed to load the preserved vendor framework');
  for (const claim of ['SYNTHETICTEAM.com.openai.codex', 'com.apple.developer.team-identifier', 'com.apple.security.application-groups', 'com.apple.security.app-sandbox'])
    assert.ok(!copiedClaims.includes(claim), `secondary executable retained restricted vendor claim ${claim}`);
  assert.deepEqual(await readFile(join(preparedApp.application.appPath, 'Contents', 'Frameworks', 'FakeRuntime.framework', 'FakeRuntime')),
    originalFrameworkBytes, 'the framework and its embedded signature must remain untouched');

  const report = await readReport(reportPath);
  assert.ok(report, 'fake AppKit vendor did not write its launch receipt');
  launchedPids.add(report.pid);
  const ps = await execFile('/bin/ps', ['-p', String(receipt.pid), '-o', 'lstart='], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' },
  });
  const psSeconds = Number(targetStartSeconds(`${ps.stdout.trim()} UTC`));
  t.diagnostic(JSON.stringify({ launchSeconds: report.launchSeconds, kernelStartSeconds: report.kernelStartSeconds,
    receiptSeconds: receipt.startSeconds, psSeconds }));
  assert.equal(receipt.startSeconds, report.kernelStartSeconds);
  assert.equal(receipt.startSeconds, psSeconds);
  assert.equal(report.pid, receipt.pid, 'LaunchServices bootstrap must exec the vendor at the same PID');
  assert.equal(report.executable, preparedApp.application.executable);
  assert.equal(receipt.executable, preparedApp.application.executable);
  assert.equal(report.bundleId, preparedApp.application.bundleId);
  assert.equal(report.runningBundleId, preparedApp.application.bundleId);
  assert.equal(report.runningName, 'Codex · Native Fixture');
  assert.equal(report.frameworkLoaded, true);
  assert.deepEqual([report.codexHome, report.sqliteHome, report.desktopData, report.userHome, report.temporary],
    [home, home, desktopData, userInfo().homedir, native.temporary]);
  assert.deepEqual(report.arguments, [`--user-data-dir=${desktopData}`]);
  assert.equal(opened.main.pid, report.pid);
  assert.equal(Number(targetStartSeconds(opened.main.startedAt)), report.kernelStartSeconds);
  const focused = await openDesktopInstance(store, 'Native Fixture', controllerOptions);
  assert.equal(focused.status, 'focused');
  assert.equal(focused.main.pid, opened.main.pid, 'a repeated controller open must focus the same PID');
  assert.equal(preparations, 1, 'a cached repeated open must not prepare or sign again');
  await waitForExit(report.pid, 20000);
  const reopened = await openDesktopInstance(store, 'Native Fixture', controllerOptions);
  assert.equal(reopened.status, 'opened', 'a stopped journal must be reconciled by open itself');
  assert.notEqual(reopened.main.pid, report.pid);
  const reopenedReport = await readReport(reportPath, 5000, report.pid);
  assert.ok(reopenedReport);
  launchedPids.add(reopenedReport.pid);
  assert.equal(reopenedReport.pid, reopened.main.pid);
  assert.equal(preparations, 1, 'the reconciled reopen must reuse the cached app');
  await assert.rejects(run(preparedApp.helperExecutable, ['--quit-pid', String(receipt.pid),
    '--target-executable', receipt.executable, '--target-start-seconds', String(receipt.startSeconds + 1)]),
  /exited 1/, 'native quit must reject a different kernel start time');
  assert.equal((await closeDesktopInstance(store, 'Native Fixture', controllerOptions)).status, 'closed');
});
