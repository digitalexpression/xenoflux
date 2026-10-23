// Process ownership for an isolated, natively launched Codex desktop instance.
// This observes only safe `ps` identity fields and delegates activation/quit to
// the one-shot native helper; it never kills a process.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo as nodeUserInfo } from 'node:os';
import { lstat as nodeLstat, realpath as nodeRealpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DESKTOP_APP, inspectDesktopApp, sameDesktopApp } from './desktop-runtime.js';

const execFileDefault = promisify(nodeExecFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (code, remainingProcesses = []) => Object.assign(new Error(code), { code, remainingProcesses });
function resourceInspectionFailure(stage, path, reason) {
  const error = fail('RESOURCE_INSPECTION_FAILED');
  // Keep diagnostics useful without copying arbitrary child-process output or
  // resource contents into logs/UI errors.
  error.message = `RESOURCE_INSPECTION_FAILED: ${stage} for ${path}: ${reason}`;
  return error;
}
function safeResourceErrorReason(error) {
  if (error?.code === 'ETIMEDOUT' || error?.timedOut) return 'timed out';
  if (error?.signal) return `terminated by ${String(error.signal).replace(/[^A-Z0-9_-]/gi, '').slice(0, 24) || 'signal'}`;
  if (Number.isInteger(error?.code)) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.toLowerCase() : '';
    if (/permission denied|operation not permitted/.test(stderr)) return `exit status ${error.code} (permission denied)`;
    return `exit status ${error.code}`;
  }
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)) return error.code;
  return 'operation failed';
}
const absoluteCanonical = value => typeof value === 'string' && value.startsWith('/') && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);
function identityChanged(previous, current) {
  const fields = current
    ? ['pid', 'startedAt', 'uid', 'executable'].filter(field => previous?.[field] !== current[field])
    : ['presence'];
  const describe = row => row ? `PID ${row.pid} (started ${row.startedAt}, UID ${row.uid}, executable ${row.executable})` : 'no current process row';
  const difference = { previous: previous ? { pid: previous.pid, startedAt: previous.startedAt, uid: previous.uid, executable: previous.executable } : null,
    current: current ? { pid: current.pid, startedAt: current.startedAt, uid: current.uid, executable: current.executable } : null, fields };
  const error = fail('PROCESS_IDENTITY_CHANGED', current ? [current] : []);
  error.message = `PROCESS_IDENTITY_CHANGED: ${describe(previous)} became ${describe(current)}; changed fields: ${fields.join(', ') || 'presence'}`;
  error.identityChange = difference;
  return error;
}

