import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRamLogs, ramLogTarget } from '../src/ram-logs.js';

async function fixture(t, key = randomUUID()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ram-logs-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mountPath = join(root, 'ram'), registry = join(root, 'registry'), home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  let mounted = false, mounts = 0, busy = false;
  const disk = {
    ensure: async () => { mounts++; await mkdir(mountPath, { recursive: true }); mounted = true; return mountPath; },
    inspect: async () => ({ mounted, path: mountPath, status: mounted ? 'mounted' : 'absent' }),
  };
  const manager = createRamLogs({ mountPath, registry, disk, execFile: async () => ({ stdout: busy ? 'p42\n' : '', stderr: '' }) });
  return { root, mountPath, registry, home, key, manager, disk, get mounts() { return mounts; },
    target: ramLogTarget(key, { mountPath }), setBusy: value => { busy = value; },
    unmount: async () => { await rm(mountPath, { recursive: true }); mounted = false; } };
}

test('inspection is read-only before first launch and while RAM storage is absent', async t => {
  const f = await fixture(t);
  const status = await f.manager.inspect(f);
  assert.equal(status.mounted, false); assert.equal(status.state, 'pending-first-launch');
  assert.equal(f.mounts, 0);
  await assert.rejects(lstat(f.registry), { code: 'ENOENT' });
  await f.manager.prepareHome(f);
  await f.unmount();
  const after = await f.manager.inspect(f);
  assert.equal(after.state, 'unavailable'); assert.equal(after.linked, true);
  assert.equal(f.mounts, 1);
});

test('Default and named profiles retain separate current-boot logs through repeated preparation', async t => {
  const f = await fixture(t, 'default'), other = join(f.root, 'other'), key = randomUUID();
  await mkdir(other, { mode: 0o700 });
  await writeFile(join(f.home, 'logs_2.sqlite'), 'A diagnostic log');
  await writeFile(join(f.home, 'logs_2.sqlite-wal'), 'A pending WAL');
  await writeFile(join(other, 'logs_2.sqlite'), 'B diagnostic log');
  await writeFile(join(f.home, 'state_5.sqlite'), 'history stays here');
  await f.manager.prepareHome(f);
  const second = await f.manager.prepareHome({ home: other, key });
  assert.notEqual(second.target, f.target);
  assert.equal(await readlink(join(f.home, 'logs_2.sqlite')), f.target);
  assert.equal(await readFile(f.target, 'utf8'), 'A diagnostic log');
  assert.equal(await readFile(f.target + '-wal', 'utf8'), 'A pending WAL');
  assert.equal(await readFile(second.target, 'utf8'), 'B diagnostic log');
  assert.equal(await readFile(join(f.home, 'state_5.sqlite'), 'utf8'), 'history stays here');
  await writeFile(f.target, 'new A log');
  await f.manager.prepareHome(f);
  assert.equal(await readFile(f.target, 'utf8'), 'new A log');
  await assert.rejects(lstat(join(f.home, 'logs_2.sqlite-wal')), { code: 'ENOENT' });
});

test('login mounting recreates registered parent directories after reboot without touching homes', async t => {
  const f = await fixture(t);
  await f.manager.prepareHome(f);
  await writeFile(f.target, 'disposable');
  await f.unmount();
  await f.manager.ensureMounted();
  assert.equal(await readlink(join(f.home, 'logs_2.sqlite')), f.target);
  // SQLite creates a missing target through the retained symlink, with WAL on RAM.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(f.home, 'logs_2.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE logs(message TEXT); INSERT INTO logs VALUES (\'new boot\')');
    assert.ok((await lstat(f.target + '-wal')).isFile());
    assert.equal(db.prepare('SELECT message FROM logs').get().message, 'new boot');
  } finally { db.close(); }
});

test('busy logs, unexpected links and mount failures prevent replacement', async t => {
  const f = await fixture(t), file = join(f.home, 'logs_2.sqlite');
  await writeFile(file, 'keep'); f.setBusy(true);
  await assert.rejects(f.manager.prepareHome(f), /Quit applications/);
  assert.equal(await readFile(file, 'utf8'), 'keep'); assert.ok((await lstat(file)).isFile());
  f.setBusy(false); await rm(file); await symlink(join(f.root, 'unrelated'), file);
  await assert.rejects(f.manager.prepareHome(f), /outside this profile/);
  assert.equal(await readlink(file), join(f.root, 'unrelated'));
  f.disk.ensure = async () => { throw new Error('mount unavailable'); };
  await assert.rejects(f.manager.prepareHome(f), { code: 'RAM_LOGS_UNAVAILABLE' });
});

test('conflicting existing RAM logs and linked sidecars are preserved', async t => {
  const f = await fixture(t);
  await f.manager.prepareHome(f);
  await writeFile(f.target, 'RAM data');
  await rm(join(f.home, 'logs_2.sqlite')); await writeFile(join(f.home, 'logs_2.sqlite'), 'other local data');
  await assert.rejects(f.manager.prepareHome(f), /different contents/);
  assert.equal(await readFile(f.target, 'utf8'), 'RAM data');
  assert.equal(await readFile(join(f.home, 'logs_2.sqlite'), 'utf8'), 'other local data');
  await symlink(join(f.root, 'other'), join(f.home, 'logs_2.sqlite-wal'));
  await assert.rejects(f.manager.prepareHome(f), /Unsafe diagnostic/);
});

test('a replaced mount directory cannot receive logs or replace the source database', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite');
  await writeFile(source, 'keep local logs');
  // Simulate forced unmount after handle inspection, leaving a writable host
  // directory with the same name. An ordinary unmount sees our open volume FD.
  const manager = createRamLogs({ disk: f.disk, mountPath: f.mountPath, registry: f.registry,
    execFile: async () => {
      await f.unmount();
      await mkdir(f.mountPath);
      return { stdout: '', stderr: '' };
    } });
  await assert.rejects(manager.prepareHome(f), /RAM disk disappeared/);
  assert.ok((await lstat(source)).isFile());
  assert.equal(await readFile(source, 'utf8'), 'keep local logs');
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
});

