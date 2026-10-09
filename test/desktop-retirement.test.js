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

test('retired desktop selection commands fail before looking up or creating a controller', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-desktop-retirement-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = join(root, 'missing-store');
  const cases = [
    [['desktop', 'switch', 'Research', '--dry-run'], 'switch'],
    [['desktop', 'pick', '--dry-run'], 'pick'],
    [['desktop', 'activate', 'Research', '--dry-run'], 'activate'],
    [['desktop', 'activate', 'Research', '--approved-plan', join(root, 'plan.json')], 'activate'],
    [['desktop', 'activate', 'Research', '--desktop-data', join(root, 'data')], 'activate'],
    [['desktop', 'activation-plan', 'Research'], 'activation-plan'],
    [['desktop', 'add-target', 'Research', '--approved-plan', join(root, 'plan.json')], 'add-target'],
  ];
  for (const [args, operation] of cases) {
    const result = await run(['--store', store, ...args]);
    assert.equal(result.code, 1, args.join(' ') + ': ' + result.stderr);
    assert.match(result.stderr, new RegExp('Legacy desktop ' + operation + ' is retired'));
    assert.match(result.stderr, /xfx desktop open NAME/);
    await assert.rejects(access(store));
  }
});

test('help keeps supported controls without advertising retired desktop selection', async () => {
  const result = await run(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /desktop open NAME/);
  assert.match(result.stdout, /desktop current \[--observe\] \| desktop restore \| desktop recover/);
  for (const retired of ['desktop switch', 'desktop pick', 'desktop activate', 'desktop activation-plan', 'desktop add-target'])
    assert.doesNotMatch(result.stdout, new RegExp(retired));
  assert.match(result.stdout, /pick \[--repo DIRECTORY\]/);
});

test('retired desktop-only options are rejected on supported commands before controller lookup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-desktop-options-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const store = join(root, 'missing-store');
  for (const [option, value] of [['--approved-plan', join(root, 'plan.json')], ['--desktop-data', join(root, 'data')]]) {
    const result = await run(['--store', store, 'desktop', 'open', 'Research', option, value]);
    assert.equal(result.code, 1, option + ': ' + result.stderr);
    assert.match(result.stderr, new RegExp(option + ' is not supported by desktop'));
    await assert.rejects(access(store));
  }
});
