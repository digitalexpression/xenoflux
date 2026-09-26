// Bounded ownership for an externally launched Codex desktop app.  This is
// deliberately not a general process manager: it only observes the selected
// bundle, asks that bundle to quit gracefully, and launches that bundle with a
// supplied environment.  It never reads command arguments, environments,
// credentials, or application data.
import { execFile as nodeExecFile } from 'node:child_process';
import { lstat as nodeLstat, readFile as nodeReadFile, realpath as nodeRealpath } from 'node:fs/promises';
import { userInfo as nodeUserInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { createLogStorage } from './log-storage.js';

const execFileDefault = promisify(nodeExecFile);
export const DESKTOP_APP = Object.freeze({
  appPath: '/Applications/Codex.app',
  bundleId: 'com.openai.codex',
  executable: '/Applications/Codex.app/Contents/MacOS/Codex',
});
const DEFAULT_APP_PATHS = [DESKTOP_APP.appPath, '/Applications/ChatGPT.app'];
// Publisher identity survives routine releases and certificate renewal. A valid
// signature alone would also accept a replacement signed by someone else.
const signingRequirement = 'identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"';

const MESSAGES = {
  INVALID_OPTIONS: 'Invalid desktop runtime options',
  APP_INSPECTION_FAILED: 'Unable to inspect the installed Codex desktop app',
  APP_IDENTITY_MISMATCH: 'The installed Codex desktop app has an unexpected bundle identity or executable path',
  APP_SIGNATURE_INVALID: 'Unable to verify the installed Codex desktop bundle signature',
  APP_AMBIGUOUS: 'More than one verified Codex desktop app is installed',
  PROCESS_INSPECTION_FAILED: 'Unable to inspect Codex desktop processes',
  PROCESS_OBSERVATION_INVALID: 'Desktop process observation is incomplete',
  SELF_HOSTED: 'Refusing to control a desktop app that is an ancestor of this process',
  DESKTOP_RUNNING: 'Codex desktop processes are still running',
  CLI_RUNNING: 'Other Codex clients are still running. Close terminal Codex sessions and quit editors using the Codex extension (including VS Code), then retry.',
  RESOURCE_BUSY: 'A required Codex resource is still open',
  RESOURCE_INSPECTION_FAILED: 'Unable to inspect required Codex resource handles',
  DESKTOP_STOP_TIMEOUT: 'Codex desktop did not stop gracefully before the timeout',
  DESKTOP_QUIT_FAILED: 'Codex did not complete the quit request. Dismiss its quit confirmation before retrying.',
  DESKTOP_QUIT_TIMEOUT: 'Timed out waiting for Codex to quit. Dismiss its quit confirmation before retrying.',
  CLIENT_QUIT_TIMEOUT: 'A blocking client did not quit gracefully before the timeout',
  CLIENT_QUIT_FAILED: 'A blocking client did not complete the quit request. Dismiss its quit confirmation before retrying.',
  CANCELLED: 'Client shutdown was cancelled',
  PROCESS_IDENTITY_CHANGED: 'Codex desktop process identity changed while waiting',
  DESKTOP_OPEN_FAILED: 'Unable to open the Codex desktop app',
  DESKTOP_OPEN_TIMEOUT: 'Codex desktop did not expose one main process before the timeout',
  DESKTOP_OPEN_AMBIGUOUS: 'Codex desktop exposed more than one main process',
};

export class DesktopRuntimeError extends Error {
  constructor(code, remainingProcesses = []) {
    const remaining = normalizeRows(remainingProcesses);
    super((MESSAGES[code] || 'Desktop runtime failed') + (remaining.length
      ? '\nLast observed blocking processes:\n' + remaining.map(p => `  PID ${p.pid} (parent ${p.ppid}): ${p.executable}`).join('\n') : ''));
    this.name = 'DesktopRuntimeError';
    this.code = code;
    this.remainingProcesses = remaining;
  }
}
const error = (code, remaining) => new DesktopRuntimeError(code, remaining);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeSystemEnvironment = home => ({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(home ? { HOME: home } : {}) });
const validAbsolute = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && !/[\x00-\x1f\x7f]/.test(value);
const identity = entry => `${entry.pid}:${entry.startedAt}`;
const validBundleExecutable = value => typeof value === 'string' && value && !value.includes('/') && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value);

