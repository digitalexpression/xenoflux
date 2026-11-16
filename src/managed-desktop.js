// LaunchServices owns the app lifetime; this durable reservation never follows the UI PID.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { exists, privateDirectory, readJSON, record } from './metadata.js';
import { find, strictDescendant, validateProfile } from './profiles.js';
import { withProfileOperation } from './desktop-instances.js';
import { createDesktopInstanceRuntime, matchesProcessIdentity, processIdentity, targetStartSeconds } from './desktop-instance-runtime.js';
import { installedProcessHelper } from './profile-launcher.js';
import { createStockDesktopApps, STOCK_DESKTOP_APPS } from './stock-desktop-apps.js';
import { claudeEnvironment } from './claude-profile.js';
import { assertCopilotEnvironment, assertManagedCopilotCredentials, managedCopilotEnvironment } from './copilot-profile.js';
import { acquireNativeParticipant, assertNoLegacyAuditLease, isNativeCliParticipant, readProfileOwners, releaseProfileParticipant } from './profile-reservations.js';
import { observeManagedCli } from './native-participants.js';
import { readClaudeDesktopSessionRecords } from './claude-handoff.js';

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
  processHelper = installedProcessHelper, handoffTimeoutMs = 7000,
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
  async function databaseOwner(value, main, processes, cli) {
    const path = value.desktopData ? join(value.desktopData, 'Cookies') : join(value.configRoot, 'data.db');
    const info = await exists(path);
    if (!info) return false;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid())
      throw new Error('Selected Desktop storage path is unsafe');
    const owners = value.desktopData ? processes : [main];
    const observed = await runtime.assertResourcesIdle([path], { allowedProcesses: value.desktopData ? owners : [...owners, ...cli] });
    const checked = await lstat(path);
    if (checked.dev !== info.dev || checked.ino !== info.ino || checked.nlink !== 1 || checked.isSymbolicLink()) throw new Error('Selected Desktop storage changed');
    return observed.processes.some(row => owners.some(owned => matchesProcessIdentity(row, owned)));
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
  async function reservations(current) {
    const owners = await exists(current.lock) ? await readProfileOwners(current.value.root) : [];
    const isCli = owner => isNativeCliParticipant(owner, current.profile.client);
    return { owner: owners.find(owner => owner?.kind === current.kind),
      cli: owners.find(isCli),
      blocked: owners.some(owner => owner?.kind !== current.kind && !isCli(owner)) };
  }
  async function assertOwner(current, owner) {
    const held = await reservations(current);
    if (held.blocked || !equal(held.owner, owner)) throw new Error('Desktop ownership changed');
    return held;
  }
  function cliProcesses(current, cli, joining = false) {
    if (!cli) return Promise.resolve([]);
    const { configRoot: home, environmentId, profileId, root: nativeRoot } = current.value;
    return observeManagedCli(store, { client: current.profile.client, home, environmentId, profileId, nativeRoot }, cli, runtime, { joining })
      .then(observed => observed.processes);
  }
  async function assertIdle(current, desktopProcesses, cli = []) {
    // The CLI may hold the shared config and workspace, never Desktop's own storage.
    if (current.value.desktopData && cli.length) await runtime.assertResourcesIdle([current.value.desktopData], { allowedProcesses: desktopProcesses });
    await runtime.assertResourcesIdle(resources(current.value), { allowedProcesses: [...desktopProcesses, ...cli] });
  }
  async function readClaim(current) {
    const { owner, blocked } = await reservations(current);
    if (blocked || owner?.kind !== current.kind || owner.schemaVersion !== 1 || owner.host !== hostname()
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
    const { cli } = await assertOwner(current, claim.owner);
    const cliAllowed = await cliProcesses(current, cli);
    const cliState = cli ? { cliReserved: true, cliRunning: cliAllowed.length > 0 } : {};
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
    await assertIdle(current, allowed, cliAllowed);
    await assertBinding(current);
    if (!equal(await readJSON(claim.path), saved) || !equal((await assertOwner(current, claim.owner)).cli, cli))
      throw new Error('Desktop ownership changed');
    if (main) {
      if (!await databaseOwner(current.value, main, allowed.filter(row => !row.executable.endsWith('/chrome_crashpad_handler')), cliAllowed)) return uncertain('Selected profile database ownership is unconfirmed');
      return { state: 'running', runId: claim.owner.runId, processes: allowed, ...cliState };
    }
    if (saved.processes.some(previous => rows.some(row => matchesProcessIdentity(row, previous))))
      return uncertain('A Desktop descendant is still running; preserve its reservation');
    if (current.vendor === 'copilot' && appProcesses(rows, saved.app.path).length) return uncertain('A Copilot app process is still running; preserve its reservation');
    await assertIdle(current, [], cliAllowed);
    const stopped = await runtime.snapshot();
    if (saved.processes.some(previous => stopped.some(row => row.pid === previous.pid))
      || current.vendor === 'copilot' && appProcesses(stopped, saved.app.path).length
      || (await scopedCrashpads(current, saved.app, stopped)).length) return uncertain('Desktop processes changed during the stopped check; preserve its reservation');
    return { state: 'recoverable-stopped', runId: claim.owner.runId, ...cliState };
  }
  async function status(name, { installation } = {}) {
    try {
      const current = await binding(name);
      const { owner, cli, blocked } = await reservations(current);
      if (blocked) throw new Error('Profile has a foreign or unresolved reservation');
      if (owner) {
        const { processes, ...state } = await observe(current, await readClaim(current));
        return cli ? { cliReserved: true, ...state } : state;
      }
      await cliProcesses(current, cli, true);
      return installation?.status === 'available' && /^[a-f0-9]{64}$/.test(installation.appKey ?? '')
        ? { state: 'available', appKey: installation.appKey, ...(cli ? { cliReserved: true, cliRunning: true } : {}) }
        : { state: 'unavailable', reason: `${current.vendor === 'claude' ? 'Claude' : 'GitHub Copilot'} Desktop is unavailable in the selected installation`, ...(cli ? { cliReserved: true, cliRunning: true } : {}) };
    } catch (error) { return { state: 'blocked', reason: error.message }; }
  }
  async function open(name, { appKey } = {}) {
    const initial = await binding(name);
    return withProfileOperation(store, initial.profile.id, lockOptions, () => openGuarded(initial, { appKey }));
  }
  async function openGuarded(initial, { appKey, isRequested = () => true }) {
    let current = await assertBinding(initial);
    const { owner: existing, cli, blocked } = await reservations(current);
    if (blocked) throw new Error('Profile has a foreign or unresolved reservation');
    if (existing) {
      const claim = await readClaim(current);
      const { processes, ...state } = await observe(current, claim);
      if (state.state !== 'recoverable-stopped') return state;
      await stockApps.binding({ client: current.vendor, appKey });
      const fresh = await readClaim(current);
      if (!equal(fresh, claim)) throw new Error('Desktop reservation changed before reopening this profile');
      const { processes: _again, ...rechecked } = await observe(current, fresh);
      if (rechecked.state !== 'recoverable-stopped') return rechecked;
      await releaseStoppedDesktop(current, claim);
      return openGuarded(await assertBinding(current), { appKey, isRequested });
    }
    const cliAllowed = await cliProcesses(current, cli, true);
    const app = await stockApps.binding({ client: current.vendor, appKey });
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
    } else {
      assertCopilotEnvironment(environment, nativeUser);
      await assertManagedCopilotCredentials(current.value.configRoot);
    }
    await assertNoLegacyAuditLease(store.directory, current.value.configRoot);
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
    await assertIdle(current, [], cliAllowed);
    await assertBinding(current);
    if (!isRequested()) throw new Error('Desktop launch request ended');
    const owner = { kind: current.kind, schemaVersion: 1, host: hostname(), runId: randomUUID(),
      profileId: current.profile.id, storePath: store.directory };
    const launches = join(current.value.root, 'launches'), directory = join(launches, owner.runId);
    await privateDirectory(launches, true); await privateDirectory(directory, true);
    const path = join(directory, 'report.json');
    let saved = { schemaVersion: 1, kind: owner.kind, owner, binding: current.value,
      app, phase: 'prepared', processes: [], spawnIntent: false, createdAt: new Date(now()).toISOString() };
    await acquireNativeParticipant(current.value.root, owner, cli);
    // Every failure after reservation, including uncertain publication, is retained for inspection.
    await record(path, saved);
    const freshApp = await stockApps.binding({ client: current.vendor, appKey });
    if (!equal(freshApp, app)) throw new Error('Desktop app changed before startup; preserving reservation');
    await assertBinding(current);
    const beforeDispatch = await runtime.snapshot();
    if (current.vendor === 'copilot' && appProcesses(beforeDispatch, app.path).length) throw new Error('Another Copilot app appeared; preserving reservation');
    if ((await scopedCrashpads(current, app, beforeDispatch)).length) throw new Error('A selected-root Claude crash reporter appeared; preserving reservation');
    await assertIdle(current, [], cliAllowed);
    if (!equal((await assertOwner(current, owner)).cli, cli) || !equal(await readJSON(path), saved))
      throw new Error('Desktop reservation changed before startup');
    if (current.vendor === 'copilot') await assertManagedCopilotCredentials(current.value.configRoot);
    if (!isRequested()) throw new Error('Desktop launch request ended');
    const intent = { ...saved, phase: 'starting', spawnIntent: true };
    // A published intent is the uncertainty boundary; prepared records prove no dispatch.
    await record(path, intent);
    saved = intent;
    await execFile('/usr/bin/open', current.vendor === 'claude' ? ['-n', '-a', app.path, '--env', `CLAUDE_CONFIG_DIR=${current.value.configRoot}`, '--args', `--user-data-dir=${current.value.desktopData}`] : ['-n', '-a', app.path, ...Object.entries(managedCopilotEnvironment({}, current.value.configRoot)).flatMap(([key, value]) => ['--env', `${key}=${value}`])], {
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
          const activeCli = await cliProcesses(current, cli);
          storageOwned = await databaseOwner(current.value, main, tree, activeCli);
          if (storageOwned) await assertIdle(current, processes, activeCli);
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
          if (!equal((await assertOwner(current, owner)).cli, cli) || !equal(await readJSON(path), saved))
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
  }
  async function recover(name, { apply = false, onlyIfStopped = false } = {}) {
    if (typeof apply !== 'boolean' || typeof onlyIfStopped !== 'boolean') throw new Error('Recovery options must be booleans');
    const initial = await binding(name), claim = await readClaim(initial);
    if (onlyIfStopped) {
      const { saved } = claim;
      if (!saved.main && saved.spawnIntent)
        return uncertain('Desktop startup has no confirmed main process; preserve its reservation');
      if (saved.main) {
        let rows;
        try { rows = await runtime.snapshot(); }
        catch { return uncertain('Desktop process observation is incomplete; preserve its reservation'); }
        const samePid = rows.find(row => row.pid === saved.main.pid);
        if (samePid) return matchesProcessIdentity(samePid, saved.main)
          ? { state: 'running', runId: claim.owner.runId }
          : uncertain('Desktop process identity changed; preserve its reservation');
      }
    }
    if (!apply || !onlyIfStopped) {
      const { processes: _processes, ...preview } = await observe(initial, claim);
      if (preview.state !== 'recoverable-stopped') return preview;
      if (!apply) return { ...preview, status: 'preview', kind: claim.owner.kind };
    }
    return withProfileOperation(store, initial.profile.id, { ...lockOptions, recovery: true }, async () => {
      const current = await assertBinding(initial), fresh = await readClaim(current);
      if (!equal(fresh.owner, claim.owner) || !equal(fresh.saved, claim.saved)) throw new Error('Desktop ownership changed; preserving reservation');
      const { processes: _processes, ...checked } = await observe(current, fresh);
      if (checked.state !== 'recoverable-stopped') return checked;
      await releaseStoppedDesktop(current, fresh);
      return { state: 'released', status: 'recovered', kind: claim.owner.kind, runId: fresh.owner.runId };
    });
  }
  async function releaseStoppedDesktop(current, claim) {
    await record(claim.path, { ...claim.saved, phase: 'recovered' });
    await releaseProfileParticipant(current.value.root, claim.owner);
  }
  async function controlBinding(name) {
    const current = await binding(name), claim = await readClaim(current);
    const installed = await stockApps.binding({ client: current.vendor, appKey: claim.saved.app.appKey });
    if (!equal(installed, claim.saved.app)) throw new Error('Desktop installation changed; preserving reservation');
    return { current, claim, installed };
  }
  async function focus(name) {
    const initial = await binding(name);
    return withProfileOperation(store, initial.profile.id, lockOptions, async () => {
      const { current, claim, installed } = await controlBinding(initial.profile.id);
      const before = await observe(current, claim);
      if (before.state !== 'running') {
        if (before.state === 'recoverable-stopped') return { state: 'closed', runId: claim.owner.runId };
        throw new Error('Desktop target is unverified; preserving reservation');
      }
      const helperExecutable = await processHelper();
      await runtime.focus(claim.saved.main, { helperExecutable });
      await assertBinding(current);
      if (!equal(await stockApps.binding({ client: current.vendor, appKey: installed.appKey }), installed)
        || !equal((await assertOwner(current, claim.owner)).owner, claim.owner)
        || !equal(await readJSON(claim.path), claim.saved)) throw new Error('Desktop ownership changed during focus');
      const after = await observe(current, claim);
      if (after.state === 'running') return { state: 'running', runId: claim.owner.runId };
      if (after.state === 'recoverable-stopped') return { state: 'closed', runId: claim.owner.runId };
      throw new Error('Desktop focus could not be confirmed; preserving reservation');
    });
  }
  async function close(name) {
    const initial = await binding(name);
    return withProfileOperation(store, initial.profile.id, lockOptions, async () => {
      const { current, claim, installed } = await controlBinding(initial.profile.id);
      const before = await observe(current, claim);
      if (before.state === 'recoverable-stopped') {
        const fresh = await readClaim(current);
        const checked = await observe(current, fresh);
        if (checked.state !== 'recoverable-stopped' || !equal(fresh.owner, claim.owner))
          throw new Error('Desktop stop could not be reconfirmed; preserving reservation');
        if (!equal(await stockApps.binding({ client: current.vendor, appKey: installed.appKey }), installed))
          throw new Error('Desktop installation changed; preserving reservation');
        await releaseStoppedDesktop(current, fresh);
        return { state: 'closed', runId: claim.owner.runId };
      }
      if (before.state !== 'running') throw new Error('Desktop target is unverified; preserving reservation');
      const helperExecutable = await processHelper();
      let latestSaved = claim.saved;
      const closed = await runtime.close(claim.saved.main, { helperExecutable, onTrackedProcesses: async processes => {
        const held = await assertOwner(current, claim.owner);
        if (!equal(held.owner, claim.owner) || !equal(await readJSON(claim.path), latestSaved))
          throw new Error('Desktop ownership changed during close; preserving reservation');
        const tracked = new Map([...before.processes, ...latestSaved.processes].map(row => [row.pid, row]));
        for (const row of processes) {
          const previous = tracked.get(row.pid);
          if (previous && !matchesProcessIdentity(previous, row))
            throw new Error('Desktop process identity changed during close; preserving reservation');
          tracked.set(row.pid, row);
        }
        latestSaved = { ...latestSaved, processes: [...tracked.values()] };
        await record(claim.path, latestSaved);
      } });
      if (closed.status !== 'stopped') throw new Error('Desktop shutdown is unverified; preserving reservation');
      await assertBinding(current);
      if (!equal(await stockApps.binding({ client: current.vendor, appKey: installed.appKey }), installed))
        throw new Error('Desktop installation changed; preserving reservation');
      const fresh = await readClaim(current);
      if (!equal(fresh.owner, claim.owner)) throw new Error('Desktop ownership changed during close');
      const after = await observe(current, fresh);
      if (after.state !== 'recoverable-stopped') throw new Error('Desktop resources are not confirmed closed; preserving reservation');
      await releaseStoppedDesktop(current, fresh);
      return { state: 'closed', runId: claim.owner.runId };
    });
  }
  async function observePeer(name, owner, { joining = false, allowStopped = false } = {}) {
    const current = await binding(name);
    const claim = await readClaim(current);
    if (!equal(claim.owner, owner))
      throw new Error('Desktop reservation changed');
    const observation = await observe(current, claim);
    if (observation.state === 'running') return observation.processes;
    if (observation.state === 'recoverable-stopped' && (!joining || allowStopped && current.vendor === 'claude')) return [];
    throw new Error('Desktop ownership could not be confirmed. Check the profile in Xenoflux before opening Terminal.');
  }
  async function handoffClaude(name, cli, sessionId, isRequested) {
    const initial = await binding(name);
    if (initial.vendor !== 'claude' || !uuid.test(sessionId)) throw new Error('Invalid Claude handoff');
    return withProfileOperation(store, initial.profile.id, { waitMs: 5000, ...lockOptions }, async () => {
      let current = await assertBinding(initial);
      const held = await reservations(current);
      if (held.blocked || !held.cli || !equal(held.cli, cli) || !isRequested()) throw new Error('Claude handoff request changed');
      await cliProcesses(current, cli, true);
      const helper = await processHelper();
      let claim = held.owner && await readClaim(current);
      if (claim) {
        const observation = await observe(current, claim);
        if (observation.state === 'recoverable-stopped' && isRequested()) {
          await releaseStoppedDesktop(current, claim);
          claim = undefined;
        } else if (observation.state !== 'running') {
          throw new Error('Claude Desktop handoff target is unverified');
        }
      }
      if (!claim) {
        const installation = (await stockApps.list()).find(app => app.client === 'claude' && app.status === 'available');
        if (!installation || !isRequested()) throw new Error('Claude Desktop is unavailable');
        const started = await openGuarded(current, { appKey: installation.appKey, isRequested });
        if (started.state !== 'running') throw new Error('Claude Desktop startup is unverified');
        current = await binding(initial.profile.id);
        claim = await readClaim(current);
        if (claim.owner.runId !== started.runId) throw new Error('Claude Desktop reservation changed');
      }
      const { app, main } = claim.saved;
      if (!equal(await stockApps.binding({ client: 'claude', appKey: app.appKey }), app))
        throw new Error('Claude Desktop app changed');
      const desktop = await observe(current, claim);
      const { cwd } = await readJSON(cli.reportPath);
      const records = () => readClaudeDesktopSessionRecords(current.value.desktopData, sessionId, cwd);
      const baseline = await records();
      if (desktop.state !== 'running' || !desktop.cliRunning || !isRequested())
        throw new Error('Claude Desktop handoff target is unverified');
      const requestedAt = now();
      await execFile(helper, ['--handoff-claude', String(main.pid), targetStartSeconds(main.startedAt), app.path, sessionId], {
        cwd: '/', timeout: 7500, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      });
      // The Apple Event reply confirms delivery. A fresh record confirms Desktop opened the session.
      const deadline = now() + handoffTimeoutMs;
      while (isRequested() && now() <= deadline) {
        const confirmed = (await records()).filter(({ path, createdAt, lastFocusedAt }) => {
          const previous = baseline.find(record => record.path === path);
          return previous ? lastFocusedAt >= requestedAt && lastFocusedAt > previous.lastFocusedAt : createdAt >= requestedAt;
        });
        if (confirmed.length > 1) break;
        if (confirmed.length === 1) {
          await assertBinding(current);
          if (!equal((await assertOwner(current, claim.owner)).cli, cli)
            || !equal(await readJSON(claim.path), claim.saved)
            || !(await runtime.snapshot()).some(row => matchesProcessIdentity(row, main)) || !isRequested()) break;
          return;
        }
        await sleep(pollIntervalMs);
      }
      throw new Error('Claude Desktop did not confirm the session handoff');
    });
  }
  return { open, status, recover, focus, close, observePeer, handoffClaude };
}
