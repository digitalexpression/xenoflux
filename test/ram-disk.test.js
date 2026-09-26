import test from 'node:test';
import assert from 'node:assert/strict';
import { createRamDisk, RAM_MOUNT } from '../src/ram-disk.js';

const ram = (disk, imagePath = 'ram://524288') => ({ images: [{ 'image-path': imagePath, 'system-entities': [{ 'dev-entry': `/dev/${disk}` }] }] });
function fixture({ present = false, volume = 'disk9s1', ramBacked = true, eraseFails = false, infoImagePath, filesystem = 'hfs' } = {}) {
  const calls = [], files = new Map(), dirs = new Set(), inodes = new Map();
  let nextInode = 10;
  const directoryNode = path => ({ uid: process.getuid(), dev: 1, ino: inodes.get(path) ?? (inodes.set(path, nextInode), nextInode++), mode: 0o40700,
    isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false });
  const fs = {
    async lstat(path) {
      if (path === RAM_MOUNT) {
        if (!present) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return directoryNode(path);
      }
      if (dirs.has(path)) return directoryNode(path);
      if (files.has(path)) return { uid: process.getuid(), mode: 0o100600, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    async access() {}, async mkdtemp(path) { return `${path}fixture`; },
    async open(path) {
      const node = await fs.lstat(path);
      return { stat: async () => node, close: async () => {} };
    },
    async mkdir(path) { if (dirs.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); dirs.add(path); inodes.set(path, nextInode++); },
    async readFile(path) { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(path); },
    async rm(path) { dirs.delete(path); inodes.delete(path); for (const key of files.keys()) if (key.startsWith(path)) files.delete(key); },
    async rename(from, to) { dirs.delete(from); dirs.add(to); inodes.set(to, inodes.get(from)); inodes.delete(from); for (const [key, value] of [...files]) if (key.startsWith(from)) { files.delete(key); files.set(`${to}${key.slice(from.length)}`, value); } },
    async unlink(path) { files.delete(path); },
    async writeFile(path, data) { files.set(path, data); },
  };
  const execFile = async (file, args) => {
    calls.push([file, args]);
    if (file.endsWith('diskutil') && args[0] === 'info') {
      if (!present) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { stdout: 'disk' };
    }
    if (file.endsWith('hdiutil') && args[0] === 'info') return { stdout: 'hdi' };
    if (file.endsWith('hdiutil') && args[0] === 'attach') { present = true; return { stdout: 'attach' }; }
    if (file.endsWith('diskutil') && args[0] === 'eraseVolume') {
      if (eraseFails) throw new Error('format failed');
      return { stdout: '' };
    }
    if (file.endsWith('hdiutil') && args[0] === 'detach') return { stdout: '' };
    throw new Error(`unexpected command ${file}`);
  };
  const parsePlist = text => text === 'disk' ? { DeviceIdentifier: volume, MountPoint: RAM_MOUNT, FilesystemType: filesystem }
    : text === 'attach' ? { 'system-entities': [{ 'dev-entry': '/dev/disk9' }] } : ramBacked ? ram('disk9', infoImagePath) : { images: [] };
  return { calls, fs, execFile, parsePlist, files, dirs };
}

test('creates, validates, formats only its fresh RAM device, and verifies writability', async () => {
  const f = fixture();
  const manager = createRamDisk({ ...f, platform: 'darwin', uuid: () => 'token' });
  assert.equal(await manager.ensure(), RAM_MOUNT);
  const erase = f.calls.find(([, args]) => args[0] === 'eraseVolume');
  assert.deepEqual(erase[1], ['eraseVolume', 'HFS+', 'CodexRAM', '/dev/disk9']);
  assert.equal((await manager.inspect()).mounted, true);
});

test('refuses a pre-existing non-RAM volume without destructive commands', async () => {
  const f = fixture({ present: true, ramBacked: false });
  const manager = createRamDisk({ ...f, platform: 'darwin' });
  await assert.rejects(manager.ensure(), /Refusing/);
  assert.equal(f.calls.some(([, args]) => args[0] === 'eraseVolume' || args[0] === 'attach'), false);
  assert.equal((await manager.inspect()).status, 'collision');
});

test('refuses an existing RAM volume with the wrong size or filesystem', async () => {
  for (const options of [{ present: true, infoImagePath: 'ram://1' }, { present: true, filesystem: 'apfs' }]) {
    const f = fixture(options);
    const manager = createRamDisk({ ...f, platform: 'darwin' });
    await assert.rejects(manager.ensure(), /Refusing/);
    assert.equal(f.calls.some(([, args]) => args[0] === 'eraseVolume' || args[0] === 'attach'), false);
    assert.equal((await manager.inspect()).status, 'collision');
  }
});

test('detaches only the fresh validated device if formatting fails', async () => {
  const f = fixture({ eraseFails: true });
  const manager = createRamDisk({ ...f, platform: 'darwin' });
  await assert.rejects(manager.ensure(), /format failed/);
  assert.deepEqual(f.calls.find(([, args]) => args[0] === 'detach')[1], ['detach', '/dev/disk9']);
});

test('requires the exact requested ram:// image path after attach', async () => {
  const f = fixture({ infoImagePath: 'ram://1' });
  const manager = createRamDisk({ ...f, platform: 'darwin' });
  await assert.rejects(manager.ensure(), /could not be validated/);
  assert.equal(f.calls.some(([, args]) => args[0] === 'eraseVolume'), false);
  assert.deepEqual(f.calls.find(([, args]) => args[0] === 'detach')[1], ['detach', '/dev/disk9']);
});

test('coalesces concurrent ensure calls', async () => {
  const f = fixture();
  const manager = createRamDisk({ ...f, platform: 'darwin', uuid: () => Math.random().toString() });
  assert.deepEqual(await Promise.all([manager.ensure(), manager.ensure()]), [RAM_MOUNT, RAM_MOUNT]);
  assert.equal(f.calls.filter(([, args]) => args[0] === 'attach').length, 1);
});

test('inspect is read-only and reports an absent volume', async () => {
  const f = fixture();
  const manager = createRamDisk({ ...f, platform: 'darwin' });
  assert.deepEqual(await manager.inspect(), { mounted: false, path: RAM_MOUNT, status: 'absent' });
  assert.equal(f.calls.some(([, args]) => args[0] === 'attach' || args[0] === 'eraseVolume'), false);
});

test('a held valid lock is bounded and an untrusted lock is refused', async () => {
  const f = fixture();
  const lockPath = '/tmp/xfx-ram-lock';
  f.dirs.add(lockPath);
  f.files.set(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, token: 'other', createdAt: 0 }));
  let clock = 0;
  const manager = createRamDisk({ ...f, platform: 'darwin', lockPath, timeoutMs: 50, now: () => clock, sleep: async ms => { clock += ms; } });
  await assert.rejects(manager.ensure(), /Timed out acquiring/);
  assert.equal(f.calls.length, 0);

  const foreign = fixture();
  foreign.dirs.add(lockPath);
  foreign.files.set(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid, token: 'other', createdAt: 0 }));
  const originalLstat = foreign.fs.lstat;
  foreign.fs.lstat = async path => path === lockPath
    ? { uid: process.getuid() + 1, mode: 0o40700, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }
    : originalLstat(path);
  await assert.rejects(createRamDisk({ ...foreign, platform: 'darwin', lockPath }).ensure(), /not a private directory/);
  assert.equal(foreign.calls.length, 0);

  const ownerless = fixture();
  ownerless.dirs.add(lockPath);
  await assert.rejects(createRamDisk({ ...ownerless, platform: 'darwin', lockPath }).ensure(), /no valid owner/);
  assert.equal(ownerless.calls.length, 0);
});

