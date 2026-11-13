import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadHomeBinding } from './homes.js';
import { PROFILE_CLIENTS } from './profiles.js';
import { PROFILE_CLIENT_NAMES } from './managed-native-profile.js';
import { discoverCodexExecutable } from './launcher.js';
import { claudeEnvironment, discoverClaudeExecutable } from './claude-profile.js';
import { assertCopilotEnvironment, inspectCopilotExecutable, resolveCopilotExecutable } from './copilot-profile.js';
import { DEFAULT_APP_PATHS, inspectDesktopApp } from './desktop-runtime.js';
import { STOCK_DESKTOP_APPS } from './stock-desktop-apps.js';

const STOCK = { codex: '.codex', 'claude-code': '.claude', copilot: '.copilot' };
const CODEX_LAYOUT = ['codex-home', 'workspace', 'user-home', 'tmp'];
const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unavailable = reason => ({ kind: 'unavailable', label: 'Could not confirm', reason });

async function directory(path, privateOnly = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(path) !== path)
    throw new Error('Folder is not a canonical directory. Symbolic links are not followed.');
  if (privateOnly && ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())))
    throw new Error('Managed folder ownership or permissions need attention.');
  return path;
}
async function folder(path, privateOnly = false) {
  try { await directory(path, privateOnly); return { kind: 'found', label: 'Folder found', reason: 'Folder presence does not check sign-in, compatibility or copy eligibility.' }; }
  catch (error) { return { kind: error.code === 'ENOENT' ? 'not-found' : 'unavailable',
    label: error.code === 'ENOENT' ? 'Folder not found' : 'Could not inspect folder', reason: error.code === 'ENOENT' ? 'Not found at the checked location.' : error.message }; }
}

