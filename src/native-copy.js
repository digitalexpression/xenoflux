// Selective configuration copies. Credentials and native runtime data are never copied.
import { lstat, realpath, readdir, open, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { resolveHome } from './homes.js';
import { readPairedPlan, pairedStatus, pairedDirectoryFacts } from './desktop-paired.js';
import { acquire, release, globalLock, privateDirectory, readJSON, record, exists } from './metadata.js';
import { createDesktopRuntime } from './desktop-runtime.js';
import { redactText, redactValue } from './redact.js';
import { MAX_COPIED_NATIVE_CONFIG_BYTES, MAX_NATIVE_CONFIG_BYTES } from './native-config.js';
import { buildAdvancedCopy, selectAdvancedComponents, validateAdvancedSelection, persistAdvancedFiles, validateAdvancedFiles,
  writeAdvanced, matchesAdvanced, snapshotAdvanced, cleanupAdvancedDirectories, matchesAdvancedPackages,
  applyAdvancedPackageDirectories } from './advanced-copy.js';
export { validateAdvancedSelection };


export const COPY_COMPONENTS = Object.freeze(['config', 'instructions', 'agents']);
const CONFIG_KEYS = ['model', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'model_verbosity',
  'model_context_window', 'model_auto_compact_token_limit', 'personality', 'service_tier',
  'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'project_doc_max_bytes', 'project_doc_fallback_filenames'];
const AGENT_KEYS = ['max_threads', 'max_concurrent_threads_per_session', 'max_depth', 'job_max_runtime_seconds',
  'default_subagent_model', 'default_subagent_reasoning_effort'];
const ROLE_KEYS = ['name', 'description', 'model', 'model_reasoning_effort', 'sandbox_mode', 'nickname_candidates', 'developer_instructions'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_FILE = MAX_COPIED_NATIVE_CONFIG_BYTES, MAX_TOTAL = MAX_NATIVE_CONFIG_BYTES, MAX_FILES = 64;
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const rootPath = store => join(store.directory, 'native-copies');
const pendingPath = store => join(rootPath(store), 'pending.json');
const relativeFile = path => ['config.toml', 'AGENTS.md', 'AGENTS.override.md'].includes(path)
  || /^agents\/[a-zA-Z0-9_-]+\.toml$/.test(path);
const equal = (a, b) => isDeepStrictEqual(a, b);
const bytes = value => Buffer.byteLength(value ?? '');
function overlap(a, b) {
  const inside = (x, y) => { const r = relative(x, y); return !r || (!r.startsWith('../') && r !== '..' && !isAbsolute(r)); };
  return inside(a, b) || inside(b, a);
}
function selection(include) {
  const list = include === undefined ? [...COPY_COMPONENTS] : typeof include === 'string' ? include.split(',').map(s => s.trim()) : include;
  if (!Array.isArray(list) || list.some(x => !COPY_COMPONENTS.includes(x)) || new Set(list).size !== list.length)
    throw new Error('Choose --include config,instructions,agents (any subset, including empty). Other components are not supported.');
  return COPY_COMPONENTS.filter(x => list.includes(x));
}
// Shared by the read-only settings comparison.  Keeping component selection
// beside copy makes the supported comparison surface exactly the copy/undo
// surface rather than a claim about all effective Codex discovery.
export function selectNativeSettingsComponents(include) { return selection(include); }
async function directory(path, privateOnly = false) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(path) !== path || s.uid !== process.getuid()
    || (s.mode & (privateOnly ? 0o077 : 0o022))) throw new Error('Expected a canonical owned directory: ' + path);
  return { path, device: s.dev, inode: s.ino };
}
async function textFile(path, limit = MAX_FILE) {
  let handle;
  try { await directory(dirname(path)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error('Unsafe or unreadable settings file: ' + path); }
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || (s.mode & 0o022) || s.size > limit)
      throw new Error('Expected a bounded owned settings file: ' + path);
    const buffer = await handle.readFile();
    if (buffer.length > limit || buffer.includes(0)) throw new Error('Invalid settings text: ' + path);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new Error('Invalid UTF-8 settings file: ' + path); }
    return { content, mode: s.mode & 0o777 };
  } finally { await handle.close(); }
}
function toml(text, name) {
  try { return parse(text ?? ''); } catch { throw new Error('Invalid TOML in ' + name); }
}
function noSecrets(content, path) {
  if (content !== null && redactText(content, path) !== content)
    throw new Error('Credential-like content in selected settings; copy refused: ' + path);
}
async function endpoint(store, name, defaultUserHome, target = false) {
  if (typeof name !== 'string' || !name) throw new Error('Choose a source and destination');
  if (name.toLowerCase() === 'default') {
    if (target) throw new Error('Default is a source or restoration destination; copy into a named profile');
    const manifest = join(store.directory, 'activation', 'manifest.json');
    let home = join(defaultUserHome, '.codex');
    if (await exists(manifest)) {
      const plan = await readPairedPlan(manifest, store, { defaultUserHome });
      const state = await pairedStatus(store, { defaultUserHome });
      if (state.recoveryRequired) throw new Error('Resolve paired activation recovery before copying settings');
      const c = plan.components[0];
      home = state.selected === 'Default' ? c.alias : c.original;
      const expected = (await pairedDirectoryFacts(plan)).get(c.alias);
      const fact = await directory(home);
      if (fact.device !== expected.device || fact.inode !== expected.inode)
        throw new Error('Default directory identity changed');
    }
    return { name: 'Default', home, identity: await directory(home), root: null, binding: null };
  }
  const { profile, native, environment } = await resolveHome(store, name);
  return { name: profile.name, profileId: profile.id, home: environment.home, identity: await directory(environment.home, true),
    root: native.root, executable: native.executable, binding: profile.native };
}
/** Resolve a comparison endpoint without applying copy's destination limits. */
export async function resolveNativeSettingsHome(store, name, { defaultUserHome = homedir() } = {}) {
  return endpoint(store, name, defaultUserHome);
}
async function agentFiles(home) {
  const dir = join(home, 'agents');
  if (!await exists(dir)) return [];
  await directory(dir);
  const names = (await readdir(dir)).filter(n => n.endsWith('.toml')).sort();
  if (names.length > MAX_FILES || names.some(n => !relativeFile('agents/' + n))) throw new Error('Unsupported agent file name or count');
  return names.map(n => 'agents/' + n);
}
export async function nativeSettingsAgentFiles(home) { return agentFiles(home); }
export async function readNativeSettingsFile(home, path) { return textFile(join(home, path)); }
async function safeStore(store, create = false) {
  await directory(store.directory, true);
  const canonical = await realpath(store.directory);
  if (canonical.split('/').some(p => ['.codex', '.agents'].includes(p))) throw new Error('Copy backups must be outside native discovery paths');
  if (create) await privateDirectory(rootPath(store), true);
  else if (await exists(rootPath(store))) await privateDirectory(rootPath(store));
}
function scalar(value) {
  return ['string', 'number', 'boolean'].includes(typeof value)
    || (Array.isArray(value) && value.every(x => typeof x === 'string'));
}
function projected(value, keys, name) {
  const result = {};
  for (const k of keys) if (Object.hasOwn(value, k)) {
    if (!scalar(value[k])) throw new Error('Unsupported value for ' + name + '.' + k);
    result[k] = value[k];
  }
  if (!equal(redactValue(result), result)) throw new Error('Credential-like content in selected ' + name);
  return result;
}
/** Project the native configuration fields that copy/undo can represent. */
export function projectNativeSettingsConfig(content, components) {
  const config = toml(content, 'native configuration');
  if ((config.model_provider ?? 'openai') !== 'openai' || Object.hasOwn(config.model_providers ?? {}, 'openai'))
    throw new Error('Custom model providers are outside the supported settings comparison surface');
  const selected = Array.isArray(components) ? components : selection(components);
  const result = {};
  if (selected.includes('config')) Object.assign(result, projected(config, CONFIG_KEYS, 'config'));
  if (selected.includes('agents')) {
    const agents = projected(config.agents ?? {}, AGENT_KEYS, 'agents');
    if (Object.keys(config.agents ?? {}).some(k => !AGENT_KEYS.includes(k)))
      throw new Error('Unsupported agent settings are outside the supported settings comparison surface');
    if (Object.keys(agents).length) result.agents = agents;
    if (Object.hasOwn(config.features ?? {}, 'multi_agent')) {
      if (typeof config.features.multi_agent !== 'boolean') throw new Error('Invalid multi_agent setting');
      result.features = { multi_agent: config.features.multi_agent };
    }
  }
  return redactValue(result);
}
async function build(store, sourceName, targetName, { include, selection: selectedItems, defaultUserHome = homedir() } = {}) {
  if (selectedItems !== undefined) {
    if (include !== undefined) throw new Error('Choose either category --include or advanced item selection');
    await safeStore(store);
    const source = await endpoint(store, sourceName, defaultUserHome);
    const target = await endpoint(store, targetName, defaultUserHome, true);
    if (overlap(source.home, target.home) || overlap(store.directory, target.home) || overlap(store.directory, source.home))
      throw new Error('Source, destination and backup storage must be separate');
    const built = await buildAdvancedCopy(store, sourceName, targetName, selectedItems, { defaultUserHome });
    return { report: built.report, plan: { source, target, components: ['advanced'], selection: selectedItems,
      files: built.plan.files.filter(f => f.before === null || f.after === null || !f.before.equals(f.after) || f.beforeMode !== f.afterMode),
      packages:built.plan.packages??[], createdDirectories: built.plan.createdDirectories ?? [], defaultUserHome } };
  }
  const components = selection(include);
  await safeStore(store);
  const source = await endpoint(store, sourceName, defaultUserHome), target = await endpoint(store, targetName, defaultUserHome, true);
  if (overlap(source.home, target.home) || overlap(store.directory, target.home) || overlap(store.directory, source.home))
    throw new Error('Source, destination and backup storage must be separate');
  const selected=await selectAdvancedComponents(store,sourceName,components,{defaultUserHome});
  const built=await buildAdvancedCopy(store,sourceName,targetName,selected,{defaultUserHome});
  const configItems=built.report.items.filter(item=>item.path?.startsWith('config.toml')||item.changes?.some(change=>change.path.startsWith('config.toml:')));
  const copiedKeys=configItems.filter(item=>item.status!=='identical').map(item=>item.label);
  return {report:{...built.report,components,
    ...(components.includes('config')||components.includes('agents')?{config:{scope:'Selected supported source config values and agent settings; absent source values and all unselected destination values are preserved.',copiedKeys,enforcedKeys:built.report.notes.some(note=>note.includes('allow_symlinked_codex_home'))?['allow_symlinked_codex_home']:[]}}:{}),
    notes:[...built.report.notes,'Category selection uses the same item planner; source-absent destination items are preserved.']},
    plan:{...built.plan,source,target,components,selection:selected,
      files:built.plan.files.filter(f=>f.before===null||f.after===null||!f.before.equals(f.after)||f.beforeMode!==f.afterMode),
      defaultUserHome}};

}
export async function planCopy(store, source, target, options = {}) { return (await build(store, source, target, options)).report; }

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
async function locks(store, journal, preflight, action, { runtime = createDesktopRuntime(), lockPath = globalLock(), isAlive = alive, signal } = {}, recovering = false) {
  const owner = { kind: 'native-copy', host: hostname(), pid: process.pid, runId: journal.id, storePath: store.directory };
  const paths = [lockPath + '.selection', lockPath, ...new Set([journal.source.root, journal.target.root].filter(Boolean).map(p => join(p, '.run-lock')))];
  const acquired = [];
  try {
    for (const path of paths) {
      if (recovering && await exists(path)) {
        const old = await readJSON(join(path, 'owner.json'));
        if (old.kind !== 'native-copy' || old.host !== owner.host || old.runId !== journal.id
          || old.storePath !== store.directory || !Number.isSafeInteger(old.pid) || old.pid <= 0 || isAlive(old.pid))
          throw new Error('Another client or copy owns a required lock; preserve it');
        await release(path, old);
      }
      await acquire(path, owner);
      acquired.push(path);
    }
    const needsClients = await preflight();
    if (signal?.aborted) throw Object.assign(new Error('Settings copy cancelled'), { code: 'CANCELLED' });
    if (needsClients !== false) {
      const cliExecutables = [...new Set([journal.source.executable, journal.target.executable].filter(Boolean))];
      await runtime.prepareClients?.({ cliExecutables, includeDesktop: true });
      await runtime.assertIdle({ cliExecutables });
    }
    if (signal?.aborted) throw Object.assign(new Error('Settings copy cancelled'), { code: 'CANCELLED' });
    return await action(runtime);
  } finally {
    for (const path of acquired.reverse()) await release(path, owner);
  }
}
async function journalPath(store, id) {
  if (id === 'pending') {
    const pointer = await readJSON(pendingPath(store));
    id = pointer.id;
  }
  if (!uuid.test(id ?? '')) throw new Error('Invalid copy ID');
  return join(rootPath(store), id, 'journal.json');
}
async function validateTarget(store, j) {
  const target = await endpoint(store, j.target.profileId, j.defaultUserHome, true);
  const { name: currentName, ...currentIdentity } = target;
  const { name: savedName, ...savedIdentity } = j.target;
  if (!equal(currentIdentity, savedIdentity)) throw new Error('Copy destination binding or directory identity changed');
  return target;
}
function journalPayload(j) {
  const base = { source: j.source, target: j.target, components: j.components, files: j.files, defaultUserHome: j.defaultUserHome };
  return j.schemaVersion >= 2 ? { ...base, selection: j.selection, createdDirectories: j.createdDirectories,
    ...(j.schemaVersion>=3?{packages:j.packages}: {}) } : base;
}
async function readJournal(store, id) {
  await safeStore(store);
  const path = await journalPath(store, id);
  await privateDirectory(dirname(path));
  const j = await readJSON(path);
  if (![1, 2, 3].includes(j.schemaVersion) || j.kind !== 'native-settings-copy' || !uuid.test(j.id ?? '') || !path.endsWith('/' + j.id + '/journal.json')
    || j.storePath !== store.directory || !['prepared', 'applied', 'undone'].includes(j.phase)
    || !Array.isArray(j.files) || new Set(j.files.map(f => f.path)).size !== j.files.length
    || j.payloadHash !== digest(journalPayload(j))) throw new Error('Invalid settings-copy journal');
  if (j.schemaVersion >= 2) {
    if (!Array.isArray(j.selection) || (j.schemaVersion===2&&!j.selection.length) || j.selection.some(id => typeof id !== 'string')
      || !Array.isArray(j.createdDirectories) || j.createdDirectories.length > 3072
      || j.createdDirectories.some(dir => typeof dir !== 'string' || !/^(?:agents|rules|skills)(?:\/[A-Za-z0-9_.-]+)*$/.test(dir)
        || dir.split('/').some(part => part === '.' || part === '..')))
      throw new Error('Invalid advanced-copy journal');
    await validateAdvancedFiles(dirname(path), j.files);
    if(j.schemaVersion>=3) {
      if(!Array.isArray(j.packages)||j.packages.length>MAX_FILES) throw new Error('Invalid skill package journal');
      const packagePaths=new Set();
      for(const p of j.packages) {
        if(typeof p.path!=='string'||!/^skills\/[A-Za-z0-9_-]+$/.test(p.path)||packagePaths.has(p.path)) throw new Error('Invalid skill package journal path');
        packagePaths.add(p.path);
        for(const side of [p.before,p.after]) if(!side||!Array.isArray(side.files)||!Array.isArray(side.directories)
          ||side.files.length>256||side.directories.length>256
          ||new Set(side.files.map(f=>f.path)).size!==side.files.length||new Set(side.directories.map(d=>d.path)).size!==side.directories.length
          ||side.files.some(f=>typeof f.path!=='string'||!f.path.startsWith(p.path+'/')||f.path.split('/').some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9_.-]+$/.test(part))
            ||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isInteger(f.mode)||f.mode<0||f.mode>0o777||(f.mode&0o022)!==0)
          ||side.directories.some(d=>typeof d.path!=='string'||!(d.path===p.path||d.path.startsWith(p.path+'/'))
            ||d.path.split('/').some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9_.-]+$/.test(part))
            ||!Number.isInteger(d.mode)||d.mode<0||d.mode>0o777||(d.mode&0o022)!==0||(d.mode&0o700)!==0o700))
          throw new Error('Invalid skill package journal manifest');
      }
    }
  } else if (j.files.length > MAX_FILES
    || j.files.some(f => !relativeFile(f.path) || ![f.before, f.after].every(x => x === null || typeof x === 'string')
      || (f.beforeMode !== null && (!Number.isInteger(f.beforeMode) || f.beforeMode < 0 || f.beforeMode > 0o777 || (f.beforeMode & 0o022))))
    || j.files.reduce((total, f) => total + bytes(f.before) + bytes(f.after), 0) > MAX_TOTAL
    || j.files.some(f => bytes(f.before) > MAX_FILE || bytes(f.after) > MAX_FILE))
    throw new Error('Invalid settings-copy journal');
  if (!j.source || (j.source.root !== null && !isAbsolute(j.source.root))) throw new Error('Invalid source binding in copy journal');
  await validateTarget(store, j);
  return { path, journal: j };
}
async function writeSetting(home, f, undo = false, payloadDirectory = null) {
  if (payloadDirectory) return writeAdvanced(home, f, payloadDirectory, undo);
  const path = join(home, f.path), content = undo ? f.before : f.after;
  const parent = dirname(path);
  if (parent !== home) {
    if (!await exists(parent)) await mkdir(parent, { mode: 0o700 });
    await directory(parent);
  }
  if (content === null) { await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); return; }
  const tmp = join(parent, '.xfx-copy-' + randomUUID() + '.tmp');
  try {
    await writeFile(tmp, content, { flag: 'wx', mode: undo ? f.beforeMode ?? 0o600 : 0o600 });
    await rename(tmp, path);
  } finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function matchesFile(home, f, direction, allowBoth = false, payloadDirectory = null) {
  if (payloadDirectory) return matchesAdvanced(home, f, payloadDirectory, direction, allowBoth);
  const current = (await textFile(join(home, f.path)))?.content ?? null;
  if (current !== f[direction] && !(allowBoth && current === f[direction === 'before' ? 'after' : 'before']))
    throw new Error('Settings changed since the copy; refusing to overwrite: ' + f.path);
}
async function restoreFiles(store, j, path, { allowBoth = false, runtime, checkpoint = async () => {} } = {}) {
  await validateTarget(store, j);
  const payloadDirectory = j.schemaVersion >= 2 ? dirname(path) : null;
  if(j.schemaVersion>=3) await matchesAdvancedPackages(j.target.home,j.packages,'after',allowBoth);
  for (const f of j.files) await matchesFile(j.target.home, f, 'after', allowBoth, payloadDirectory);
  for (const f of [...j.files].reverse()) {
    await runtime.assertIdle({ cliExecutables: [j.target.executable] });
    await validateTarget(store, j);
    await matchesFile(j.target.home, f, 'after', allowBoth, payloadDirectory);
    await writeSetting(j.target.home, f, true, payloadDirectory);
    await checkpoint('undo-file', f.path);
  }
  if(j.schemaVersion>=3) {
    await applyAdvancedPackageDirectories(j.target.home,j.packages,true);
    await matchesAdvancedPackages(j.target.home,j.packages,'before');
  }
  if (payloadDirectory) await cleanupAdvancedDirectories(j.target.home, j.createdDirectories);
  j.phase = 'undone'; j.undoneAt = new Date().toISOString(); await record(path, j);
}
async function clearPending(store, id) {
  if (await exists(pendingPath(store))) {
    if ((await readJSON(pendingPath(store))).id !== id) throw new Error('A different copy is pending');
    await unlink(pendingPath(store));
  }
}
export async function applyCopy(store, source, target, options = {}) {
  const initial = await build(store, source, target, options);
  if (options.expectedHash && initial.report.hash !== options.expectedHash) throw new Error('Copy preview changed; preview again');
  const packageChanges=(initial.plan.packages??[]).some(p=>JSON.stringify(p.before)!==JSON.stringify(p.after));
  if (!initial.plan.files.length&&!packageChanges) return { ...initial.report, status: 'unchanged' };
  const j = { schemaVersion: 3, kind: 'native-settings-copy', id: randomUUID(), storePath: store.directory,
    phase: 'prepared', createdAt: new Date().toISOString(), ...initial.plan };
  j.payloadHash = digest(journalPayload(j));
  const verifyInputs = async () => {
    if (await exists(pendingPath(store))) throw new Error('An interrupted settings copy needs copy undo pending');
    const current = await build(store, source, target, options);
    if (current.report.hash !== initial.report.hash) throw new Error('Copy inputs changed; preview again');
  };
  return locks(store, j, verifyInputs, async runtime => {
    await verifyInputs();
    await safeStore(store, true);
    const dir = join(rootPath(store), j.id); await privateDirectory(dir, true);
    const path = join(dir, 'journal.json');
    if (j.schemaVersion >= 2) {
      j.files = await persistAdvancedFiles(dir, initial.plan.files);
      j.payloadHash = digest(journalPayload(j));
    }
    const payloadDirectory = j.schemaVersion >= 2 ? dir : null;
    if (Buffer.byteLength(JSON.stringify(j)) > 900000) throw new Error('Copy journal exceeds metadata limit');
    await record(path, j);
    await record(pendingPath(store), { id: j.id });
    try {
      if(j.schemaVersion>=3) await matchesAdvancedPackages(j.target.home,j.packages,'before');
      for (const f of j.files) {
        if (options.signal?.aborted) throw Object.assign(new Error('Settings copy cancelled'), { code: 'CANCELLED' });
        await runtime.assertIdle({ cliExecutables: [j.target.executable] });
        await validateTarget(store, j);
        await matchesFile(j.target.home, f, 'before', false, payloadDirectory);
        await writeSetting(j.target.home, f, false, payloadDirectory);
        await options.checkpoint?.('copy-file', f.path);
      }
      if(j.schemaVersion>=3) {
        await applyAdvancedPackageDirectories(j.target.home,j.packages,false);
        await matchesAdvancedPackages(j.target.home,j.packages,'after');
      }
      j.phase = 'applied'; j.appliedAt = new Date().toISOString(); await record(path, j);
      await clearPending(store, j.id);
      return { ...initial.report, status: 'applied', id: j.id, backup: path, undo: 'copy undo ' + j.id };
    } catch (e) {
      // A committed operation must not be rolled back for metadata cleanup failure.
      if (j.phase === 'applied') throw new Error('Settings copied; cleanup needs copy undo ' + j.id);
      try {
        await restoreFiles(store, j, path, { allowBoth: true, runtime });
        await clearPending(store, j.id);
      } catch (recoveryError) {
        throw new Error('Copy incomplete; preserve backups and run copy undo ' + j.id + ' after closing clients: ' + recoveryError.message);
      }
      throw new Error('Copy failed and prior settings were restored. Backup ID: ' + j.id);
    }
  }, options);
}
export async function planUndo(store, id) {
  const { journal: j } = await readJournal(store, id);
  const current = [];
  for (const f of j.files) current.push(j.schemaVersion >= 2
    ? { path: f.path, ...await snapshotAdvanced(j.target.home, f) }
    : { path: f.path, content: (await textFile(join(j.target.home, f.path)))?.content ?? null });
  if(j.schemaVersion>=3) await matchesAdvancedPackages(j.target.home,j.packages,j.phase==='undone'?'before':'after',j.phase==='prepared'||Boolean(j.undoStarted));
  const changes=j.files.map(f=>({path:f.path,action:f.before===null?'remove':'restore'}));
  if(j.schemaVersion>=3) for(const pkg of j.packages) {
    const before=new Map(pkg.before.directories.map(d=>[d.path,d.mode])), after=new Map(pkg.after.directories.map(d=>[d.path,d.mode]));
    for(const path of new Set([...before.keys(),...after.keys()])) if(before.get(path)!==after.get(path))
      changes.push({path,action:before.has(path)?after.has(path)?'restore-directory-mode':'restore-directory': 'remove-directory'});
  }
  return { status: 'preview', id: j.id, phase: j.phase, target: { name: j.target.name, home: j.target.home },
    hash: digest({ journal: j, current }), changes,
    notes: ['Undo restores copied settings only. Newer edits are preserved by refusing conflicts. History and sign-in remain untouched.'] };
}
export async function undoCopy(store, id, options = {}) {
  const preview = await planUndo(store, id);
  if (options.expectedHash && options.expectedHash !== preview.hash) throw new Error('Undo preview changed; preview again');
  const { path, journal: j } = await readJournal(store, id);
  const verifyInputs = async () => {
    const current = await readJournal(store, j.id);
    if (current.path !== path || !equal(current.journal, j)) throw new Error('Copy journal changed; preview again');
    if (options.expectedHash && (await planUndo(store, j.id)).hash !== options.expectedHash) throw new Error('Undo inputs changed; preview again');
    if (await exists(pendingPath(store)) && (await readJSON(pendingPath(store))).id !== j.id)
      throw new Error('A different copy is pending; use copy undo pending first');
    if (j.phase !== 'undone') {
      // Validate an ordinary undo before recording recovery authority. A later
      // interrupted undo may contain any mix of its before/after file contents.
      for (const f of j.files) await matchesFile(j.target.home, f, 'after', j.phase === 'prepared' || Boolean(j.undoStarted), j.schemaVersion >= 2 ? dirname(path) : null);
      if(j.schemaVersion>=3) await matchesAdvancedPackages(j.target.home,j.packages,'after',j.phase==='prepared'||Boolean(j.undoStarted));
    }
    return j.phase !== 'undone';
  };
  return locks(store, j, verifyInputs, async runtime => {
    await verifyInputs();
    if (options.signal?.aborted) throw Object.assign(new Error('Settings copy cancelled'), { code: 'CANCELLED' });
    if (j.phase !== 'undone') {
      // Preserve a recovery pointer while undo is partially applied.
      await record(pendingPath(store), { id: j.id });
      j.undoStarted = true;
      await record(path, j);
      await restoreFiles(store, j, path, { allowBoth: true, runtime, checkpoint: options.checkpoint });
    }
    await clearPending(store, j.id);
    return { status: 'undone', id: j.id, target: preview.target, historyChanged: false };
  }, options, true);
}