/** Versions and hashes are observations, not persistent compatibility pins. */
export function sameDesktopApp(left, right) {
  return Boolean(left && right && validAbsolute(left.appPath) && validAbsolute(left.executable)
    && typeof left.bundleId === 'string' && left.bundleId
    && left.appPath === right.appPath && left.bundleId === right.bundleId && left.executable === right.executable);
}

function crashReporterPath(executable, appPath) {
  const prefix = `${appPath}/Contents/Frameworks/Codex Framework.framework/Versions/`;
  return typeof executable === 'string' && executable.startsWith(prefix)
    && /^[0-9]+(?:\.[0-9]+)*\/Helpers\/browser_crashpad_handler$/.test(executable.slice(prefix.length));
}

function isAppExecutable(executable, appPath) {
  return typeof executable === 'string' && (executable === appPath || executable.startsWith(`${appPath}/Contents/`));
}

function parsePs(stdout) {
  if (typeof stdout !== 'string') throw error('PROCESS_OBSERVATION_INVALID');
  const rows = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // lstart is deliberately retained as a start identity instead of parsing
    // locale-sensitive text. `comm` is requested specifically so ps provides
    // the executable, not command arguments.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/);
    if (!match) throw error('PROCESS_OBSERVATION_INVALID');
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), startedAt: match[4], executable: match[5] });
  }
  return rows;
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw error('PROCESS_OBSERVATION_INVALID');
  const byPid = new Map();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.ppid) || row.ppid < 0 ||
      !Number.isSafeInteger(row.uid) || row.uid < 0 || typeof row.startedAt !== 'string' || !row.startedAt ||
      typeof row.executable !== 'string' || !row.executable || /[\x00-\x1f\x7f]/.test(row.executable) || byPid.has(row.pid)) throw error('PROCESS_OBSERVATION_INVALID');
    byPid.set(row.pid, { pid: row.pid, ppid: row.ppid, uid: row.uid, startedAt: row.startedAt, executable: row.executable });
  }
  return [...byPid.values()];
}

