import { access, lstat, mkdtemp, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

export const RAM_DISK_PATH = '/Volumes/CodexRAM';
export const RAM_MOUNT = RAM_DISK_PATH;
const RAM_BYTES = 256 * 1024 * 1024;
const deviceName = /^disk\d+(?:s\d+)?$/;

const missing = error => error?.code === 'ENOENT' || error?.code === 'ENXIO';
const abortError = () => Object.assign(new Error('RAM disk operation aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
const output = value => typeof value === 'string' ? value : value?.stdout ?? '';

function entries(info) {
  if (!info || typeof info !== 'object' || !Array.isArray(info.images)) return [];
  return info.images.flatMap(image => Array.isArray(image['system-entities'])
    ? image['system-entities'].map(entity => ({ image, entity })) : []);
}

function diskFrom(value) {
  const match = typeof value === 'string' && value.match(/^\/dev\/(disk\d+)(?:s\d+)?$/);
  return match?.[1] ?? null;
}

function ramEntity(info, identifier, expectedImagePath) {
  if (typeof identifier !== 'string' || !deviceName.test(identifier)) return null;
  const whole = identifier.match(/^disk\d+/)[0];
  return entries(info).find(({ image, entity }) => diskFrom(entity['dev-entry']) === whole
    && typeof image['image-path'] === 'string'
    && (expectedImagePath ? image['image-path'] === expectedImagePath : image['image-path'].startsWith('ram://'))) ?? null;
}

/** A deliberately narrow manager for the shared, disposable Codex log volume.
 * It never repairs or reformats a volume it did not create in this invocation. */
export function createRamDisk({
  execFile = promisify(nodeExecFile), mountPath = RAM_MOUNT, sizeBytes = RAM_BYTES,
  fs = { access, lstat, mkdtemp, mkdir, open, readFile, rename, rm, unlink, writeFile },
  parsePlist, lockPath = '/private/tmp/xenoflux-codexram.lock', timeoutMs = 10_000,
  lockStaleMs = 60_000, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  kill = process.kill, platform = process.platform, tempDirectory = tmpdir(), uuid = randomUUID, uid = process.getuid(),
} = {}) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes % 512) throw new Error('RAM disk size must be a positive multiple of 512 bytes');
  if (mountPath !== RAM_MOUNT) throw new Error(`RAM disk mount path must be ${RAM_MOUNT}`);
  let localEnsure;

  const command = async (file, args, signal) => {
    if (signal?.aborted) throw abortError();
    try { return output(await execFile(file, args, { signal, timeout: timeoutMs, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' } })); }
    catch (error) { if (signal?.aborted || error?.code === 'ABORT_ERR') throw abortError(); throw error; }
  };

  const plist = async (text, signal) => {
    if (parsePlist) return parsePlist(text, { signal });
    const dir = await fs.mkdtemp(join(tempDirectory, 'xfx-ram-plist-'));
    const path = join(dir, 'value.plist');
    try {
      await fs.writeFile(path, text, { mode: 0o600 });
      return JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], signal));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  };

  const hdiInfo = async signal => plist(await command('/usr/bin/hdiutil', ['info', '-plist'], signal), signal);
  const diskInfo = async signal => plist(await command('/usr/sbin/diskutil', ['info', '-plist', mountPath], signal), signal);

  const inspect = async ({ signal } = {}) => {
    if (platform !== 'darwin') return { mounted: false, path: mountPath, status: 'unsupported' };
    let present = true;
    let mountNode;
    try {
      mountNode = await fs.lstat(mountPath);
      if (mountNode.isSymbolicLink?.() || !mountNode.isDirectory?.())
        return { mounted: false, path: mountPath, status: 'collision', reason: 'mount path is not a directory volume' };
    } catch (error) { if (missing(error)) present = false; else throw error; }
    if (!present) return { mounted: false, path: mountPath, status: 'absent' };
    let disk;
    try { disk = await diskInfo(signal); } catch (error) {
      if (signal?.aborted || error?.code === 'ABORT_ERR') throw abortError();
      if (Number.isInteger(error?.code)) return { mounted: false, path: mountPath, status: 'collision', reason: 'mount path is not a diskutil volume' };
      throw error;
    }
    const identifier = disk?.DeviceIdentifier;
    const entity = ramEntity(await hdiInfo(signal), identifier, `ram://${sizeBytes / 512}`);
    if (!entity || disk?.MountPoint !== mountPath || disk?.FilesystemType !== 'hfs')
      return { mounted: false, path: mountPath, status: 'collision', reason: 'mount path is not the configured HFS RAM disk' };
    const state = { mounted: true, path: mountPath, status: 'mounted', device: identifier };
    Object.defineProperty(state, 'mountIdentity', { value: { dev: mountNode.dev, ino: mountNode.ino } });
    return state;
  };

  const verifyWritable = async (mountIdentity, signal) => {
    if (signal?.aborted) throw abortError();
    if (!sameIdentity(mountIdentity, mountIdentity)) throw new Error('RAM mount path has no stable filesystem identity');
    const directory = await fs.open(mountPath, 'r');
    const probe = join(mountPath, `.xenoflux-write-check-${uuid()}`);
    let written = false, verified = false;
    const assertPinned = async () => {
      const pinned = await directory.stat();
      const current = await fs.lstat(mountPath);
      if (!current.isDirectory?.() || current.isSymbolicLink?.() || !sameIdentity(pinned, mountIdentity)
        || !sameIdentity(current, mountIdentity)) throw new Error('RAM mount path changed during writable verification');
    };
    try {
      await assertPinned();
      await fs.access(mountPath, fsConstants.W_OK);
      await assertPinned();
      await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
      written = true;
      await assertPinned();
      verified = true;
    } finally {
      if (written && verified) { try { await fs.unlink(probe); } catch (error) { if (!missing(error)) throw error; } }
      await directory.close();
    }
  };

  const ownerPath = join(lockPath, 'owner.json');
  const privateNode = (node, directory = false) => node && !node.isSymbolicLink?.()
    && (directory ? node.isDirectory?.() : node.isFile?.()) && node.uid === uid && !(node.mode & 0o077);
  const lockOwner = async () => {
    const lock = await fs.lstat(lockPath);
    if (!privateNode(lock, true)) throw new Error('RAM disk lock is not a private directory owned by this user');
    let file;
    try { file = await fs.lstat(ownerPath); }
    catch (error) {
      if (missing(error)) throw new Error('RAM disk lock has no valid owner; manual recovery is required');
      throw error;
    }
    if (!privateNode(file)) throw new Error('RAM disk lock owner is not a private regular file');
    try {
      return { owner: JSON.parse(await fs.readFile(ownerPath, 'utf8')),
        identity: { dev: lock.dev, ino: lock.ino } };
    }
    catch { throw new Error('RAM disk lock has no valid owner; manual recovery is required'); }
  };
  const moveAndRemove = async suffix => {
    const retired = `${lockPath}.${suffix}-${uuid()}`;
    await fs.rename(lockPath, retired);
    await fs.rm(retired, { recursive: true, force: true });
  };
  const release = async token => {
    try {
      const current = await lockOwner();
      if (current.owner?.token === token) await moveAndRemove('released');
    } catch (error) { if (!missing(error) && !/manual recovery/.test(error.message)) throw error; }
  };
  const recoveryPath = `${lockPath}.recovery`;
  const waitForRecoveryGuard = async deadline => {
    for (;;) {
      if (now() >= deadline) throw new Error('Timed out waiting for RAM disk stale-lock recovery');
      try {
        await fs.mkdir(recoveryPath, { mode: 0o700 });
        if (!privateNode(await fs.lstat(recoveryPath), true))
          throw new Error('RAM disk recovery guard is not a private directory owned by this user');
        return true;
      }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let guard;
        try { guard = await fs.lstat(recoveryPath); } catch (reason) { if (missing(reason)) continue; throw reason; }
        if (!privateNode(guard, true)) throw new Error('RAM disk recovery guard is not a private directory owned by this user');
        await sleep(Math.min(25, Math.max(1, deadline - now())));
      }
    }
  };
  const releaseRecoveryGuard = async () => {
    const guard = await fs.lstat(recoveryPath);
    if (!privateNode(guard, true)) throw new Error('RAM disk recovery guard changed unexpectedly; manual recovery is required');
    const retired = `${recoveryPath}.complete-${uuid()}`;
    await fs.rename(recoveryPath, retired);
    await fs.rm(retired, { recursive: true, force: true });
  };
  const sameIdentity = (left, right) => Number.isSafeInteger(left?.dev) && Number.isSafeInteger(left?.ino)
    && left.dev === right?.dev && left.ino === right?.ino;
  const reclaimStale = async (observed, deadline) => {
    await waitForRecoveryGuard(deadline);
    let complete = false;
    try {
      let current;
      try { current = await lockOwner(); } catch (error) { if (missing(error)) { complete = true; return false; } throw error; }
      const unchanged = sameIdentity(current.identity, observed.identity)
        && current.owner?.token === observed.owner?.token && current.owner?.pid === observed.owner?.pid;
      if (!unchanged) { complete = true; return false; }
      let dead = false;
      try { kill(current.owner.pid, 0); } catch (error) { dead = error?.code === 'ESRCH'; }
      if (!dead) { complete = true; return false; }
      await moveAndRemove('stale');
      complete = true;
      return true;
    } finally {
      // An interrupted recovery is deliberately left for manual recovery; a
      // later contender must not guess whether this guard's owner was safe.
      if (complete) await releaseRecoveryGuard();
    }
  };
  const acquire = async signal => {
    const token = uuid();
    const deadline = now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (now() >= deadline) throw new Error('Timed out acquiring RAM disk lock');
      try {
        await fs.mkdir(lockPath, { mode: 0o700 });
        await fs.writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: now() }), { flag: 'wx', mode: 0o600 });
        if ((await lockOwner()).owner?.token !== token) throw new Error('RAM disk lock ownership changed unexpectedly');
        return token;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let owner;
        try { owner = await lockOwner(); } catch (reason) {
          if (missing(reason)) continue;
          throw reason;
        }
        const stale = Number.isSafeInteger(owner.owner?.pid) && Number.isFinite(owner.owner?.createdAt) && now() - owner.owner.createdAt > lockStaleMs;
        let dead = false;
        if (stale) { try { kill(owner.owner.pid, 0); } catch (reason) { dead = reason?.code === 'ESRCH'; } }
        if (dead) { await reclaimStale(owner, deadline); continue; }
        await sleep(Math.min(25, Math.max(1, deadline - now())));
      }
    }
  };

  const detachFresh = async (whole, signal) => {
    // This receives only the identifier parsed from this invocation's attach
    // plist and already cross-checked against hdiutil info.
    // Do not pass an already-aborted caller signal: cleanup must still detach
    // the device allocated by this call. It remains bounded by timeoutMs.
    await command('/usr/bin/hdiutil', ['detach', `/dev/${whole}`]).catch(() => {});
  };
  const createFresh = async signal => {
    const imagePath = `ram://${sizeBytes / 512}`;
    const attached = await plist(await command('/usr/bin/hdiutil', ['attach', '-nomount', '-plist', imagePath], signal), signal);
    // attach -plist returns a top-level system-entities array, unlike info.
    const whole = diskFrom(attached?.['system-entities']?.find(entity => diskFrom(entity?.['dev-entry']))?.['dev-entry']);
    if (!whole) throw new Error('hdiutil did not return a fresh RAM disk device');
    // Cross-check the returned device before eraseVolume. This is the only disk
    // identifier this module will ever pass to diskutil's destructive command.
    try {
      if (!ramEntity(await hdiInfo(signal), whole, imagePath)) throw new Error('fresh RAM disk could not be validated');
      await command('/usr/sbin/diskutil', ['eraseVolume', 'HFS+', 'CodexRAM', `/dev/${whole}`], signal);
    } catch (error) { await detachFresh(whole, signal); throw error; }
    return whole;
  };

  const ensure = ({ signal } = {}) => {
    if (localEnsure) return localEnsure;
    localEnsure = (async () => {
      if (platform !== 'darwin') throw new Error('RAM disk logs require macOS');
      const token = await acquire(signal);
      let freshDevice;
      try {
        let state = await inspect({ signal });
        if (state.status === 'collision') throw new Error(`Refusing to use ${mountPath}: ${state.reason}`);
        if (state.status === 'absent') {
          freshDevice = await createFresh(signal);
          state = await inspect({ signal });
          if (state.status !== 'mounted') {
            throw new Error('new RAM disk did not mount at the expected path');
          }
        }
        await verifyWritable(state.mountIdentity, signal);
        return mountPath;
      } catch (error) {
        if (freshDevice) await detachFresh(freshDevice, signal);
        throw error;
      } finally { await release(token); }
    })();
    return localEnsure.finally(() => { localEnsure = undefined; });
  };

  return { ensure, inspect };
}
