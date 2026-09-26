import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPairedPathFixture } from '../test-support/paired-path-fixture.js';

const moduleUrl = new URL('../test-support/paired-path-fixture.js', import.meta.url).href;

async function fixture(t) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'xfx-paired-path-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const path = join(parent, 'fixture'), lab = createPairedPathFixture(path);
  await lab.init();
  return { parent, path, lab };
}

const ids = paths => Promise.all(paths.map(async path => {
  const s = await lstat(path);
  return { device: s.dev, inode: s.ino };
}));
const sameIds = (actual, expected) => assert.deepEqual(actual, expected);

function interrupted(path, target, event) {
  const source = `import { createPairedPathFixture } from ${JSON.stringify(moduleUrl)};
    await createPairedPathFixture(process.argv[1]).switchTo(process.argv[2], {
      checkpoint: async event => { if (event === process.argv[3]) process.exit(86); }
    });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, path, target, event], { encoding: 'utf8' });
  assert.equal(result.status, 86, result.stderr);
}

function componentPaths(info) { return info.components.flatMap(component => [component.alias, component.original, component.targets.A, component.targets.B]); }
async function writeActiveProfile(info, label) {
  for (const component of info.components) for (const file of ['settings.fixture', 'history.fixture'])
    await writeFile(join(component.alias, file), `${label}:${component.name}:${file}`, { mode: 0o600 });
}
async function assertActiveProfile(info, label) {
  for (const component of info.components) for (const file of ['settings.fixture', 'history.fixture'])
    assert.equal(await readFile(join(component.alias, file), 'utf8'), `${label}:${component.name}:${file}`);
}

test('initializes a new synthetic fixture and round-trips both aliases through A, B, and Default', async t => {
  const f = await fixture(t), initial = await f.lab.inspect();
  assert.equal(initial.state, 'fixture-only');
  assert.equal(initial.selected, 'Default');
  assert.equal(initial.recoveryRequired, false);
  assert.deepEqual(initial.components.map(component => component.state), ['Default', 'Default']);
  assert.ok(componentPaths(initial).every(path => path.startsWith(f.path)));
  const originalIds = await ids(initial.components.map(component => component.alias));
  for (const component of initial.components) await writeFile(join(component.alias, `${component.name}.sentinel`), component.name, { mode: 0o600 });
  const events = [];
  await f.lab.switchTo('A', { checkpoint: async event => events.push(event) });
  assert.deepEqual(events, ['prepared', 'codex-home:original-preserved', 'codex-home:link-staged', 'codex-home:alias-installed',
    'desktop-data:original-preserved', 'desktop-data:link-staged', 'desktop-data:alias-installed', 'committed']);
  await writeActiveProfile(await f.lab.inspect(), 'A');
  await f.lab.switchTo('B');
  await writeActiveProfile(await f.lab.inspect(), 'B');
  await f.lab.switchTo('A');
  await assertActiveProfile(await f.lab.inspect(), 'A');
  interrupted(f.path, 'B', 'desktop-data:alias-installed');
  assert.equal((await f.lab.recover()).recovered, true);
  await assertActiveProfile(await f.lab.inspect(), 'A');
  await f.lab.switchTo('B');
  await assertActiveProfile(await f.lab.inspect(), 'B');
  await f.lab.restore();
  const restored = await f.lab.inspect();
  assert.equal(restored.selected, 'Default');
  sameIds(await ids(restored.components.map(component => component.alias)), originalIds);
  for (const component of restored.components)
    assert.equal(await readFile(join(component.alias, `${component.name}.sentinel`), 'utf8'), component.name);
});

test('crash recovery rolls back every initial activation mutation checkpoint', async t => {
  for (const event of ['codex-home:original-preserved', 'codex-home:link-staged', 'codex-home:alias-installed',
    'desktop-data:original-preserved', 'desktop-data:link-staged', 'desktop-data:alias-installed']) await t.test(event, async t => {
    const f = await fixture(t), before = await f.lab.inspect(), originalIds = await ids(before.components.map(component => component.alias));
    interrupted(f.path, 'A', event);
    assert.equal((await f.lab.inspect()).recoveryRequired, true);
    const recovered = await f.lab.recover();
    assert.equal(recovered.recovered, true);
    const after = await f.lab.inspect();
    assert.equal(after.selected, 'Default');
    sameIds(await ids(after.components.map(component => component.alias)), originalIds);
  });
});

test('crash recovery rolls back every profile-switch and restoration mutation checkpoint', async t => {
  for (const [from, to, events] of [
    ['A', 'B', ['codex-home:link-staged', 'codex-home:alias-installed', 'desktop-data:link-staged', 'desktop-data:alias-installed']],
    ['A', 'Default', ['codex-home:alias-removed', 'codex-home:original-restored', 'desktop-data:alias-removed', 'desktop-data:original-restored']],
  ]) await t.test(`${from}->${to}`, async t => {
    for (const event of events) await t.test(event, async t => {
      const f = await fixture(t);
      await f.lab.switchTo(from);
      interrupted(f.path, to, event);
      assert.equal((await f.lab.recover()).recovered, true);
      assert.equal((await f.lab.inspect()).selected, from);
    });
  });
});

test('an interrupted recovery can itself be recovered, while committed switches retain the new selection', async t => {
  const f = await fixture(t);
  const initial = await f.lab.inspect(), shared = join(f.path, 'shared-resource');
  await mkdir(shared, { mode: 0o700 });
  await writeFile(join(shared, 'sentinel'), 'shared-resource-sentinel', { mode: 0o600 });
  await symlink(shared, join(initial.components[0].alias, 'shared-link'));
  await f.lab.switchTo('A');
  interrupted(f.path, 'B', 'desktop-data:alias-installed');
  const source = `import { createPairedPathFixture } from ${JSON.stringify(moduleUrl)};
    await createPairedPathFixture(process.argv[1]).recover({ checkpoint: async event => { if (event === 'recover:codex-home:alias-installed') process.exit(87); } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.path], { encoding: 'utf8' });
  assert.equal(child.status, 87, child.stderr);
  assert.equal((await f.lab.recover()).recovered, true);
  assert.equal((await f.lab.inspect()).selected, 'A');
  assert.equal(await readFile(join(shared, 'sentinel'), 'utf8'), 'shared-resource-sentinel');
  assert.equal((await f.lab.recover()).recovered, false);

  const committed = await fixture(t);
  await committed.lab.switchTo('A');
  interrupted(committed.path, 'B', 'committed');
  assert.equal((await committed.lab.recover()).recovered, false);
  assert.equal((await committed.lab.inspect()).selected, 'B');
});