async function inspectOneDesktopApp({ appPath, execFile, readFile, realpath, expected, timeoutMs, discoverDefault }) {
  let plist, asar, crashReporter;
  try {
    [{ stdout: plist }, asar, crashReporter] = await Promise.all([
      execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', `${appPath}/Contents/Info.plist`], { encoding: 'utf8', maxBuffer: 65536, timeout: timeoutMs }),
      readFile(`${appPath}/Contents/Resources/app.asar`),
      realpath(`${appPath}/Contents/Frameworks/Codex Framework.framework/Helpers/browser_crashpad_handler`),
    ]);
  } catch { throw error('APP_INSPECTION_FAILED'); }
  let info;
  try { info = JSON.parse(String(plist)); } catch { throw error('APP_INSPECTION_FAILED'); }
  if (!info || typeof info.CFBundleShortVersionString !== 'string' || !info.CFBundleShortVersionString.trim()
    || !['string', 'number'].includes(typeof info.CFBundleVersion) || !String(info.CFBundleVersion).trim()
    || !validBundleExecutable(info.CFBundleExecutable) || !crashReporterPath(crashReporter, appPath)) throw error('APP_INSPECTION_FAILED');
  const result = {
    appPath,
    bundleId: info.CFBundleIdentifier,
    version: info.CFBundleShortVersionString,
    build: String(info.CFBundleVersion),
    executable: `${appPath}/Contents/MacOS/${info.CFBundleExecutable}`,
    asarSha256: createHash('sha256').update(asar).digest('hex'),
    crashReporter,
  };
  if (discoverDefault ? result.bundleId !== DESKTOP_APP.bundleId : !sameDesktopApp(result, expected)) throw error('APP_IDENTITY_MISMATCH');
  try {
    await execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${signingRequirement}`, appPath],
      { encoding: 'utf8', maxBuffer: 65536, timeout: timeoutMs, env: safeSystemEnvironment() });
  } catch { throw error('APP_SIGNATURE_INVALID'); }
  return result;
}

/** Discover and verify the installed desktop bundle without opening it. */
export async function inspectDesktopApp({
  appPath = DESKTOP_APP.appPath,
  execFile = execFileDefault,
  readFile = nodeReadFile,
  realpath = nodeRealpath,
  expected = DESKTOP_APP,
  timeoutMs = 5000,
} = {}) {
  if (!validAbsolute(appPath) || typeof execFile !== 'function' || typeof readFile !== 'function' || typeof realpath !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error('INVALID_OPTIONS');
  const discoverDefault = appPath === DESKTOP_APP.appPath && expected === DESKTOP_APP;
  if (!discoverDefault) return inspectOneDesktopApp({ appPath, execFile, readFile, realpath, expected, timeoutMs, discoverDefault: false });
  const matches = [];
  for (const candidate of DEFAULT_APP_PATHS) {
    try { matches.push(await inspectOneDesktopApp({ appPath: candidate, execFile, readFile, realpath, expected, timeoutMs, discoverDefault: true })); }
    catch (caught) {
      if (caught.code !== 'APP_INSPECTION_FAILED') throw caught;
    }
  }
  if (!matches.length) throw error('APP_INSPECTION_FAILED');
  if (matches.length !== 1) throw error('APP_AMBIGUOUS');
  return matches[0];
}

/**
 * Create the desktop side of a profile-switch controller.  All process and
 * command operations can be injected for tests; production defaults use only
 * macOS system tools with sanitized environments.
 */
export function createDesktopRuntime({
  appPath = DESKTOP_APP.appPath,
  bundleId = DESKTOP_APP.bundleId,
  executable = DESKTOP_APP.executable,
  execFile = execFileDefault,
  readFile = nodeReadFile,
  realpath = nodeRealpath,
  lstat = nodeLstat,
  expected = DESKTOP_APP,
  processSnapshot,
  sleep = delay,
  now = () => Date.now(),
  currentPid = process.pid,
  userInfo = nodeUserInfo,
  stopTimeoutMs = 10000,
  openTimeoutMs = 15000,
  pollIntervalMs = 100,
  systemTimeoutMs = 5000,
  quitTimeoutMs = 60000,
  closeClients = false,
  confirmCloseClients,
  signal,
  onProgress = () => {},
  ramLogs = createLogStorage(),
} = {}) {
  if (!validAbsolute(appPath) || typeof bundleId !== 'string' || !bundleId || !validAbsolute(executable) ||
    typeof execFile !== 'function' || typeof lstat !== 'function' || (processSnapshot !== undefined && typeof processSnapshot !== 'function') ||
    typeof sleep !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(currentPid) || currentPid <= 0 ||
    typeof userInfo !== 'function' || ![stopTimeoutMs, openTimeoutMs, pollIntervalMs, systemTimeoutMs, quitTimeoutMs].every(v => Number.isFinite(v) && v > 0) ||
    typeof closeClients !== 'boolean' || (confirmCloseClients !== undefined && typeof confirmCloseClients !== 'function') || typeof onProgress !== 'function' ||
    (signal !== undefined && (!signal || typeof signal !== 'object' || typeof signal.aborted !== 'boolean'))) throw error('INVALID_OPTIONS');

  // Retaining the observed identities lets a child which was re-parented when
  // the main process exits remain an owned process until it actually exits.
  let tracked = new Map();
  let appVerified = false, verifiedCrashReporter, retained = [], clientPreparationAttempted = false;
  const fallbackDiscoveryPending = appPath === DESKTOP_APP.appPath && expected === DESKTOP_APP;

  async function inspectApp() {
    appVerified = false;
    verifiedCrashReporter = undefined;
    const result = await inspectDesktopApp({ appPath, execFile, readFile, realpath, expected, timeoutMs: systemTimeoutMs });
    appPath = result.appPath;
    bundleId = result.bundleId;
    executable = result.executable;
    expected = result;
    verifiedCrashReporter = result.crashReporter;
    appVerified = true;
    return result;
  }

  async function allProcesses() {
    let value;
    try {
      value = processSnapshot ? await processSnapshot() : parsePs((await execFile('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,comm='], {
        encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: systemTimeoutMs,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
      })).stdout);
    } catch (caught) {
      if (caught instanceof DesktopRuntimeError) throw caught;
      throw error('PROCESS_INSPECTION_FAILED');
    }
    return normalizeRows(value);
  }

  async function resolveObservedAlternate(all) {
    if (!fallbackDiscoveryPending || appVerified || !all.some(row => isAppExecutable(row.executable, DEFAULT_APP_PATHS[1]))) return;
    await inspectApp();
  }

  function orphanCrashReporters(all, entries) {
    const parents = new Set(all.map(row => row.ppid));
    const uid = currentUid();
    return entries.filter(row => row.uid === uid && row.ppid === 1
      && (appVerified ? row.executable === verifiedCrashReporter : crashReporterPath(row.executable, appPath))
      && !parents.has(row.pid));
  }

  async function observed() {
    const all = await allProcesses();
    await resolveObservedAlternate(all);
    const byPid = new Map(all.map(row => [row.pid, row]));
    const seeds = new Set();
    for (const row of all) if (isAppExecutable(row.executable, appPath)) seeds.add(row.pid);
    for (const old of tracked.values()) {
      const current = byPid.get(old.pid);
      if (current && identity(current) === identity(old)) seeds.add(current.pid);
    }
    const owned = new Map();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of all) {
        if ((seeds.has(row.pid) || owned.has(row.ppid)) && !owned.has(row.pid)) {
          owned.set(row.pid, row); changed = true;
        }
      }
    }
    const entries = [...owned.values()].sort((a, b) => a.pid - b.pid);
    tracked = new Map(entries.map(row => [identity(row), row]));
    // Crashpad can outlive Electron. Retain only the installed signed helper,
    // orphaned under launchd with no children and owned by the current user.
    // Unknown helpers and every other observed descendant still block.
    retained = appVerified ? orphanCrashReporters(all, entries) : [];
    const retainedPids = new Set(retained.map(row => row.pid));
    return { all, entries: entries.filter(row => !retainedPids.has(row.pid)) };
  }

  async function snapshot() { return (await observed()).entries; }

  function currentUid() {
    try {
      const uid = userInfo().uid;
      if (Number.isSafeInteger(uid) && uid >= 0) return uid;
    } catch { /* fail closed below */ }
    throw error('PROCESS_OBSERVATION_INVALID');
  }

  async function resourceHolders(resourcePaths) {
    const presentPaths = [];
    for (const path of resourcePaths) {
      try { await lstat(path); presentPaths.push(path); }
      catch (caught) {
        // A RAM disk or its log may be absent after reboot. Only a confirmed
        // missing entry is skipped; permission errors and dangling symlinks
        // must not be mistaken for successful handle inspection.
        if (caught?.code !== 'ENOENT') throw error('RESOURCE_INSPECTION_FAILED');
      }
    }
    if (!presentPaths.length) return [];
    let result;
    try {
      // `-F pcu` returns only PID, command name, and UID records. We use only
      // PIDs and resolve their safe identity from our own `ps` observation;
      // lsof never receives a directory or wildcard, only caller-approved
      // exact resource paths.
      result = await execFile('/usr/sbin/lsof', ['-nP', '-F', 'pcu', '-a', '--', ...presentPaths], {
        cwd: '/', env: safeSystemEnvironment(), encoding: 'utf8', maxBuffer: 65536, timeout: systemTimeoutMs,
      });
    } catch (caught) {
      if (caught?.code === 1 && caught.stdout === '' && caught.stderr === '') return [];
      throw error('RESOURCE_INSPECTION_FAILED');
    }
    if (typeof result?.stdout !== 'string' || (result.stderr !== undefined && result.stderr !== '')) throw error('RESOURCE_INSPECTION_FAILED');
    if (result.stdout === '') return [];
    const pids = new Set();
    let sawProcess = false;
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('p')) {
        const pid = Number(line.slice(1));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw error('RESOURCE_INSPECTION_FAILED');
        pids.add(pid); sawProcess = true;
      } else if (!sawProcess || !/^[cu][^\x00-\x1f\x7f]+$/.test(line)) throw error('RESOURCE_INSPECTION_FAILED');
    }
    if (!pids.size) throw error('RESOURCE_INSPECTION_FAILED');
    return [...pids];
  }

  function cliClients(rows, cliExecutables, excluded = new Set()) {
    const uid = currentUid(), executables = new Set(cliExecutables);
    return rows.filter(row => row.uid === uid && !excluded.has(row.pid)
      && (executables.has(row.executable) || ['codex', 'codex-cli'].includes(basename(row.executable))));
  }

  function aborted() {
    if (signal?.aborted) throw error('CANCELLED');
  }

  // Only accept a VS Code application that is actually the ancestor of the
  // Codex process we saw. A path inside .vscode alone is deliberately not an
  // authority to quit an editor.
  function codeAppPath(row) {
    const marker = '/Contents/MacOS/';
    const index = row.executable.indexOf(marker);
    if (index <= 0 || row.executable.indexOf(marker, index + 1) !== -1) return undefined;
    const app = row.executable.slice(0, index);
    const main = row.executable.slice(index + marker.length);
    return app.endsWith('.app') && main && validAbsolute(app) ? { appPath: app, executable: row.executable } : undefined;
  }

  async function inspectCodeApp(root) {
    const candidate = codeAppPath(root);
    if (!candidate) return undefined;
    let stdout;
    try {
      ({ stdout } = await execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', `${candidate.appPath}/Contents/Info.plist`], {
        cwd: '/', env: safeSystemEnvironment(), encoding: 'utf8', maxBuffer: 65536, timeout: systemTimeoutMs,
      }));
    } catch { return undefined; }
    let info;
    try { info = JSON.parse(String(stdout)); } catch { return undefined; }
    if (!info || !['com.microsoft.VSCode', 'com.microsoft.VSCodeInsiders'].includes(info.CFBundleIdentifier) ||
      typeof info.CFBundleExecutable !== 'string' || !info.CFBundleExecutable ||
      candidate.executable !== `${candidate.appPath}/Contents/MacOS/${info.CFBundleExecutable}`) return undefined;
    return { type: 'vscode', name: info.CFBundleName || (info.CFBundleIdentifier === 'com.microsoft.VSCodeInsiders' ? 'Visual Studio Code - Insiders' : 'Visual Studio Code'), appPath: candidate.appPath, bundleId: info.CFBundleIdentifier,
      executable: candidate.executable, pid: root.pid, startedAt: root.startedAt, clients: [], processes: [] };
  }

  function codeAncestors(row, byPid) {
    const seen = new Set(); let current = row;
    const result = [];
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (codeAppPath(current)) result.push(current);
      current = byPid.get(current.ppid);
    }
    return result;
  }

  async function verifiedCodeAncestor(row, byPid) {
    for (const root of codeAncestors(row, byPid)) {
      const descriptor = await inspectCodeApp(root);
      if (descriptor) return { root, descriptor };
    }
    return undefined;
  }

  function appleString(value) {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  async function quitCodeApps(descriptors) {
    const roots = descriptors.filter(item => item.type === 'vscode');
    // Recheck before issuing any event: a PID that has exited or been reused
    // must never cause us to activate a new application instance.
    const current = await allProcesses();
    const fresh = new Map(current.map(row => [row.pid, row]));
    for (const item of roots) {
      const row = fresh.get(item.pid);
      if (!row || identity(row) !== `${item.pid}:${item.startedAt}` || row.executable !== item.executable || row.uid !== currentUid()) throw error('PROCESS_IDENTITY_CHANGED', item.clients);
    }
    for (const item of roots) {
      aborted();
      // Revalidate each exact root just before its own event; another editor
      // may have been closed or relaunched while a previous quit was pending.
      const latest = new Map((await allProcesses()).map(row => [row.pid, row]));
      const root = latest.get(item.pid);
      if (!root || identity(root) !== `${item.pid}:${item.startedAt}` || root.executable !== item.executable) throw error('PROCESS_IDENTITY_CHANGED', item.clients);
      onProgress(`Quitting ${item.name}…`);
      try {
        await execFile('/usr/bin/osascript', ['-e', `if application "${appleString(item.appPath)}" is running then tell application "${appleString(item.appPath)}" to quit`], {
          cwd: '/', env: safeSystemEnvironment(), encoding: 'utf8', maxBuffer: 65536, timeout: quitTimeoutMs, ...(signal ? { signal } : {}),
        });
      } catch (caught) {
        if (signal?.aborted || caught?.name === 'AbortError') throw error('CANCELLED');
        throw error(caught.killed ? 'CLIENT_QUIT_TIMEOUT' : 'CLIENT_QUIT_FAILED', item.clients);
      }
    }
    const until = now() + stopTimeoutMs;
    while (true) {
      aborted();
      const rows = await allProcesses(); const fresh = new Map(rows.map(row => [row.pid, row]));
      const remaining = roots.flatMap(item => {
        const root = fresh.get(item.pid);
        if (root && identity(root) !== `${item.pid}:${item.startedAt}`) throw error('PROCESS_IDENTITY_CHANGED', [root]);
        const clients = item.clients.filter(client => {
          const live = fresh.get(client.pid);
          if (live && identity(live) !== identity(client)) throw error('PROCESS_IDENTITY_CHANGED', [live]);
          return Boolean(live);
        });
        return root ? [root, ...clients] : clients;
      });
      if (!remaining.length) return;
      if (now() >= until) throw error('CLIENT_QUIT_TIMEOUT', remaining);
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Prepare known graphical Codex clients for an exclusive profile operation.
   * This is the sole mutating client path; ordinary assertions remain read-only.
   */
  async function prepareClients({ cliExecutables = [], includeDesktop = false } = {}) {
    if (!Array.isArray(cliExecutables) || !cliExecutables.every(validAbsolute) || typeof includeDesktop !== 'boolean') throw error('INVALID_OPTIONS');
    aborted();
    let desktop = await observed();
    // Copy/import can be called before the desktop has been inspected. Match
    // assertIdle's retained-crashpad handling so an already-exited desktop does
    // not prompt the user merely because its signed orphan helper remains.
    if (includeDesktop && !appVerified && desktop.entries.length &&
      orphanCrashReporters(desktop.all, desktop.entries).length === desktop.entries.length) {
      await inspectApp();
      desktop = await observed();
    }
    const cli = cliClients(desktop.all, cliExecutables, new Set(desktop.entries.map(row => row.pid)));
    if (!cli.length && (!includeDesktop || !desktop.entries.length)) return { clients: [] };
    const byPid = new Map(desktop.all.map(row => [row.pid, row]));
    const ancestry = []; const seen = new Set(); let cursor = currentPid;
    while (true) {
      if (seen.has(cursor)) throw error('PROCESS_OBSERVATION_INVALID');
      seen.add(cursor);
      const row = byPid.get(cursor);
      if (!row) throw error('PROCESS_OBSERVATION_INVALID');
      ancestry.push(row);
      if (row.ppid === 1) break;
      cursor = row.ppid;
    }
    const groups = new Map();
    for (const client of cli) {
      const matched = await verifiedCodeAncestor(client, byPid);
      if (!matched || matched.root.uid !== currentUid()) throw error('CLI_RUNNING', cli);
      const root = matched.root;
      // AppleScript addresses an application bundle, so multiple observed main
      // processes for that exact bundle make the target ambiguous.
      if (desktop.all.filter(row => row.uid === currentUid() && row.executable === matched.descriptor.executable).length !== 1) throw error('CLI_RUNNING', cli);
      const key = identity(root);
      if (!groups.has(key)) groups.set(key, { root, descriptor: matched.descriptor, clients: [] });
      groups.get(key).clients.push(client);
    }
    const descriptors = [];
    for (const group of groups.values()) {
      const descriptor = group.descriptor;
      descriptor.clients = group.clients.map(row => ({ ...row }));
      descriptor.processes = descriptor.clients;
      descriptors.push(descriptor);
    }
    if (new Set(descriptors.map(item => item.appPath)).size !== descriptors.length) throw error('CLI_RUNNING', cli);
    // An integrated terminal is normally under a Code Helper.app before the
    // actual editor. Check every ancestor, not just the nearest helper.
    const selfAncestors = await verifiedCodeAncestor(ancestry[0], byPid);
    if (selfAncestors && descriptors.some(item => item.pid === selfAncestors.root.pid && item.startedAt === selfAncestors.root.startedAt)) throw error('SELF_HOSTED', [selfAncestors.root]);
    if (includeDesktop && desktop.entries.length) {
      if (!appVerified) await inspectApp();
      desktop = await observed();
      await assertExternal();
      const mains = desktop.entries.filter(row => row.executable === executable);
      if (mains.length !== 1 || mains[0].uid !== currentUid()) throw error('DESKTOP_RUNNING', desktop.entries);
      descriptors.push({ type: 'desktop', name: 'Codex', appPath, bundleId, executable, pid: undefined, startedAt: undefined,
        clients: desktop.entries.map(row => ({ ...row })), processes: desktop.entries.map(row => ({ ...row })) });
    }
    if (!descriptors.length) return { clients: [] };
    if (clientPreparationAttempted) throw error(desktop.entries.length && includeDesktop ? 'DESKTOP_RUNNING' : 'CLI_RUNNING', cli);
    clientPreparationAttempted = true;
    const publicDescriptors = descriptors.map(item => ({ ...item, clients: item.clients.map(row => ({ ...row })), processes: item.processes.map(row => ({ ...row })) }));
    if (!closeClients) {
      if (!confirmCloseClients) throw error(desktop.entries.length && includeDesktop ? 'DESKTOP_RUNNING' : 'CLI_RUNNING', cli.length ? cli : desktop.entries);
      if (!await confirmCloseClients(publicDescriptors)) throw error('CANCELLED');
    }
    aborted();
    const code = descriptors.filter(item => item.type === 'vscode');
    if (code.length) await quitCodeApps(code);
    const desktopDescriptor = descriptors.find(item => item.type === 'desktop');
    if (desktopDescriptor) {
      aborted(); onProgress(`Quitting ${desktopDescriptor.name}…`);
      const freshDesktop = await observed();
      const originalMains = desktop.entries.filter(row => row.executable === executable);
      const freshMains = freshDesktop.entries.filter(row => row.executable === executable);
      if (originalMains.length !== 1 || freshMains.length !== 1 || !desktop.entries.every(old => {
        const live = freshDesktop.all.find(row => row.pid === old.pid);
        return !live || (identity(live) === identity(old) && live.executable === old.executable);
      }) || identity(originalMains[0]) !== identity(freshMains[0])) throw error('PROCESS_IDENTITY_CHANGED', freshDesktop.entries);
      await stop({ signal });
    }
    onProgress('Blocking clients have closed.');
    return { clients: publicDescriptors };
  }

  // A pre-quit usability check. The running desktop and its descendants are
  // expected here; the strict post-quit assertIdle check still requires them gone.
  async function assertNoOtherClients(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || !Array.isArray(options.cliExecutables ?? []) || !(options.cliExecutables ?? []).every(validAbsolute)) throw error('INVALID_OPTIONS');
    const desktop = await observed();
    const clients = cliClients(desktop.all, options.cliExecutables ?? [], new Set(desktop.entries.map(row => row.pid)));
    if (clients.length) throw error('CLI_RUNNING', clients);
    return { otherClients: [] };
  }

  /**
   * Confirm no managed desktop, same-user standalone CLI, or explicit shared
   * resource handle can race a paired home/alias change. This is inspection
   * only: it never closes a handle, kills a process, or walks a directory.
   */
  async function assertIdle(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw error('INVALID_OPTIONS');
    const { cliExecutables = [], resourcePaths = [] } = options;
    if (!Array.isArray(cliExecutables) || !Array.isArray(resourcePaths) ||
      !cliExecutables.every(validAbsolute) || !resourcePaths.every(validAbsolute)) throw error('INVALID_OPTIONS');
    let desktop = await observed();
    // Standalone settings copy/undo callers have not inspected the app first.
    // Verify only when all remaining desktop entries could be retained reporters,
    // then take a fresh snapshot before relying on that exception.
    if (!appVerified && desktop.entries.length
      && orphanCrashReporters(desktop.all, desktop.entries).length === desktop.entries.length) {
      await inspectApp();
      desktop = await observed();
    }
    if (desktop.entries.length) throw error('DESKTOP_RUNNING', desktop.entries);
    const all = await allProcesses();
    const cli = cliClients(all, cliExecutables);
    if (cli.length) throw error('CLI_RUNNING', cli);
    const holders = await resourceHolders(resourcePaths);
    if (!holders.length) return { desktop: [], cli: [], resources: [] };
    // A process can exit between lsof and ps. It cannot safely be assumed to
    // have exited: a reused PID could now own the resource, so take a fresh
    // identity snapshot and fail closed if lsof's PID is absent.
    const fresh = new Map((await allProcesses()).map(row => [row.pid, row]));
    const resources = holders.map(pid => fresh.get(pid));
    if (resources.some(row => row === undefined)) throw error('RESOURCE_INSPECTION_FAILED');
    throw error('RESOURCE_BUSY', resources);
  }

  async function assertExternal() {
    const all = await allProcesses();
    await resolveObservedAlternate(all);
    const byPid = new Map(all.map(row => [row.pid, row]));
    const visited = new Set();
    let pid = currentPid;
    while (pid && !visited.has(pid)) {
      visited.add(pid);
      const row = byPid.get(pid);
      if (!row) throw error('PROCESS_OBSERVATION_INVALID');
      if (isAppExecutable(row.executable, appPath)) throw error('SELF_HOSTED');
      // ps output can omit PID 1 in constrained sessions.  A process directly
      // parented by launchd has no further desktop ancestor to inspect.
      if (row.ppid === 1) return true;
      pid = row.ppid;
    }
    return true;
  }

  async function command(path, args, env) {
    try { await execFile(path, args, { cwd: '/', env, encoding: 'utf8', maxBuffer: 65536, timeout: systemTimeoutMs }); }
    catch { throw error('DESKTOP_OPEN_FAILED'); }
  }

  function identitiesStillMatch(initial, all) {
    const byPid = new Map(all.map(row => [row.pid, row]));
    for (const old of initial) {
      const current = byPid.get(old.pid);
      if (current && identity(current) !== identity(old)) return false;
    }
    return true;
  }

  async function stop({ signal: quitSignal } = {}) {
    if (quitSignal?.aborted) throw error('CANCELLED');
    await assertExternal();
    const before = await observed();
    if (!before.entries.length) return before.entries;
    // A re-parented helper has no app main left to receive a graceful quit.
    // Sending an Apple event in that state can itself activate the app, so the
    // controller must recover the leftover explicitly instead of guessing.
    if (!before.entries.some(row => row.executable === executable)) throw error('DESKTOP_RUNNING', before.entries);
    // The native confirmation is interactive; a five-second system-command
    // budget is unsuitable while a person is deciding whether to end tasks.
    try { await execFile('/usr/bin/osascript', ['-e', `tell application id "${bundleId}" to quit`], { cwd: '/', env: safeSystemEnvironment(), encoding: 'utf8', maxBuffer: 65536, timeout: quitTimeoutMs, ...(quitSignal ? { signal: quitSignal } : {}) }); }
    catch (caught) {
      // Keep process evidence even if the quit request itself fails. Refresh
      // it when possible; a failed observation must not hide the quit error.
      const remaining = await observed().then(value => value.entries, () => before.entries);
      if (quitSignal?.aborted || caught?.name === 'AbortError') throw error('CANCELLED', remaining);
      throw error(caught.killed ? 'DESKTOP_QUIT_TIMEOUT' : 'DESKTOP_QUIT_FAILED', remaining);
    }
    const until = now() + stopTimeoutMs;
    while (true) {
      if (quitSignal?.aborted) throw error('CANCELLED');
      const next = await observed();
      if (!identitiesStillMatch(before.entries, next.all)) throw error('PROCESS_IDENTITY_CHANGED', next.entries);
      if (!next.entries.length) return next.entries;
      if (now() >= until) throw error('DESKTOP_STOP_TIMEOUT', next.entries);
      await sleep(pollIntervalMs);
    }
  }

  function validPlan(plan) {
    return plan && typeof plan === 'object' && validAbsolute(plan.home) && validAbsolute(plan.desktopData) && plan.env &&
      validAbsolute(plan.env.HOME) && validAbsolute(plan.env.TMPDIR);
  }

  async function waitForOneMain() {
    const until = now() + openTimeoutMs;
    while (true) {
      const next = await observed();
      const mains = next.entries.filter(row => row.executable === executable);
      if (mains.length === 1) return next.entries;
      if (mains.length > 1) throw error('DESKTOP_OPEN_AMBIGUOUS');
      if (now() >= until) throw error('DESKTOP_OPEN_TIMEOUT');
      await sleep(pollIntervalMs);
    }
  }

  async function open(plan) {
    if (!validPlan(plan)) throw error('INVALID_OPTIONS');
    await assertExternal();
    const before = await observed();
    if (before.entries.length) throw error('DESKTOP_RUNNING', before.entries);
    const env = safeSystemEnvironment();
    const args = ['-n', '--env', `CODEX_HOME=${plan.home}`, '--env', `CODEX_ELECTRON_USER_DATA_PATH=${plan.desktopData}`,
      '--env', `CODEX_SQLITE_HOME=${plan.home}`, '--env', `HOME=${plan.env.HOME}`, '--env', `TMPDIR=${plan.env.TMPDIR}`,
      appPath, '--args', `--user-data-dir=${plan.desktopData}`];
    await command('/usr/bin/open', args, env);
    return waitForOneMain();
  }

  async function restore() {
    await assertExternal();
    const before = await observed();
    if (before.entries.length) throw error('DESKTOP_RUNNING', before.entries);
    let home;
    try { home = userInfo().homedir; } catch { throw error('INVALID_OPTIONS'); }
    if (!validAbsolute(home)) throw error('INVALID_OPTIONS');
    await command('/usr/bin/open', [appPath], safeSystemEnvironment(home));
    return waitForOneMain();
  }

  function seedTracked(entries) {
    const normalized = normalizeRows(entries);
    tracked = new Map(normalized.map(row => [identity(row), row]));
  }

  return { inspectApp, assertExternal, assertNoOtherClients, assertIdle, prepareClients, snapshot, seedTracked, stop, open, restore,
    ensureLogStorage: options => ramLogs.ensureMounted(options),
    ensureHomeLogs: options => ramLogs.prepareHome(options),
    retainedCrashpad: () => retained.map(row => ({ ...row })) };
}
