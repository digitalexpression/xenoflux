// LaunchServices owns the app lifetime; this durable reservation never follows the UI PID.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { acquire, exists, privateDirectory, readJSON, record, release } from './metadata.js';
import { find, strictDescendant, validateProfile } from './profiles.js';
import { withProfileOperation } from './desktop-instances.js';
import { createDesktopInstanceRuntime, matchesProcessIdentity, processIdentity } from './desktop-instance-runtime.js';
import { createStockDesktopApps, STOCK_DESKTOP_APPS } from './stock-desktop-apps.js';
import { claudeEnvironment } from './claude-profile.js';
import { assertCopilotEnvironment } from './copilot-profile.js';
import { assertNoLegacyAuditLease } from './profile-reservations.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const absolute = value => typeof value === 'string' && value.startsWith('/') && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value);
const validProcess = row => row && Number.isSafeInteger(row.pid) && row.pid > 0 && row.uid === process.getuid()
  && typeof row.startedAt === 'string' && row.startedAt.length > 0 && absolute(row.executable);
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const uncertain = reason => ({ state: 'uncertain', reason });

export function createManagedDesktop(store, {
  stockApps = createStockDesktopApps(), lockOptions = {}, runtime = createDesktopInstanceRuntime(),
  execFile = promisify(nodeExecFile), environment = process.env, nativeUser = userInfo(),
  now = Date.now, sleep = sleepDefault, openTimeoutMs = 15000, pollIntervalMs = 100,
} = {}) {
  async function binding(name) {
    const profile = find(await store.read(), name);
    validateProfile(profile);
    const native = profile.native;
    const vendor = profile.client === 'claude-code' ? 'claude' : 'copilot';
    if (!['copilot', 'claude-code'].includes(profile.client) || native?.rootMode !== 'explicit'
      || !strictDescendant(native.root, native.configRoot)) throw new Error('Choose an explicit managed Desktop profile');
    const stocks = vendor === 'copilot' ? [join(nativeUser.homedir, '.copilot')] : [join(nativeUser.homedir, '.claude'), join(nativeUser.homedir, 'Library/Application Support/Claude')];
    for (const stock of stocks) {
      let canonical = stock;
      if (vendor === 'claude') {
        try { canonical = await realpath(stock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if ([stock, canonical].some(path => native.root === path || strictDescendant(native.root, path) || strictDescendant(path, native.root))
        || native.root === nativeUser.homedir) throw new Error('Managed Desktop root overlaps the native account');
    }
    const workspace = join(native.root, 'workspace');
    if (vendor === 'claude' && (native.configRoot === workspace || strictDescendant(native.configRoot, workspace) || strictDescendant(workspace, native.configRoot))) throw new Error('Profile config and workspace overlap');
    const desktopData = join(native.root, 'desktop');
    if (vendor === 'claude' && (native.configRoot === desktopData || strictDescendant(native.configRoot, desktopData) || strictDescendant(desktopData, native.configRoot))) throw new Error('Profile config and Desktop storage overlap');
    const roots = [native.root, native.configRoot, workspace];
    const desktopPresent = vendor === 'claude' && Boolean(await exists(desktopData));
    if (desktopPresent) roots.push(desktopData);
    const identities = await Promise.all(roots.map(async path => {
      await privateDirectory(path);
      const stat = await lstat(path);
      return [stat.dev, stat.ino];
    }));
    return { profile, vendor, kind: `${vendor}-desktop`, value: { profileId: profile.id, environmentId: native.environmentId,
      root: native.root, configRoot: native.configRoot, workspace, ...(vendor === 'claude' ? { desktopData } : {}), identities },
    lock: join(native.root, '.run-lock') };
  }
  const resources = value => [value.root, value.configRoot, value.workspace, value.desktopData].filter(Boolean);
  async function databaseOwner(value, main, processes = [main]) {
    const path = value.desktopData ? join(value.desktopData, 'Cookies') : join(value.configRoot, 'data.db');
    const info = await exists(path);
    if (!info) return false;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid())
      throw new Error('Selected Desktop storage path is unsafe');
    const observed = await runtime.assertResourcesIdle([path], { allowedProcesses: value.desktopData ? processes : [main] });
    const checked = await lstat(path);
    if (checked.dev !== info.dev || checked.ino !== info.ino || checked.nlink !== 1 || checked.isSymbolicLink()) throw new Error('Selected Desktop storage changed');
    return observed.processes.some(row => (value.desktopData ? processes : [main]).some(owned => matchesProcessIdentity(row, owned)));
  }
  async function assertBinding(previous) {
    const current = await binding(previous.profile.id);
    if (!equal(current.value, previous.value)) throw new Error('Desktop profile roots changed; preserving reservation');
    return current;
  }
  function appProcesses(rows, path) {
    return rows.filter(row => row.executable === path || row.executable.startsWith(`${path}/`)
      || row.executable.endsWith('/Contents/MacOS/github')
      || row.executable.startsWith(`${STOCK_DESKTOP_APPS.copilot.path}/`));
  }
  function descendants(rows, main) {
    const selected = new Set([main.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
    }
    return rows.filter(row => selected.has(row.pid));
  }
  async function scopedCrashpads(current, app, rows) {
    if (current.vendor !== 'claude') return [];
    const executable = join(app.path, 'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler');
    const result = [];
    for (const row of rows.filter(row => row.uid === process.getuid() && row.executable === executable)) {
      const before = (await runtime.snapshot()).find(candidate => candidate.pid === row.pid);
      if (!matchesProcessIdentity(before, row)) throw new Error('Claude crash reporter identity changed; preserving reservation');
      const { stdout } = await execFile('/bin/ps', ['-ww', '-p', String(row.pid), '-o', 'args='], {
        timeout: 1000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' },
      });
      const after = (await runtime.snapshot()).find(candidate => candidate.pid === row.pid);
      if (!matchesProcessIdentity(after, row)) throw new Error('Claude crash reporter identity changed; preserving reservation');
      const args = typeof stdout === 'string' ? stdout.trim() : '';
      // ps renders unquoted paths; accept only one unambiguous database option.
      const databases = [...args.matchAll(/(?:^| )--database=(.*?)(?= --|$)/g)];
      if (args.length >= 16383 || /[\r\n\x00]/.test(args) || !args.startsWith(`${executable} `)
        || databases.length !== 1 || !absolute(databases[0][1]))
        throw new Error('Claude crash reporter attribution is incomplete; preserving reservation');
      if (databases[0][1] === join(current.value.desktopData, 'Crashpad')) result.push(row);
    }
    return result;
  }
  async function readClaim(current) {
    await privateDirectory(current.lock);
    const owner = await readJSON(join(current.lock, 'owner.json'));
    if (owner?.kind !== current.kind || owner.schemaVersion !== 1 || owner.host !== hostname()
      || owner.profileId !== current.profile.id || owner.storePath !== store.directory || !uuid.test(owner.runId ?? '')
      || Object.keys(owner).sort().join(',') !== 'host,kind,profileId,runId,schemaVersion,storePath')
      throw new Error('Profile has a foreign or unresolved reservation');
    const directory = join(current.value.root, 'launches', owner.runId);
    await privateDirectory(join(current.value.root, 'launches'));
    await privateDirectory(directory);
    const path = join(directory, 'report.json'), saved = await readJSON(path);
    if (saved.schemaVersion !== 1 || saved.kind !== owner.kind || !equal(saved.owner, owner)
      || current.vendor === 'claude' && current.value.identities.length !== 4
      || !equal(saved.binding, current.value) || !['prepared', 'starting', 'running', 'recovered'].includes(saved.phase)
      || !absolute(saved.app?.path) || !absolute(saved.app?.executable)
      || !strictDescendant(join(saved.app.path, 'Contents', 'MacOS'), saved.app.executable)
      || !/^[a-f0-9]{64}$/.test(saved.app.appKey ?? '') || !Array.isArray(saved.processes)
      || typeof saved.spawnIntent !== 'boolean'
      || saved.phase === 'prepared' && saved.spawnIntent !== false
      || ['starting', 'running'].includes(saved.phase) && saved.spawnIntent !== true
      || saved.spawnIntent === false && (saved.main !== undefined || saved.processes.length !== 0)
      || saved.processes.some(row => !validProcess(row))
      || ['running', 'recovered'].includes(saved.phase) && saved.spawnIntent && (!validProcess(saved.main) || saved.main.executable !== saved.app.executable
        || !saved.processes.some(row => matchesProcessIdentity(row, saved.main))))
      throw new Error('Desktop record is incomplete or changed; preserving reservation');
    return { owner, saved, path };
  }
  async function observe(current, claim) {
    const rows = await runtime.snapshot(), saved = claim.saved;
    if (!saved.main && saved.spawnIntent !== false) return uncertain('Desktop startup attribution is incomplete; preserve its reservation');
    for (const previous of saved.processes) {
      const row = rows.find(row => row.pid === previous.pid);
      if (row && !matchesProcessIdentity(row, previous)) return uncertain('Desktop process identity changed; preserve its reservation');
    }
    const main = rows.find(row => matchesProcessIdentity(row, saved.main));
    const scoped = await scopedCrashpads(current, saved.app, rows);
    const allowed = [...new Map([...saved.processes, ...(main ? descendants(rows, main) : [])]
      .map(row => [processIdentity(row), row])).values()];
    if (scoped.some(row => !allowed.some(previous => matchesProcessIdentity(row, previous)))) return uncertain('A selected-root crash reporter is still running; preserve its reservation');
    await runtime.assertResourcesIdle(resources(current.value), { allowedProcesses: allowed });
    await assertBinding(current);
    if (!equal(await readJSON(claim.path), saved) || !equal(await readJSON(join(current.lock, 'owner.json')), claim.owner))
      throw new Error('Desktop ownership changed');
    if (main) {
      if (!await databaseOwner(current.value, main, allowed.filter(row => !row.executable.endsWith('/chrome_crashpad_handler')))) return uncertain('Selected profile database ownership is unconfirmed');
      return { state: 'running', runId: claim.owner.runId };
    }
    if (saved.processes.some(previous => rows.some(row => matchesProcessIdentity(row, previous))))
      return uncertain('A Desktop descendant is still running; preserve its reservation');
    if (current.vendor === 'copilot' && appProcesses(rows, saved.app.path).length) return uncertain('A Copilot app process is still running; preserve its reservation');
    await runtime.assertResourcesIdle(resources(current.value));
    const stopped = await runtime.snapshot();
    if (saved.processes.some(previous => stopped.some(row => row.pid === previous.pid))
      || current.vendor === 'copilot' && appProcesses(stopped, saved.app.path).length
      || (await scopedCrashpads(current, saved.app, stopped)).length) return uncertain('Desktop processes changed during the stopped check; preserve its reservation');
    return { state: 'recoverable-stopped', runId: claim.owner.runId };
  }
  async function status(name, { installation } = {}) {
    try {
      const current = await binding(name);
      if (await exists(current.lock)) return await observe(current, await readClaim(current));
      return installation?.status === 'available' && /^[a-f0-9]{64}$/.test(installation.appKey ?? '')
        ? { state: 'available', appKey: installation.appKey }
        : { state: 'unavailable', reason: `${current.vendor === 'claude' ? 'Claude' : 'GitHub Copilot'} Desktop is unavailable in the selected installation` };
    } catch (error) { return { state: 'blocked', reason: error.message }; }
  }
  async function open(name, { appKey } = {}) {
    const initial = await binding(name);
    return withProfileOperation(store, initial.profile.id, lockOptions, async () => {
      let current = await assertBinding(initial);
      if (await exists(current.lock)) return observe(current, await readClaim(current));
      if (current.vendor === 'claude') {
        claudeEnvironment(environment, { userHome: nativeUser.homedir, home: current.value.configRoot, rootMode: 'explicit' });
        if (Object.keys(environment).some(key => /^(?:CLAUDE_|ELECTRON_|CHROME_|REMOTE_DEBUGGING|DEBUG|VSCODE_INSPECTOR_OPTIONS)/i.test(key))) throw new Error('Remove ambient Claude Desktop overrides');
        if (environment.HOME !== nativeUser.homedir || environment.USER !== nativeUser.username || environment.LOGNAME !== nativeUser.username) throw new Error('Claude Desktop requires the native account environment');
        if (current.value.identities.length === 3) {
          await privateDirectory(current.value.desktopData, true);
          const prepared = await binding(current.profile.id);
          if (!equal(prepared.value.identities.slice(0, 3), current.value.identities)) throw new Error('Profile roots changed during preparation');
          current = prepared;
        }
      } else assertCopilotEnvironment(environment, nativeUser);
      await assertNoLegacyAuditLease(store.directory, current.value.configRoot);
      const app = await stockApps.binding({ client: current.vendor, appKey });
      const before = await runtime.snapshot();
      if (current.vendor === 'copilot' && appProcesses(before, app.path).length) throw new Error('Close every GitHub Copilot Desktop instance before opening a managed profile');
      if ((await scopedCrashpads(current, app, before)).length) throw new Error('A selected-root Claude crash reporter is still running; preserve its storage');
      // No invocation from inside a target app or its descendants, even through wrappers.
      let ancestor = before.find(row => row.pid === process.pid);
      const seen = new Set();
      while (ancestor && !seen.has(ancestor.pid)) {
        seen.add(ancestor.pid);
        if (ancestor.executable === app.executable || ancestor.executable.startsWith(`${app.path}/`)) throw new Error('Open Desktop from outside the app');
        ancestor = before.find(row => row.pid === ancestor.ppid);
      }
      await runtime.assertResourcesIdle(resources(current.value));
      await assertBinding(current);
      const owner = { kind: current.kind, schemaVersion: 1, host: hostname(), runId: randomUUID(),
        profileId: current.profile.id, storePath: store.directory };
      const launches = join(current.value.root, 'launches'), directory = join(launches, owner.runId);
      await privateDirectory(launches, true); await privateDirectory(directory, true);
      const path = join(directory, 'report.json');
      let saved = { schemaVersion: 1, kind: owner.kind, owner, binding: current.value,
        app, phase: 'prepared', processes: [], spawnIntent: false, createdAt: new Date(now()).toISOString() };
      await acquire(current.lock, owner, true);
      // Every failure after reservation, including uncertain publication, is retained for inspection.
      await record(path, saved);
      const freshApp = await stockApps.binding({ client: current.vendor, appKey });
      if (!equal(freshApp, app)) throw new Error('Desktop app changed before startup; preserving reservation');
      await assertBinding(current);
      const beforeDispatch = await runtime.snapshot();
      if (current.vendor === 'copilot' && appProcesses(beforeDispatch, app.path).length) throw new Error('Another Copilot app appeared; preserving reservation');
      if ((await scopedCrashpads(current, app, beforeDispatch)).length) throw new Error('A selected-root Claude crash reporter appeared; preserving reservation');
      await runtime.assertResourcesIdle(resources(current.value));
      if (!equal(await readJSON(join(current.lock, 'owner.json')), owner) || !equal(await readJSON(path), saved))
        throw new Error('Desktop reservation changed before startup');
      const intent = { ...saved, phase: 'starting', spawnIntent: true };
      // A published intent is the uncertainty boundary; prepared records prove no dispatch.
      await record(path, intent);
      saved = intent;
      await execFile('/usr/bin/open', current.vendor === 'claude' ? ['-n', '-a', app.path, '--env', `CLAUDE_CONFIG_DIR=${current.value.configRoot}`, '--args', `--user-data-dir=${current.value.desktopData}`] : ['-n', '-a', app.path, '--env', `COPILOT_HOME=${current.value.configRoot}`], {
        cwd: current.value.workspace, timeout: openTimeoutMs, maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: nativeUser.homedir, USER: nativeUser.username, LOGNAME: nativeUser.username },
      });
      const old = new Set(before.map(processIdentity)), deadline = now() + openTimeoutMs;
      while (now() <= deadline) {
        const rows = await runtime.snapshot();
        const mains = rows.filter(row => row.executable === app.executable && !old.has(processIdentity(row)));
        if (mains.length > 1) throw new Error('Desktop startup is ambiguous; preserving reservation');
        if (mains.length === 1) {
          const main = mains[0], tree = descendants(rows, main);
          if (before.some(row => row.pid === main.pid && !matchesProcessIdentity(row, main))) throw new Error('Desktop startup reused a process identity; preserving reservation');
          const scoped = await scopedCrashpads(current, app, rows);
          if (scoped.some(row => old.has(processIdentity(row)))) throw new Error('A pre-existing Claude crash reporter uses the selected root');
          const processes = [...tree, ...scoped.filter(row => !tree.some(owned => matchesProcessIdentity(row, owned)))];
          if (current.vendor === 'copilot' && appProcesses(rows, app.path).some(row => !processes.some(owned => matchesProcessIdentity(row, owned))))
            throw new Error('Another Copilot app appeared during startup; preserving reservation');
          if (processes.some(row => !validProcess(row))) {
            await sleep(pollIntervalMs);
            continue;
          }
          let storageOwned;
          try {
            storageOwned = await databaseOwner(current.value, main, tree);
            if (storageOwned) await runtime.assertResourcesIdle(resources(current.value), { allowedProcesses: processes });
          } catch (error) {
            // New helpers can appear between the tree snapshot and the handle scan.
            if (error.code !== 'RESOURCE_BUSY' || !error.remainingProcesses?.length) throw error;
            const fresh = await runtime.snapshot(), currentMain = fresh.find(row => matchesProcessIdentity(row, main));
            const currentTree = currentMain ? descendants(fresh, currentMain) : [];
            if (!error.remainingProcesses.every(row => validProcess(row) && !old.has(processIdentity(row))
              && currentTree.some(owned => matchesProcessIdentity(row, owned)))) throw error;
            await sleep(pollIntervalMs);
            continue;
          }
          if (storageOwned) {
            await assertBinding(current);
            if (!equal(await readJSON(join(current.lock, 'owner.json')), owner) || !equal(await readJSON(path), saved))
              throw new Error('Desktop reservation changed during startup');
            if (!equal(await stockApps.binding({ client: current.vendor, appKey }), app)) throw new Error('Desktop installation changed during startup');
            const latest = await runtime.snapshot();
            const latestMains = latest.filter(row => row.executable === app.executable && !old.has(processIdentity(row)));
            if (latestMains.length !== 1 || !matchesProcessIdentity(latestMains[0], main)) throw new Error('Desktop startup attribution changed; preserving reservation');
            if (processes.some(previous => latest.some(row => row.pid === previous.pid && !matchesProcessIdentity(row, previous))))
              throw new Error('Desktop process changed during startup');
            if (!processes.every(previous => latest.some(row => matchesProcessIdentity(row, previous)))) {
              await sleep(pollIntervalMs);
              continue;
            }
            await record(path, { ...saved, phase: 'running', main, processes });
            return { state: 'running', runId: owner.runId };
          }
        }
        await sleep(pollIntervalMs);
      }
      return uncertain('Desktop startup could not be attributed; preserve its reservation');
    });
  }
  async function recover(name, { apply = false } = {}) {
    if (typeof apply !== 'boolean') throw new Error('Recovery apply must be a boolean');
    const initial = await binding(name), claim = await readClaim(initial);
    const preview = await observe(initial, claim);
    if (preview.state !== 'recoverable-stopped') return preview;
    if (!apply) return { ...preview, status: 'preview', kind: claim.owner.kind };
    return withProfileOperation(store, initial.profile.id, { ...lockOptions, recovery: true }, async () => {
      const current = await assertBinding(initial), fresh = await readClaim(current);
      if (!equal(fresh.owner, claim.owner) || !equal(fresh.saved, claim.saved)) throw new Error('Desktop ownership changed; preserving reservation');
      const checked = await observe(current, fresh);
      if (checked.state !== 'recoverable-stopped') return checked;
      await record(fresh.path, { ...fresh.saved, phase: 'recovered' });
      await release(current.lock, fresh.owner);
      return { state: 'released', status: 'recovered', kind: claim.owner.kind, runId: fresh.owner.runId };
    });
  }
  return { open, status, recover };
}
