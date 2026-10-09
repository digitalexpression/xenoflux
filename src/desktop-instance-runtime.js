// Process ownership for an isolated, natively launched Codex desktop instance.
// This observes only safe `ps` identity fields and delegates activation/quit to
// the one-shot native helper; it never kills a process.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo as nodeUserInfo } from 'node:os';
import { lstat as nodeLstat, realpath as nodeRealpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DESKTOP_APP, inspectDesktopApp, sameDesktopApp } from './desktop-runtime.js';

const execFileDefault = promisify(nodeExecFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (code, remainingProcesses = []) => Object.assign(new Error(code), { code, remainingProcesses });

function parsePs(stdout) {
  if (typeof stdout !== 'string') throw fail('PROCESS_OBSERVATION_INVALID');
  const rows = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/);
    if (!m) throw fail('PROCESS_OBSERVATION_INVALID');
    rows.push({ pid: +m[1], ppid: +m[2], uid: +m[3], startedAt: m[4], executable: m[5] });
  }
  return rows;
}

function validateRows(rows) {
  if (!Array.isArray(rows)) throw fail('PROCESS_OBSERVATION_INVALID');
  const pids = new Set();
  return rows.map(r => {
    if (!r || !Number.isSafeInteger(r.pid) || r.pid < 1 || !Number.isSafeInteger(r.ppid) || r.ppid < 0
      || !Number.isSafeInteger(r.uid) || r.uid < 0 || typeof r.startedAt !== 'string' || !r.startedAt
      || typeof r.executable !== 'string' || !r.executable || /[\x00-\x1f\x7f]/.test(r.executable) || pids.has(r.pid))
      throw fail('PROCESS_OBSERVATION_INVALID');
    pids.add(r.pid);
    return { pid: r.pid, ppid: r.ppid, uid: r.uid, startedAt: r.startedAt, executable: r.executable };
  });
}

export function processIdentity(row) {
  return `${row.pid}:${row.startedAt}:${row.uid}:${row.executable}`;
}
export function matchesProcessIdentity(row, identity) {
  return Boolean(row && identity && row.pid === identity.pid && row.startedAt === identity.startedAt
    && row.uid === identity.uid && row.executable === identity.executable);
}
export function targetStartSeconds(startedAt) {
  const millis = Date.parse(startedAt);
  if (!Number.isFinite(millis)) throw fail('PROCESS_OBSERVATION_INVALID');
  return String(Math.floor(millis / 1000));
}

