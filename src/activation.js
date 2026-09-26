// Read-only proposal for persistent selection. No apply operation is exposed.
// Inspect routing configuration and path metadata; never read native credentials
// or database contents, traverse histories, or invoke desktop lifecycle actions.
import { lstat, realpath, readlink, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { userInfo } from 'node:os';
import { join, dirname, basename, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { selectionPlan, currentDesktop } from './desktop-selection.js';
import { createDesktopRuntime } from './desktop-runtime.js';
import { redactValue } from './redact.js';

const absolute = path => typeof path === 'string' && path.startsWith('/') && resolve(path) === path
  && !/[\x00-\x1f\x7f]/.test(path);
const within = (root, path) => path === root || (!relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !relative(root, path).startsWith('/'));
const overlaps = (a, b) => within(a, b) || within(b, a);
const safePath = path => absolute(path) && redactValue(path) === path;
const maxConfig = 1024 * 1024, maxEntries = 512;

async function pathMetadata(path) {
  if (!safePath(path)) throw new Error('Activation paths must be canonical absolute paths without credential-like values');
  try {
    const s = await lstat(path);
    const result = { path, kind: s.isSymbolicLink() ? 'symlink' : s.isDirectory() ? 'directory' : 'other',
      uid: s.uid, mode: (s.mode & 0o777).toString(8), identity: { device: s.dev, inode: s.ino } };
    if (s.isSymbolicLink()) result.target = redactValue(await readlink(path));
    return result;
  } catch (error) { if (error.code === 'ENOENT') return { path, kind: 'absent' }; throw error; }
}

async function routingConfiguration(home) {
  const path = join(home, 'config.toml');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || s.size > maxConfig || s.uid !== process.getuid())
      return { path, status: 'unavailable', reason: 'Configuration is not an owned bounded regular file' };
    const bytes = Buffer.alloc(maxConfig + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > maxConfig) return { path, status: 'unavailable', reason: 'Configuration exceeds inspection limit' };
    const config = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)));
    const backend = config.cli_auth_credentials_store;
    const credentialStore = backend === undefined ? 'native-default-unresolved'
      : ['file', 'keyring', 'auto', 'ephemeral'].includes(backend) ? backend : 'unsupported';
    const sqliteHome = config.sqlite_home === undefined ? null : safePath(config.sqlite_home) ? config.sqlite_home : 'unsupported-or-redacted';
    return { path, status: 'inspected', credentialStore, sqliteHome,
      scope: 'Two routing fields only; other configuration values are omitted' };
  } catch (error) {
    return { path, status: error.code === 'ENOENT' ? 'absent' : 'unavailable',
      reason: error.code === 'ENOENT' ? 'Native defaults are unresolved' : 'Unable to inspect routing configuration safely' };
  } finally { await handle?.close(); }
}

async function immediateLinks(home) {
  // Only the immediate children of the chosen Codex home. Do not descend into
  // credentials, session directories, plugins, databases, or linked resources.
  const entries = await readdir(home, { withFileTypes: true });
  if (entries.length > maxEntries) return { status: 'incomplete', links: [], reason: 'Home entry limit exceeded' };
  const links = [];
  for (const entry of entries) if (entry.isSymbolicLink()) {
    const path = join(home, entry.name), target = await readlink(path);
    links.push({ path: redactValue(path), target: redactValue(target),
      external: !within(home, resolve(home, target)), inspected: 'link text only; target not followed' });
  }
  return { status: 'inspected', links: links.sort((a, b) => a.path.localeCompare(b.path)), depth: 1 };
}

/** Proposed original-directory preservation paths are siblings, keeping each
 * eventual rename on its source filesystem. Nothing here creates those paths. */
