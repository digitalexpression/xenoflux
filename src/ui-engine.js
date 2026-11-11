// The engine-backed provider for the local app. Each method reuses existing
// discovery, history, comparison, export and copy code and returns the view
// models in web/src/api/types.ts. Task execution requires a reviewed run token.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareAuditProfiles, compareAuditSessions } from './audit.js';
import { auditSelectionOptions } from './audit-selection.js';
import { canonicalAuditChecks } from './audit-explanation.js';
import { exportAuditReport, readAuditReport } from './audit-store.js';
import { buildAuditReviewPacket, projectAuditReviewState } from './audit-review.js';
import { evaluateAuditEvidence, previewAuditEvidence } from './audit-review-command.js';
import { ASSOCIATION, presentComparison, presentEvidence, presentReviews, presentRunExecution, presentSetupComparison, presentSkillPackage } from './audit-presentation.js';
import { inspectCopyProfile } from './copy-client.js';
import { managedNativeProfiles, PROFILE_CLIENT_NAMES } from './managed-native-profile.js';
import { inspectSetupGuidance } from './setup-guidance.js';
import { createDesktopRuntime, DESKTOP_APP } from './desktop-runtime.js';
import { createHome, planHomeCreation } from './home-create.js';
import { nativeClient } from './profile-command.js';
import { bind, find, PROFILE_CLIENTS, renameProfile as renameInData } from './profiles.js';
import { editProfileRegistry, removeProfile as removeFromStore } from './profile-removal.js';
import { acquire, privateDirectory, record, release } from './metadata.js';
import { findHistory, listHistory, recordedHistoryClient } from './history.js';
import { listHomes, registerHome } from './homes.js';
import { createCodexDesktopSurface } from './desktop-surface.js';
import { applyCopy, planCopy, planUndo, resolveNativeSettingsHome, undoCopy, validateAdvancedSelection } from './native-copy.js';
import { observeProfileClients } from './ui-clients.js';
import { UiError } from './ui-server.js';
import { createUiRuns } from './ui-runs.js';
import { createUiReviewTasks } from './ui-review-tasks.js';
import { createUiCatalog } from './ui-catalog.js';
import { createStockDesktopApps } from './stock-desktop-apps.js';
import { withProfileOperation } from './desktop-instances.js';
import { assertEnvironmentBinding, createEnvironmentBinding } from './client-contracts.js';
import { createCopilotRuntime } from './copilot-runtime.js';
import { resolveProfileExecutionProfile } from './audit-profile.js';
import { importClaudeSession, listClaudeSessions } from './claude-sessions.js';
import { importClaudeTranscript } from './claude-transcript.js';
import { importCopilotTranscript } from './copilot-transcript.js';
import { auditNativeSession } from './audit-session.js';
import { compareAuditRuns } from './audit-report.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const plain = value => typeof value === 'string' && value.trim() !== '' && value.length <= 200 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const encodeRef = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeRef(ref) {
  try { return JSON.parse(Buffer.from(ref, 'base64url').toString('utf8')); }
  catch { return null; }
}
const tilde = path => path?.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;
const profileArg = id => id === 'default' ? 'Default' : id;

function when(seconds) {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return 'date not recorded';
  const now = new Date(), sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  if (yesterday) return `yesterday ${time}`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

const CLIENT_TEXT = { cli: 'Codex CLI', desktop: 'Codex Desktop', unknown: 'client not recorded' };

function replayCitationTopics(topics, subject, ref) {
  const rows = { a: subject?.left, b: subject?.right };
  return topics.map(topic => ({ ...topic, reviews: topic.reviews.map(review => ({ ...review,
    basedOn: review.basedOn.map(item => {
      if (!item.text.startsWith('replay:')) return item;
      try {
        const [runId, sessionId, eventId] = JSON.parse(decodeURIComponent(item.text.slice('replay:'.length)));
        const side = rows.a?.id === runId ? 'a' : rows.b?.id === runId ? 'b' : null;
        const event = rows[side]?.sessionReplay?.sessions?.find(session => session.id === sessionId)?.events?.find(event => event.id === eventId);
        if (!side || !event) return item;
        const citation = encodeURIComponent(JSON.stringify([side, sessionId, eventId]));
        return { text: `${side === 'a' ? 'Left' : 'Right'}: ${event.label || event.kind}`, href: `/reports/${encodeURIComponent(ref)}?event=${citation}` };
      } catch { return item; }
    }),
  })) }));
}


const XFX = fileURLToPath(new URL('../bin/xfx.js', import.meta.url));
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const appleString = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 15000 }, error => error ? reject(error) : resolve()));