/** Bounded metadata observations only. Operational planners retain admission. */
export async function discoverProfiles({ store, profilesBase, defaultUserHome, terminalEnvironment,
  stockApps, inspectDesktop = inspectDesktopApp, desktopLocations = DEFAULT_APP_PATHS,
  stockLocations = stockApps.locations ?? Object.values(STOCK_DESKTOP_APPS).map(app => app.path) }) {
  const scope = ['Selected terminal PATH (absolute entries only)',
    `Codex Desktop: ${desktopLocations.join(' and ')}`,
    `Stock apps: ${stockLocations.join(' and ')}`,
    ...PROFILE_CLIENTS.map(client => join(defaultUserHome, STOCK[client])),
    store.file, `${profilesBase} (immediate children only)`];
  const limits = [];
  const selectedPath = terminalEnvironment.PATH ?? '';
  const pathLimited = selectedPath.length > 32768 || selectedPath.split(':').length > 200;
  if (pathLimited) limits.push('CLI inspection skipped because selected PATH exceeds 200 entries or 32 KiB.');
  const resolvers = {
    codex: () => discoverCodexExecutable(terminalEnvironment),
    'claude-code': () => discoverClaudeExecutable({ ...claudeEnvironment(terminalEnvironment,
      { userHome: defaultUserHome, rootMode: 'implicit' }), PATH: selectedPath }),
    copilot: async () => inspectCopilotExecutable(await resolveCopilotExecutable(terminalEnvironment)),
  };
  const registry = await store.inspect();
  limits.push(...registry.limits);
  const attention = [];
  const seen = new Set();
  const clients = await Promise.all(PROFILE_CLIENTS.map(async client => {
    let cli;
    try {
      if (pathLimited) throw new Error('Selected PATH exceeds the discovery inspection limit.');
      const binary = await resolvers[client]();
      cli = { kind: 'found', label: 'Found on selected PATH', location: binary.executable, version: null,
        identity: identity([binary.executable, binary.executableIdentity]) };
    } catch (error) { cli = unavailable(error.message); }
    const location = join(defaultUserHome, STOCK[client]);
    const observation = await folder(location);
    if (observation.kind === 'found') seen.add(location);
    return { client, name: client === 'copilot' ? 'GitHub Copilot' : PROFILE_CLIENT_NAMES[client], cli, desktop: unavailable('Desktop inspection has not completed.'),
      desktopNote: client === 'codex' ? 'Managed desktop profiles are supported separately in Profiles.'
        : 'Open a managed profile from Profiles. Desktop startup and profile storage are supported; sign-in and task execution remain unverified.',
      setups: [{ key: `standard-${client}`, name: 'Default', origin: 'Standard client folder', location, ...observation,
        ...(observation.kind === 'found' ? { inspectHref: `/profiles/Default/setup?client=${encodeURIComponent(client)}` } : {}) }] };
  }));
  await Promise.all([
    (async () => {
      try {
        const app = await inspectDesktop();
        clients[0].desktop = { kind: 'found', label: 'Found', location: app.appPath, version: app.version ?? null, identity: identity(app) };
      } catch (error) { clients[0].desktop = unavailable(`Codex Desktop inspection could not confirm an app (${error.code ?? 'inspection failed'}).`); }
    })(),
    (async () => {
      try {
        const result = await stockApps.list();
        const apps = Array.isArray(result) ? result : result.apps;
        for (const row of clients.slice(1)) {
          const app = apps?.find(app => app.client === (row.client === 'claude-code' ? 'claude' : row.client));
          row.desktop = app?.status === 'available'
            ? { kind: 'found', label: 'Found', location: app.path, version: app.version ?? null, identity: app.appKey ?? identity(app) }
            : unavailable('Not available in checked app locations, or app identity could not be verified.');
        }
      } catch { for (const row of clients.slice(1)) row.desktop = unavailable('Stock desktop app inspection failed.'); }
    })(),
  ]);
  for (const record of registry.rows) {
    if (record.kind === 'unsupported') {
      attention.push({ key: record.key, name: record.name, kind: 'unsupported', label: 'Unsupported record',
        origin: 'Registry inspection only', location: null, reason: `${record.reason} Automatic migration is not available.` });
      continue;
    }
    const row = clients.find(row => row.client === record.client);
    if (!record.native) {
      row.setups.push({ key: record.key, name: record.name, kind: 'unbound', label: 'Needs setup · no folder bound',
        origin: 'Registered profile', location: null, reason: `Review the existing binding and setup guidance in Profiles.${record.olderEncoding ? ' Older Codex attribution is supported without migration.' : ''}` });
      continue;
    }
    const location = record.native.root;
    seen.add(location);
    let observation = await folder(location, true);
    if (observation.kind === 'found') {
      const paths = record.client === 'codex' ? CODEX_LAYOUT.map(name => join(location, name))
        : [record.native.configRoot, join(location, 'workspace')];
      for (const path of paths) {
        const child = await folder(path, true);
        if (child.kind !== 'found') { observation = { ...child, label: 'Binding needs attention' }; break; }
      }
    }
    if (observation.kind === 'found' && record.client === 'codex') {
      try { await loadHomeBinding(record.native); }
      catch (error) { observation = { kind: 'unavailable', label: 'Binding needs attention', reason: error.message }; }
    }
    row.setups.push({ key: record.key, name: record.name, origin: 'Registered profile', location,
      inspectHref: `/profiles/${encodeURIComponent(record.name)}/setup?client=${encodeURIComponent(record.client)}`,
      ...observation, reason: `${observation.reason}${record.olderEncoding ? ' Older Codex attribution is supported without migration.' : ''}` });
  }
  try {
    await directory(profilesBase);
    const entries = await opendir(profilesBase);
    let count = 0;
    for await (const entry of entries) {
      if (++count > 200) { limits.push('Only the first 200 managed-folder entries were inspected.'); break; }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const location = join(profilesBase, entry.name);
      if (seen.has(location)) continue;
      const observation = await folder(location, true);
      let codex = observation.kind === 'found';
      if (codex) for (const name of CODEX_LAYOUT) {
        if ((await folder(join(location, name), true)).kind !== 'found') { codex = false; break; }
      }
      const item = { key: `folder-${identity(['managed-folder', location])}`, name: entry.name, origin: 'Folder outside the registry', location,
        ...observation, reason: codex ? 'Codex folder layout found. Review registration in Profiles. Eligibility has not been checked.'
          : observation.kind === 'found' ? 'Client could not be determined from the folder layout. Automatic migration is not available.' : observation.reason };
      if (codex) clients[0].setups.push(item); else attention.push(item);
      seen.add(location);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') limits.push(`Could not inspect the managed-profile folder: ${error.message}`);
  }
  return { checkedAt: new Date().toISOString(), scope, registry: { kind: registry.kind, reason: registry.reason },
    clients, attention, limits, simulated: false };
}


async function metadata(path, followTarget = false) {
  try {
    const info = await lstat(path);
    const fields = value => [value.dev, value.ino, value.mode, value.uid, value.nlink, value.size, value.mtimeMs, value.ctimeMs];
    if (!followTarget) return [path, fields(info)];
    try {
      const target = await realpath(path);
      return [path, fields(info), target, target === path ? null : fields(await lstat(target))];
    } catch (error) { return [path, fields(info), error.code ?? 'unavailable']; }
  } catch (error) { return [path, error.code ?? 'unavailable']; }
}

async function boundedChildren(path, limit) {
  const children = [];
  try {
    await directory(path);
    const entries = await opendir(path);
    for await (const entry of entries) {
      if (children.length === limit) return { children, limited: true };
      children.push(join(path, entry.name));
    }
  } catch { /* The directory metadata records missing or unavailable locations. */ }
  return { children, limited: false };
}

async function discoveryFingerprint(options) {
  const { store, profilesBase, defaultUserHome, terminalEnvironment, stockApps,
    desktopLocations = DEFAULT_APP_PATHS,
    stockLocations = stockApps.locations ?? Object.values(STOCK_DESKTOP_APPS).map(app => app.path) } = options;
  const paths = new Map([[store.file, false], [profilesBase, false]]);
  const canonical = [];
  const limits = [];
  const selectedPath = terminalEnvironment.PATH ?? '';
  if (selectedPath.length <= 32768 && selectedPath.split(':').length <= 200)
    for (const path of selectedPath.split(':').filter(path => path.startsWith('/')))
      for (const command of ['codex', 'claude', 'copilot']) paths.set(join(path, command), true);
  const registry = await store.inspect();
  const managed = await boundedChildren(profilesBase, 200);
  const roots = new Set([...PROFILE_CLIENTS.map(client => join(defaultUserHome, STOCK[client])), ...managed.children]);
  const configRoots = new Map();
  for (const record of registry.rows) if (record.kind === 'supported' && record.native) {
    roots.add(record.native.root);
    if (record.native.configRoot) configRoots.set(record.native.root, record.native.configRoot);
  }
  for (const root of roots) {
    paths.set(root, false);
    try { await directory(root); canonical.push([root, true]); }
    catch { canonical.push([root, false]); continue; }
    for (const child of [...CODEX_LAYOUT, 'desktop-data']) paths.set(join(root, child), false);
    for (const config of [root, join(root, 'codex-home'), configRoots.get(root)].filter(Boolean)) {
      paths.set(config, false);
      try { await directory(config); canonical.push([config, true]); }
      catch { canonical.push([config, false]); continue; }
      for (const name of ['config.toml', 'auth.json', 'settings.json', '.credentials.json', 'config.json']) paths.set(join(config, name), false);
    }
  }
  for (const app of [...desktopLocations, ...stockLocations]) {
    paths.set(app, false);
    try { await directory(app); canonical.push([app, true]); }
    catch { canonical.push([app, false]); continue; }
    const contents = join(app, 'Contents');
    paths.set(contents, false);
    try { await directory(contents); canonical.push([contents, true]); }
    catch { canonical.push([contents, false]); continue; }
    paths.set(join(contents, 'Info.plist'), false);
    for (const [name, files] of [['MacOS', []], ['Resources', ['app.asar']], ['_CodeSignature', ['CodeResources']]]) {
      const location = join(contents, name);
      paths.set(location, false);
      try { await directory(location); canonical.push([location, true]); }
      catch { canonical.push([location, false]); continue; }
      for (const file of files) paths.set(join(location, file), false);
    }
    const executables = await boundedChildren(join(contents, 'MacOS'), 50);
    for (const executable of executables.children) paths.set(executable, false);
    if (executables.limited) limits.push(`Only the first 50 executable-folder entries were inspected in ${app}.`);
  }
  const allowed = check => { try { check(); return null; } catch (error) { return error.message; } };
  const environment = [selectedPath,
    allowed(() => claudeEnvironment(terminalEnvironment, { userHome: defaultUserHome, rootMode: 'implicit' })),
    allowed(() => assertCopilotEnvironment(terminalEnvironment))];
  return { key: identity([environment, canonical.sort(([left], [right]) => left.localeCompare(right)), await Promise.all([...paths].sort(([left], [right]) => left.localeCompare(right))
    .map(([path, followTarget]) => metadata(path, followTarget)))]), limits };
}

/** One demand-driven scan and one coalesced trailing explicit refresh per provider. */
export function createProfileDiscovery({ now = Date.now, maxAgeMs = 30000, ...options }) {
  let cached = null, inFlight = null, trailingFresh = null;
  async function check(fresh) {
    const fingerprint = await discoveryFingerprint(options);
    if (!fresh && cached && cached.key === fingerprint.key && now() - cached.at < Math.min(maxAgeMs, 30000))
      return { ...cached.value, discovery: { ...cached.value.discovery, checkedAt: new Date(now()).toISOString() } };
    let rawApps, appsError;
    const stockApps = { list: async () => {
      try { rawApps = await options.stockApps.list(); }
      catch (error) { appsError = error; throw error; }
      return rawApps;
    } };
    const discovery = await discoverProfiles({ ...options, stockApps,
      stockLocations: options.stockLocations ?? options.stockApps.locations ?? Object.values(STOCK_DESKTOP_APPS).map(app => app.path) });
    discovery.checkedAt = new Date(now()).toISOString();
    discovery.limits.push(...fingerprint.limits);
    const value = { discovery, apps: Array.isArray(rawApps) ? { apps: rawApps } : rawApps, appsError };
    cached = appsError ? null : { key: fingerprint.key, at: now(), value };
    return value;
  }
  function read({ fresh = false } = {}) {
    if (inFlight) {
      if (!fresh) return inFlight;
      if (!trailingFresh) {
        const next = () => { trailingFresh = null; return read({ fresh: true }); };
        trailingFresh = inFlight.then(next, next);
      }
      return trailingFresh;
    }
    inFlight = check(fresh).finally(() => { inFlight = null; });
    return inFlight;
  }
  return {
    discovery: async input => (await read(input)).discovery,
    apps: async input => {
      const result = await read(input);
      if (result.appsError) throw result.appsError;
      return result.apps;
    },
  };
}
