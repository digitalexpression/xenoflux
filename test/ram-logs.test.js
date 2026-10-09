import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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

test('preparation after RAM loss skips the dangling main link but checks existing sidecars', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite');
  await f.manager.prepareHome(f); await f.unmount();
  await writeFile(source + '-wal', 'local diagnostic sidecar');
  let checked = [];
  const busy = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk,
    execFile: async (_file, args) => { checked = args.slice(args.indexOf('--') + 1); return { stdout: 'p42\n', stderr: '' }; } });
  await assert.rejects(busy.prepareHome(f), /Quit applications/);
  assert.deepEqual(checked, [source + '-wal']);
  assert.equal(await readFile(source + '-wal', 'utf8'), 'local diagnostic sidecar');
  assert.equal(await readlink(source), f.target);
  await rm(source + '-wal');
  const idle = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk,
    execFile: async () => assert.fail('a dangling main link with no sidecars must not be sent to lsof') });
  await idle.prepareHome(f);
  assert.equal(await readlink(source), f.target);
  assert.ok((await lstat(f.target)).isFile());
});

test('native handle probe accepts preparation after a lost RAM target', async t => {
  try { await lstat('/usr/sbin/lsof'); } catch { return t.skip('native lsof unavailable'); }
  const f = await fixture(t);
  await f.manager.prepareHome(f); await f.unmount();
  await writeFile(join(f.home, 'logs_2.sqlite-wal'), 'closed fixture sidecar');
  const native = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk });
  await native.prepareHome(f);
  assert.equal(await readlink(join(f.home, 'logs_2.sqlite')), f.target);
  assert.ok((await lstat(f.target)).isFile());
});

test('explicit archive recovery preserves disk logs and archives the complete RAM file set', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite'), recoveryRoot = join(f.root, 'recovery');
  await f.manager.prepareHome(f);
  await rm(source); await writeFile(source, 'disk main'); await writeFile(source + '-wal', 'disk WAL');
  await writeFile(f.target, 'RAM main'); await writeFile(f.target + '-wal', 'RAM WAL');
  await writeFile(f.target + '-shm', 'RAM SHM');
  const result = await f.manager.archiveHome({ ...f, recoveryRoot });
  assert.equal(result.archived, true);
  assert.deepEqual(result.files.map(file => file.sha256).length, 3);
  assert.equal(await readFile(join(result.archive, 'logs_2.sqlite'), 'utf8'), 'RAM main');
  assert.equal(await readFile(join(result.archive, 'logs_2.sqlite-wal'), 'utf8'), 'RAM WAL');
  assert.equal(await readFile(join(result.archive, 'logs_2.sqlite-shm'), 'utf8'), 'RAM SHM');
  assert.equal(await readFile(join(result.archive, 'disk', 'logs_2.sqlite'), 'utf8'), 'disk main');
  assert.equal(await readFile(join(result.archive, 'disk', 'logs_2.sqlite-wal'), 'utf8'), 'disk WAL');
  const manifest = JSON.parse(await readFile(join(result.archive, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.files[0].source, f.target);
  assert.equal(manifest.files[0].sha256, result.files[0].sha256);
  assert.equal(manifest.diskFiles.length, 2);
  assert.equal(manifest.diskFiles[0].sha256, resultHash('disk main'));
  assert.equal(await readFile(source, 'utf8'), 'disk main');
  assert.equal(await readFile(source + '-wal', 'utf8'), 'disk WAL');
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  const diskOnly = await f.manager.archiveHome({ ...f, recoveryRoot });
  assert.equal(diskOnly.archived, true);
  assert.equal(diskOnly.files.length, 0);
  assert.equal(await readFile(join(diskOnly.archive, 'disk', 'logs_2.sqlite'), 'utf8'), 'disk main');
});

test('archive recovery fails closed for busy logs, unexpected entries, and unsafe disk files', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite'), recoveryRoot = join(f.root, 'recovery');
  await f.manager.prepareHome(f); await rm(source); await writeFile(source, 'disk'); await writeFile(f.target, 'RAM');
  f.setBusy(true);
  await assert.rejects(f.manager.archiveHome({ ...f, recoveryRoot }), /Quit applications/);
  assert.equal(await readFile(f.target, 'utf8'), 'RAM');
  f.setBusy(false);
  await writeFile(join(f.mountPath, `xenoflux-${process.getuid()}`, f.key, 'unexpected'), 'keep');
  await assert.rejects(f.manager.archiveHome({ ...f, recoveryRoot }), /Unexpected entries/);
  assert.equal(await readFile(f.target, 'utf8'), 'RAM');
  await rm(join(f.mountPath, `xenoflux-${process.getuid()}`, f.key, 'unexpected'));
  await rm(source); await symlink(join(f.root, 'elsewhere'), source);
  await assert.rejects(f.manager.archiveHome({ ...f, recoveryRoot }), /ordinary disk-backed/);
  assert.equal(await readlink(source), join(f.root, 'elsewhere'));
});