test('excludes concurrent writers while a checkpoint holds the paired lock', async t => {
  const f = await fixture(t);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const acquired = new Promise(resolve => { entered = resolve; });
  const switching = f.lab.switchTo('A', { checkpoint: async event => { if (event === 'prepared') { entered(); await held; } } });
  await acquired;
  await assert.rejects(f.lab.switchTo('B'), /locked/);
  await assert.rejects(f.lab.recover(), /writer is still running/);
  release();
  assert.equal((await switching).selected, 'A');
});

test('refuses replaced original, parent, target, or staged paths and preserves foreign data', async t => {
  for (const kind of ['original', 'parent', 'target', 'stage']) await t.test(kind, async t => {
    const f = await fixture(t), initial = await f.lab.inspect();
    const phase = kind === 'stage' ? 'codex-home:link-staged' : kind === 'original' ? 'codex-home:original-preserved' : 'prepared';
    interrupted(f.path, 'A', phase);
    const codex = initial.components[0];
    let foreign;
    if (kind === 'original') {
      foreign = codex.original; await rm(foreign, { recursive: true }); await mkdir(foreign);
    } else if (kind === 'parent') {
      foreign = join(f.path, 'normal-home'); await rm(foreign, { recursive: true }); await mkdir(foreign);
    } else if (kind === 'target') {
      foreign = codex.targets.A; await rm(foreign, { recursive: true }); await mkdir(foreign);
    } else {
      foreign = join(f.path, 'normal-home', `.xfx-next-${(await f.lab.inspect()).journal.id}-codex-home`);
      await unlink(foreign); await mkdir(foreign);
    }
    await writeFile(join(foreign, 'foreign'), `${kind}-sentinel`, { mode: 0o600 });
    await assert.rejects(f.lab.recover());
    assert.equal(await readFile(join(foreign, 'foreign'), 'utf8'), `${kind}-sentinel`);
  });
});

test('refuses existing, native-like, and symlink fixture roots without adopting them', async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'xfx-paired-path-roots-')));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const existing = join(parent, 'existing');
  await mkdir(existing); await writeFile(join(existing, 'foreign'), 'keep', { mode: 0o600 });
  await assert.rejects(createPairedPathFixture(existing).init(), { code: 'EEXIST' });
  await assert.rejects(createPairedPathFixture(join(parent, '.codex', 'fixture')).init(), /outside Codex/);
  const target = join(parent, 'target'); await mkdir(target);
  const linked = join(parent, 'linked'); await symlink(target, linked);
  await assert.rejects(createPairedPathFixture(linked).init(), { code: 'EEXIST' });
  assert.equal(await readFile(join(existing, 'foreign'), 'utf8'), 'keep');
});
