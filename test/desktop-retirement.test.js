import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../bin/xfx.js', import.meta.url).pathname;

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

test('legacy desktop controls have no CLI path and do not create a controller', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-desktop-retirement-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = join(root, 'missing-store');
  const cases = [
    [['desktop', 'switch', 'Research', '--dry-run']],
    [['desktop', 'pick', '--dry-run']],
    [['desktop', 'activate', 'Research', '--dry-run']],
    [['desktop', 'activation-plan', 'Research']],
    [['desktop', 'add-target', 'Research']],
    [['desktop', 'current', '--observe']],
    [['desktop', 'restore']],
    [['desktop', 'recover']],
    [['desktop', 'recover', '--no-open']],
  ];
  for (const [args] of cases) {
    const result = await run(['--store', store, ...args]);
    assert.equal(result.code, 1, args.join(' ') + ': ' + result.stderr);
    assert.ok(/Invalid desktop command|Unknown option: --no-open|is not supported by desktop/.test(result.stderr), result.stderr);
    await assert.rejects(access(store));
  }
  const prepare = await run(['--store', store, 'desktop', 'prepare', 'Research']);
  assert.equal(prepare.code, 1);
  assert.match(prepare.stderr, /external interactive terminal/);
  await assert.rejects(access(store));
  const refreshAlias = await run(['--store', store, '--json', 'desktop', 'refresh', 'Research']);
  assert.equal(refreshAlias.code, 1);
  assert.doesNotMatch(refreshAlias.stderr, /Invalid desktop command/);
  const dryRun = await run(['--store', store, 'desktop', 'prepare', 'Research', '--dry-run']);
  assert.equal(dryRun.code, 1);
  assert.doesNotMatch(dryRun.stderr, /Invalid desktop command|not supported by desktop/);
  const closeFlag = await run(['--store', store, 'desktop', 'refresh', 'Research', '--close-clients']);
  assert.equal(closeFlag.code, 1);
  assert.match(closeFlag.stderr, /--close-clients is not supported by desktop/);
});

test('help advertises only named desktop controls while retaining the CLI picker', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /desktop open NAME/);
  assert.match(result.stdout, /desktop prepare NAME/);
  assert.match(result.stdout, /desktop refresh NAME/);
  assert.match(result.stdout, /desktop recover NAME/);
  for (const retired of ['desktop switch', 'desktop pick', 'desktop activate', 'desktop activation-plan', 'desktop add-target',
    'desktop current', 'desktop restore', 'desktop recover --no-open'])
    assert.doesNotMatch(result.stdout, new RegExp(retired));
  assert.match(result.stdout, /pick \[--repo DIRECTORY\]/);
});

test('removed desktop-only options are unknown on supported commands before controller lookup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-desktop-options-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = join(root, 'missing-store');
  for (const [option, value] of [['--approved-plan', join(root, 'plan.json')], ['--desktop-data', join(root, 'data')]]) {
    const result = await run(['--store', store, 'desktop', 'open', 'Research', option, value]);
    assert.equal(result.code, 1, option + ': ' + result.stderr);
    assert.match(result.stderr, new RegExp('Unknown option: ' + option));
    await assert.rejects(access(store));
  }
});