/** Explicit client operations, each started by a person in the app. Replaceable in tests. */
export function defaultClientOps(store, desktopSurface = createCodexDesktopSurface(store)) {
  const xfx = args => [process.execPath, XFX, '--store', store.directory, ...args].map(shellQuote).join(' ');
  return {
    openTerminal: args => run('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script ${appleString(xfx(args))}`, '-e', 'tell application "Terminal" to activate']),
    showTerminal: () => run('/usr/bin/open', ['-a', 'Terminal']),
    openDefaultDesktop: () => desktopSurface.openDefault(),
    openDesktop: name => desktopSurface.open(name),
    focusDesktop: name => desktopSurface.focus(name),
  };
}

const CLIENT_BLOCKED = /DESKTOP_RUNNING|CLI_RUNNING|RESOURCE_BUSY|running|in use/i;
function copyError(error) {
  const message = String(error?.message ?? error);
  if (CLIENT_BLOCKED.test(String(error?.code ?? '')) || /DESKTOP_RUNNING|CLI_RUNNING|RESOURCE_BUSY/.test(message))
    return new UiError(409, 'Codex is open in this profile. Changes can only be applied while it’s closed. Close it yourself, then apply again; Xenoflux never closes Codex or Terminal sessions for you.', 'client-open');
  if (/preview again|changed/i.test(message)) return new UiError(409, `${message}. Nothing was changed; review the preview again.`, 'changed');
  return new UiError(422, message, 'copy-failed');
}

const MAX_SAVED = 20;

export function createEngineProvider({ store, version = 'unknown', reportsRoot = join(homedir(), 'Xenoflux reports'), defaultUserHome = homedir(),
  observeClients = observeProfileClients, desktopSurface = createCodexDesktopSurface(store), stockApps = createStockDesktopApps(), clientOps = defaultClientOps(store, desktopSurface), copyRuntime = () => createDesktopRuntime({ closeClients: false }),
  resolveClient = signal => nativeClient(store, {}, signal), profilesBase = join(dirname(store.directory), 'profiles'), lockOptions = {}, runContext = {}, reviewContext = {}, catalogContext = {}, copilotImportContext = {}, accountContext = {}, maxActiveJobs = 8 }) {
  if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1) throw new Error('Invalid active job capacity');
  const admitted = new Set();
  const activeImports = new Set();
  const sessionSelections = { codex: new Map(), 'claude-code': new Map(), copilot: new Map() };
  const claudeSelections = sessionSelections['claude-code'], copilotSelections = sessionSelections.copilot;
  const copilotRuntime = createCopilotRuntime();
  const nativeProfiles = managedNativeProfiles({ terminalEnvironment: runContext.terminalEnvironment ?? process.env,
    ...accountContext, store, profilesBase, defaultUserHome, copilotRuntime, lockOptions });
  const resolvers = context => ({ copilot: nativeProfiles.qualifiedCopilot, ...context.profileResolvers });
  runContext = { ...runContext, profileResolvers: resolvers(runContext) };
  reviewContext = { ...reviewContext, profileResolvers: resolvers(reviewContext) };
  catalogContext = { ...catalogContext, profileResolvers: resolvers(catalogContext) };
  async function resolveCopilotSource(name) {
    const stock = name.trim().toLowerCase() === 'default';
    const selected = stock ? null : find(await store.read(), name);
    const repository = selected?.repositories[0]?.path;
    if (!stock && !repository) throw new Error('Bind a workspace to the selected Copilot profile.');
    const profile = await resolveProfileExecutionProfile(store, { name, client: 'copilot' }, {
      defaultUserHome, sessionOnly: stock, repository, terminalEnvironment: runContext.terminalEnvironment ?? process.env,
      profileResolvers: runContext.profileResolvers,
    });
    if (stock) return profile;
    if (profile.profileId !== selected.id || profile.cwd !== repository || profile.bindingRepository !== repository)
      throw new Error('The selected Copilot workspace binding changed.');
    const info = await lstat(repository);
    if (!info.isDirectory() || await realpath(repository) !== repository)
      throw new Error('The selected Copilot workspace is no longer canonical.');
    return { ...profile, metadataWorkspaceIdentity: `${info.dev}:${info.ino}` };
  }
  async function withCopilotMetadata(name, profile, directory, read) {
    const guard = action => withProfileOperation(store, profile.profileId, { waitMs: 5000, recovery: true, ...lockOptions }, action);
    const lock = join(profile.reservationRoot, '.run-lock'), id = randomUUID();
    const owner = { kind: 'copilot-session-read', runId: id, profileId: profile.profileId,
      home: profile.home, host: hostname(), pid: process.pid, storePath: await realpath(store.directory) };
    const receipt = join(directory, 'session-read.json');
    const state = { schemaVersion: 1, kind: owner.kind, owner, binding: profile.environmentBinding, shutdown: null };
    let held = false;
    try {
      await record(receipt, state);
      await guard(async () => {
        if (closing) throw new Error('Xenoflux is stopping');
        const fresh = await resolveCopilotSource(name);
        assertEnvironmentBinding(fresh.environmentBinding, profile.environmentBinding);
        if (fresh.metadataWorkspaceIdentity !== profile.metadataWorkspaceIdentity)
          throw new Error('The selected Copilot workspace changed.');
        if (JSON.stringify(fresh.accountQualification) !== JSON.stringify(profile.accountQualification))
          throw new Error('Copilot account qualification changed');
        await acquire(lock, owner, true);
        held = true;
      });
      return await read({
        onSpawn: async process => { state.process = process; await record(receipt, state); },
        onShutdown: async process => { state.shutdown = process.shutdown; await record(receipt, state); },
      });
    } catch (error) {
      if (held && state.shutdown?.groupTerminated !== true) error.nativeShutdownUncertain = true;
      throw error;
    } finally {
      if (held && state.shutdown?.groupTerminated === true) {
        try { await guard(() => release(lock, owner)); }
        catch (error) { error.preserveNativeEvidence = true; throw error; }
      }
    }
  }
  const resolveClaudeSource = name => resolveProfileExecutionProfile(store, { name, client: 'claude-code' },
    { defaultUserHome, sessionOnly: true, terminalEnvironment: runContext.terminalEnvironment ?? process.env });
  async function codexSessionIdentity(entry) {
    if (!entry?.rolloutPath) return null;
    const identity = async path => {
      const info = await lstat(path);
      if (info.isSymbolicLink() || await realpath(path) !== path) throw new Error('The selected history source is no longer canonical.');
      return [info.dev, info.ino, ...(info.isFile() ? [info.size, info.mtimeMs, info.ctimeMs] : [])];
    };
    const { profileId, environmentId, home, rolloutPath, id, indexSource } = entry;
    return { profileId, environmentId, id, home, rolloutPath, indexSource, root: await identity(home), file: await identity(rolloutPath) };
  }

  async function importListedSession(client, token, directory, directories) {
    const bound = sessionSelections[client].get(token);
    if (!bound || bound.expiresAt < Date.now()) throw new Error('The selected session expired.');
    if (client === 'codex') {
      const { profileId, id } = bound.selection;
      const verify = async () => {
        const { entry } = await findHistory(store, profileArg(profileId), id, { defaultUserHome });
        if (JSON.stringify(await codexSessionIdentity(entry)) !== JSON.stringify(bound.selection))
          throw new Error('The selected Codex history source changed.');
        return entry;
      };
      const entry = await verify();
      const imported = await auditNativeSession(store, profileArg(profileId), id, { defaultUserHome, includeReplay: true });
      await verify();
      if (!['ready', 'partial'].includes(imported.status) || imported.profile?.profileId !== profileId)
        throw new Error('The selected Codex history source is unavailable.');
      return { ...imported, clientIdentity: { client }, source: { ...imported.source, readContext: {
        client, profileId, profileName: entry.profileName, rootMode: profileId === 'default' ? 'implicit' : 'explicit',
        surface: await recordedHistoryClient(entry.rolloutPath, entry.indexSource), executionLocation: 'local',
      } } };
    }
    const profile = await (client === 'claude-code' ? resolveClaudeSource(bound.name) : resolveCopilotSource(bound.name));
    let imported;
    if (client === 'claude-code') {
      imported = await importClaudeSession(profile, bound.selection, { directory, onArtifactCreated: artifact => directories.push(artifact) });
    } else {
      if (profile.metadataWorkspaceIdentity !== bound.workspaceIdentity)
        throw new Error('The selected Copilot workspace changed.');
      const readJournal = input => withCopilotMetadata(bound.name, profile, directory,
        lifecycle => copilotRuntime.readJournal({ ...input, ...lifecycle }));
      let artifact;
      imported = await importCopilotTranscript({ sessionId: bound.selection.sessionId, selection: bound.selection },
        { ...copilotImportContext, directory, onArtifactCreated: value => { artifact = value; }, profile, readJournal });
      if (artifact) directories.push(artifact);
    }
    const { profileId, profileName, rootMode, surface, executionLocation } = profile;
    return { ...imported, source: { ...imported.source, readContext: { ...imported.source.readContext,
      client, profileId, profileName, rootMode, surface, executionLocation } } };
  }
  let closing = false;
  const admission = {
    async acquire(id) {
      if (admitted.size >= maxActiveJobs) throw new UiError(409, `This controller can run ${maxActiveJobs} jobs at once. Try again after one finishes.`, 'job-capacity');
      admitted.add(id);
    },
    release(id) { admitted.delete(id); },
  };
  const catalogs = createUiCatalog({ store, defaultUserHome, context: { lockOptions, ...catalogContext } });
  const validateSelection = (input, execution) => catalogs.validate(input, execution);
  async function nativeExecutionOptions() {
    const data = await store.read();
    const profiles = await Promise.all(data.profiles.filter(row => row.client && row.client !== 'codex').map(async selected => {
      const { name, client } = selected;
      const ready = await nativeProfiles.resolveProfile(client, selected).then(() => true, () => false);
      return { name, client, label: `${name} · ${PROFILE_CLIENT_NAMES[client]}`, ready, surface: 'cli', executionLocation: 'local',
        rootMode: 'explicit', readiness: ready ? 'Sign-in and access are checked before Start.' : 'The native root or executable is unavailable.' };
    }));
    for (const client of ['claude-code', 'copilot']) {
      if (await nativeProfiles.hasStock(client)) profiles.push({ name: 'Default', client, label: `${PROFILE_CLIENT_NAMES[client]} Default`,
        ready: true, surface: 'cli', executionLocation: 'local', rootMode: 'implicit',
        readiness: 'Uses the existing stock setup. Sign-in and access are checked before Start.' });
    }
    return profiles;
  }
  const runs = createUiRuns({ store, defaultUserHome, context: { validateSelection, nativeExecutionOptions, ...runContext }, admission });
  const reviewTasks = createUiReviewTasks({ store, defaultUserHome, context: { validateSelection, nativeExecutionOptions, ...reviewContext }, admission,
    resolveComparison: async ref => {
      // A Start rechecks current session evidence, not a previously cached view.
      if (ref.startsWith('s.') || ref.startsWith('p.')) cache.delete(ref);
      const source = await comparisonFor(ref);
      return { value: source.value, title: await titleFor(ref, source.selection, source.saved) ?? 'Task comparison',
        comparisonFingerprint: source.comparisonFingerprint };
    } });
  const cache = new Map();          // ref → comparison value (bounded)
  const opened = new Map();         // saved ref → { value, title, savedAt, path }
  const titles = new Map();         // session ref → task title shown to the user
  const privateSelections = new Map();
  const plans = new Map();          // plan token → what the person reviewed
  const setups = new Map();         // encoded profile pair → { at, value } short-lived setup snapshots
  const reviewDrafts = new Map();   // one-use, short-lived preview token → validated frozen submission
  const savedFile = join(store.directory, 'ui-saved-reports.json');

  function remember(ref, value) {
    cache.set(ref, value);
    while (cache.size > 12) cache.delete(cache.keys().next().value);
  }

  async function savedList() {
    try {
      const value = JSON.parse(await readFile(savedFile, 'utf8'));
      if (!Array.isArray(value) || value.some(entry => !entry || ['id', 'title', 'savedAt', 'folder', 'jsonPath'].some(key => typeof entry[key] !== 'string')))
        throw new Error('The saved report index is invalid');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function savedIdentity(value) {
    const subject = value?.kind === 'audit-evaluation-report' ? value.subject : value;
    if (subject?.kind !== 'audit-comparison') return null;
    const side = (run, key) => {
      const execution = presentRunExecution(run);
      const checks = canonicalAuditChecks(run ?? {});
      const counts = new Map();
      for (const check of checks) counts.set(check?.status ?? 'unknown', (counts.get(check?.status ?? 'unknown') ?? 0) + 1);
      const checkSummary = checks.length ? [...counts].map(([status, count]) => `${count} ${status}`).join(', ')
        : execution.state === 'not-started' ? 'Checks not run' : 'Checks not recorded';
      const profile = run?.profile?.profileName ?? run?.source?.profileName ?? subject.selection?.[key]?.profileName;
      return { side: key === 'left' ? 'A' : 'B', profile: typeof profile === 'string' && profile ? profile : `Side ${key === 'left' ? 'A' : 'B'}`, state: execution.state, detail: execution.text, checks: checkSummary };
    };
    return [side(subject.left, 'left'), side(subject.right, 'right')];
  }
  async function writeSaved(entries) {
    await mkdir(store.directory, { recursive: true, mode: 0o700 });
    const temporary = join(store.directory, `.ui-saved-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(entries.slice(0, MAX_SAVED), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, savedFile);
    } finally { await rm(temporary, { force: true }); }
  }

  async function saveRecent(entry) {
    const deadline = Date.now() + 5000;
    while (true) {
      try { return await store.withLock(async () => writeSaved([entry, ...await savedList()])); }
      catch (error) {
        if (!error.message.startsWith('Store is locked:') || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  }

  async function profileRecords() {
    const homes = await listHomes(store);
    const data = await store.read();
    let defaultHome = null;
    try { defaultHome = (await resolveNativeSettingsHome(store, 'Default', { defaultUserHome })).home; await lstat(defaultHome); } catch { defaultHome = null; /* no standard Codex home */ }
    return { homes, data, defaultHome };
  }

  async function sessionRows({ query, profile, client } = {}) {
    const needle = typeof query === 'string' && query.trim() ? query.trim().slice(0, 200) : undefined;
    const lists = [];
    if (!profile || profile === 'Default') lists.push(listHistory(store, { profile: 'Default', query: needle, limit: 100, defaultUserHome, client }).catch(error => ({ entries: [], homes: [{ profileName: 'Default', status: 'unavailable', reason: error.message }] })));
    if (!profile) lists.push(listHistory(store, { query: needle, limit: 100, defaultUserHome, client }));
    else if (profile !== 'Default') lists.push(listHistory(store, { profile, query: needle, limit: 100, defaultUserHome, client }));
    const results = await Promise.all(lists);
    const candidates = results.flatMap(result => result.entries).sort((x, y) => y.updatedAt - x.updatedAt || y.createdAt - x.createdAt || x.profileId.localeCompare(y.profileId) || x.id.localeCompare(y.id));
    const entries = candidates.slice(0, 100);
    const homes = results.flatMap(result => result.homes);
    const rows = await Promise.all(entries.map(async entry => {
      const client = await recordedHistoryClient(entry.rolloutPath, entry.indexSource);
      return { key: `${entry.profileId}:${entry.id}`, title: entry.title || 'Untitled task', profile: entry.profileName, client, clientText: CLIENT_TEXT[client],
        project: basename(entry.cwd) || entry.cwd, recordedAt: when(entry.updatedAt), turns: entry.archived ? 'archived' : '', history: 'unknown', historyText: 'Checked when compared',
        updatedAt: entry.updatedAt };
    }));
    return { rows, homes, truncated: candidates.length > 100 || results.some(result => result.truncated) };
  }

  /** One session's row, looked up within its own profile's history. */
  async function rowFor(key) {
    const { profile, id } = parseKey(key);
    const found = await findHistory(store, profile, id, { defaultUserHome }).catch(() => null);
    const entry = found?.entry;
    if (!entry) return null;
    const client = await recordedHistoryClient(entry.rolloutPath, entry.indexSource);
    return { key, title: entry.title || 'Untitled task', profile: entry.profileName, client, clientText: CLIENT_TEXT[client],
      project: basename(entry.cwd) || entry.cwd, recordedAt: when(entry.updatedAt), turns: entry.archived ? 'archived' : '', history: 'unknown', historyText: 'Checked when compared' };
  }

  function parseKey(key) {
    const index = typeof key === 'string' ? key.lastIndexOf(':') : -1;
    const profileId = index > 0 ? key.slice(0, index) : '', id = index > 0 ? key.slice(index + 1) : '';
    if (!plain(profileId) || !UUID.test(id)) throw new UiError(400, 'Choose sessions from the list.', 'invalid-selection');
    return { profile: profileArg(profileId), id };
  }

  async function comparisonFor(ref) {
    if (ref.startsWith('r.')) {
      const frozen = await reviewTasks.frozenComparison(ref.slice(2));
      return { value: frozen.value, saved: frozen, comparisonFingerprint: frozen.comparisonFingerprint };
    }
    if (ref.startsWith('e.')) return { value: await runs.comparison(ref.slice(2)), execution: ref.slice(2) };
    if (cache.has(ref)) return { value: cache.get(ref), selection: privateSelections.get(ref) ?? decodeRef(ref.slice(2)) };
    if (ref.startsWith('f.')) {
      const saved = opened.get(ref);
      if (!saved) throw new UiError(404, 'This saved report isn’t open any more. Open it again from Open saved report.', 'report-missing');
      return { value: saved.value, saved };
    }
    const selection = ref.startsWith('p.') ? privateSelections.get(ref) : ref.startsWith('s.') ? decodeRef(ref.slice(2)) : null;
    if (ref.startsWith('p.') && !selection) throw new UiError(410, 'This private comparison link has expired. Reopen the exported report to continue.', 'expired-ref');
    if (!selection?.l || !selection?.r) throw new UiError(404, 'This report link isn’t valid. Choose the sessions again.', 'report-missing');
    const control = auditSelectionOptions({ ...(selection.t ? { taskAssociation: { status: 'user-declared', taskId: selection.t } } : {}),
      ...(selection.v?.length ? { declaredVariables: selection.v } : {}) });
    let value;
    try { value = await compareAuditSessions(store, parseKey(selection.l), parseKey(selection.r), control, { defaultUserHome, includeReplay: true }); }
    catch (error) { throw new UiError(422, `Couldn’t compare these sessions: ${error.message}`, 'compare-failed'); }
    remember(ref, value);
    return { value, selection };
  }

  /** Reviews only exist on saved evaluation reports; live comparisons are not reviewed. */
  function subjectOf(value) {
    if (value?.kind === 'audit-evaluation-report' && value.subject?.kind === 'audit-comparison')
      return { subject: value.subject, reviews: projectAuditReviewState(value.subject, value.reviewHistory) };
    return { subject: value, reviews: null };
  }

  const setupKey = (a, b, aClient, bClient) => aClient === 'codex' && bClient === 'codex'
    ? JSON.stringify([a, b]) : JSON.stringify([a, b, aClient, bClient]);
  async function setupFor(a, b, aClient = 'codex', bClient = 'codex') {
    const key = setupKey(a, b, aClient, bClient), cached = setups.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    let value;
    try {
      const data = await store.read();
      const optionsFor = async (name, clientId) => {
        if (clientId === 'codex') {
          const selected = data.profiles.find(profile => profile.name === name);
          if (selected?.client && selected.client !== clientId) throw new Error('Choose the matching native client.');
          return { clientId };
        }
        if (name === 'Default') return { clientId };
        const selected = data.profiles.find(profile => profile.name === name && profile.client === clientId);
        if (!selected) throw new Error('The selected native profile is unavailable.');
        const { sourceBinding } = await copyOptions(name, null, clientId);
        return { clientId, binding: sourceBinding };
      };
      const [leftOptions, rightOptions] = await Promise.all([optionsFor(a, aClient), optionsFor(b, bClient)]);
      value = await compareAuditProfiles(store, a, b, { defaultUserHome, client: 'cli', includeSourceValues: true, leftOptions, rightOptions });
    }
    catch (error) { throw new UiError(422, `Couldn’t read these setups: ${error.message}`, 'setup-failed'); }
    setups.set(key, { at: Date.now(), value });
    return value;
  }

  /** Decode the setup item's source identity for copy preselection. */
  function originIdentity(item) {
    if (typeof item !== 'string' || !item) return null;
    try {
      const parts = Buffer.from(item, 'base64url').toString('utf8').split('\u0000');
      if (parts.length !== 5 && parts.length !== 6) return null;
      return { category: parts[0], scope: parts[1], name: parts[4] };
    }
    catch { return null; }
  }

  function describeChange(entry, target) {
    const changes = entry.changes ?? [];
    const details = changes.map(change => ({ path: change.path, action: change.action,
      before: change.before == null ? null : typeof change.before === 'string' ? change.before : JSON.stringify(change.before),
      after: change.after == null ? null : typeof change.after === 'string' ? change.after : JSON.stringify(change.after),
      beforeMode: Number.isInteger(change.beforeMode) ? change.beforeMode : null,
      afterMode: Number.isInteger(change.afterMode) ? change.afterMode : null }));
    const first = changes[0];
    if (entry.category === 'config' || String(first?.path ?? '').startsWith('config.toml:')) {
      const before = first?.before, after = first?.after;
      return { kind: before === null || before === undefined ? `Setting · new to ${target}` : 'Setting', change: before === null || before === undefined ? `Set to ${JSON.stringify(after)}` : `${JSON.stringify(before)} → ${JSON.stringify(after)}`, details };
    }
    const removals = changes.filter(change => /remove|delete/.test(change.action)).length;
    const additions = changes.filter(change => change.action === 'new' || change.action === 'add').length;
    const updates = changes.length - removals - additions;
    const parts = [updates && `update ${updates} ${updates === 1 ? 'file' : 'files'}`, additions && `add ${additions} ${additions === 1 ? 'file' : 'files'}`, removals && `remove ${removals} ${removals === 1 ? 'file' : 'files'}`].filter(Boolean);
    const exact = entry.category === 'skill' && entry.status !== 'new';
    return { kind: `${entry.category === 'skill' ? 'Skill' : entry.category === 'instruction' ? 'Instructions' : entry.category ?? 'Item'}${exact ? ' · exact replacement' : entry.status === 'new' ? ` · new to ${target}` : ''}`,
      change: parts.length ? `${parts.join(' · ').replace(/^./, c => c.toUpperCase())}` : 'Replace with the source version', details };
  }

  function selectedManual(reviewed, ids) {
    const rows = new Map((reviewed.manualOptions ?? []).map(entry => [entry.id, entry]));
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !rows.has(id)))
      throw new UiError(400, 'Choose manual setup guidance from the preview.', 'invalid-selection');
    return ids.map(id => rows.get(id));
  }

  async function copyOptions(from, target, client) {
    if (!client || client === 'codex') return { defaultUserHome };
    async function binding(name) {
      if (!name || name.toLowerCase() === 'default') return undefined;
      try {
        const selected = find(await store.read(), name);
        const profile = await nativeProfiles.resolveProfile(client, selected);
        return createEnvironmentBinding({
          client, profileId: profile.profileId, surface: 'cli', executionLocation: 'local', rootMode: profile.rootMode,
          roots: { config: profile.home, reservation: profile.reservationRoot, user: profile.userHome, runtime: profile.home },
          workspace: null, executable: { path: profile.executable, identity: profile.executableIdentity, version: profile.version }, settingsIdentity: null,
        });
      } catch (error) {
        throw new UiError(422, error.message, 'copy-binding-unavailable');
      }
    }
    return { defaultUserHome, clientId: client, sourceBinding: await binding(from), targetBinding: await binding(target) };
  }

  async function copyCandidates(from, target, client, options) {
    let inventory, guidance = { items: [] };
    try {
      inventory = await inspectCopyProfile(store, from, { ...options, binding: options.sourceBinding, mainConversationsOnly: true });
      if (target && client === 'codex') guidance = await inspectSetupGuidance(store, from, target, { defaultUserHome });
    } catch (error) { throw new UiError(422, `Couldn’t read ${from}: ${error.message}`, 'inventory-failed'); }
    const copyable = inventory.items.filter(entry => entry.copyable === true && entry.status !== 'unsupported'
      && entry.scope !== 'project' && !['project', 'db', 'runtime', 'docs'].includes(entry.category));
    let endpointFingerprint = null;
    let planned = copyable.map(entry => ({ id: entry.id, label: entry.label, category: entry.category, status: 'new', changes: [] }));
    if (target && copyable.length) {
      try {
        const plan = await planCopy(store, from, target, { selection: copyable.map(entry => entry.id), ...options });
        planned = plan.items ?? []; endpointFingerprint = plan.endpointFingerprint;
      }
      catch (error) { throw new UiError(422, `Couldn’t prepare the preview: ${error.message}`, 'plan-failed'); }
    }
    const items = planned.filter(entry => !['identical', 'unchanged', 'kept'].includes(entry.status)).map(entry => {
      const source = copyable.find(item => item.id === entry.id);
      const described = describeChange({ ...entry, category: entry.category ?? source?.category }, target ?? 'the new profile');
      return { id: entry.id, name: entry.label ?? source?.label ?? entry.id, kind: described.kind, change: described.change, details: described.details,
        _category: source?.category, _scope: source?.scope,
        note: entry.status === 'conflict' ? `Differs in ${target}; ticking it replaces ${target}’s version.` : source?.category === 'skill' ? 'External tools it calls aren’t installed by copying.' : '',
        fingerprint: entry.fingerprint };
    });
    const manual = (guidance.items ?? []).filter(entry => entry.destinationStatus !== 'same').slice(0, 8)
      .map(entry => `${entry.label}: ${(entry.steps ?? [])[0] ?? 'Set it up in Codex if you want it there.'}`);
    if (!manual.length) manual.push(`Set up plugins, MCP servers and hooks in ${PROFILE_CLIENT_NAMES[client]} if you want them in this profile.`);
    const manualOptions = inventory.items.filter(entry => entry.setup === true).slice(0, 50)
      .map(entry => ({ id: entry.id, label: entry.label, steps: entry.steps }));
    return { items, manual, manualOptions, endpointFingerprint };
  }

  async function targetBlocked(target) {
    const home = (await listHomes(store)).find(item => item.name === target);
    if (!home?.home || home.state !== 'ready') return null;
    let instance = null;
    try { instance = (await desktopSurface.list({ ...lockOptions, observe: true })).instances.find(item => item.profileId === home.id) ?? null; } catch { /* unknown */ }
    const card = await observeClients(home.home, { desktopRunning: instance ? instance.observed?.status === 'running' : null });
    if (card.cli.state === 'running') return { title: `${target} is open in Codex CLI.`, body: `Changes can only be applied while it’s closed. Close ${target}’s Terminal session, then check again. Xenoflux never closes Codex or Terminal sessions for you.` };
    if (card.desktop.state === 'running') return { title: `${target} is open in Codex Desktop.`, body: `Changes can only be applied while it’s closed. Quit ${target}’s Codex Desktop, then check again.` };
    return null;
  }

  async function addExistingFolder(name, folder) {
    if (!plain(name)) throw new UiError(400, 'Enter a profile name.', 'invalid-name');
    if (typeof folder !== 'string' || !isAbsolute(folder.trim())) throw new UiError(400, 'Enter the Codex folder’s full path, starting with /.', 'invalid-path');
    let root;
    try { root = await realpath(folder.trim()); }
    catch { throw new UiError(404, 'That folder doesn’t exist or can’t be read.', 'invalid-path'); }
    let client;
    try { client = await resolveClient(); }
    catch (error) { throw new UiError(422, `Couldn’t find a Codex CLI: ${error.message}`, 'codex-missing'); }
    try { await registerHome(store, name.trim(), root, client); }
    catch (error) { throw new UiError(422, `${error.message}. Nothing was added.`, 'register-failed'); }
    return { status: 'applied', title: `Added ${name.trim()}`, changes: [], note: 'Xenoflux registered the folder as a profile. Its files weren’t moved or changed.', undo: null };
  }

  function clientActionsFor(name, clients, signIn) {
    const conflict = { title: `${name} is open in Codex CLI`, body: `A profile can’t run in Codex CLI and Codex Desktop at the same time. Finish and close ${name}’s Terminal session, then try again. Other profiles aren’t affected.` };
    if (clients.cli.state === 'running') return [{ id: 'show-terminal', label: 'Show Terminal' }, { id: 'open-desktop', label: 'Open Codex Desktop…', conflict }];
    if (clients.desktop.state === 'running') return [{ id: 'focus-desktop', label: 'Show Codex Desktop' }];
    if (signIn === 'No sign-in saved') return [{ id: 'signin', label: 'Open in Terminal to sign in…' }];
    return [{ id: 'open-terminal', label: 'Open in Terminal (Codex CLI)…' }, { id: 'open-desktop', label: 'Open Codex Desktop' }];
  }

  async function titleFor(ref, selection, saved) {
    if (saved) return saved.title;
    if (ref.startsWith('e.')) return 'Task comparison';
    if (!titles.has(ref) && selection?.l) {
      const row = await rowFor(selection.l).catch(() => null);
      if (row) titles.set(ref, row.title.slice(0, 200));
    }
    return selection?.t ?? titles.get(ref);
  }

  async function reportView(ref) {
    const { value, selection, saved, execution } = await comparisonFor(ref);
    const { subject, reviews } = subjectOf(value);
    const view = presentComparison(subject, { title: execution ? 'Task comparison' : await titleFor(ref, selection, saved), reviews, sameTaskLabel: selection?.t });
    const quote = text => `"${String(text).replace(/(["\\$`])/g, '\\$1')}"`;
    const left = subject.selection?.left, right = subject.selection?.right;
    const sameProfile = left?.profileName === right?.profileName && view.a.nativeClient === view.b.nativeClient;
    const setupSelection = left && right && new URLSearchParams({ a: left.profileName, b: right.profileName,
      ...(view.a.nativeClient && view.a.nativeClient !== 'codex' ? { aClient: view.a.nativeClient } : {}),
      ...(view.b.nativeClient && view.b.nativeClient !== 'codex' ? { bClient: view.b.nativeClient } : {}) });
    return { ...view, ref, breadcrumb: saved ? 'Open saved report' : execution ? 'Run progress' : 'Choose sessions',
      ...(execution ? { progressHref: `/runs/${execution}` } : {}),
      saved: saved ? { recordedAt: view.a.time, savedAt: saved.savedAt ?? 'date not recorded', notInReport: ['a', 'b'].filter(side => view.outcome.patches?.[side]?.status !== 'available').map(side => `Task-end patch content for ${view[side].profile}`) } : null,
      conditions: { ...view.conditions, setupHref: !saved && setupSelection && !sameProfile ? `/compare/setups?${setupSelection}` : null },
      verification: { ...view.verification, reviews: { text: view.verification.reviews.text,
        href: subject?.kind === 'audit-comparison' ? `/reports/${encodeURIComponent(ref)}/reviews` : null } },
      cliCommand: execution ? `xfx audit show ${execution}` : saved?.path ? `xfx audit show ${quote(saved.path)}`
        : `xfx audit diff --left-profile ${quote(left?.profileName ?? '')} --left-id ${left?.sessionId} --right-profile ${quote(right?.profileName ?? '')} --right-id ${right?.sessionId}${selection?.t ? ` --same-task ${quote(selection.t)}` : ''}${selection?.v?.length ? ` --variables ${quote(selection.v.join(','))}` : ''}`,
    };
  }

  function savedSummary(ref, entry) {
    const { subject, reviews } = subjectOf(entry.value);
    const view = presentComparison(subject, { title: entry.title, reviews });
    return { id: ref, title: entry.title, recordedAt: view.a.time, savedAt: entry.savedAt ?? 'date not recorded', ref,
      sides: savedIdentity(entry.value),
      kept: [{ label: 'Conditions, replay and measurements', value: 'Kept' },
        { label: 'Reviews attached earlier', value: reviews ? 'Kept, with reviewers and earlier revisions' : 'None attached' },
        { label: 'Evidence references', value: 'Kept; the original history isn’t read' },
        { label: 'Task-end patches', value: ['a', 'b'].map(side => `${view[side].profile}: ${view.outcome.patches?.[side]?.status === 'available' ? 'retained' : 'content unavailable'}`).join(' · ') }],
      cliCommand: entry.path ? `xfx audit show "${entry.path}"` : 'xfx audit show REPORT.md.audit.json' };
  }

  function register(value, { title, savedAt, path }) {
    const kind = value?.kind === 'audit-evaluation-report' ? value.subject?.kind : value?.kind;
    if (kind !== 'audit-comparison') throw new UiError(422, `This saved report is a ${String(value?.kind ?? 'unknown').replace(/^audit-/, '')}. Open it with xfx audit show; the app opens two-session comparisons.`, 'unsupported-kind');
    const ref = `f.${randomUUID()}`;
    opened.set(ref, { value, title, savedAt, path });
    while (opened.size > 20) opened.delete(opened.keys().next().value);
    return savedSummary(ref, opened.get(ref));
  }

  const provider = {
    apps: async () => {
      const result = await stockApps.list();
      return Array.isArray(result) ? { apps: result } : result;
    },
    async openApp(input) {
      try { return await stockApps.open(input); }
      catch (error) { throw new UiError(409, error.message, 'stock-app-unavailable'); }
    },
    catalog: catalogs.get,
    refreshCatalog: catalogs.refresh,
    cancelCatalog: catalogs.cancel,
    runOptions: runs.runOptions,
    runPreview: runs.runPreview,
    startRun: runs.startRun,
    run: runs.run,
    cancelRun: runs.cancelRun,
    respondRun: runs.respondRun,
    recoverRun: runs.recoverRun,
    previewReviewTask: reviewTasks.previewReviewTask,
    startReviewTask: reviewTasks.startReviewTask,
    reviewTask: reviewTasks.reviewTask,
    cancelReviewTask: reviewTasks.cancelReviewTask,
    respondReviewTask: reviewTasks.respondReviewTask,
    async close() {
      closing = true;
      const results = await Promise.allSettled([runs.close(), reviewTasks.close(), catalogs.close(), Promise.allSettled([...activeImports])]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
    },
    async info() {
      let desktop = { status: 'unavailable', nativeAcceptance: 'pending' };
      try { desktop = await desktopSurface.inspect(); } catch { /* Missing vendor app remains unavailable. */ }
      return { mode: 'engine', version, activeJobs: [...runs.activeJobs(), ...reviewTasks.activeJobs()], maxActiveJobs, activeRun: await runs.activeRun(),
        desktop,
        features: { runs: true, copy: true, create: true, clientControls: true, profileEdits: true } };
    },

    async overview() {
      const { homes, defaultHome } = await profileRecords();
      const count = homes.length + (defaultHome ? 1 : 0);
      let sessions = { status: 'none', text: 'No sessions found yet' };
      try {
        const { rows, homes: sources } = await sessionRows();
        const readable = sources.filter(home => home.status === 'ready').length;
        const unreadable = sources.length - readable;
        sessions = { status: unreadable ? 'partial' : rows.length ? 'ready' : 'none',
          text: `${rows.length >= 100 ? '100+' : rows.length} ${rows.length === 1 ? 'session' : 'sessions'} in ${readable} ${readable === 1 ? 'profile' : 'profiles'}${unreadable ? ` · ${unreadable} ${unreadable === 1 ? 'profile' : 'profiles'} couldn’t be read` : ''}` };
      } catch { sessions = { status: 'partial', text: 'Sessions couldn’t be read' }; }
      const recent = [...await runs.recent(), ...(await savedList()).slice(0, 5).map(entry => ({ kind: 'saved', title: entry.title, meta: `saved report · ${entry.savedAt}`, href: '/reports/open' }))].slice(0, 5);
      return { profileCount: count, readyToRun: homes.filter(home => home.state === 'ready').length, sessions, runs: { available: true, text: 'Review a task and two profiles before starting' },
        setups: { text: `${count} ${count === 1 ? 'profile' : 'profiles'} · read-only, nothing is copied, activated or signed in` }, recent };
    },

    async profiles() {
      const { homes, data, defaultHome } = await profileRecords();
      let instances = [];
      try { instances = (await desktopSurface.list({ ...lockOptions, observe: true })).instances; } catch { /* reported as unknown below */ }
      const byId = new Map(data.profiles.map(profile => [profile.id, profile]));
      const card = async ({ name, isDefault, home, root, state, reason, profile }) => {
        const instance = instances.find(item => item.profileId === profile?.id);
        const clients = state === 'ready' && home ? await observeClients(home, { desktopRunning: instance ? instance.observed?.status === 'running' : null })
          : { cli: { state: 'unknown', text: 'unknown' }, desktop: { state: 'unknown', text: 'unknown' } };
        let signIn = 'Sign-in unknown';
        try { if (home) { await lstat(join(home, 'auth.json')); signIn = 'Sign-in saved'; } }
        catch (error) { if (error.code === 'ENOENT') signIn = 'No sign-in saved'; }
        const repositories = profile?.repositories ?? [];
        return { name, client: 'codex', isDefault, state, reason, signIn,
          binding: isDefault ? 'your standard Codex setup' : repositories.length === 0 ? 'no project' : repositories.length === 1 ? `bound to ${basename(repositories[0].path)}` : `bound to ${repositories.length} projects`,
          summary: isDefault ? 'Your normal Codex setup. Other profiles can copy from it; nothing is copied into it.' : profile?.description || `Codex folder ${tilde(root ?? home ?? '')}`,
          cli: clients.cli, desktop: clients.desktop, clientActions: state === 'ready' ? clientActionsFor(name, clients, signIn) : [],
          moreMenu: isDefault ? null : [
            { id: 'copy', label: 'Copy settings from another profile…', detail: `Choose items, see exactly what changes in ${name}, undo later` },
            { id: 'binding', label: 'Change project binding…' },
            { id: 'rename', label: 'Rename…' },
            { id: 'remove', label: 'Remove from Xenoflux…', detail: 'Keeps the profile’s files on disk.',
              ...(clients.desktop.state === 'running' ? { disabledReason: 'Not available while its Desktop is open.' } : {}) },
          ] };
      };
      const cards = await Promise.all([
        ...(defaultHome ? [card({ name: 'Default', isDefault: true, home: defaultHome, state: 'ready', reason: null })] : []),
        ...homes.map(home => card({ name: home.name, isDefault: false, home: home.home, root: home.root, state: home.state, reason: home.reason, profile: byId.get(home.id) })),
      ]);
      for (const selected of data.profiles.filter(profile => profile.client && profile.client !== 'codex')) {
        const client = selected.client;
        let profile, setup, observation;
        try {
          profile = await nativeProfiles.resolveProfile(client, selected);
          setup = await nativeProfiles.setup(profile);
          observation = await nativeProfiles.observed(profile);
        } catch { /* Show the unavailable binding without offering native actions. */ }
        const ready = Boolean(setup);
        const accountScope = client === 'claude-code' ? 'per-root' : observation?.qualification ? 'shared' : 'unverified';
        const signIn = ({ 'signed-in': 'Signed in', 'signed-out': 'Signed out', unverified: 'Sign-in route unverified' })[observation?.state] ?? 'Sign-in not checked';
        const repositories = selected.repositories;
        cards.push({ name: selected.name, client, isDefault: false, state: ready ? 'ready' : 'unavailable',
          reason: ready ? null : 'The native root or executable no longer matches this binding.',
          signIn, accountScope, accountIndependence: 'not verified', setup,
          binding: repositories.length === 0 ? 'no project' : repositories.length === 1 ? `bound to ${basename(repositories[0].path)}` : `bound to ${repositories.length} projects`,
          summary: selected.description || `${PROFILE_CLIENT_NAMES[client]} folder ${tilde(selected.native?.configRoot ?? '')}`,
          cli: { state: 'unknown', text: 'Process state not checked' }, desktop: { state: 'unavailable', text: 'Unavailable' },
          clientActions: ready ? [{ id: 'check', label: 'Check sign-in' }] : [],
          moreMenu: [
            ...(ready ? [{ id: 'copy', label: 'Copy settings from another profile…' }] : []),
            { id: 'binding', label: 'Change project binding…' },
            { id: 'rename', label: 'Rename…' },
            { id: 'remove', label: 'Remove from Xenoflux…', detail: 'Keeps the profile’s files on disk.' },
          ] });
      }
      const copySources = Object.fromEntries(await Promise.all(PROFILE_CLIENTS.map(async client => [client, [
        ...((client === 'codex' ? !!defaultHome : await nativeProfiles.hasStock(client)) ? ['Default'] : []),
        ...cards.filter(card => card.client === client && card.state === 'ready' && !card.isDefault).map(card => card.name),
      ]])));
      return { profiles: cards, copySources, simulated: false,
        notes: ['Viewing profiles does not open a client. Checking sign-in asks the selected CLI for account status without starting a task.'] };
    },

    async sessions({ query, profile, client }) {
      const { rows, homes, truncated } = await sessionRows({ query, profile: plain(profile) ? profile : undefined, client: client || undefined });
      const unreadable = homes.filter(home => home.status !== 'ready');
      const { data, defaultHome } = await profileRecords();
      return {
        sessions: rows.map(({ updatedAt, ...row }) => row),
        profiles: [...(defaultHome ? ['Default'] : []), ...data.profiles.filter(p => !p.client || p.client === 'codex').map(p => p.name)],
        partial: unreadable.length ? { text: `${unreadable.map(home => `${home.profileName}’s history couldn’t be read${home.reason ? ` (${home.reason})` : ''}`).join('; ')}. Sessions from the other profiles are listed.`,
          help: 'macOS asks before an app reads some folders. If a profile lives in Documents, Desktop or Downloads, allow access for the terminal that runs xfx ui in System Settings › Privacy & Security › Files and Folders, then reload.' } : null,
        truncated };
    },

    async association({ left, right }) {
      const ref = `s.${encodeRef({ l: left, r: right })}`;
      const { value } = await comparisonFor(ref);
      const view = presentComparison(value);
      const basis = view.association.basis === 'recorded' ? 'recorded' : 'unknown';
      const [a, b] = await Promise.all([rowFor(left), rowFor(right)]);
      return { basis, title: ASSOCIATION[basis].title, text: view.association.text,
        suggestedVariables: view.conditions.rows.map(row => row.name), sides: { a, b } };
    },

    async compareSessions({ left, right, sameTask, variables, title }) {
      parseKey(left); parseKey(right);
      if (left === right) throw new UiError(400, 'Choose two different sessions.', 'invalid-selection');
      const selection = { l: left, r: right };
      if (typeof sameTask === 'string' && plain(sameTask)) selection.t = sameTask.trim();
      if (Array.isArray(variables)) { const v = variables.filter(plain).slice(0, 20); if (v.length) selection.v = v; }
      // Private declarations stay in process memory; only an opaque token enters the URL.
      const ref = selection.t ? `p.${randomUUID()}` : `s.${encodeRef(selection)}`;
      if (selection.t) privateSelections.set(ref, selection);
      const named = selection.t ?? (plain(title) ? title : undefined);
      if (named) titles.set(ref, named.slice(0, 200));
      await comparisonFor(ref);
      return { ref };
    },

    async setupComparison({ a, b, aClient = 'codex', bClient = 'codex' }) {
      if (!plain(a) || !plain(b) || !PROFILE_CLIENTS.includes(aClient) || !PROFILE_CLIENTS.includes(bClient)) throw new UiError(400, 'Choose two profiles.', 'invalid-selection');
      if (a === b && aClient === bClient) return { a: { name: a }, b: { name: b }, project: null, readAt: '', counts: { different: 0, same: 0, cannotCompare: 0 }, limits: null, groups: [], blocked: 'Choose two different profiles.' };
      const value = await setupFor(a, b, aClient, bClient);
      const view = presentSetupComparison(value, { home: homedir() });
      const mixed = value.comparison?.mode === 'separate';
      const native = aClient !== 'codex' || bClient !== 'codex';
      const describe = (name, client, profile) => ({ name, meta: `${PROFILE_CLIENT_NAMES[client]} CLI${native
        ? ` · ${(profile?.rootMode ?? (name === 'Default' ? 'implicit' : 'explicit')) === 'implicit' ? 'stock root' : 'managed root'} · local` : ''}` });
      const inventory = side => ({ status: side.status, warnings: side.warnings ?? [], resources: side.resources.map(resource => ({
        name: resource.name, category: resource.category, scope: resource.scope, origin: resource.origin, status: resource.status,
      })) });
      const target = a === 'Default' ? b : a, source = a === 'Default' ? a : b;
      const missingSourceState = source === a ? 'added' : 'removed';
      const href = id => `/profiles/${encodeURIComponent(target)}/copy?from=${encodeURIComponent(source)}&item=${encodeURIComponent(id)}`;
      const groups = view.groups.map(group => ({ ...group, items: group.items.map(item => ({ ...item, actions: {
        ...(!native && item.actions.copyable && item.exactState !== missingSourceState && target !== 'Default' ? { copy: { from: source === a ? 'a' : 'b', label: `Copy from ${source} into ${target}…`, href: href(item.id) } } : {}),
        ...(!native && item.actions.package ? { packageHref: `/compare/setups/skills/${encodeURIComponent(item.actions.package)}?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&item=${encodeURIComponent(item.id)}` } : {}),
        ...(!native && item.actions.guidance ? { guidance: item.actions.guidance } : {}),
      } })) }));
      return { a: describe(a, aClient, value.left.profile), b: describe(b, bClient, value.right.profile), project: null,
        readAt: `Today’s setup, read ${new Date(setups.get(setupKey(a, b, aClient, bClient)).at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
        counts: view.counts, limits: view.limits, groups,
        ...(mixed ? { separate: { reason: value.comparison.reason, a: inventory(value.left), b: inventory(value.right) } } : {}),
        ...(!mixed && native && target !== 'Default' ? { copyHref: `/profiles/${encodeURIComponent(target)}/copy?from=${encodeURIComponent(source)}` } : {}) };
    },

    async skillDetail({ skill, a, b, item: selectedItem }) {
      if (!plain(skill) || !plain(a) || !plain(b)) throw new UiError(400, 'Choose a skill and two profiles.', 'invalid-selection');
      const detail = presentSkillPackage(await setupFor(a, b), skill, { itemId: selectedItem });
      if (!detail) throw new UiError(404, `No skill named ${skill} was found in either profile.`, 'not-found');
      const target = a === 'Default' ? b : a, source = a === 'Default' ? a : b;
      const item = Buffer.from(['skill', '', '', '', skill].join('\u0000')).toString('base64url');
      return { ...detail, copy: target === 'Default' || !detail.copyable ? null : { label: `Copy ${source}’s version into ${target}…`,
        aToB: `Makes ${target}’s ${skill} match ${source}’s exactly: changed files are replaced, files only in ${target} are removed, and files only in ${source} are added.`,
        bToA: `Copying the other way is also possible from ${source}’s Profiles card. Either way the whole package is replaced, never merged, and you can undo it.`,
        href: `/profiles/${encodeURIComponent(target)}/copy?from=${encodeURIComponent(source)}&skill=${encodeURIComponent(skill)}&item=${encodeURIComponent(item)}` } };
    },

    async copyPlan({ target, from, item, skill }) {
      if (!plain(target) || !plain(from)) throw new UiError(400, 'Choose the two profiles.', 'invalid-selection');
      if (target.toLowerCase() === 'default') throw new UiError(400, 'Default can be copied from, not into.', 'invalid-target');
      if (target === from) throw new UiError(400, 'Choose a different profile to copy from.', 'invalid-selection');
      const client = find(await store.read(), target).client ?? 'codex';
      const options = await copyOptions(from, target, client);
      const { items, manual, manualOptions, endpointFingerprint } = await copyCandidates(from, target, client, options);
      const identity = originIdentity(item);
      const wanted = identity?.name ?? skill ?? null;
      const matches = wanted ? items.filter(entry => entry.name === wanted
        && (!identity?.category || entry._category === identity.category)
        && (!identity?.scope || entry._scope === identity.scope)) : [];
      const preselect = matches.length === 1 ? matches[0] : null;
      const blocked = await targetBlocked(target);
      const token = randomUUID();
      plans.set(token, { mode: 'copy', from, target, client, endpointFingerprint, manualOptions, changes: new Map(items.map(entry => [entry.id, entry.fingerprint])) });
      return { mode: 'copy', client, source: from, target, title: `Copy from ${from} into ${target}`,
        intro: `Only what you tick changes in ${target}. Everything else stays as it is, and nothing is deleted just because ${from} doesn’t have it.`,
        origin: preselect ? `Started from ${preselect.name} in the setup comparison. Tick more items if you want them too.`
          : wanted && matches.length > 1 ? `More than one item is named ${wanted}; choose the intended one.` : null,
        items: items.map(({ fingerprint, _category, _scope, ...entry }) => ({ ...entry, selected: entry.id === preselect?.id })), manual, manualOptions,
        never: ['Sign-in and credentials, conversation history, memory, trust and approvals, caches.'],
        blocked, planToken: token, simulated: false };
    },

    async copyApply({ target, from, items = [], manualItems = [], planToken }) {
      const reviewed = plans.get(planToken);
      if (!reviewed || reviewed.mode !== 'copy' || reviewed.target !== target || reviewed.from !== from) throw new UiError(409, 'This preview has expired. Review it again before applying.', 'changed');
      const guidance = selectedManual(reviewed, manualItems);
      if (!Array.isArray(items) || !items.length) throw new UiError(400, 'Choose at least one item.', 'nothing-selected');
      if (items.some(id => !reviewed.changes.has(id))) throw new UiError(400, 'Choose items from the preview.', 'invalid-selection');
      const options = await copyOptions(from, target, reviewed.client);
      const current = await planCopy(store, from, target, { selection: items, ...options });
      for (const entry of current.items ?? []) if (items.includes(entry.id) && reviewed.changes.get(entry.id) !== entry.fingerprint)
        throw new UiError(409, `${entry.label} changed since you reviewed it. Nothing was changed; review the preview again.`, 'changed');
      let result;
      try { result = await applyCopy(store, from, target, { selection: items, ...options, expectedHash: current.hash, expectedEndpointFingerprint: reviewed.endpointFingerprint,
        expectedItemFingerprints: Object.fromEntries(items.map(id => [id, reviewed.changes.get(id)])), runtime: copyRuntime(), ...lockOptions }); }
      catch (error) { throw copyError(error); }
      plans.delete(planToken);
      setups.clear();
      if (result.status === 'unchanged') return { status: 'applied', title: `Nothing to change in ${target}`, changes: [], note: 'The selected items already match.', undo: null };
      return { status: 'applied', title: `Copied into ${target}`, changes: (current.items ?? []).filter(entry => items.includes(entry.id)).map(entry => `${entry.label}: ${describeChange(entry, target).change}`),
        note: `Start a fresh conversation in ${target} to use the changes.`, guidance,
        undo: { id: result.id, explanation: 'Undo restores the replaced files and settings, including removed package files and their permissions. It refuses if you’ve edited them since.' } };
    },

    async copyUndo({ id }) {
      if (!UUID.test(id ?? '')) throw new UiError(400, 'Unknown copy.', 'invalid-selection');
      let preview;
      try { preview = await planUndo(store, id); }
      catch (error) { throw new UiError(409, `Can’t undo safely: ${error.message}. Nothing was changed.`, 'undo-refused'); }
      try { await undoCopy(store, id, { expectedHash: preview.hash, defaultUserHome, runtime: copyRuntime(), ...lockOptions }); }
      catch (error) {
        const mapped = copyError(error);
        if (mapped.code === 'client-open') throw mapped;
        throw new UiError(409, `Can’t undo safely: ${error.message}. Nothing was changed.`, 'undo-refused');
      }
      setups.clear();
      return { status: 'undone', title: 'Undone', changes: [], note: `${preview.target?.name ?? 'The profile'} is back to how it was before the copy.`, undo: null };
    },

    async createPlan({ name, from, client = 'codex' }) {
      if (!plain(name)) throw new UiError(400, 'Enter a name for the new profile.', 'invalid-name');
      if (!PROFILE_CLIENTS.includes(client)) throw new UiError(400, 'Choose a supported client.', 'invalid-client');
      const data = await store.read();
      if (data.profiles.some(profile => profile.name === name || profile.id === name) || name.toLowerCase() === 'default')
        throw new UiError(409, `A profile named ${name} already exists. Choose another name.`, 'name-taken');
      const source = plain(from) ? from : null;
      const options = await copyOptions(source, null, client);
      const candidates = source ? await copyCandidates(source, null, client, options) : { items: [], manual: [], manualOptions: [] };
      const verified = source ? await validateAdvancedSelection(store, source, candidates.items.map(entry => entry.id), { ...options, skipUnsafe: true }) : null;
      const exact = new Map(verified?.items.map(entry => [entry.id, entry]));
      const items = candidates.items.filter(entry => exact.has(entry.id)).map(entry => ({
        ...entry, ...describeChange(exact.get(entry.id), 'the new profile'),
      }));
      const manual = [...candidates.manual, ...candidates.items.filter(entry => !exact.has(entry.id))
        .map(entry => `${entry.name} couldn’t be prepared safely for copying and was left out.`)];
      let binary;
      try { if (client !== 'codex') binary = await nativeProfiles.binary(client); }
      catch (error) { throw new UiError(422, error.message, 'native-cli-missing'); }
      const token = randomUUID();
      plans.set(token, { mode: 'create', client, binary, from: source, target: name, changes: new Map(items.map(entry => [entry.id, entry.fingerprint])),
        sourceFingerprints: verified?.fingerprints, sourceEndpointFingerprint: verified?.sourceEndpointFingerprint, manualOptions: candidates.manualOptions });
      return { mode: 'create', client, executable: binary?.executable, source: source ?? '', target: name,
        title: source ? `Create ${name} from parts of ${source}` : `Create ${name}`,
        intro: source ? `${name} starts with only what you tick. ${source} isn’t changed.` : `${name} starts with an empty ${PROFILE_CLIENT_NAMES[client]} configuration.`,
        origin: null, items: items.map(({ fingerprint, _category, _scope, ...entry }) => ({ ...entry, selected: false })), manual, manualOptions: candidates.manualOptions,
        never: ['Sign-in and credentials, conversation history, memory, trust and approvals, caches.'], blocked: null, planToken: token, simulated: false };
    },

    async createApply({ name, from, client, items = [], manualItems = [], planToken, register, folder }) {
      if (register === true && (client === undefined || client === 'codex')) return addExistingFolder(name, folder);
      if (!plain(name)) throw new UiError(400, 'Enter a name for the new profile.', 'invalid-name');
      if (!Array.isArray(items) || new Set(items).size !== items.length) throw new UiError(400, 'Choose items from the preview.', 'invalid-selection');
      const reviewed = planToken ? plans.get(planToken) : { mode: 'create', client: 'codex', from: null, target: name, changes: new Map() };
      if (!reviewed || reviewed.mode !== 'create' || reviewed.target !== name || (client !== undefined && client !== reviewed.client)
        || (plain(from) && from !== reviewed.from)) throw new UiError(409, 'Review this profile preview again before creating.', 'changed');
      const guidance = selectedManual(reviewed, manualItems);
      if (items.length && (!reviewed.from || items.some(id => !reviewed.changes.has(id)))) throw new UiError(400, 'Choose items from the preview.', 'invalid-selection');
      const { client: selectedClient } = reviewed;
      let options;
      if (items.length) {
        try {
          options = await copyOptions(reviewed.from, null, selectedClient);
          const current = await validateAdvancedSelection(store, reviewed.from, items, options);
          if (current.sourceEndpointFingerprint !== reviewed.sourceEndpointFingerprint
            || items.some(id => reviewed.sourceFingerprints?.[id] !== current.fingerprints[id])) throw new Error('Copy source changed.');
        } catch {
          throw new UiError(409, 'The selected source changed after preview. Review it again before creating.', 'changed');
        }
      }
      const preview = await planHomeCreation({ store, name, base: profilesBase });
      if (preview.profile?.action !== 'create') throw new UiError(409, `A profile named ${name} already exists. Choose another name.`, 'name-taken');
      if (planToken) plans.delete(planToken);
      let profile;
      if (selectedClient === 'codex') {
        let binary;
        try { binary = await resolveClient(); }
        catch (error) { throw new UiError(422, `Couldn’t find a Codex CLI to create the profile with: ${error.message}`, 'codex-missing'); }
        await mkdir(dirname(profilesBase), { recursive: true, mode: 0o700 });
        await privateDirectory(profilesBase, true);
        profile = (await createHome({ store, name, base: profilesBase, ...binary })).profile;
      } else {
        try { profile = await nativeProfiles.createProfile(name, selectedClient, reviewed.binary); }
        catch (error) { throw new UiError(422, error.message, 'native-profile-preparation-failed'); }
      }
      const changes = [];
      let undo = null;
      if (items.length) {
        try {
          options = await copyOptions(reviewed.from, profile.id, selectedClient);
          const plan = await planCopy(store, reviewed.from, profile.id, { selection: items, ...options });
          const result = await applyCopy(store, reviewed.from, profile.id, { selection: items, ...options, expectedHash: plan.hash,
            expectedSourceEndpointFingerprint: reviewed.sourceEndpointFingerprint,
            expectedSourceFingerprints: Object.fromEntries(items.map(id => [id, reviewed.sourceFingerprints[id]])), runtime: copyRuntime(), ...lockOptions });
          changes.push(...(plan.items ?? []).map(entry => `${entry.label}: ${describeChange(entry, name).change}`));
          if (result.id) undo = { id: result.id, explanation: 'Undo removes the copied settings and files. The profile stays registered.' };
        } catch (error) {
          // Creation and copying are separate outcomes; a failed copy keeps the created profile.
          return { status: 'applied', title: `${name} created; its settings weren’t copied`, changes: [],
            note: `${copyError(error).message} You can review another copy from the profile card.`, undo: null };
        }
      }
      return { status: 'applied', title: `${name} created`, changes, guidance, undo,
        note: selectedClient === 'codex' ? 'It has its own settings and no sign-in yet. Use “Open in Terminal to sign in…” on its Profiles card.'
          : 'Open its Profiles card for the native setup command and sign-in check.' };
    },

    async profileAccount({ name, client }) {
      if (!plain(name) || !['claude-code', 'copilot'].includes(client))
        throw new UiError(400, 'Choose a Claude Code or Copilot CLI profile.', 'invalid-selection');
      try { return await nativeProfiles.check(name, client); }
      catch (error) { throw new UiError(422, error.message, 'native-account-check-failed'); }
    },

    async renameProfile({ name, newName }) {
      if (!plain(newName)) throw new UiError(400, 'Enter the new name.', 'invalid-name');
      if (name === 'Default') throw new UiError(400, 'Default can’t be renamed.', 'invalid-target');
      try { await editProfileRegistry(store, name, (data, profile) => renameInData(data, profile.id, newName.trim()), lockOptions); }
      catch (error) { throw new UiError(409, error.message, 'rename-failed'); }
      return { status: 'success', message: `Renamed ${name} to ${newName.trim()}. Its files, sign-in and history are unchanged.` };
    },

    async bindProfile({ name, repository }) {
      if (typeof repository !== 'string' || !isAbsolute(repository.trim())) throw new UiError(400, 'Enter the project folder’s full path, starting with /.', 'invalid-path');
      try { await editProfileRegistry(store, name, (data, profile) => bind(data, profile.id, repository.trim()), lockOptions); }
      catch (error) { throw new UiError(409, error.message, 'bind-failed'); }
      return { status: 'success', message: `Bound ${name} to ${basename(repository.trim())}.` };
    },

    async removeProfile({ name }) {
      if (name === 'Default') throw new UiError(400, 'Default can’t be removed.', 'invalid-target');
      try { await removeFromStore(store, name, lockOptions); }
      catch (error) { throw new UiError(409, `${error.message}. Nothing was removed.`, 'remove-failed'); }
      return { status: 'success', message: `Removed ${name} from Xenoflux. Its files are still on disk.` };
    },

    async clientAction({ name, action, session }) {
      const card = (await this.profiles()).profiles.find(profile => profile.name === name);
      if (card?.client && card.client !== 'codex') {
        if (action !== 'check') throw new UiError(400, 'Use the native command on the profile card.', 'invalid-action');
        const result = await this.profileAccount({ name, client: card.client });
        const text = result.state === 'signed-in' ? 'Signed in' : result.state === 'signed-out' ? 'Signed out' : 'Sign-in route unverified';
        return { status: 'success', message: `${name}: ${text}.` };
      }
      if (!card) throw new UiError(404, `Profile not found: ${name}`, 'not-found');
      const isDefault = name === 'Default';
      if (action === 'check') return { status: 'neutral', message: `Checked ${name} again.`, profile: card };
      if (['open-desktop', 'focus-desktop'].includes(action) && card.cli.state === 'running')
        throw new UiError(409, `${name} is open in Codex CLI. A profile can’t run in Codex CLI and Codex Desktop at the same time. Finish and close its Terminal session, then try again.`, 'client-conflict');
      if (['open-terminal', 'resume', 'signin'].includes(action) && card.desktop.state === 'running')
        throw new UiError(409, `${name} is open in Codex Desktop. Close it there first, or use Show Codex Desktop.`, 'client-conflict');
      try {
        if (action === 'open-terminal') await clientOps.openTerminal(card.signIn === 'No sign-in saved' ? ['profile', 'signin', name, '--apply'] : ['launch', name]);
        else if (action === 'signin') await clientOps.openTerminal(['profile', 'signin', name, '--apply']);
        else if (action === 'resume') { const { id } = parseKey(session); await clientOps.openTerminal(['resume', name, id]); }
        else if (action === 'show-terminal') await clientOps.showTerminal();
        else if (action === 'open-desktop') await (isDefault ? clientOps.openDefaultDesktop() : clientOps.openDesktop(name));
        else if (action === 'focus-desktop') await (isDefault ? clientOps.openDefaultDesktop() : clientOps.focusDesktop(name));
        else throw new UiError(400, 'Unknown client action.', 'invalid-action');
      } catch (error) {
        if (error instanceof UiError) throw error;
        throw new UiError(422, `Couldn’t ${action.replace('-', ' ')} for ${name}: ${error.message}`, 'client-failed');
      }
      const done = { 'open-terminal': `Opened a Terminal window for ${name}.`, signin: `Opened a Terminal window to sign in to ${name}.`, resume: `Opened the session in a Terminal window for ${name}.`,
        'show-terminal': 'Brought Terminal to the front.', 'open-desktop': `Opening Codex Desktop for ${name}.`, 'focus-desktop': `Brought ${name}’s Codex Desktop to the front.` }[action];
      return { status: 'success', message: done };
    },

    async report({ ref }) { return reportView(ref); },

    async evidence({ ref }) {
      const { value, saved, selection } = await comparisonFor(ref);
      const { subject } = subjectOf(value);
      return { ref, title: await titleFor(ref, selection, saved) ?? 'Session comparison', ...presentEvidence(subject) };
    },

    async reviews({ ref }) {
      const { value, saved, selection, comparisonFingerprint } = await comparisonFor(ref);
      const { subject, reviews } = subjectOf(value);
      const view = presentComparison(subject, { reviews });
      const presented = presentReviews(reviews, { a: view.a.profile, b: view.b.profile }, { a: subject.left?.id, b: subject.right?.id });
      const topics = replayCitationTopics(presented.topics, subject, ref);
      return { ref, title: await titleFor(ref, selection, saved), canPrepare: subject?.kind === 'audit-comparison',
        canImport: subject?.kind === 'audit-comparison' && value?.kind === 'audit-evaluation-report' && Boolean(value.reviewPacket), topics: topics.length
        ? topics : [{ title: 'This comparison', meta: 'No reviews', disagreement: null, notReviewed: true, reviews: [] }],
        hasReviews: Boolean(reviews?.reviews?.length),
        reviewOptions: await reviewTasks.reviewTaskOptions(),
        reviewTasks: (await reviewTasks.taskSummaries(comparisonFingerprint ?? buildAuditReviewPacket(subject).evidenceFingerprint)).tasks,
        consistency: 'Can’t be reviewed with one pair: consistency is unmeasured.', checksAfter: presented.checksAfter };
    },

    async previewReview({ ref, submission }) {
      if (!submission || typeof submission !== 'object' || Array.isArray(submission))
        throw new UiError(400, 'Choose a review submission JSON file.', 'invalid-review');
      const { value, selection, saved } = await comparisonFor(ref);
      const { subject } = subjectOf(value);
      if (subject?.kind !== 'audit-comparison') throw new UiError(422, 'Only a saved two-session comparison can receive a review.', 'unsupported-review-source');
      if (value?.kind !== 'audit-evaluation-report' || !value.reviewPacket)
        throw new UiError(409, 'Prepare a review packet from this exported evidence before importing a submission.', 'review-packet-required');
      let prepared;
      try { prepared = await previewAuditEvidence(store, value, submission); }
      catch (error) { throw new UiError(422, error.message, 'invalid-review'); }
      const view = presentComparison(prepared.report.subject, { title: await titleFor(ref, selection, saved), reviews: prepared.reviewState });
      const presented = presentReviews(prepared.reviewState, { a: view.a.profile, b: view.b.profile },
        { a: prepared.report.subject.left?.id, b: prepared.report.subject.right?.id });
      const token = randomUUID(), now = Date.now();
      for (const [key, draft] of reviewDrafts) if (draft.expiresAt <= now) reviewDrafts.delete(key);
      reviewDrafts.set(token, { ref, submission, evidenceFingerprint: prepared.packet.evidenceFingerprint, expiresAt: now + 10 * 60 * 1000 });
      while (reviewDrafts.size > 12) reviewDrafts.delete(reviewDrafts.keys().next().value);
      return { token, title: await titleFor(ref, selection, saved) ?? 'Session comparison',
        evidenceFingerprint: prepared.packet.evidenceFingerprint, claimScopes: prepared.packet.claimScopes,
        evidenceRefCount: prepared.packet.evidenceRefs.length, topics: replayCitationTopics(presented.topics, prepared.report.subject, ref),
        disagreement: presented.topics.find(topic => topic.disagreement)?.disagreement ?? null,
        consistency: 'Can’t be reviewed with one pair: consistency is unmeasured.' };
    },

    async saveReview({ ref, token }) {
      const draft = reviewDrafts.get(token);
      if (!draft || draft.ref !== ref || draft.expiresAt <= Date.now()) {
        reviewDrafts.delete(token);
        throw new UiError(409, 'This review preview expired. Choose the file again to review it.', 'review-preview-expired');
      }
      if (draft.saving) throw new UiError(409, 'This review is already being saved.', 'review-save-in-progress');
      draft.saving = true;
      let current;
      try { current = await comparisonFor(ref); }
      catch (error) { draft.saving = false; throw error; }
      const { value, selection, saved } = current;
      let prepared;
      try { prepared = await previewAuditEvidence(store, value, draft.submission); }
      catch (error) { draft.saving = false; throw new UiError(422, error.message, 'invalid-review'); }
      if (prepared.packet.evidenceFingerprint !== draft.evidenceFingerprint)
        { draft.saving = false; throw new UiError(409, 'The report evidence changed after preview. Review the current evidence again before saving.', 'review-source-changed'); }
      let evaluated;
      try { evaluated = await evaluateAuditEvidence(store, value, draft.submission); }
      catch (error) { draft.saving = false; throw new UiError(422, error.message, 'invalid-review'); }
      reviewDrafts.delete(token);
      const title = await titleFor(ref, selection, saved) ?? 'Session comparison';
      const savedAt = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      return register(evaluated, { title, savedAt, path: null });
    },

    async exportPlan({ ref }) {
      const report = await reportView(ref);
      const { value } = await comparisonFor(ref);
      const { reviews } = subjectOf(value);
      const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      const safe = text => text.replace(/[/:\\\p{Cc}]/gu, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Comparison';
      const slug = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'comparison';
      const folder = join(reportsRoot, `${safe(report.title)} — ${date}`);
      return { ref, title: report.title, folder: `${tilde(folder)}/`, name: slug, files: [`${slug}.md`, `${slug}.md.audit.json`],
        included: ['Recorded conditions', 'Replay events, relationships and source references when available; bodies only if selected below', 'Check results and definition metadata; commands and output only if selected below', 'Captured task-end patch metadata; patch text only if recorded content is selected', 'What each agent said', 'Reviews attached earlier, with their reviewers', 'Time and token measurements with their scope', 'What couldn’t be seen'],
        neverIncluded: ['Private internal reasoning', 'Credential stores or bulk memory archives'],
        replayAvailable: Boolean(report.replay?.a || report.replay?.b || ['a', 'b'].some(side => report.outcome.patches?.[side]?.status === 'available') || report.verification?.rows?.some(row =>
          [row.a, row.b].some(check => check?.definition.command !== null && check?.definition.command !== undefined || check?.output.status === 'retained'))),
        contentFiles: [], reviewedEvidence: Boolean(reviews?.reviews?.length),
        privacy: 'Recorded content can contain private prompts, source code, tool output and paths. Known secret patterns are redacted, but this cannot remove every secret. Replay retains up to 1 MiB per body and 16 MiB per workflow; task-end patches retain at most 256 KiB per side. Omissions remain explicit. Exports are limited to 64 MiB. Read the report before sharing it.' };
    },

    async exportReport({ ref, includeReplayContent = false, prepareReview = false }) {
      if (typeof includeReplayContent !== 'boolean' || typeof prepareReview !== 'boolean')
        throw new UiError(400, 'Choose whether to include recorded content and prepare a review packet.', 'invalid-content-choice');
      const plan = await this.exportPlan({ ref });
      const { value } = await comparisonFor(ref);
      const base = plan.folder.replace(/^~/, homedir()).replace(/\/$/, '');
      await mkdir(dirname(base), { recursive: true, mode: 0o700 });
      let folder;
      for (let n = 1; n <= 50; n++) {
        const candidate = n === 1 ? base : `${base} (${n})`;
        try { await mkdir(candidate, { mode: 0o700 }); folder = candidate; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      if (!folder) throw new UiError(409, 'Too many exports with this name already exist. Rename or move some first.', 'folder-taken');
      let result;
      let reviewPacket = null;
      let reviewPacketReport = null;
      try {
        let exportValue = value;
        if (prepareReview) {
          const scratch = join(store.directory, 'ui-review-packet', randomUUID());
          await mkdir(scratch, { recursive: true, mode: 0o700 });
          try {
            const projected = await exportAuditReport(value, { output: join(scratch, 'source.md'), format: 'markdown', includeReplayContent });
            const frozenProjection = await readAuditReport(projected.evidencePath);
            const prepared = await previewAuditEvidence(store, frozenProjection);
            exportValue = prepared.report;
            reviewPacket = prepared.packet;
            reviewPacketReport = prepared.report;
          } finally { await rm(scratch, { recursive: true, force: true }); }
        }
        result = await exportAuditReport(exportValue, { output: join(folder, plan.files[0]), format: 'markdown', includeReplayContent });
      }
      catch (error) {
        await rmdir(folder).catch(() => {});
        throw new UiError(500, error.message, 'export-failed');
      }
      const savedAt = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      let warning;
      try { await saveRecent({ id: randomUUID(), title: plan.title, savedAt, folder, jsonPath: result.evidencePath }); }
      catch { warning = 'Both files were saved, but Recent could not be updated. Use the folder location below to reopen them.'; }
      const reviewPacketRef = reviewPacketReport
        ? register(reviewPacketReport, { title: plan.title, savedAt, path: result.evidencePath }).ref : undefined;
      return { folder: `${tilde(folder)}/`, files: [basename(result.output), basename(result.evidencePath)], contentIncluded: 'not included',
        ...(warning ? { warning } : {}),
        replayContentIncluded: includeReplayContent && plan.replayAvailable ? 'included where available, with known secret patterns redacted' : 'not included',
        ...(reviewPacket ? { reviewPacketFingerprint: reviewPacket.evidenceFingerprint, reviewPacketRef } : {}) };
    },

    async savedReports() {
      const recent = await savedList();
      return { recent: await Promise.all(recent.slice(0, 10).map(async entry => {
        let sides = null;
        try { sides = savedIdentity(await readAuditReport(entry.jsonPath)); } catch { /* moved or legacy missing file: identity is unavailable */ }
        return { id: entry.id, title: entry.title, savedAt: `saved ${entry.savedAt}`, folder: tilde(entry.folder), sides };
      })) };
    },

    async openRecentReport({ id }) {
      const entry = (await savedList()).find(item => item.id === id);
      if (!entry) throw new UiError(404, 'That saved report isn’t in the recent list any more.', 'not-found');
      let value;
      try { value = await readAuditReport(entry.jsonPath); }
      catch { throw new UiError(422, `Couldn’t read ${tilde(entry.jsonPath)}. It may have been moved or changed; choose the file instead.`, 'unreadable'); }
      return register(value, { title: entry.title, savedAt: entry.savedAt, path: entry.jsonPath });
    },

    async openReport({ fileName = '', text }) {
      const name = basename(String(fileName));
      if (/\.md$/i.test(name)) throw new UiError(422, `Found ${name}, but not ${name}.audit.json`, 'json-missing', { markdown: name });
      if (typeof text !== 'string' || !text.trim()) throw new UiError(422, 'This file is empty. Choose the file ending in .audit.json.', 'unreadable');
      // Validate through the same reader as the CLI, from a private copy.
      const directory = join(store.directory, 'ui-open');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `${randomUUID()}.audit.json`);
      let value;
      try {
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        value = await readAuditReport(temporary);
      } catch (error) {
        throw new UiError(422, error.message.startsWith('Unsupported') ? error.message : 'This file isn’t a readable saved Xenoflux report. Choose the file ending in .audit.json.', 'unreadable');
      } finally { await rm(temporary, { force: true }); }
      return register(value, { title: name.replace(/\.md\.audit\.json$|\.audit\.json$|\.json$/i, '') || 'Saved report', savedAt: null, path: null });
    },
    async importListedComparison({ left, right } = {}) {
      if (closing) throw new UiError(409, 'The app is stopping.', 'stopping');
      if ([left, right].some(side => !side || typeof side !== 'object' || Object.keys(side).length !== 2
        || !PROFILE_CLIENTS.includes(side.client) || typeof side.token !== 'string' || !UUID.test(side.token))
        || left.token === right.token)
        throw new UiError(400, 'Choose two distinct sessions from their profile lists.', 'invalid-session-selection');
      const operation = (async () => {
        const id = randomUUID(), directories = [];
        await admission.acquire(id);
        try {
          const parent = join(store.directory, 'ui-imports');
          await privateDirectory(store.directory, true);
          await privateDirectory(parent, true);
          const a = await importListedSession(left.client, left.token, join(parent, randomUUID()), directories);
          const b = await importListedSession(right.client, right.token, join(parent, randomUUID()), directories);
          const value = compareAuditRuns(a, b);
          return register(value, { title: 'Imported native sessions', savedAt: null, path: null });
        } catch {
          for (const artifact of directories) {
            const current = await lstat(artifact.directory).catch(() => null);
            if (current?.dev === artifact.dev && current.ino === artifact.ino)
              await rm(artifact.directory, { recursive: true, force: true });
          }
          throw new UiError(422, 'A selected session or its profile context is no longer available. List sessions again in the original profile.', 'session-selection-unavailable');
        } finally { admission.release(id); }
      })();
      activeImports.add(operation);
      try { return await operation; }
      finally { activeImports.delete(operation); }
    },
    async codexSessions({ profile, limit = '30' } = {}) {
      if (!plain(profile) || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
        throw new UiError(400, 'Choose a Codex profile and a session limit from 1 to 100.', 'invalid-session-selection');
      try {
        const { entries, homes } = await listHistory(store, { profile, limit: Number(limit), defaultUserHome });
        if (!homes.some(home => ['ready', 'partial'].includes(home.status))) throw new Error('Unavailable history');
        const sessions = await Promise.all(entries.map(async entry => {
          const selection = await codexSessionIdentity(entry).catch(() => null);
          const token = selection ? randomUUID() : null;
          if (token) sessionSelections.codex.set(token, { selection, expiresAt: Date.now() + 20 * 60_000 });
          return { id: entry.id, title: entry.title, cwd: entry.cwd, modifiedAt: entry.updatedAt, token,
            surface: await recordedHistoryClient(entry.rolloutPath, entry.indexSource) };
        }));
        while (sessionSelections.codex.size > 1000) sessionSelections.codex.delete(sessionSelections.codex.keys().next().value);
        return { client: 'codex', profileId: homes[0].profileId, rootMode: homes[0].profileId === 'default' ? 'implicit' : 'explicit',
          executionLocation: 'local', sessions };
      } catch { throw new UiError(422, 'The selected Codex session list is unavailable.', 'codex-session-list-unavailable'); }
    },
    async copilotSessions({ profile: name, limit } = {}) {
      if (closing) throw new UiError(409, 'The app is stopping.', 'stopping');
      if (!plain(name) || limit !== undefined && (!/^\d{1,3}$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 100))
        throw new UiError(400, 'Choose a Copilot CLI profile and a session limit from 1 to 100.', 'invalid-copilot-profile');
      const operation = (async () => {
        const id = randomUUID();
        await admission.acquire(id);
        try {
          const profile = await resolveCopilotSource(name);
          const parent = join(store.directory, 'session-probes'), directory = join(parent, id);
          await privateDirectory(store.directory, true);
          await privateDirectory(parent, true);
          await mkdir(directory, { mode: 0o700 });
          const result = await withCopilotMetadata(name, profile, directory, lifecycle =>
            copilotRuntime.listSessions({ ...lifecycle, profile, workspace: profile.cwd, limit: limit === undefined ? undefined : Number(limit),
              stdoutPath: join(directory, 'native.stdout'), stderrPath: join(directory, 'native.stderr') }));
          const sessions = result.map(({ selection, ...row }) => {
            const token = randomUUID();
            copilotSelections.set(token, { name, selection, workspaceIdentity: profile.metadataWorkspaceIdentity, expiresAt: Date.now() + 20 * 60_000 });
            return { ...row, token };
          });
          while (copilotSelections.size > 1000) copilotSelections.delete(copilotSelections.keys().next().value);
          await rm(directory, { recursive: true, force: true });
          return { client: 'copilot', profileId: profile.profileId, rootMode: profile.rootMode, surface: profile.surface, executionLocation: profile.executionLocation, sessions };
        } catch {
          throw new UiError(422, 'The selected Copilot session list is unavailable.', 'copilot-session-list-unavailable');
        } finally { admission.release(id); }
      })();
      activeImports.add(operation);
      try { return await operation; }
      finally { activeImports.delete(operation); }
    },
    async importCopilotComparison({ left, right } = {}) {
      if (closing) throw new UiError(409, 'The app is stopping. Start it again before importing.', 'stopping');
      if ([left, right].some(selected => !selected || typeof selected !== 'object' || Array.isArray(selected)
        || Object.keys(selected).length !== 1 || !(['sessionId', 'token'].some(key =>
          Object.hasOwn(selected, key) && typeof selected[key] === 'string' && UUID.test(selected[key])))))
        throw new UiError(422, 'Choose two Copilot sessions or enter their existing session UUIDs.', 'invalid-copilot-import');
      if (Object.hasOwn(left, 'token') !== Object.hasOwn(right, 'token'))
        throw new UiError(422, 'Choose both Copilot sessions using the same selection method.', 'invalid-copilot-import');
      const operation = (async () => {
        const id = randomUUID(), directories = [];
        await admission.acquire(id);
        try {
          await privateDirectory(store.directory, true);
          const parent = join(store.directory, 'ui-imports');
          await privateDirectory(parent, true);
          const imported = [];
          for (const selected of [left, right]) {
            const directory = join(parent, randomUUID());
            let artifact;
            const options = { ...copilotImportContext, directory, onArtifactCreated: created => { artifact = created; } };
            if (Object.hasOwn(selected, 'token')) imported.push(await importListedSession('copilot', selected.token, directory, directories));
            else imported.push(await importCopilotTranscript(selected, options));
            if (artifact) directories.push(artifact);
          }
          const value = compareAuditRuns(imported[0], imported[1]);
          return { ...register(value, { title: 'Imported Copilot conversations', savedAt: null, path: null }), origin: 'copilot-import' };
        } catch {
          for (const artifact of directories) {
            const current = await lstat(artifact.directory).catch(() => null);
            if (current?.dev === artifact.dev && current.ino === artifact.ino)
              await rm(artifact.directory, { recursive: true, force: true });
          }
          throw new UiError(422, 'These local Copilot conversations could not be imported. No new session or model task was requested.', 'invalid-copilot-import');
        } finally { admission.release(id); }
      })();
      activeImports.add(operation);
      try { return await operation; }
      finally { activeImports.delete(operation); }
    },
    async claudeSessions({ profile: name, limit, offset } = {}) {
      if (closing) throw new UiError(409, 'The app is stopping.', 'stopping');
      if (!plain(name) || name.length > 200) throw new UiError(400, 'Choose a Claude Code profile.', 'invalid-claude-profile');
      const id = randomUUID();
      await admission.acquire(id);
      try {
        const profile = await resolveClaudeSource(name);
        const result = await listClaudeSessions(profile, { limit: limit === undefined ? undefined : Number(limit),
          offset: offset === undefined ? undefined : Number(offset) });
        const sessions = result.sessions.map(({ selection, ...row }) => {
          const token = row.importable ? randomUUID() : null;
          if (token) claudeSelections.set(token, { name, selection, expiresAt: Date.now() + 20 * 60_000 });
          return { ...row, token };
        });
        while (claudeSelections.size > 1000) claudeSelections.delete(claudeSelections.keys().next().value);
        return { client: 'claude-code', profileId: profile.profileId, rootMode: profile.rootMode, surface: profile.surface, executionLocation: profile.executionLocation, sessions, nextOffset: result.nextOffset };
      } catch {
        throw new UiError(422, 'The selected Claude Code session list is unavailable.', 'claude-session-list-unavailable');
      } finally { admission.release(id); }
    },
    async importClaudeComparison({ left, right } = {}) {
      if (closing) throw new UiError(409, 'The app is stopping. Start it again before importing.', 'stopping');
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
        throw new UiError(422, 'Choose both Claude Code transcript files.', 'invalid-claude-import');
      const operation = (async () => {
        const id = randomUUID(), directories = [];
        await admission.acquire(id);
        try {
          await privateDirectory(store.directory, true);
          const parent = join(store.directory, 'ui-imports');
          await privateDirectory(parent, true);
          const imported = [];
          for (const selected of [left, right]) {
            const directory = join(parent, randomUUID());
            const options = { directory, onArtifactCreated: artifact => directories.push(artifact) };
            if (Object.hasOwn(selected, 'token')) {
              if (Object.keys(selected).length !== 1) throw new Error('Invalid Claude session selection');
              imported.push(await importListedSession('claude-code', selected.token, directory, directories));
            } else imported.push(await importClaudeTranscript(selected, options));
          }
          const value = compareAuditRuns(imported[0], imported[1]);
          const summary = register(value, { title: 'Imported Claude Code conversations', savedAt: null, path: null });
          return { ...summary, origin: 'claude-code-import' };
        } catch {
          // Nothing is published until both bounded, isolated reads succeed.
          for (const artifact of directories) {
            const current = await lstat(artifact.directory).catch(() => null);
            if (current?.dev === artifact.dev && current.ino === artifact.ino)
              await rm(artifact.directory, { recursive: true, force: true });
          }
          throw new UiError(422, 'These files could not be imported as bounded Claude Code transcripts. No agent or model task was started.', 'invalid-claude-import');
        } finally { admission.release(id); }
      })();
      activeImports.add(operation);
      try { return await operation; }
      finally { activeImports.delete(operation); }
    },
  };
  return provider;
}