test('archive recovery retains its copy and original when RAM contents change during copying', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite'), recoveryRoot = join(f.root, 'recovery');
  await f.manager.prepareHome(f); await rm(source); await writeFile(source, 'disk'); await writeFile(f.target, 'before');
  const changing = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk,
    execFile: async () => { await writeFile(f.target, 'after'); return { stdout: '', stderr: '' }; } });
  await assert.rejects(changing.archiveHome({ ...f, recoveryRoot }), error => {
    assert.match(error.message, /archive verification failed/);
    assert.match(error.message, /recovery archive retained at/);
    return true;
  });
  assert.equal(await readFile(f.target, 'utf8'), 'after');
  const archives = await import('node:fs/promises').then(fs => fs.readdir(recoveryRoot));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(recoveryRoot, archives[0], 'logs_2.sqlite'), 'utf8'), 'after');
  assert.equal(await readFile(source, 'utf8'), 'disk');
});

test('archive recovery records its archive path and manifest if disk logs change before deletion', async t => {
  const f = await fixture(t), source = join(f.home, 'logs_2.sqlite'), recoveryRoot = join(f.root, 'recovery');
  await f.manager.prepareHome(f); await rm(source); await writeFile(source, 'disk before'); await writeFile(f.target, 'RAM');
  let probes = 0;
  const changing = createRamLogs({ mountPath: f.mountPath, registry: f.registry, disk: f.disk,
    execFile: async () => {
      if (++probes === 2) await writeFile(source, 'disk after');
      return { stdout: '', stderr: '' };
    } });
  await assert.rejects(changing.archiveHome({ ...f, recoveryRoot }), error => {
    assert.match(error.message, /Disk diagnostic files changed during archiving/);
    assert.match(error.message, /recovery archive retained at (.+)$/);
    return true;
  });
  assert.equal(await readFile(source, 'utf8'), 'disk after');
  assert.equal(await readFile(f.target, 'utf8'), 'RAM');
  const [directory] = await import('node:fs/promises').then(fs => fs.readdir(recoveryRoot));
  const manifest = JSON.parse(await readFile(join(recoveryRoot, directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files[0].sha256, resultHash('RAM'));
});

test('archive recovery snapshots disk-only diagnostics and allows a fresh missing-log home', async t => {
  const f = await fixture(t), recoveryRoot = join(f.root, 'recovery');
  assert.deepEqual(await f.manager.archiveHome({ ...f, recoveryRoot }), { archived: false, files: [], persistent: true });
  await f.manager.ensureMounted();
  const source = join(f.home, 'logs_2.sqlite');
  await writeFile(source, 'disk only main'); await writeFile(source + '-wal', 'disk only WAL');
  const result = await f.manager.archiveHome({ ...f, recoveryRoot });
  assert.equal(result.files.length, 0);
  assert.equal(result.diskFiles.length, 2);
  assert.equal(await readFile(join(result.archive, 'disk', 'logs_2.sqlite'), 'utf8'), 'disk only main');
  assert.equal(await readFile(join(result.archive, 'disk', 'logs_2.sqlite-wal'), 'utf8'), 'disk only WAL');
});

test('archive recovery refuses RAM-only diagnostics without an ordinary disk main', async t => {
  const f = await fixture(t), recoveryRoot = join(f.root, 'recovery');
  await f.manager.ensureMounted();
  await mkdir(join(f.mountPath, `xenoflux-${process.getuid()}`, f.key), { recursive: true, mode: 0o700 });
  await writeFile(f.target, 'RAM only');
  await assert.rejects(f.manager.archiveHome({ ...f, recoveryRoot }), /ordinary disk-backed diagnostic log/);
  assert.equal(await readFile(f.target, 'utf8'), 'RAM only');
});

function resultHash(value) {
  return createHash('sha256').update(value).digest('hex');
}
