import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('launch verification retries stale callback state and still rejects unverified identities', {
  skip: process.platform !== 'darwin', timeout: 60000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-launch-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(new URL('../src/native/profile-launcher.swift', import.meta.url), 'utf8');
  const identity = source.slice(source.indexOf('struct TargetIdentity'), source.indexOf('func resolvedPath'));
  const validation = source.slice(source.indexOf('func validatedApplication'), source.indexOf('func safeAbsolutePath'));
  // Exercise the production launch/validation code with deterministic AppKit
  // registration states. No real application is opened, focused or closed.
  const productionLaunch = source.slice(source.indexOf('func openApplicationOneShot'), source.indexOf('struct ProfileMetadata'));
  const launch = productionLaunch.replace('addingTimeInterval(15)', 'addingTimeInterval(0.2)');
  assert.notEqual(launch, productionLaunch, 'the simulated failure cases use a shortened verification deadline');
  const harness = `import Foundation
import Darwin
let scenario = CommandLine.arguments[1]
var registrationReady = false
${identity}
func safeAbsolutePath(_ value: String) -> Bool { value.hasPrefix("/") }
func resolvedPath(_ url: URL) -> String { url.path }
func accountHome() -> String? { "/fixture/user" }
func executablePath(_ pid: pid_t) -> String? {
    scenario == "wrong-executable" ? "/fixture/other" : "/fixture/app/Contents/MacOS/Codex"
}
func processStartSeconds(_ pid: pid_t) -> Int? {
    if scenario == "unavailable" && registrationReady { return nil }
    return scenario == "reused-pid" && registrationReady ? 101 : 100
}
class NSRunningApplication {
    let processIdentifier: pid_t = 999999
    let isTerminated: Bool
    init(callback: Bool) { isTerminated = callback || scenario == "terminated" }
    init?(processIdentifier: pid_t) {
        guard registrationReady && scenario != "unregistered" else { return nil }
        isTerminated = scenario == "terminated"
    }
}
class NSWorkspace {
    static let shared = NSWorkspace()
    class OpenConfiguration {
        var createsNewApplicationInstance = false
        var arguments: [String] = []
        var environment: [String: String] = [:]
    }
    func openApplication(at: URL, configuration: OpenConfiguration,
                         completionHandler: (NSRunningApplication?, Error?) -> Void) {
        completionHandler(NSRunningApplication(callback: true), nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.025) { registrationReady = true }
    }
}
${validation}
${launch}
openApplicationOneShot(["--open-signed-app", "/fixture/app", "--home", "/fixture/home",
    "--desktop-data", "/fixture/data", "--user-home", "/fixture/user", "--temporary", "/fixture/tmp",
    "--target-executable", "/fixture/app/Contents/MacOS/Codex"])
`;
  const swift = join(root, 'main.swift'), executable = join(root, 'verify');
  await writeFile(swift, harness);
  execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), swift, '-o', executable], { timeout: 45000 });
  const success = spawnSync(executable, ['delayed-registration'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), { pid: 999999, executable: '/fixture/app/Contents/MacOS/Codex', startSeconds: 100 });
  for (const scenario of ['wrong-executable', 'reused-pid', 'unavailable', 'unregistered', 'terminated']) {
    const failure = spawnSync(executable, [scenario], { encoding: 'utf8', timeout: 5000 });
    assert.equal(failure.status, 1, scenario);
    assert.equal(failure.stdout, '', scenario);
    assert.match(failure.stderr, /expected start 100, observed start .*macOS registration .*terminated .*elapsed/, scenario);
  }
});