export function createDesktopInstanceRuntime({
  execFile = execFileDefault, processSnapshot, inspectApp: inspectAppInjected,
  lstat = nodeLstat, realpath = nodeRealpath,
  now = () => Date.now(), sleep = delay, userInfo = nodeUserInfo,
  currentPid = process.pid, systemTimeoutMs = 5000, openTimeoutMs = 15000,
  closeTimeoutMs = 10000, pollIntervalMs = 100,
} = {}) {
  if (typeof execFile !== 'function' || typeof lstat !== 'function' || typeof realpath !== 'function'
    || (processSnapshot !== undefined && typeof processSnapshot !== 'function')
    || typeof now !== 'function' || typeof sleep !== 'function' || typeof userInfo !== 'function'
    || !Number.isSafeInteger(currentPid) || currentPid < 1
    || ![systemTimeoutMs, openTimeoutMs, closeTimeoutMs, pollIntervalMs].every(x => Number.isFinite(x) && x > 0)) throw fail('INVALID_OPTIONS');
  const uid = userInfo().uid;
  let app;
  const ownership = new Map();
  const ownedFor = main => {
    const key = processIdentity(main);
    if (!ownership.has(key)) ownership.set(key, new Map());
    return ownership.get(key);
  };

  async function inspectApp() {
    app = inspectAppInjected ? await inspectAppInjected() : await inspectDesktopApp({ execFile, timeoutMs: systemTimeoutMs });
    if (!app || app.bundleId !== DESKTOP_APP.bundleId || app.executable !== DESKTOP_APP.executable && !app.executable.startsWith(`${app.appPath}/Contents/MacOS/`))
      throw fail('APP_IDENTITY_MISMATCH');
    return app;
  }
  async function snapshot() {
    let rows;
    try {
      rows = processSnapshot ? await processSnapshot() : parsePs((await execFile('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,comm='], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: systemTimeoutMs,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
      })).stdout);
    } catch (e) { if (e?.code === 'PROCESS_OBSERVATION_INVALID') throw e; throw fail('PROCESS_INSPECTION_FAILED'); }
    return validateRows(rows).filter(row => row.uid === uid);
  }
  function ancestors(rows) {
    const byPid = new Map(rows.map(r => [r.pid, r]));
    let cursor = byPid.get(currentPid); const seen = new Set();
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      cursor = byPid.get(cursor.ppid);
      if (cursor?.pid === currentPid) break;
    }
    return seen;
  }
  function descendants(rows, root) {
    const selected = new Map([[root.pid, root]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.set(row.pid, row); changed = true;
      }
    }
    return [...selected.values()];
  }
  function validateTarget(rows, main) {
    if (!main || !Number.isSafeInteger(main.pid) || main.pid < 1 || main.uid !== uid || !main.startedAt || !main.executable)
      throw fail('INVALID_TARGET');
    if (ancestors(rows).has(main.pid)) throw fail('SELF_HOSTED', [main]);
    const current = rows.find(r => r.pid === main.pid);
    if (!current || !matchesProcessIdentity(current, main)) throw fail('PROCESS_IDENTITY_CHANGED', current ? [current] : []);
    return current;
  }
  async function open(plan, { helperExecutable } = {}) {
    const inspected = await inspectApp();
    const before = await snapshot();
    if (!sameDesktopApp(plan?.app, inspected)) throw fail('APP_IDENTITY_CHANGED');
    const appPath = plan?.appPath ?? plan?.app?.appPath;
    const userHome = plan?.userHome ?? userInfo().homedir;
    if (![plan?.home, plan?.desktopData, userHome, plan?.temporary, appPath, helperExecutable]
      .every(x => typeof x === 'string' && x.startsWith('/') && !/[\x00-\x1f\x7f]/.test(x))) throw fail('INVALID_PLAN');
    if (appPath !== inspected.appPath) throw fail('APP_IDENTITY_CHANGED');
    const args = ['--open-app', appPath, '--home', plan.home, '--desktop-data', plan.desktopData,
      '--user-home', userHome, '--temporary', plan.temporary, '--target-executable', inspected.executable];
    let receipt, result;
    try {
      result = await execFile(helperExecutable, args, {
        cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userHome }, encoding: 'utf8', maxBuffer: 65536, timeout: openTimeoutMs,
      });
    } catch { throw fail('DESKTOP_OPEN_FAILED'); }
    try {
      const output = result?.stdout;
      if (typeof output !== 'string' || result.stderr || !output.trim()) throw new Error();
      receipt = JSON.parse(output.trim());
      if (!receipt || Array.isArray(receipt) || Object.keys(receipt).sort().join(',') !== 'executable,pid,startSeconds'
        || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1
        || typeof receipt.executable !== 'string' || !receipt.executable.startsWith('/') || /[\x00-\x1f\x7f]/.test(receipt.executable)
        || !Number.isSafeInteger(receipt.startSeconds) || receipt.startSeconds < 0
        || receipt.executable !== inspected.executable) throw new Error();
    } catch { throw fail('DESKTOP_OPEN_RECEIPT_INVALID'); }
    const prior = new Set(before.map(processIdentity));
    const deadline = now() + openTimeoutMs;
    while (now() <= deadline) {
      const after = await snapshot();
      const row = after.find(r => r.pid === receipt.pid);
      if (row) {
        if (row.uid !== uid || row.executable !== receipt.executable || targetStartSeconds(row.startedAt) !== String(receipt.startSeconds))
          throw fail('DESKTOP_OPEN_RECEIPT_MISMATCH', [row]);
        if (prior.has(processIdentity(row))) throw fail('DESKTOP_OPEN_PREEXISTING', [row]);
        const main = row;
        const processes = descendants(after, main);
        const owned = ownedFor(main);
        for (const row of processes) owned.set(row.pid, row);
        return { main, processes };
      }
      await sleep(pollIntervalMs);
    }
    throw fail('DESKTOP_OPEN_TIMEOUT', []);
  }
  async function observe(main, { trackedProcesses = [] } = {}) {
    if (!Array.isArray(trackedProcesses)) throw fail('PROCESS_OBSERVATION_INVALID');
    const owned = ownedFor(main);
    for (const row of trackedProcesses) {
      if (!row || row.uid !== uid || !Number.isSafeInteger(row.pid) || !row.startedAt || !row.executable)
        throw fail('PROCESS_OBSERVATION_INVALID');
      owned.set(row.pid, { pid: row.pid, ppid: row.ppid, uid: row.uid, startedAt: row.startedAt, executable: row.executable });
    }
    const rows = await snapshot();
    const samePid = rows.find(r => r.pid === main?.pid);
    if (samePid && !matchesProcessIdentity(samePid, main)) return { status: 'identity-changed', processes: [samePid] };
    const liveTracked = [];
    for (const [pid, previous] of owned) {
      const row = rows.find(r => r.pid === pid);
      if (!row) continue;
      if (!matchesProcessIdentity(row, previous)) return { status: 'identity-changed', processes: [row] };
      if (pid !== main?.pid) liveTracked.push(row);
    }
    if (!samePid) return liveTracked.length
      ? { status: 'running', orphaned: true, processes: liveTracked }
      : { status: 'stopped', processes: [] };
    validateTarget(rows, main);
    const tree = descendants(rows, samePid);
    const treePids = new Set(tree.map(row => row.pid));
    const escaped = liveTracked.filter(row => !treePids.has(row.pid));
    const processes = [...tree, ...escaped.filter(row => !treePids.has(row.pid))];
    for (const row of tree) owned.set(row.pid, row);
    return { status: 'running', ...(escaped.length ? { orphaned: true } : {}), processes };
  }
  async function assertResourcesIdle(paths) {
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path) || resolve(path) !== path))
      throw fail('INVALID_RESOURCE_PATHS');
    const present = [];
    for (const path of new Set(paths)) {
      let stat;
      try { stat = await lstat(path); }
      catch (e) { if (e.code === 'ENOENT') continue; throw fail('RESOURCE_INSPECTION_FAILED'); }
      let canonical;
      try { canonical = await realpath(path); } catch { throw fail('RESOURCE_INSPECTION_FAILED'); }
      if (canonical !== path || stat.isSymbolicLink?.()) throw fail('RESOURCE_INSPECTION_FAILED');
      present.push({ path, directory: stat.isDirectory?.() === true });
    }
    const holders = new Set();
    for (const item of present) {
      let result;
      const args = ['-nP', '-Fpcun', '-u', String(uid), '-a', ...(item.directory ? ['+D', item.path] : ['--', item.path])];
      try {
        result = await execFile('/usr/sbin/lsof', args, { cwd: '/', encoding: 'utf8', timeout: systemTimeoutMs,
          maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });
      } catch (e) {
        if (e.code === 1 && e.stdout === '' && e.stderr === '') continue;
        throw fail('RESOURCE_INSPECTION_FAILED');
      }
      if (typeof result.stdout !== 'string' || result.stderr) throw fail('RESOURCE_INSPECTION_FAILED');
      let currentPidSeen, sawCommand = false, sawUid = false, sawName = false;
      const finishProcess = () => {
        if (currentPidSeen !== undefined && (!sawCommand || !sawUid || !sawName)) throw fail('RESOURCE_INSPECTION_FAILED');
      };
      for (const line of result.stdout.split('\n')) {
        if (!line) continue;
        const field = line[0], value = line.slice(1);
        if (field === 'p') {
          finishProcess();
          if (!/^\d+$/.test(value)) throw fail('RESOURCE_INSPECTION_FAILED');
          currentPidSeen = Number(value);
          sawCommand = sawUid = sawName = false;
        } else if (field === 'c' && currentPidSeen !== undefined) {
          if (!value) throw fail('RESOURCE_INSPECTION_FAILED');
          sawCommand = true;
        } else if (field === 'u' && currentPidSeen !== undefined) {
          if (value !== String(uid)) throw fail('RESOURCE_INSPECTION_FAILED');
          sawUid = true;
        } else if (field === 'n' && currentPidSeen !== undefined) {
          if (!value) throw fail('RESOURCE_INSPECTION_FAILED');
          sawName = true;
          let observed = value;
          try { observed = await realpath(value); } catch { /* compare the reported absolute path below */ }
          const within = item.directory ? observed === item.path || observed.startsWith(`${item.path}/`) : observed === item.path;
          if (within) holders.add(currentPidSeen);
        }
      }
      finishProcess();
    }
    if (!holders.size) return { idle: true, processes: [] };
    const rows = await snapshot();
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const processes = [...holders].map(pid => byPid.get(pid));
    if (processes.some(row => !row)) throw fail('RESOURCE_INSPECTION_FAILED');
    throw fail('RESOURCE_BUSY', processes);
  }
  async function control(flag, main, helperExecutable) {
    const rows = await snapshot(); validateTarget(rows, main);
    if (typeof helperExecutable !== 'string' || !helperExecutable.startsWith('/')) throw fail('INVALID_HELPER');
    try {
      await execFile(helperExecutable, [flag, String(main.pid), '--target-executable', main.executable,
        '--target-start-seconds', targetStartSeconds(main.startedAt)], {
        cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8', maxBuffer: 65536, timeout: systemTimeoutMs,
      });
    } catch { throw fail(flag === '--focus-pid' ? 'DESKTOP_FOCUS_FAILED' : 'DESKTOP_QUIT_FAILED', [main]); }
  }
  async function focus(main, { helperExecutable } = {}) { return control('--focus-pid', main, helperExecutable); }
  async function close(main, { helperExecutable } = {}) {
    const owned = ownedFor(main);
    const before = await snapshot();
    validateTarget(before, main);
    for (const row of descendants(before, main)) owned.set(row.pid, row);
    await control('--quit-pid', main, helperExecutable);
    const deadline = now() + closeTimeoutMs;
    while (now() <= deadline) {
      const rows = await snapshot();
      const byPid = new Map(rows.map(r => [r.pid, r]));
      const root = byPid.get(main.pid);
      if (root && !matchesProcessIdentity(root, main)) throw fail('PROCESS_IDENTITY_CHANGED', [root]);
      const liveOwned = [];
      for (const [pid, previous] of owned) {
        const row = byPid.get(pid);
        if (!row) continue;
        if (!matchesProcessIdentity(row, previous)) throw fail('PROCESS_IDENTITY_CHANGED', [row]);
        if (pid !== main.pid) {
          const parent = owned.get(row.ppid);
          if (!parent || !byPid.has(row.ppid) || !matchesProcessIdentity(byPid.get(row.ppid), parent))
            throw fail('PROCESS_TREE_AMBIGUOUS', [row]);
        }
        liveOwned.push(row);
      }
      const tree = root ? descendants(rows, root) : liveOwned;
      const merged = new Map([...liveOwned, ...tree].map(r => [r.pid, r]));
      if (!merged.size) return { status: 'stopped', processes: [] };
      await sleep(pollIntervalMs);
    }
    const rows = await snapshot();
    const remaining = rows.filter(r => (owned.has(r.pid) && matchesProcessIdentity(r, owned.get(r.pid)))
      || descendants(rows, main).some(child => child.pid === r.pid));
    throw fail('DESKTOP_CLOSE_TIMEOUT', remaining);
  }
  async function openLauncher({ launcherApp, launcherExecutable }, main) {
    const rows = await snapshot(); validateTarget(rows, main);
    if (![launcherApp, launcherExecutable].every(x => typeof x === 'string' && x.startsWith('/'))) throw fail('INVALID_LAUNCHER');
    const before = await snapshot();
    try { await execFile('/usr/bin/open', ['-n', launcherApp, '--args', '--target-pid', String(main.pid), '--target-executable', main.executable,
      '--target-start-seconds', targetStartSeconds(main.startedAt)], { cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, encoding: 'utf8', maxBuffer: 65536, timeout: systemTimeoutMs }); }
    catch { throw fail('LAUNCHER_OPEN_FAILED'); }
    const deadline = now() + openTimeoutMs;
    while (now() <= deadline) {
      const after = await snapshot();
      const old = new Set(before.map(processIdentity));
      const mains = after.filter(r => r.executable === launcherExecutable && !old.has(processIdentity(r)));
      if (mains.length > 1) throw fail('LAUNCHER_OPEN_AMBIGUOUS', mains);
      if (mains.length === 1) return mains[0];
      await sleep(pollIntervalMs);
    }
    throw fail('LAUNCHER_OPEN_TIMEOUT');
  }
  return { inspectApp, snapshot, open, observe, focus, close, openLauncher, assertResourcesIdle };
}