test('two stale-lock reclaimers cannot retire a newly acquired lock', async () => {
  const f = fixture();
  const lockPath = '/tmp/xfx-ram-race';
  f.dirs.add(lockPath);
  f.files.set(`${lockPath}/owner.json`, JSON.stringify({ pid: 71, token: 'dead-owner', createdAt: 0 }));
  let sequence = 0;
  const options = { ...f, platform: 'darwin', lockPath, now: () => 100, lockStaleMs: 1,
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }, uuid: () => `id-${++sequence}` };
  const left = createRamDisk(options);
  const right = createRamDisk(options);
  assert.deepEqual(await Promise.all([left.ensure(), right.ensure()]), [RAM_MOUNT, RAM_MOUNT]);
  assert.equal(f.calls.filter(([, args]) => args[0] === 'attach').length, 1);
  assert.equal(f.calls.filter(([, args]) => args[0] === 'eraseVolume').length, 1);
});

test('fails before probing when the mounted path is replaced after inspection', async () => {
  const f = fixture({ present: true });
  const originalLstat = f.fs.lstat;
  let mountLookups = 0, probes = 0;
  f.fs.lstat = async path => {
    const node = await originalLstat(path);
    if (path !== RAM_MOUNT) return node;
    mountLookups += 1;
    return mountLookups === 1 ? node : { ...node, dev: 99, ino: 99 };
  };
  const originalWrite = f.fs.writeFile;
  f.fs.writeFile = async (path, ...args) => {
    if (path.startsWith(`${RAM_MOUNT}/.xenoflux-write-check-`)) probes += 1;
    return originalWrite(path, ...args);
  };
  await assert.rejects(createRamDisk({ ...f, platform: 'darwin' }).ensure(), /mount path changed/);
  assert.equal(probes, 0);
  assert.equal(f.calls.some(([, args]) => args[0] === 'attach' || args[0] === 'eraseVolume'), false);
});