function parsePs(stdout) {
  if (typeof stdout !== 'string') throw fail('PROCESS_OBSERVATION_INVALID');
  const rows = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // macOS may report a negative UID sentinel (for example -2) for a
    // process whose account cannot be resolved. Such a row cannot belong to
    // the current numeric UID and is irrelevant to same-user ownership.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+?)\s*$/);
    if (!m) throw fail('PROCESS_OBSERVATION_INVALID');
    // A zombie retains a PID and start time but no longer has a live executable
    // or open resources. Do not compare its ps command label with the former
    // executable identity or try to control it.
    if (+m[3] < 0 || m[5].startsWith('Z')) continue;
    rows.push({ pid: +m[1], ppid: +m[2], uid: +m[3], startedAt: `${m[4]} UTC`, executable: m[6] });
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
// macOS ps may lose argv before a quitting process becomes a zombie and fall
// back to `(command)`. This is uncertain executable identity, not a new target:
// close may only wait for it to disappear, keeping the PID/UID/start guards.
function awaitingExit(row, identity) {
  return Boolean(row && identity && row.pid === identity.pid && row.startedAt === identity.startedAt
    && row.uid === identity.uid && /^\([^\r\n]+\)$/.test(row.executable));
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
      rows = processSnapshot ? await processSnapshot() : parsePs((await execFile('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,state=,comm='], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: systemTimeoutMs,
        // ASCII locales escape the middle dot in every generated app path.
        // Use English UTF-8 paths and explicit UTC process timestamps.
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' },
      })).stdout);
    } catch (e) { if (e?.code === 'PROCESS_OBSERVATION_INVALID') throw e; throw fail('PROCESS_INSPECTION_FAILED'); }
    if (Array.isArray(rows)) {
      for (const row of rows) if (row?.state !== undefined && (typeof row.state !== 'string' || !/^[A-Z][A-Za-z+<>]*$/.test(row.state)))
        throw fail('PROCESS_OBSERVATION_INVALID');
      rows = rows.filter(row => !row?.state?.startsWith('Z'));
    }
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
  function appDescendants(rows, root, excludePid) {
    const selected = new Map([[root.pid, root]]), excluded = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (selected.has(row.pid) || excluded.has(row.pid)) continue;
        if (selected.has(row.ppid)) {
          if (row.pid === excludePid) excluded.add(row.pid);
          else selected.set(row.pid, row);
          changed = true;
        } else if (excluded.has(row.ppid)) { excluded.add(row.pid); changed = true; }
      }
    }
    return [...selected.values()];
  }
  function validateTarget(rows, main) {
    if (!main || !Number.isSafeInteger(main.pid) || main.pid < 1 || main.uid !== uid || !main.startedAt || !main.executable)
      throw fail('INVALID_TARGET');
    if (ancestors(rows).has(main.pid)) throw fail('SELF_HOSTED', [main]);
    const current = rows.find(r => r.pid === main.pid);
    if (!current || !matchesProcessIdentity(current, main)) throw identityChanged(main, current);
    return current;
  }
  async function open(plan, { helperExecutable, application, bootstrap, onBootstrapReady } = {}) {
    const inspected = await inspectApp();
    const before = await snapshot();
    if (!sameDesktopApp(plan?.app, inspected)) throw fail('APP_IDENTITY_CHANGED');
    // Desktop needs the real account HOME to locate the macOS login keychain.
    // plan.userHome remains the isolated CLI route, not the Desktop OS context.
    const userHome = userInfo().homedir;
    if (![plan?.home, plan?.desktopData, userHome, plan?.temporary, helperExecutable,
      application?.appPath, application?.executable].every(absoluteCanonical)
      || typeof application?.bundleId !== 'string' || !application.bundleId) throw fail('INVALID_PLAN');
    const vendorName = basename(inspected.executable);
    if (!sameDesktopApp(plan.app, inspected) || application.bundleId !== `com.xenoflux.profile.${String(plan.profileId ?? '').toLowerCase()}`
      || application.appPath === inspected.appPath || !basename(application.appPath).startsWith('Codex · ')
      || !basename(application.appPath).endsWith('.app')
      || application.executable !== join(application.appPath, 'Contents', 'MacOS', vendorName)) throw fail('APP_IDENTITY_CHANGED');
    const bootstrapExecutable = join(application.appPath, 'Contents', 'MacOS', 'XfxProfileLauncher');
    if (bootstrap != null) {
      if (!bootstrap || !Number.isSafeInteger(bootstrap.pid) || bootstrap.pid <= 0
        || !Number.isSafeInteger(bootstrap.ppid) || bootstrap.ppid < 0 || bootstrap.uid !== uid
        || typeof bootstrap.startedAt !== 'string' || !bootstrap.startedAt
        || bootstrap.executable !== bootstrapExecutable || typeof onBootstrapReady !== 'function') throw fail('PROFILE_BOOTSTRAP_INVALID');
      const observed = before.find(row => row.pid === bootstrap.pid);
      if (!observed || !matchesProcessIdentity(observed, bootstrap) || observed.ppid !== bootstrap.ppid)
        throw identityChanged(bootstrap, observed);
      const caller = before.find(row => row.pid === currentPid);
      if (!caller || caller.ppid !== bootstrap.pid) throw fail('PROFILE_BOOTSTRAP_CALLER_MISMATCH', [observed]);
      await onBootstrapReady({ kind: 'xfx-profile-bootstrap', status: 'launch', profileId: plan.profileId, pid: bootstrap.pid });
      const deadline = now() + openTimeoutMs;
      while (now() <= deadline) {
        const after = await snapshot();
        const row = after.find(item => item.pid === bootstrap.pid);
        if (!row) throw fail('PROFILE_BOOTSTRAP_EXITED', []);
        if (row.uid !== bootstrap.uid || row.startedAt !== bootstrap.startedAt)
          throw identityChanged(bootstrap, row);
        if (row.executable === application.executable) {
          const main = row;
          const processes = appDescendants(after, main, currentPid);
          const owned = ownedFor(main);
          for (const process of processes) owned.set(process.pid, process);
          return { main, processes };
        }
        if (row.executable !== bootstrapExecutable) throw identityChanged(bootstrap, row);
        await sleep(pollIntervalMs);
      }
      throw fail('DESKTOP_OPEN_TIMEOUT', []);
    }
    const args = ['--open-app', application.appPath, '--home', plan.home, '--desktop-data', plan.desktopData,
      '--user-home', userHome, '--temporary', plan.temporary, '--target-executable', application.executable];
    let receipt, result;
    try {
      result = await execFile(helperExecutable, args, {
        cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: userHome }, encoding: 'utf8', maxBuffer: 65536, timeout: openTimeoutMs,
      });
    } catch (cause) {
      const error = fail('DESKTOP_OPEN_FAILED');
      const details = typeof cause.stderr === 'string' ? cause.stderr.trim().slice(0, 4096) : '';
      error.message += `: ${cause.killed ? 'Native launch helper timed out.' : details || 'Native launch helper failed without diagnostics.'}`;
      error.cause = cause;
      throw error;
    }
    try {
      const output = result?.stdout;
      if (typeof output !== 'string' || result.stderr || !output.trim()) throw new Error();
      receipt = JSON.parse(output.trim());
      if (!receipt || Array.isArray(receipt) || Object.keys(receipt).sort().join(',') !== 'executable,pid,startSeconds'
        || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1
        || typeof receipt.executable !== 'string' || !receipt.executable.startsWith('/') || /[\x00-\x1f\x7f]/.test(receipt.executable)
        || !Number.isSafeInteger(receipt.startSeconds) || receipt.startSeconds < 0
        || receipt.executable !== application.executable) throw new Error();
    } catch { throw fail('DESKTOP_OPEN_RECEIPT_INVALID'); }
    const prior = new Set(before.map(processIdentity));
    const deadline = now() + openTimeoutMs;
    while (now() <= deadline) {
      const after = await snapshot();
      const row = after.find(r => r.pid === receipt.pid);
      if (row) {
        if (row.uid !== uid || row.executable !== receipt.executable || targetStartSeconds(row.startedAt) !== String(receipt.startSeconds)) {
          const error = fail('DESKTOP_OPEN_RECEIPT_MISMATCH', [row]);
          error.message += `: expected PID ${receipt.pid}, UID ${uid}, executable ${receipt.executable}, start ${receipt.startSeconds}; observed PID ${row.pid}, UID ${row.uid}, executable ${row.executable}, start ${targetStartSeconds(row.startedAt)} (${row.startedAt}).`;
          throw error;
        }
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
    if (samePid && !matchesProcessIdentity(samePid, main)) return { status: 'identity-changed', processes: [samePid], identityChange: identityChanged(main, samePid).identityChange };
    const liveTracked = [];
    for (const [pid, previous] of owned) {
      const row = rows.find(r => r.pid === pid);
      if (!row) continue;
      if (!matchesProcessIdentity(row, previous)) return { status: 'identity-changed', processes: [row], identityChange: identityChanged(previous, row).identityChange };
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
      catch (e) { if (e.code === 'ENOENT') continue; throw resourceInspectionFailure('lstat', path, safeResourceErrorReason(e)); }
      let canonical;
      try { canonical = await realpath(path); } catch (e) { throw resourceInspectionFailure('realpath', path, safeResourceErrorReason(e)); }
      if (canonical !== path) throw resourceInspectionFailure('canonicality check', path, `resolved to ${canonical}`);
      if (stat.isSymbolicLink?.()) throw resourceInspectionFailure('lstat', path, 'path is a symbolic link');
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
        throw resourceInspectionFailure('lsof', item.path, safeResourceErrorReason(e));
      }
      if (!result || typeof result.stdout !== 'string') throw resourceInspectionFailure('lsof output', item.path, 'stdout was not text');
      if (result.stderr) {
        const reason = /permission denied|operation not permitted/i.test(result.stderr) ? 'reported permission denied' : 'reported warnings';
        throw resourceInspectionFailure('lsof output', item.path, reason);
      }
      let currentPidSeen, sawCommand = false, sawUid = false, sawName = false;
      const finishProcess = () => {
        if (currentPidSeen !== undefined && (!sawCommand || !sawUid || !sawName)) {
          const missing = [['command', sawCommand], ['uid', sawUid], ['name', sawName]].filter(([, seen]) => !seen).map(([name]) => name);
          throw resourceInspectionFailure('lsof fields', item.path, `PID ${currentPidSeen} missing ${missing.join(', ')}`);
        }
      };
      for (const line of result.stdout.split('\n')) {
        if (!line) continue;
        const field = line[0], value = line.slice(1);
        if (field === 'p') {
          finishProcess();
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
            throw resourceInspectionFailure('lsof fields', item.path, 'invalid PID field');
          currentPidSeen = Number(value);
          sawCommand = sawUid = sawName = false;
        } else if (field === 'c' && currentPidSeen !== undefined) {
          if (!value) throw resourceInspectionFailure('lsof fields', item.path, `PID ${currentPidSeen} has an empty command field`);
          sawCommand = true;
        } else if (field === 'u' && currentPidSeen !== undefined) {
          if (value !== String(uid)) throw resourceInspectionFailure('lsof fields', item.path, `PID ${currentPidSeen} has an unexpected UID field`);
          sawUid = true;
        } else if (field === 'n' && currentPidSeen !== undefined) {
          if (!value) throw resourceInspectionFailure('lsof fields', item.path, `PID ${currentPidSeen} has an empty name field`);
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
    const missingPid = [...holders].find(pid => !byPid.has(pid));
    if (missingPid !== undefined) throw resourceInspectionFailure('process snapshot', present.map(item => item.path).join(', '), `holder PID ${missingPid} was absent`);
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
    const beforeMain = before.find(row => row.pid === main?.pid);
    if (beforeMain && !matchesProcessIdentity(beforeMain, main)) throw identityChanged(main, beforeMain);
    if (beforeMain) {
      validateTarget(before, main);
      for (const row of descendants(before, main)) owned.set(row.pid, row);
      try { await control('--quit-pid', main, helperExecutable); }
      catch (error) {
        // The app may exit after our preflight but before the native helper
        // validates it. Recheck before treating that helper failure as natural
        // completion; a live exact target keeps the original helper error.
        const afterFailure = await snapshot();
        const current = afterFailure.find(row => row.pid === main.pid);
        if (current && !matchesProcessIdentity(current, main) && !awaitingExit(current, main)) throw identityChanged(main, current);
        if (current && !awaitingExit(current, main)) throw error;
      }
    }
    const deadline = now() + closeTimeoutMs;
    while (now() <= deadline) {
      const rows = await snapshot();
      const byPid = new Map(rows.map(r => [r.pid, r]));
      if ([...owned.values()].some(previous => awaitingExit(byPid.get(previous.pid), previous))) {
        for (const previous of owned.values()) {
          const current = byPid.get(previous.pid);
          if (current && !matchesProcessIdentity(current, previous) && !awaitingExit(current, previous))
            throw identityChanged(previous, current);
        }
        // Shutdown can spawn children while argv is unavailable. Retain each
        // verified descendant so reparenting cannot make it disappear from our
        // ownership set; an unknown child's missing path stays ambiguous.
        for (const row of descendants(rows, main)) {
          if (owned.has(row.pid)) continue;
          if (!absoluteCanonical(row.executable)) throw fail('PROCESS_TREE_AMBIGUOUS', [main]);
          owned.set(row.pid, row);
        }
        await sleep(pollIntervalMs);
        continue;
      }
      const root = byPid.get(main.pid);
      if (root && !matchesProcessIdentity(root, main)) throw identityChanged(main, root);
      const liveOwned = [];
      for (const [pid, previous] of owned) {
        const row = byPid.get(pid);
        if (!row) continue;
        if (!matchesProcessIdentity(row, previous)) throw identityChanged(previous, row);
        if (pid !== main.pid) {
          const parent = owned.get(row.ppid);
          const endedMainParent = row.ppid === main.pid && !root && matchesProcessIdentity(parent, main);
          if (!endedMainParent && (!parent || !byPid.has(row.ppid) || !matchesProcessIdentity(byPid.get(row.ppid), parent)))
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
    const remaining = rows.filter(r => (owned.has(r.pid) && (matchesProcessIdentity(r, owned.get(r.pid)) || awaitingExit(r, owned.get(r.pid))))
      || descendants(rows, main).some(child => child.pid === r.pid));
    // Keep the last verified executable in the reservation when ps cannot read
    // a quitting process's argv. That fallback label is never a control target.
    throw fail('DESKTOP_CLOSE_TIMEOUT', remaining.map(row => awaitingExit(row, owned.get(row.pid)) ? owned.get(row.pid) : row));
  }
  return { inspectApp, snapshot, open, observe, focus, close, assertResourcesIdle };
}