export async function activationPlan(store, name, { runtime = createDesktopRuntime(),
  defaultUserHome = userInfo().homedir, desktopData, platform = process.platform } = {}) {
  if (!safePath(defaultUserHome) || await realpath(defaultUserHome) !== defaultUserHome) throw new Error('Default user home must be a canonical directory');
  if (!(await lstat(defaultUserHome)).isDirectory()) throw new Error('Default user home must be a directory');
  const selected = await selectionPlan(store, name, { runtime });
  if (!safePath(store.directory) || await realpath(store.directory) !== store.directory)
    throw new Error('Xenoflux metadata must use a canonical directory');
  const defaultData = desktopData ?? join(defaultUserHome, 'Library', 'Application Support', 'Codex');
  if (!safePath(defaultData)) throw new Error('Desktop data must be a canonical absolute path');
  const current = await currentDesktop(store, { defaultUserHome });
  const blockers = [];
  if (platform !== 'darwin') blockers.push({ code: 'UNSUPPORTED_PLATFORM', detail: 'This desktop proposal targets the macOS desktop app.' });
  const definitions = [
    { component: 'codex-home', alias: join(defaultUserHome, '.codex'), target: selected.home },
    { component: 'desktop-data', alias: defaultData, target: selected.desktopData },
  ].map(item => ({ ...item, originalPath: join(dirname(item.alias), `${basename(item.alias)}.xenoflux-original`) }));
  const boundaries = definitions.flatMap(item => [item.alias, item.originalPath]);
  const overlappingComponents = definitions.filter(item => definitions.some(other => other !== item
    && [item.alias, item.originalPath].some(path => [other.alias, other.originalPath].some(otherPath => overlaps(path, otherPath)))));
  if (overlappingComponents.length) blockers.push({ code: 'OVERLAPPING_ALIASES',
    detail: 'Codex home, desktop-data aliases and both original-preservation paths must be independent directories.' });
  const changes = [];
  for (const item of definitions) {
    const { originalPath } = item;
    const [source, preserved, destination] = await Promise.all([pathMetadata(item.alias), pathMetadata(originalPath), pathMetadata(item.target)]);
    const conflicts = [];
    if (overlappingComponents.includes(item)) conflicts.push('Alias or original-preservation path overlaps another component');
    try { if (await realpath(dirname(item.alias)) !== dirname(item.alias)) conflicts.push('Alias parent contains a symbolic link'); }
    catch { conflicts.push('Alias parent is unavailable'); }
    if (source.kind === 'symlink') conflicts.push('Existing alias is unmanaged; preserve it until ownership is established');
    if (source.kind === 'other') conflicts.push('Alias path is not a directory');
    if (source.uid !== undefined && source.uid !== process.getuid()) conflicts.push('Alias path is owned by another user');
    if (source.mode && (parseInt(source.mode, 8) & 0o022)) conflicts.push('Alias path is writable by another user');
    if (preserved.kind !== 'absent') conflicts.push('Original-preservation path already exists; it must not be overwritten');
    if (!['directory', 'absent'].includes(destination.kind) || (destination.kind === 'absent' && item.component === 'codex-home')) conflicts.push('Selected destination is unavailable');
    if (boundaries.some(boundary => overlaps(boundary, item.target)))
      conflicts.push('Selected destination overlaps an alias or original-preservation path');
    if ([item.alias, originalPath, item.target].some(path => overlaps(path, store.directory)))
      conflicts.push('Xenoflux metadata must be independent of aliases, preserved originals and selected destinations');
    const steps = [];
    if (!conflicts.length) {
      if (destination.kind === 'absent') steps.push({ action: 'create-private-directory', path: item.target });
      if (source.kind === 'directory') steps.push({ action: 'preserve-original-by-rename', from: item.alias, to: originalPath });
      steps.push({ action: 'install-directory-symlink', path: item.alias, target: item.target,
        method: 'Stage a sibling link, validate expected old state, then rename it into place.' });
    }
    const rollback = conflicts.length ? [] : source.kind === 'directory'
      ? [{ action: 'remove-only-matching-managed-alias', path: item.alias, expectedTarget: item.target },
        { action: 'restore-preserved-directory', from: originalPath, to: item.alias, requireDestinationAbsent: true }]
      : source.kind === 'absent' ? [{ action: 'remove-only-matching-managed-alias', path: item.alias, expectedTarget: item.target }] : [];
    changes.push({ ...item, source, destination, originalPath, preserved, conflicts, proposedSteps: steps, rollback });
    if (conflicts.length) blockers.push({ code: 'PATH_CONFLICT', component: item.component, detail: conflicts.join('; ') });
  }
  const originalHome = changes[0];
  const routing = originalHome.source.kind === 'directory' ? await routingConfiguration(originalHome.alias)
    : { status: 'not-inspected', reason: 'The original home is absent or not an ordinary directory' };
  const links = originalHome.source.kind === 'directory' ? await immediateLinks(originalHome.alias)
    : { status: 'not-inspected', links: [] };
  if (routing.status !== 'inspected') blockers.push({ code: 'ORIGINAL_ROUTING_UNRESOLVED', detail: 'Resolve original credential and SQLite routing before proposing live relocation.' });
  if (routing.status === 'inspected' && !['file', 'native-default-unresolved'].includes(routing.credentialStore)) blockers.push({ code: 'ORIGINAL_CREDENTIAL_ROUTE_UNVERIFIED',
    detail: 'The original home does not use a supported file credential-store configuration.' });
  if (routing.sqliteHome !== null && routing.sqliteHome !== undefined)
    blockers.push({ code: 'EXPLICIT_SQLITE_ROUTE', detail: 'The original configuration has an explicit SQLite route that must be reconciled with relocation.' });
  if (links.status !== 'inspected' || links.links.length) blockers.push({ code: 'LINKED_RESOURCES_REVIEW',
    detail: 'Immediate home links require ownership and relocation review; targets and nested resources were not inspected.' });
  if (current.status !== 'unmanaged' && current.status !== 'restored') blockers.push({ code: 'MANAGED_DESKTOP_RESERVATION',
    detail: 'A prior desktop selection still has a recorded reservation; reconcile it through the controller before live activation.' });
  const result = { schemaVersion: 1, kind: 'desktop-activation-preview', status: blockers.length ? 'blocked-preview' : 'ready-preview',
    selectedProfile: { id: selected.profileId, name: selected.name, home: selected.home, desktopData: selected.desktopData },
    app: selected.app, desktopDataPathBasis: desktopData ? 'caller-selected; normal launch routing unverified'
      : 'Expected production bootstrap default: macOS appData/Codex; normal launch routing unverified',
    currentDesktop: current, changes, originalRouting: routing, immediateHomeLinks: links,
    launchDifferences: { profileUserHome: selected.env.HOME, defaultUserHome,
      testedTemporaryDirectory: selected.env.TMPDIR, normalTemporaryDirectory: 'OS supplied; not controlled by the two aliases' },
    journalPath: join(store.directory, 'activation', 'session.json'), blockers,
    rollbackConditions: ['Stop and verify relevant writers first.', 'Compare actual aliases, preserved directory identities and the journal.',
      'Never delete or overwrite an unexpected path; keep selected profile data and credentials in place.'],
    liveHomeChanged: false,
    credentialFilesRead: false, databaseContentsRead: false, lifecycleActionsPerformed: false,
  };
  return { ...result, planId: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
