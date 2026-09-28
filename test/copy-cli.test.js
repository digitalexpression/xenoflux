import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';

const cli = new URL('../bin/xfx.js', import.meta.url).pathname;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-copy-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const a = await prepareNativeHome({ directory: join(root, 'a'), executable, codexVersion: '0.153.4' });
  const b = await prepareNativeHome({ directory: join(root, 'b'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  await registerHome(store, 'A', a.root, { executable, version: '0.153.4' });
  await registerHome(store, 'B', b.root, { executable, version: '0.153.4' });
  await writeFile(join(a.home, 'config.toml'), `${await readFile(join(a.home, 'config.toml'), 'utf8')}model = "source-model"\n`, { mode: 0o600 });
  return { root, store, a, b };
}

function run(f, ...args) {
  return spawnSync(process.execPath, [cli, '--store', f.store.directory, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: f.root },
  });
}

async function absent(path) { await assert.rejects(stat(path), { code: 'ENOENT' }); }

test('copy preview with explicit include is JSON-safe and leaves native homes and backup storage untouched', async t => {
  const f = await fixture(t), target = join(f.b.home, 'config.toml');
  const before = await readFile(target, 'utf8');
  const result = run(f, '--json', 'copy', 'A', 'B', '--include', 'config');
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.status, 'preview');
  assert.deepEqual(preview.components, ['config']);
  assert.match(preview.config.scope, /General model/);
  assert.ok(preview.changes.some(change => change.path === 'config.toml'));
  assert.equal(await readFile(target, 'utf8'), before);
  await absent(join(f.store.directory, 'native-copies'));
});

test('copy parser rejects unsupported selections and conflicting flags before copy storage exists', async t => {
  const f = await fixture(t);
  for (const args of [
    ['--json', 'copy', 'A', 'B', '--include', 'history'],
    ['--json', 'copy', 'A', 'B', '--advanced'],
    ['copy', 'A', 'B', '--advanced', '--include', 'config'],
    ['copy', 'undo', 'pending', '--advanced'],
    ['--json', 'copy', 'undo', 'pending', '--include', 'config'],
    ['--json', 'copy', 'A', 'B', '--include', 'config,config'],
    ['--json', 'copy', 'A', 'B', '--include', 'config', '--apply', '--dry-run'],
  ]) {
    const result = run(f, ...args);
    assert.notEqual(result.status, 0, `${args.join(' ')} unexpectedly succeeded`);
  }
  await absent(join(f.store.directory, 'native-copies'));
});

test('copy and undo mutation are refused in a noninteractive terminal before native work', async t => {
  const f = await fixture(t), target = join(f.b.home, 'config.toml');
  const before = await readFile(target, 'utf8');
  for (const args of [
    ['--json', 'copy', 'A', 'B', '--include', 'config', '--apply'],
    ['--json', 'copy', 'undo', 'pending', '--apply'],
    ['--json', 'copy', 'A', 'B', '--include', 'config', '--apply', '--close-clients'],
    ['--json', 'copy', 'undo', 'pending', '--apply', '--close-clients'],
  ]) {
    const result = run(f, ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /external interactive terminal/);
  }
  assert.equal(await readFile(target, 'utf8'), before);
  await absent(join(f.store.directory, 'native-copies'));
});

test('help documents preview, application, and undo without exposing unsupported categories', async () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /copy SOURCE TARGET \[--include config,instructions,agents\]/);
  assert.match(result.stdout, /copy undo COPY_ID/);
  assert.match(result.stdout, /--close-clients/);
  assert.match(result.stdout, /Read-only operations never quit applications/);
});

test('profile inspect exposes scoped inventory without modifying the native profile', async t => {
  const f = await fixture(t), before = await readFile(join(f.a.home, 'config.toml'));
  const result = run(f, '--json', 'profile', 'inspect', 'A');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.inventory.items.some(item => item.transfer?.key === 'model' && item.copyable));
  assert.ok(report.inventory.limitations.length);
  assert.deepEqual(await readFile(join(f.a.home, 'config.toml')), before);
  await absent(join(f.store.directory, 'native-copies'));
});

test('advanced copy works end to end as a read-only terminal selection', async t => {
  if (spawnSync('/usr/bin/expect', ['-v']).error) return t.skip('expect unavailable');
  const f = await fixture(t), before = await readFile(join(f.b.home, 'config.toml'));
  const project=join(f.root,'project');
  await mkdir(join(project,'.codex','agents'),{recursive:true,mode:0o700});
  await writeFile(join(project,'.codex','agents','repo-only.toml'),'name="repo-only"\ndescription="repo agent"\ndeveloper_instructions="Local only"\n',{mode:0o600});
  const configPath=join(f.a.home,'config.toml');
  await writeFile(configPath,`${await readFile(configPath,'utf8')}\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n[mcp_servers.private.http_headers]\nAuthorization="Bearer sk-fixture12345678901234567890"\n`,{mode:0o600});
  const program = `set timeout 10
spawn $env(XFX_TEST_NODE) $env(XFX_TEST_CLI) --store $env(XFX_TEST_STORE) copy A B --advanced
expect {
  -re {Selected: 0} {}
  timeout { exit 2 }
}
send -- "/model\\r"
after 50
send -- "\\033\\133B"
send -- " "
expect {
  -re {Selected: 1} {}
  timeout { exit 3 }
}
send -- "\\r"
expect {
  -re {source-model} {}
  timeout { exit 4 }
}
expect {
  eof {}
  timeout { exit 5 }
}
catch wait result
exit [lindex $result 3]`;
  const result = spawnSync('/usr/bin/expect', ['-c', program], { encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: f.root, XFX_TEST_NODE: process.execPath, XFX_TEST_CLI: cli, XFX_TEST_STORE: f.store.directory } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /source-model/);
  assert.doesNotMatch(result.stdout, /repo-only|state_5\.sqlite|sk-fixture12345678901234567890|Could not build preview/);
  assert.deepEqual(await readFile(join(f.b.home, 'config.toml')), before);
  await absent(join(f.store.directory, 'native-copies'));
});
