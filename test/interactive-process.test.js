import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { access, chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runInteractive } from '../src/interactive-process.js';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';

const runFile = promisify(execFile);
const cli = new URL('../bin/xfx.js', import.meta.url).pathname;
const ramLogsLoader = new URL('../test-support/ram-logs-test-loader.mjs', import.meta.url).pathname;

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-interactive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'child.mjs');
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return { root, path };
}

const options = (path, overrides = {}) => ({
  executable: process.execPath,
  args: [path],
  cwd: tmpdir(),
  env: { PATH: '/usr/bin:/bin', ONLY_FOR_INTERACTIVE_TEST: 'present' },
  testStdio: 'ignore',
  ...overrides,
});

async function eventually(read) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await read(); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  return read();
}

async function eventuallyGone(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(pid, 0); } catch (caught) { if (caught.code === 'ESRCH') return; throw caught; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`owned descendant ${pid} survived cancellation`);
}

test('uses the explicit executable, args, cwd and environment only', async t => {
  const f = await fixture(t, `
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), arg: process.argv[3], only: process.env.ONLY_FOR_INTERACTIVE_TEST, inherited: process.env.HOME || null }));
`);
  const marker = join(f.root, 'result.json');
  const result = await runInteractive(options(f.path, { args: [f.path, marker, 'fixed-argument'], cwd: f.root }));
  assert.deepEqual(result, { exitCode: 0, signal: null, shutdown: { groupTerminated: true, escapedDescendantsUnverified: true } });
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { cwd: await realpath(f.root), arg: 'fixed-argument', only: 'present', inherited: null });
});