test('login setup refuses a mount lost between ensure and inspection', async t => {
  const f = await fixture(t);
  f.disk.inspect = async () => {
    await f.unmount();
    await mkdir(f.mountPath);
    return { mounted: false, path: f.mountPath, status: 'collision' };
  };
  await assert.rejects(f.manager.ensureMounted(), /RAM disk disappeared/);
  await assert.rejects(lstat(join(f.mountPath, `xenoflux-${process.getuid()}`)), { code: 'ENOENT' });
});

test('disabled mode never mounts or creates RAM routing, and reports a retained link', async t => {
  const f = await fixture(t);
  const disabled = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk, enabled: false,
    execFile: async () => assert.fail('disabled mode must not inspect open handles') });
  const before = await disabled.inspect(f);
  assert.deepEqual({ kind: before.kind, enabled: before.enabled, state: before.state },
    { kind: 'disk', enabled: false, state: 'disk' });
  await disabled.ensureMounted(); await disabled.prepareHome(f);
  assert.equal(f.mounts, 0);
  await f.manager.prepareHome(f);
  const retained = await disabled.inspect(f);
  assert.equal(retained.state, 'restore-required'); assert.equal(retained.linked, true);
  await assert.rejects(disabled.prepareHome(f), /explicit restoration/);
  assert.equal(f.mounts, 1);
});

test('restoration resets owned disposable RAM diagnostics to a private disk file', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite');
  await f.manager.prepareHome(f);
  await writeFile(f.target, 'current RAM diagnostics');
  await writeFile(source + '-wal', 'stale local WAL');
  const result = await f.manager.restoreHome(f);
  assert.equal(result.restored, true); assert.equal(result.kind, 'disk');
  assert.equal(await readFile(source, 'utf8'), '');
  assert.equal(result.diagnosticsReset, true);
  assert.ok((await lstat(source)).isFile());
  await assert.rejects(readlink(source), { code: 'EINVAL' });
  await assert.rejects(lstat(source + '-wal'), { code: 'ENOENT' });
  assert.equal((await f.manager.restoreHome(f)).restored, false);
});

test('restoration repairs a dangling owned RAM link without mounting and preserves foreign links', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite');
  await f.manager.prepareHome(f); await f.unmount();
  await symlink(join(f.root, 'foreign-log'), source + '-wal');
  await assert.rejects(f.manager.restoreHome(f), { code: 'RAM_LOGS_UNAVAILABLE' });
  assert.equal(await readlink(source), f.target);
  await rm(source + '-wal');
  const absentVolume = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk,
    execFile: async () => assert.fail('a dangling RAM link must not be sent to lsof') });
  const restored = await absentVolume.restoreHome(f);
  assert.equal(restored.restored, true); assert.ok((await lstat(source)).isFile());
  assert.equal((await lstat(source)).size, 0);
});

test('restoration refuses open handles, foreign links and an unowned home', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite');
  await f.manager.prepareHome(f); f.setBusy(true);
  await assert.rejects(f.manager.restoreHome(f), /Quit applications/);
  assert.equal(await readlink(source), f.target);
  f.setBusy(false); await rm(source); await symlink(join(f.root, 'foreign-log'), source);
  await assert.rejects(f.manager.restoreHome(f), /not owned RAM storage/);
  const otherUid = createRamLogs({ mountPath: f.mountPath, registry: join(f.root, 'other-registry'), disk: f.disk,
    uid: process.getuid() + 1, execFile: async () => ({ stdout: '', stderr: '' }) });
  await assert.rejects(otherUid.restoreHome(f), /canonical owned home/);
});

test('restoration cancellation leaves the exact link in place and a retry succeeds', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite'), controller = new AbortController();
  await f.manager.prepareHome(f); await writeFile(f.target, 'keep this data');
  const interrupted = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk,
    execFile: async () => { controller.abort(); return { stdout: '', stderr: '' }; } });
  await assert.rejects(interrupted.restoreHome({ ...f, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(await readlink(source), f.target);
  await f.manager.restoreHome(f);
  assert.equal(await readFile(source, 'utf8'), '');
});

test('ordinary disk diagnostics and their WAL remain untouched', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite');
  await writeFile(source, 'durable disk main');
  await writeFile(source + '-wal', 'committed disk WAL');
  const result = await f.manager.restoreHome(f);
  assert.equal(result.restored, false); assert.equal(result.cleanedSidecars, undefined);
  assert.equal(await readFile(source, 'utf8'), 'durable disk main');
  assert.equal(await readFile(source + '-wal', 'utf8'), 'committed disk WAL');
});

test('disk logs reopen after RAM and the old registry are gone, before replacement setup', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite');
  await f.manager.prepareHome(f);
  await f.unmount();
  await f.manager.restoreHome(f);
  await rm(f.registry, {recursive:true});
  const diskMode = createRamLogs({enabled:false, registry:join(f.root,'new-registry'), disk:f.disk, mountPath:f.mountPath});
  await diskMode.prepareHome(f);
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE logs(message TEXT); INSERT INTO logs VALUES ('replacement interrupted')");
    assert.equal(db.prepare('SELECT message FROM logs').get().message, 'replacement interrupted');
  } finally { db.close(); }
  assert.equal((await f.disk.inspect()).mounted, false);
  assert.ok((await lstat(source)).isFile());
  await assert.rejects(lstat(join(f.root,'new-registry')), {code:'ENOENT'});
});
