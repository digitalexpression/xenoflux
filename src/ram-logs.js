// Disposable diagnostics only. Native configuration, credentials, state and
// conversation history never move. The registry contains directory keys only.
import { access, chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rename, symlink, unlink } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { execFile as nodeExecFile } from 'node:child_process';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { acquire, exists, readJSON, release } from './metadata.js';
import { createRamDisk, RAM_DISK_PATH } from './ram-disk.js';

const validKey = key => typeof key === 'string' && /^(?:default|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(key);
const database = 'logs_2.sqlite';
const suffixes = ['', '-wal', '-shm'];
const failed = message => Object.assign(new Error(message), { code: 'RAM_LOGS_UNAVAILABLE' });
const cancelled = signal => { if (signal?.aborted) throw Object.assign(new Error('RAM log preparation cancelled'), { code: 'CANCELLED' }); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
const sameNode = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;

export function ramLogTarget(key, { mountPath = RAM_DISK_PATH, uid = process.getuid() } = {}) {
  if (!validKey(key) || !Number.isSafeInteger(uid) || uid < 0) throw failed('Invalid RAM log identity');
  return join(mountPath, `xenoflux-${uid}`, key, database);
}

export function createRamLogs({ disk = createRamDisk(), mountPath = RAM_DISK_PATH,
  registry = join(userInfo().homedir, '.xfx', 'ramlogs', 'homes'), enabled = true,
  execFile = promisify(nodeExecFile), uid = process.getuid(), isAlive = alive } = {}) {
  if (typeof enabled !== 'boolean') throw failed('Invalid RAM log enabled setting');
  const targetFor = key => ramLogTarget(key, { mountPath, uid });
  const validateHome = async home => {
    if (typeof home !== 'string' || resolve(home) !== home || /[\x00-\x1f\x7f]/.test(home)) throw failed('Invalid native log home');
    const s = await lstat(home);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o022) || await realpath(home) !== home)
      throw failed('RAM logs require a canonical owned home without other-user write access');
  };
  const privateDir = async (path, create = false, recursive = false) => {
    if (create) await mkdir(path, { recursive, mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o077) || await realpath(path) !== path)
      throw failed(`Unsafe RAM log directory: ${path}`);
  };
  const checkedFile = async path => {
    const s = await exists(path);
    if (s && (!s.isFile() || s.isSymbolicLink() || s.uid !== uid || s.nlink !== 1 || (s.mode & 0o022)))
      throw failed(`Unsafe diagnostic log file: ${path}`);
    return s;
  };
  async function withMounted(signal, operation) {
    cancelled(signal);
    if (await disk.ensure({ signal }) !== mountPath) throw failed('RAM disk mounted at an unexpected location');
    // Keep the mounted directory open while preparing logs. Normal unmounts
    // see a busy volume; forced unmount/path replacement must fail closed.
    const handle = await open(mountPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = await handle.stat();
      const checkMount = async () => {
        cancelled(signal);
        const current = await lstat(mountPath).catch(() => null);
        if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== pinned.dev || current.ino !== pinned.ino)
          throw failed('RAM disk disappeared during log preparation; local logs were preserved');
      };
      if (!(await disk.inspect({ signal })).mounted) throw failed('RAM disk disappeared during log preparation');
      await checkMount();
      await privateDir(registry, true, true);
      await checkMount();
      await privateDir(join(mountPath, `xenoflux-${uid}`), true);
      for (const key of await readdir(registry)) {
        if (!validKey(key)) continue; // Preparation locks are not home registrations.
        await privateDir(join(registry, key));
        await checkMount();
        await privateDir(join(mountPath, `xenoflux-${uid}`, key), true);
      }
      await checkMount();
      return await operation(checkMount);
    } finally { await handle.close(); }
  }
  async function ensureMounted({ signal } = {}) {
    if (!enabled) { cancelled(signal); return mountPath; }
    return withMounted(signal, async () => mountPath);
  }
  async function inspect({ home, key }) {
    await validateHome(home);
    const target = targetFor(key), path = join(home, database), entry = await exists(path);
    const link = entry?.isSymbolicLink() ? await readlink(path) : null;
    let volume, available = false;
    try { volume = await disk.inspect(); available = volume.mounted && Boolean(await checkedFile(target)); }
    catch { volume = { mounted: false, status: 'inspection-unavailable' }; }
    if (!enabled) return { kind: 'disk', enabled: false, key, target, mounted: volume.mounted,
      mountStatus: volume.status, available, linked: link === target,
      state: link === target ? 'restore-required' : link ? 'foreign-link' : 'disk', persistent: true };
    return { kind: 'ram', enabled: true, key, target, mounted: volume.mounted, mountStatus: volume.status, available,
      linked: link === target, state: link === target ? available ? 'ready' : 'unavailable' : 'pending-first-launch',
      persistent: false };
  }
  async function noHandles(paths, signal) {
    const present = [];
    for (const path of new Set(paths)) {
      try { await lstat(path); present.push(path); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!present.length) return;
    let result;
    try {
      result = await execFile('/usr/sbin/lsof', ['-nP', '-F', 'p', '-a', '--', ...present], {
        cwd: '/', encoding: 'utf8', timeout: 10000, maxBuffer: 65536, signal,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
      });
    } catch (e) {
      if (e.code === 1 && e.stdout === '' && e.stderr === '') return;
      throw failed('Unable to verify diagnostic log handles; no log files were replaced');
    }
    if (result.stderr || typeof result.stdout !== 'string') throw failed('Unable to verify diagnostic log handles');
    if (result.stdout) throw failed('Quit applications using this home before preparing its RAM logs');
  }
  async function removeLocalSidecars(home, signal) {
    let removed = 0;
    for (const suffix of suffixes.slice(1)) {
      cancelled(signal);
      const path = join(home, database + suffix), before = await checkedFile(path);
      if (!before) continue;
      const current = await lstat(path);
      if (!sameNode(before, current)) throw failed('Diagnostic log sidecar changed during restoration; preserving it');
      await unlink(path); removed++;
    }
    return removed;
  }
  async function digest(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) hash.update(chunk);
    return hash.digest('hex');
  }
  async function prepareHome({ home, key, signal }) {
    let owner, lock;
    try {
      cancelled(signal);
      await validateHome(home);
      const target = targetFor(key), source = join(home, database);
      if (!enabled) {
        const entry = await exists(source);
        if (entry?.isSymbolicLink()) {
          const link = await readlink(source);
          if (link === target) throw failed('RAM log link requires explicit restoration before disk-backed launch');
          throw failed('The diagnostic log link is not owned RAM storage; preserving it');
        }
        return { kind: 'disk', enabled: false, key, home, persistent: true };
      }
      await privateDir(registry, true, true);
      await privateDir(join(registry, key), true);
      lock = join(registry, `.prepare-${key}`);
      owner = { kind: 'ram-log-preparation', key, host: hostname(), pid: process.pid, runId: randomUUID() };
      if (await exists(lock)) {
        // Serialize stale recovery so two contenders cannot retire a lock that
        // the other contender just acquired. A stranded guard fails closed.
        const guard = `${lock}.recovery`;
        await acquire(guard, owner, true);
        try {
          if (await exists(lock)) {
            await privateDir(lock);
            const previous = await readJSON(join(lock, 'owner.json'));
            if (previous.kind !== owner.kind || previous.key !== key || previous.host !== owner.host
              || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || isAlive(previous.pid))
              throw failed('Another RAM log preparation is running or needs inspection');
            await release(lock, previous);
          }
        } finally { await release(guard, owner); }
      }
      await acquire(lock, owner, true);
      try {
        return await withMounted(signal, async checkMount => {
          const entry = await exists(source), linked = entry?.isSymbolicLink() ? await readlink(source) : null;
          if (linked && linked !== target) throw failed('The diagnostic log link points outside this profile’s RAM storage');
          const sourceBase = source;
          const originals = [];
          for (const suffix of suffixes) {
            const path = sourceBase + suffix;
            if (linked !== target) originals.push(await checkedFile(path) ? path : null);
            else originals.push(null);
            await checkedFile(target + suffix);
          }
          await noHandles([...suffixes.map(s => source + s), ...suffixes.map(s => sourceBase + s), ...suffixes.map(s => target + s)], signal);
          await checkMount();
          const created = [];
          let committed = false;
          try {
            // Preserve current-boot logs on their first move. This creates no
            // persistent backup and never resets an existing per-home RAM database.
            for (const [i, suffix] of suffixes.entries()) {
              if (!originals[i] || originals[i] === target + suffix) continue;
              const destination = target + suffix;
              if (await exists(destination)) {
                if (await digest(originals[i]) !== await digest(destination))
                  throw failed('Both local and RAM logs exist with different contents; preserving both');
              } else {
                const temporary = `${destination}.${randomUUID()}.tmp`;
                try {
                  await checkMount();
                  await copyFile(originals[i], temporary, constants.COPYFILE_EXCL);
                  await checkMount();
                  await rename(temporary, destination);
                  created.push({ path: destination, stat: await lstat(destination) });
                }
                finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
              }
            }
            // SQLite can initialize an empty database. Its WAL/SHM files are next
            // to the resolved main database, on the same RAM volume.
            await checkMount();
            if (!await exists(target)) {
              const handle = await open(target, 'wx', 0o600);
              try { created.push({ path: target, stat: await handle.stat() }); } finally { await handle.close(); }
            }
            await access(target, constants.R_OK | constants.W_OK);
            await checkMount();
            if (linked !== target) {
              const temporary = join(home, `.xfx-ramlogs-${randomUUID()}`);
              try { await symlink(target, temporary); await checkMount(); await rename(temporary, source); }
              finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
            }
            committed = true;
            // Any old local sidecars were copied before the main link changed.
            for (const suffix of suffixes.slice(1)) {
              if (await checkedFile(source + suffix)) await unlink(source + suffix);
            }
            return { kind: 'ram', key, home, target, persistent: false };
          } finally {
            // Failed conversion must not strand a partial copy that blocks a
            // retry. Only retire files created here, and only before link commit.
            if (!committed) for (const entry of created.reverse()) {
              const current = await exists(entry.path);
              if (current?.dev === entry.stat.dev && current?.ino === entry.stat.ino) await unlink(entry.path);
            }
          }
        });
      } finally { await release(lock, owner); }
    } catch (e) {
      if (signal?.aborted || e.code === 'CANCELLED' || e.name === 'AbortError')
        throw Object.assign(new Error('RAM log preparation cancelled'), { code: 'CANCELLED' });
      if (e.code === 'RAM_LOGS_UNAVAILABLE') throw e;
      throw failed(`RAM log preparation failed: ${e.message}`);
    }
  }
  async function restoreHome({ home, key, signal }) {
    let owner, lock;
    try {
      cancelled(signal);
      await validateHome(home);
      const target = targetFor(key), source = join(home, database);
      await privateDir(registry, true, true);
      await privateDir(join(registry, key), true);
      lock = join(registry, `.prepare-${key}`);
      owner = { kind: 'ram-log-preparation', key, host: hostname(), pid: process.pid, runId: randomUUID() };
      if (await exists(lock)) {
        const guard = `${lock}.recovery`;
        await acquire(guard, owner, true);
        try {
          if (await exists(lock)) {
            await privateDir(lock);
            const previous = await readJSON(join(lock, 'owner.json'));
            if (previous.kind !== owner.kind || previous.key !== key || previous.host !== owner.host
              || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || isAlive(previous.pid))
              throw failed('Another RAM log preparation is running or needs inspection');
            await release(lock, previous);
          }
        } finally { await release(guard, owner); }
      }
      await acquire(lock, owner, true);
      try {
        const entry = await exists(source);
        if (!entry) return { kind: 'disk', enabled: false, key, home, restored: false, persistent: true };
        if (!entry.isSymbolicLink()) {
          await checkedFile(source);
          return { kind: 'disk', enabled: false, key, home, restored: false, persistent: true };
        }
        if (await readlink(source) !== target)
          throw failed('The diagnostic log link is not owned RAM storage; preserving it');
        for (const suffix of suffixes.slice(1)) await checkedFile(source + suffix);
        const targetNode = await checkedFile(target);
        for (const suffix of suffixes.slice(1)) await checkedFile(target + suffix);
        // A dangling link has no resolvable database to hold open after an
        // absent RAM volume. Check any local sidecars, and only pass the main
        // link/target to lsof while the target exists.
        const localSidecars = suffixes.slice(1).map(suffix => source + suffix);
        await noHandles(targetNode
          ? [...suffixes.map(suffix => source + suffix), ...suffixes.map(suffix => target + suffix)]
          : [...localSidecars, ...suffixes.slice(1).map(suffix => target + suffix)], signal);
        cancelled(signal);
        const temporary = join(home, `.xfx-ramlogs-restore-${randomUUID()}`);
        let replacement = false;
        try {
          // Diagnostics are disposable. A fresh database avoids combining a
          // RAM main file with WAL frames from a different SQLite lifetime.
          const file = await open(temporary, 'wx', 0o600);
          await file.close();
          const tempNode = await lstat(temporary);
          if (!tempNode.isFile() || tempNode.isSymbolicLink() || tempNode.uid !== uid || tempNode.nlink !== 1)
            throw failed('Unable to create a safe disk-backed diagnostic log');
          cancelled(signal);
          const current = await lstat(source);
          if (!current.isSymbolicLink() || await readlink(source) !== target)
            throw failed('Diagnostic log link changed during restoration; preserving it');
          // Only an exact owned RAM link authorizes retiring these sidecars.
          // Finish before the atomic disk replacement, so a retry never needs
          // to guess whether ordinary disk WAL files belong to this operation.
          const cleanedSidecars = await removeLocalSidecars(home, signal);
          cancelled(signal);
          if (!(await lstat(source)).isSymbolicLink() || await readlink(source) !== target)
            throw failed('Diagnostic log link changed during restoration; preserving it');
          await rename(temporary, source);
          replacement = true;
          return { kind: 'disk', enabled: false, key, home, restored: true,
            cleanedSidecars, diagnosticsReset: true, persistent: true };
        } finally {
          if (!replacement) await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
        }
      } finally { await release(lock, owner); }
    } catch (e) {
      if (signal?.aborted || e.code === 'CANCELLED' || e.name === 'AbortError')
        throw Object.assign(new Error('RAM log restoration cancelled'), { code: 'CANCELLED' });
      if (e.code === 'RAM_LOGS_UNAVAILABLE') throw e;
      throw failed(`RAM log restoration failed: ${e.message}`);
    }
  }
  return { ensureMounted, prepareHome, restoreHome, inspect };
}
