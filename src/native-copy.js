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
  const list = typeof include === 'string' ? include.split(',').map(s => s.trim()) : include;
  if (!Array.isArray(list) || !list.length || list.some(x => !COPY_COMPONENTS.includes(x)) || new Set(list).size !== list.length)
    throw new Error('Choose --include config,instructions,agents (any nonempty subset). Other components are not supported.');
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
async function build(store, sourceName, targetName, { include, defaultUserHome = homedir() } = {}) {
  const components = selection(include);
  await safeStore(store);
  const source = await endpoint(store, sourceName, defaultUserHome), target = await endpoint(store, targetName, defaultUserHome, true);
  if (overlap(source.home, target.home) || overlap(store.directory, target.home) || overlap(store.directory, source.home))
    throw new Error('Source, destination and backup storage must be separate');
  const files = [], copiedKeys = [], preservedKeys = [];
  async function add(path, after) {
    if (!relativeFile(path)) throw new Error('Unsupported settings path');
    if (after !== null && Buffer.byteLength(after) > MAX_FILE)
      throw new Error('Selected settings exceed the bounded file limit: ' + path);
    const prior = await textFile(join(target.home, path)), before = prior?.content ?? null;
    noSecrets(before, path); noSecrets(after, path);
    if (before !== after) files.push({ path, before, beforeMode: prior?.mode ?? null, after });
  }
  if (components.includes('config') || components.includes('agents')) {
    const sourceConfig = await textFile(join(source.home, 'config.toml'));
    if (!sourceConfig) throw new Error('Source configuration is missing');
    const from = toml(sourceConfig.content, 'source config');
    const prior = await textFile(join(target.home, 'config.toml'));
    if (!prior) throw new Error('Destination configuration is missing');
    // Parse a separate editable copy to preserve TOML dates and table prototypes.
    const before = toml(prior.content, 'destination config'), after = toml(prior.content, 'destination config');
    if ([from, before].some(config => (config.model_provider ?? 'openai') !== 'openai'
      || Object.hasOwn(config.model_providers ?? {}, 'openai')))
      throw new Error('Config and agent copies do not support custom model providers; select instructions instead');
    if (components.includes('config')) {
      const values = projected(from, CONFIG_KEYS, 'config');
      for (const key of CONFIG_KEYS) { delete after[key]; if (Object.hasOwn(values, key)) after[key] = values[key]; }
      // Named homes are selected through a CODEX_HOME symlink. Keep that
      // required root-level setting enabled regardless of the imported source.
      after.allow_symlinked_codex_home = true;
      copiedKeys.push(...Object.keys(values));
    }
    if (components.includes('agents')) {
      for (const config of [from, before]) for (const key of ['agents', 'features']) {
        const value = config[key];
        if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Date))
          throw new Error(`Agent copies require a TOML table for ${key}`);
      }
      const settings = projected(from.agents ?? {}, AGENT_KEYS, 'agents');
      // Unsupported agent role references can point outside this home. Do not silently retain them.
      if (Object.keys(before.agents ?? {}).some(k => !AGENT_KEYS.includes(k))
        || Object.keys(from.agents ?? {}).some(k => !AGENT_KEYS.includes(k)))
        throw new Error('Unsupported agent settings or role references; inspect before copying agents');
      if (Object.keys(settings).length) after.agents = Object.assign(Object.create(null), settings); else delete after.agents;
      if (Object.hasOwn(from.features ?? {}, 'multi_agent')) {
        if (typeof from.features.multi_agent !== 'boolean') throw new Error('Invalid multi_agent setting');
        after.features ??= Object.create(null);
        after.features.multi_agent = from.features.multi_agent;
      } else if (after.features) delete after.features.multi_agent;
      copiedKeys.push('agents', 'features.multi_agent');
    }
    preservedKeys.push(...Object.keys(before).filter(k => !(components.includes('config') && (CONFIG_KEYS.includes(k) || k === 'allow_symlinked_codex_home')) && !(components.includes('agents') && ['agents', 'features'].includes(k))));
    if (components.includes('agents') && before.features) preservedKeys.push('features (except multi_agent)');
    if (!equal(before, after)) await add('config.toml', stringify(after));
  }
  if (components.includes('instructions')) {
    for (const path of ['AGENTS.md', 'AGENTS.override.md']) await add(path, (await textFile(join(source.home, path)))?.content ?? null);
  }
  if (components.includes('agents')) {
    const sources = await agentFiles(source.home), targets = await agentFiles(target.home);
    for (const path of [...new Set([...sources, ...targets])].sort()) {
      let content = sources.includes(path) ? (await textFile(join(source.home, path)))?.content ?? null : null;
      if (content !== null) {
        const role = toml(content, path);
        if (Object.keys(role).some(k => !ROLE_KEYS.includes(k)) || typeof role.name !== 'string'
          || typeof role.description !== 'string' || typeof role.developer_instructions !== 'string'
          || Object.values(role).some(v => !scalar(v))) throw new Error('Unsupported or incomplete agent definition: ' + path);
      }
      await add(path, content);
    }
  }
  if (files.length > MAX_FILES || files.reduce((n, f) => n + Buffer.byteLength(f.before ?? '') + Buffer.byteLength(f.after ?? ''), 0) > MAX_TOTAL)
    throw new Error('Selected settings exceed the bounded backup limit');
  const plan = { source, target, components, files, defaultUserHome };
  const report = { status: 'preview', hash: digest(plan), source: { name: source.name, home: source.home },
    target: { name: target.name, home: target.home }, components,
    changes: files.map(f => ({ path: f.path, action: f.before === null ? 'add' : f.after === null ? 'remove' : 'replace',
      beforeSha256: f.before === null ? null : hash(f.before), afterSha256: f.after === null ? null : hash(f.after) })),
    config: { scope: 'General model, reasoning and permission settings, plus enabling symlinked Codex homes; selected agent settings are separate.',
      copiedKeys, preservedKeys, enforcedKeys: components.includes('config') ? ['allow_symlinked_codex_home'] : [],
      formatting: 'Changed config.toml is serialized; its comments and formatting are not retained.' },
    excluded: ['sign-in and credentials', 'history and memories', 'desktop state', 'skills and plugins',
      'MCP servers, hooks and notifications', 'repository files', 'storage routing'],
    notes: ['Selected instruction/agent categories replace their destination counterparts, including removing absent source files.',
      'References inside instruction prose are unchanged; referenced skills and external tools are not cloned.',
      'Restore Default through the desktop picker before closing clients if a named desktop is selected.',
      'Apply/undo can gracefully close known blocking Codex and VS Code clients after confirmation. Close standalone CLI or unknown clients yourself.',
      'Restart and use a fresh task to evaluate changed settings.'] };
  return { plan, report };
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
async function readJournal(store, id) {
  await safeStore(store);
  const path = await journalPath(store, id);
  await privateDirectory(dirname(path));
  const j = await readJSON(path);
  if (j.schemaVersion !== 1 || j.kind !== 'native-settings-copy' || !uuid.test(j.id ?? '') || !path.endsWith('/' + j.id + '/journal.json')
    || j.storePath !== store.directory || !['prepared', 'applied', 'undone'].includes(j.phase)
    || !Array.isArray(j.files) || j.files.length > MAX_FILES || new Set(j.files.map(f => f.path)).size !== j.files.length
    || j.files.some(f => !relativeFile(f.path) || ![f.before, f.after].every(x => x === null || typeof x === 'string')
      || (f.beforeMode !== null && (!Number.isInteger(f.beforeMode) || f.beforeMode < 0 || f.beforeMode > 0o777 || (f.beforeMode & 0o022))))
    || j.payloadHash !== digest({ source: j.source, target: j.target, components: j.components, files: j.files, defaultUserHome: j.defaultUserHome }))
    throw new Error('Invalid settings-copy journal');
  if (j.files.reduce((total, f) => total + bytes(f.before) + bytes(f.after), 0) > MAX_TOTAL
    || j.files.some(f => bytes(f.before) > MAX_FILE
      || bytes(f.after) > MAX_FILE))
    throw new Error('Invalid settings-copy journal');
  if (!j.source || (j.source.root !== null && !isAbsolute(j.source.root))) throw new Error('Invalid source binding in copy journal');
  await validateTarget(store, j);
  return { path, journal: j };
}
async function writeSetting(home, f, undo = false) {
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
async function matchesFile(home, f, direction, allowBoth = false) {
  const current = (await textFile(join(home, f.path)))?.content ?? null;
  if (current !== f[direction] && !(allowBoth && current === f[direction === 'before' ? 'after' : 'before']))
    throw new Error('Settings changed since the copy; refusing to overwrite: ' + f.path);
}
async function restoreFiles(store, j, path, { allowBoth = false, runtime, checkpoint = async () => {} } = {}) {
  await validateTarget(store, j);
  for (const f of j.files) await matchesFile(j.target.home, f, 'after', allowBoth);
  for (const f of [...j.files].reverse()) {
    await runtime.assertIdle({ cliExecutables: [j.target.executable] });
    await matchesFile(j.target.home, f, 'after', allowBoth);
    await writeSetting(j.target.home, f, true);
    await checkpoint('undo-file', f.path);
  }
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
  if (!initial.plan.files.length) return { ...initial.report, status: 'unchanged' };
  const j = { schemaVersion: 1, kind: 'native-settings-copy', id: randomUUID(), storePath: store.directory,
    phase: 'prepared', createdAt: new Date().toISOString(), ...initial.plan, payloadHash: digest(initial.plan) };
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
    if (Buffer.byteLength(JSON.stringify(j)) > 900000) throw new Error('Copy journal exceeds metadata limit');
    await record(path, j);
    await record(pendingPath(store), { id: j.id });
    try {
      for (const f of j.files) {
        if (options.signal?.aborted) throw Object.assign(new Error('Settings copy cancelled'), { code: 'CANCELLED' });
        await runtime.assertIdle({ cliExecutables: [j.target.executable] });
        await validateTarget(store, j);
        await matchesFile(j.target.home, f, 'before');
        await writeSetting(j.target.home, f);
        await options.checkpoint?.('copy-file', f.path);
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
      } catch {
        throw new Error('Copy incomplete; preserve backups and run copy undo ' + j.id + ' after closing clients');
      }
      throw new Error('Copy failed and prior settings were restored. Backup ID: ' + j.id);
    }
  }, options);
}
export async function planUndo(store, id) {
  const { journal: j } = await readJournal(store, id);
  const current = [];
  for (const f of j.files) current.push({ path: f.path, content: (await textFile(join(j.target.home, f.path)))?.content ?? null });
  return { status: 'preview', id: j.id, phase: j.phase, target: { name: j.target.name, home: j.target.home },
    hash: digest({ journal: j, current }), changes: j.files.map(f => ({ path: f.path, action: f.before === null ? 'remove' : 'restore' })),
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
      for (const f of j.files) await matchesFile(j.target.home, f, 'after', j.phase === 'prepared' || Boolean(j.undoStarted));
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