test('reports the spawned pid and reaps descendants left by a normally exiting leader', async t => {
  const f = await fixture(t, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.unref();
writeFileSync(process.argv[2], String(child.pid));
`);
  const marker = join(f.root, 'descendant.pid');
  let spawned;
  await runInteractive(options(f.path, { args: [f.path, marker], onSpawn: pid => { spawned = pid; } }));
  assert.ok(Number.isInteger(spawned) && spawned > 0);
  const descendant = Number(await eventually(() => readFile(marker, 'utf8')));
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
});

test('cancellation terminates an owned TERM-ignoring group within the bounded cleanup', async t => {
  const f = await fixture(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  let pid;
  const running = runInteractive(options(f.path, { signal: controller.signal, onSpawn: value => { pid = value; } }));
  await new Promise(resolve => setTimeout(resolve, 30));
  controller.abort();
  await assert.rejects(running, { code: 'CANCELLED' });
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
});

test('forwards terminal resize only to the owned detached group', async t => {
  const f = await fixture(t, `
import { writeFileSync } from 'node:fs';
process.on('SIGWINCH', () => writeFileSync(process.argv[2], 'seen'));
writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`);
  const marker = join(f.root, 'winch');
  const controller = new AbortController();
  const running = runInteractive(options(f.path, { args: [f.path, marker], signal: controller.signal }));
  try {
    assert.equal(await eventually(() => readFile(marker, 'utf8')), 'ready');
    process.kill(process.pid, 'SIGWINCH');
    assert.equal(await eventually(async () => {
      const value = await readFile(marker, 'utf8');
      if (value !== 'seen') throw new Error('still waiting');
      return value;
    }), 'seen');
  } finally {
    controller.abort();
    await assert.rejects(running, { code: 'CANCELLED' });
  }
});

test('cleans up when the spawn callback fails and fails closed for invalid launches', async t => {
  const f = await fixture(t, `setInterval(() => {}, 1000);`);
  let pid;
  await assert.rejects(runInteractive(options(f.path, { onSpawn: value => { pid = value; throw new Error('private detail'); } })), caught => {
    assert.equal(caught.code, 'ON_SPAWN_FAILED');
    assert.equal(caught.message.includes('private detail'), false);
    return true;
  });
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  await assert.rejects(runInteractive(options(f.path, { executable: '/definitely/not/a-real-executable' })), { code: 'SPAWN_FAILED' });
});

test('rejects implicit or malformed launch inputs', async () => {
  await assert.rejects(runInteractive({ executable: process.execPath, args: [], cwd: tmpdir(), env: process.env, testStdio: 'ignore' }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(runInteractive({ executable: 'node', args: [], cwd: tmpdir(), env: {}, testStdio: 'ignore' }), { code: 'INVALID_OPTIONS' });
});

test('detached inherited stdio keeps a fake PTY interactive for reads and writes', async t => {
  // `expect` supplies a real pseudo-terminal.  This verifies the production
  // inherited-stdio branch without recording any terminal output in Xenoflux.
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('POSIX-only helper');
  if (!existsSync('/usr/bin/expect')) return t.skip('expect is unavailable');
  const f = await fixture(t, '');
  const driver = join(f.root, 'pty-driver.mjs');
  const helperUrl = pathToFileURL(join(process.cwd(), 'src', 'interactive-process.js')).href;
  const childProgram = "process.stdin.setEncoding('utf8'); console.log('TTY:' + [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY].join(',')); process.stdin.once('data', value => { console.log('READ:' + value.trim()); process.exit(value.trim() === 'go' ? 0 : 2); }); setTimeout(() => process.exit(3), 2000);";
  await writeFile(driver, `
import { runInteractive } from ${JSON.stringify(helperUrl)};
const result = await runInteractive({ executable: process.execPath, args: ['-e', ${JSON.stringify(childProgram)}], cwd: ${JSON.stringify(f.root)}, env: { PATH: '/usr/bin:/bin' } });
console.log('RESULT:' + result.exitCode);
`);
  const expectProgram = `set timeout 5
proc require {pattern} {
  expect {
    -exact $pattern { return }
    timeout { puts stderr "missing $pattern"; exit 1 }
    eof { puts stderr "unexpected eof waiting for $pattern"; exit 1 }
  }
}
spawn ${process.execPath} ${driver}
require {TTY:true,true,true}
send -- "go\\r"
require {READ:go}
require {RESULT:0}
expect { eof {} timeout { puts stderr "missing eof"; exit 1 } }`;
  await runFile('/usr/bin/expect', ['-c', expectProgram], { timeout: 7_000 });
});

test('the xfx SIGHUP coordinator cancels the owned fake CLI group, removes its lock, and records CANCELLED', async t => {
  if (!['darwin', 'linux'].includes(process.platform)) return t.skip('POSIX-only launcher');
  if (!existsSync('/usr/bin/expect')) return t.skip('expect is unavailable');
  const f = await fixture(t, '');
  const descendantMarker = join(f.root, 'owned-descendant.pid');
  // This is a synthetic executable only: it recognizes the bounded version
  // preflight, then remains interactive and starts one owned descendant.
  await writeFile(f.path, `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'codex-cli 0.153.4\\n'; exit 0; fi
( trap '' TERM; while :; do sleep 1; done ) &
echo $! > ${JSON.stringify(descendantMarker)}
trap '' TERM
printf 'OWNED_READY\\n'
while :; do sleep 1; done
`, { mode: 0o700 });
  await chmod(f.path, 0o700);
  const native = await prepareNativeHome({ directory: join(f.root, 'native'), executable: f.path, codexVersion: '0.153.4' });
  const store = new Store(join(f.root, 'store'));
  await store.update(data => { create(data, 'A'); });
  await registerHome(store, 'A', native.root, { executable: f.path, version: '0.153.4' });
  const expectProgram = `set timeout 8
proc require {pattern} {
  expect {
    -exact $pattern { return }
    timeout { puts stderr "missing $pattern"; exit 1 }
    eof { puts stderr "unexpected eof waiting for $pattern"; exit 1 }
  }
}
spawn ${process.execPath} --loader ${ramLogsLoader} ${cli} --store ${store.directory} launch A
require {OWNED_READY}
exec /bin/kill -HUP [exp_pid]
require {Codex incomplete (CANCELLED).}
expect { eof {} timeout { puts stderr "missing eof"; exit 1 } }
exit 0`;
  await runFile('/usr/bin/expect', ['-c', expectProgram], { timeout: 10_000 });
  await assert.rejects(access(join(native.root, '.run-lock')), { code: 'ENOENT' });
  const launches = await readdir(join(native.root, 'launches'));
  assert.equal(launches.length, 1);
  const report = JSON.parse(await readFile(join(native.root, 'launches', launches[0], 'report.json'), 'utf8'));
  assert.equal(report.status, 'incomplete');
  assert.equal(report.error, 'CANCELLED');
  await eventuallyGone(Number(await readFile(descendantMarker, 'utf8')));
});
