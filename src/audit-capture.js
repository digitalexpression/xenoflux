// Live, bounded capture through the native Codex app-server JSON-RPC protocol.
// The adapter stores only allow-listed metadata; prompts, item payloads and
// server error strings remain in the private process transcript, never report.
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, lstat, realpath, rm } from 'node:fs/promises';
import { runAuditProcess } from './audit-process.js';
import { createAuditToolCapture } from './audit-tools.js';
import { createAuditHookCapture } from './audit-hooks.js';
import { startAuditTelemetry } from './audit-telemetry.js';
import { mergeAuditSkillTelemetry } from './audit-skill-usage.js';
import { assessUsageSequence, normalizeUsageSnapshot, nativeUsageAccounting, summarizeWorkflowUsage, summarizeTurnUsage, USAGE_FIELDS } from './audit-usage.js';
import { redactValue } from './redact.js';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLiteralSkillReadDetails } from './audit-skill-read.js';
import { nativeInstructionSourceContract, projectInstructionSources, compactInstructionSources } from './audit-instructions.js';
import { createResourceProvenance } from './audit-provenance.js';

const MAX_SKILLS = 5000;
const MAX_EVENTS = 20000;
const MAX_ITEMS = 10000;
const MAX_ARTIFACTS = 10000;
const MAX_OBSERVATIONS = 20000;
const MAX_LINKED_AGENTS = 64;
const MAX_PAGES = 100;
const METADATA_NATIVE_EVENTS = new Set(['thread/readState/changed', 'turn/moderationMetadata', 'turn/diff/updated',
  'item/agentMessage/delta', 'item/commandExecution/outputDelta']);
const CAPTURE_NATIVE_EVENTS = new Set(['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed',
  'item/started', 'item/completed', ...METADATA_NATIVE_EVENTS,
  'thread/tokenUsage/updated', 'mcpServer/startupStatus/updated', 'hook/started', 'hook/completed', 'error']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const safeText = (v, max = 160) => typeof v === 'string' && v.length <= max
  ? String(redactValue(v)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max) : undefined;
const idHash = v => createHash('sha256').update(String(v)).digest('hex').slice(0, 24);
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const validId = v => typeof v === 'string' && SAFE_ID.test(v);
const timestampFromNativeSeconds = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000
  ? new Date(value * 1000).toISOString() : null;
function nativePath(value, cwd = null) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
  let path = value;
  if (value.startsWith('file://')) {
    try { const url = new URL(value); if (url.search || url.hash) return null; path = fileURLToPath(url); }
    catch { return null; }
  }
  if (!path.startsWith('/')) { if (!cwd) return null; path = resolve(cwd, path); }
  return path.startsWith('/') ? path : null;
}
async function privateRuntimeDirectory(stdoutPath, requestedPath) {
  const base = await realpath(resolve(dirname(stdoutPath)));
  const baseInfo = await lstat(base);
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()
    || baseInfo.uid !== process.getuid() || (baseInfo.mode & 0o077))
    throw new Error('Audit process output directory is not private and canonical');
  const directory = resolve(requestedPath ?? join(base, 'runtime'));
  const rel = relative(base, directory);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Audit runtime directory must be a new child of its run directory');
  // Exclusive creation prevents a retry or symlink planted in an existing run
  // directory from directing native state into a profile or another run.
  await mkdir(directory, { mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory
    || info.uid !== process.getuid() || (info.mode & 0o077))
    throw new Error('Audit runtime directory is not private and canonical');
  const paths = { root: directory, sqlite: join(directory, 'sqlite'), logs: join(directory, 'logs'), tmp: join(directory, 'tmp') };
  for (const path of [paths.sqlite, paths.logs, paths.tmp]) {
    await mkdir(path, { mode: 0o700 });
    const child = await lstat(path);
    if (!child.isDirectory() || child.isSymbolicLink() || await realpath(path) !== path
      || child.uid !== process.getuid() || (child.mode & 0o077)) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw new Error('Audit runtime child directory is not private and canonical');
    }
  }
  return paths;
}

function isolatedNativeOptions(env, paths) {
  if (typeof env.HOME !== 'string' || typeof env.CODEX_HOME !== 'string')
    throw new Error('Audit native process requires explicit profile HOME and CODEX_HOME');
  const processEnv = { ...env, CODEX_SQLITE_HOME: paths.sqlite, TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp };
  // Values use JSON's quoted-string syntax, which is valid TOML basic-string
  // syntax and safely handles spaces and punctuation in private paths.
  const args = ['-c', `sqlite_home=${JSON.stringify(paths.sqlite)}`,
    '-c', `log_dir=${JSON.stringify(paths.logs)}`];
  return { env: processEnv, args };
}

function emptyUsage() {
  return { scope: 'per-agent-source-reported', last: null, total: null, snapshots: 0 };
}

function safeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const project = b => {
    if (!b || typeof b !== 'object') return null;
    const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens'];
    const result = {};
    for (const field of fields) result[field] = count(b[field]);
    return result;
  };
  return { last: project(raw.last), total: project(raw.total), modelContextWindow: count(raw.modelContextWindow) };
}

function skillProjection(skill, cwd, profileHome = null) {
  if (!skill || typeof skill !== 'object' || typeof skill.name !== 'string' || typeof skill.path !== 'string') return null;
  const scopeMap = { user: 'user', repo: 'project', system: 'system', admin: 'admin' };
  const nativeScope = scopeMap[skill.scope];
  if (!nativeScope) return null;
  const skillPath = nativePath(skill.path, nativePath(cwd));
  if (!skillPath) return null;
  const plugin = safeText(skill.pluginId, 120);
  const profileSkillsRoot = typeof profileHome === 'string' && isAbsolute(profileHome) ? resolve(profileHome, 'skills') : null;
  const absoluteSkillPath = resolve(skillPath);
  const profileRelative = profileSkillsRoot && absoluteSkillPath ? relative(profileSkillsRoot, absoluteSkillPath) : null;
  const isProfileSkill = !plugin && skill.scope === 'user' && profileRelative !== null
    && profileRelative !== '..' && !profileRelative.startsWith(`..${sep}`) && !isAbsolute(profileRelative);
  const scope = isProfileSkill ? 'profile' : nativeScope;
  return {
    id: idHash(`${skill.scope}\0${skill.pluginId ?? ''}\0${skillPath}`),
    name: safeText(skill.name, 120) ?? 'unknown-skill',
    origin: plugin ? 'plugin' : scope === 'project' ? 'repository' : scope === 'user' ? 'user' : scope,
    scope,
    nativeScope: skill.scope,
    path: safeText(skillPath, 512),
    ...(plugin ? { provider: plugin } : {}),
    enabled: skill.enabled === true,
    observations: [],
    catalogs: [{ source: 'skills/list', cwd: safeText(cwd, 512), agentId: null }],
  };
}

function eventProjection(method, p, index) {
  const threadId = validId(p?.threadId) ? p.threadId : undefined;
  const turnId = validId(p?.turnId) ? p.turnId : undefined;
  const at = Number.isFinite(p?.completedAtMs) ? p.completedAtMs : Number.isFinite(p?.startedAtMs) ? p.startedAtMs : null;
  const out = { kind: method, recordedAt: at, sourceLine: index };
  if (threadId) out.threadId = threadId;
  if (turnId) out.turnId = turnId;
  // Streaming text, command output, diffs and moderation/read-state payloads
  // stay private. Their known notification kind and item identity are enough
  // to explain activity without duplicating terminal items or token counters.
  if (METADATA_NATIVE_EVENTS.has(method)) {
    if (method === 'thread/readState/changed') delete out.turnId;
    if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(method)
      && validId(p?.itemId)) out.itemId = p.itemId;
    return out;
  }
  if (p?.item && typeof p.item === 'object') {
    const item = p.item;
    const type = safeText(item.type, 80);
    const itemId = validId(item.id) ? item.id : undefined;
    if (type) out.itemType = type;
    if (itemId) out.itemId = itemId;
    if (typeof item.status === 'string') out.status = safeText(item.status, 60);
    if (Number.isSafeInteger(item.exitCode)) out.exitCode = item.exitCode;
    // A collab link is accepted only from structured native metadata; the
    // prompt/description accompanying it is intentionally omitted.
    const call = item.collabAgentToolCall ?? item;
    const receivers = call?.receiverThreadIds;
    if (Array.isArray(receivers)) out.receiverThreadIds = receivers.filter(validId).slice(0, MAX_LINKED_AGENTS);
    const parent = call?.threadId ?? call?.senderThreadId;
    if (validId(parent)) out.parentThreadId = parent;
    const name = safeText(item.name ?? item.toolName, 100);
    if (name) out.toolName = name;
    if (typeof item.error === 'boolean') out.failed = item.error;
  }
  if (p?.turn && typeof p.turn === 'object') {
    out.turnId ??= validId(p.turn.id) ? p.turn.id : undefined;
    if (typeof p.turn.status === 'string') out.status = safeText(p.turn.status, 60);
  }
  if (p?.status && typeof p.status.type === 'string') out.status = safeText(p.status.type, 40);
  if (method === 'error') {
    if (typeof p?.willRetry === 'boolean') out.willRetry = p.willRetry;
    const info = p?.error?.codexErrorInfo;
    const allowed = new Set(['contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded','rateLimitExceeded','flexUnavailable',
      'serverOverloaded','cyberPolicy','misalignmentPolicyViolation','tooManyDenials','internalServerError','unauthorized','badRequest',
      'threadRollbackFailed','sandboxError','other']);
    if (typeof info === 'string' && allowed.has(info)) out.errorCode = info;
    else if (info && typeof info === 'object' && !Array.isArray(info)) {
      const tag = Object.keys(info).find(key => ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected',
        'responseTooManyFailedAttempts','activeTurnNotSteerable'].includes(key));
      if (tag) {
        out.errorCode = tag;
        const detail = info[tag];
        if (tag === 'activeTurnNotSteerable' && ['review','compact'].includes(detail?.turnKind)) out.turnKind = detail.turnKind;
        else if (Number.isSafeInteger(detail?.httpStatusCode) && detail.httpStatusCode >= 0 && detail.httpStatusCode <= 65535)
          out.httpStatusCode = detail.httpStatusCode;
      }
    }
  }
  return out;
}

function linkedAgentCandidates(item) {
  if (!item || typeof item !== 'object') return [];
  // Current Codex schemas can report delegated work as a sub-agent activity
  // item without the older collaboration tool-call receiver list. Keep only
  // the thread identifier; agentPath and any surrounding prose are ignored.
  if (item.type === 'subAgentActivity')
    return validId(item.agentThreadId) ? [item.agentThreadId] : [];
  const call = item.collabAgentToolCall ?? item;
  return Array.isArray(call?.receiverThreadIds) ? call.receiverThreadIds.filter(validId).slice(0, MAX_LINKED_AGENTS) : [];
}

/**
 * Run one task through an isolated native app-server process and retain a
 * privacy-projected evidence record. processOptions are passed to the shared
 * bounded runner; profile must already contain executable/env selection.
 */
export async function runAuditCapture({ profile, workspace, task, selectedSkills = [], sandbox = 'workspace-write', processOptions = {},
  onSession, onPhase, onTaskEnd, limits = {}, telemetryFactory = startAuditTelemetry } = {}) {
  if (!profile || typeof profile.executable !== 'string' || !profile.executable.startsWith('/')
    || typeof workspace !== 'string' || !workspace.startsWith('/') || typeof task !== 'string' || task.length === 0
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)
    || !processOptions.env || !processOptions.stdoutPath || !processOptions.stderrPath) {
    throw new TypeError('Invalid audit capture input');
  }
  const maxEvents = Math.min(MAX_EVENTS, limits.maxEvents ?? MAX_EVENTS);
  const maxItems = Math.min(MAX_ITEMS, limits.maxItems ?? MAX_ITEMS);
  const toolCapture = createAuditToolCapture({ maxInvocations: maxItems, maxServers: 1000 });
  const hookCapture = createAuditHookCapture({ maxInvocations: maxItems });
  const hookPackets = [];
  const run = {
    schemaVersion: 1, kind: 'audit-run', id: safeText(limits.id ?? randomUUID(), 80),
    profile: { profileId: safeText(profile.profileId, 100), profileName: safeText(profile.profileName, 100),
      home: safeText(profile.home, 512), userHome: safeText(profile.userHome, 512), environmentId: safeText(profile.environmentId, 100) },
    status: 'partial', reason: null, agents: [], events: [], turns: [], skills: [], instructionSources: [], usage: { observations: [] },
    metrics: { wallMs: null, processElapsedMs: null, toolsActiveIntervalMs: null, activeTime: 'unknown', waitingTime: 'unknown' },
    coverage: { timeline: 'partial', agents: 'partial', instructions: 'unavailable', skills: 'partial', skillInventory: 'partial', skillUsage: 'partial', usage: 'partial', workspaceDiff: 'unavailable', outcome: 'partial' },
    outcome: { status: 'unknown' }, artifacts: [], warnings: [],
  };
  const capture = { status: 'partial', capabilities: { appServerV2: 'unknown', skillsList: 'unknown', runtimeEvents: 'unknown', childHydration: 'unknown', skillUseObservability: 'partial' }, errors: [], byAgent: {}, byOrigin: {} };
  const provenance = createResourceProvenance({ workspace, profileHome: profile.home, userHome: profile.userHome });
  const updateProvenance = () => {
    run.resourceProvenance = provenance.snapshot();
    run.coverage.resourceProvenance = run.resourceProvenance.status;
  };
  updateProvenance();
  const startedAt = Date.now();
  let endedTaskAt = null, taskEndEvidence = null;
  let eventIndex = 0, itemCount = 0, capped = false;
  let observationCount = 0;
  const skillById = new Map();
  const comparisonPaths = new Map();
  const observationKeys = new Set();
  let taskEndPromise = null;
  const threadMap = new Map();
  const childCandidates = new Map();
  const pendingChildMessages = new Map();
  let pendingChildMessageCount = 0;
  const seenCompletedItems = new Set();
  const outgoing = [];
  const outgoingWaiters = [];
  const pending = new Map();
  const rpcEvidence = new WeakMap();
  const childNativeMetadata = new Map();
  const streamedAgentIds = new Set();
  const instructionContract = nativeInstructionSourceContract(profile.version);
  const instructionSnapshot = (agent, result, source, reason = null) => {
    const row = projectInstructionSources(result?.instructionSources, { agentId: agent.id,
      source, phase: source === 'thread/start' ? 'before-task' : 'after-task',
      sourceLine: result && rpcEvidence.get(result)?.sourceLine,
      workspace, profileHome: profile.home, userHome: profile.userHome,
      reason: instructionContract ? reason : 'unsupported-native-version' });
    run.instructionSources.push(row);
    return row;
  };
  const updateInstructionCoverage = () => {
    const summary = compactInstructionSources(run.instructionSources, { maxSources: 128 });
    run.coverage.instructions = summary.status;
    if (run.agents.some(agent => !summary.rows.some(row => row.agentId === agent.id)) || run.coverage.agents === 'partial')
      run.coverage.instructions = summary.rows.some(row => row.status !== 'unavailable') ? 'partial' : 'unavailable';
    capture.capabilities.instructionSources = run.coverage.instructions;
  };
  const notifications = [];
  const notificationWaiters = [];
  const rpcTimers = new Map();
  let sequence = 0;
  let rpcClosed = false;
  let captureStopped = false;
  let inputStarted = false;
  let settleInput;
  const inputSettled = new Promise(resolve => { settleInput = resolve; });
  const notify = () => {
    for (let i = 0; i < notificationWaiters.length;) {
      const waiter = notificationWaiters[i];
      const messageIndex = notifications.findIndex(waiter.predicate);
      if (messageIndex < 0) { i++; continue; }
      const [message] = notifications.splice(messageIndex, 1);
      notificationWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  };
  const pushOutgoing = line => { if (outgoingWaiters.length) outgoingWaiters.shift()({ value: line, done: false }); else outgoing.push(line); };
  const recordWarning = code => { if (!run.warnings.includes(code)) run.warnings.push(code); };
  const agentFor = (threadId, parentId = null, depth = 0, sessionId = null, cwd = null) => {
    if (!validId(threadId)) return null;
    if (threadMap.has(threadId)) return threadMap.get(threadId);
    if (run.agents.length >= MAX_LINKED_AGENTS + 1) { recordWarning('linked-agent-limit'); return null; }
    const agent = { id: threadId, parentId: validId(parentId) ? parentId : null, depth, role: threadId === rootThreadId ? 'root' : 'child',
      ...(validId(sessionId) ? { sessionId } : {}), ...(safeText(cwd, 512) ? { cwd: safeText(cwd, 512) } : {}) };
    threadMap.set(threadId, agent); run.agents.push(agent);
    run.usage[threadId] = emptyUsage(); capture.byAgent[threadId] = { events: 0, items: 0 };
    return agent;
  };
  let rootThreadId = null, rootTurnId = null, rootTerminalTurn = null;
  let rootSessionId = null;
  // Keep only bounded, structured IDs from startup ancestry notices when the
  // parent has not been admitted yet. These links are never ownership proof.
  const deferredStartupLinks = new Map();
  const addChildCandidate = (childId, parentId, parentTurnId) => {
    if (!validId(childId) || !threadMap.has(parentId) || childId === parentId || threadMap.has(childId)) return;
    deferredStartupLinks.delete(childId);
    if (childCandidates.size >= MAX_LINKED_AGENTS) { recordWarning('linked-agent-limit'); return; }
    if (!childCandidates.has(childId)) childCandidates.set(childId, { id: childId, parentId, parentTurnId: validId(parentTurnId) ? parentTurnId : null });
  };
  const deferStartupLink = (childId, parentId, parentTurnId) => {
    if (!validId(childId) || !validId(parentId) || childId === parentId || threadMap.has(childId) || childCandidates.has(childId)) return;
    if (threadMap.has(parentId)) { addChildCandidate(childId, parentId, parentTurnId); return; }
    if (deferredStartupLinks.has(childId)) return;
    if (childCandidates.size + deferredStartupLinks.size >= MAX_LINKED_AGENTS) {
      recordWarning('deferred-agent-link-limit'); return;
    }
    deferredStartupLinks.set(childId, { id: childId, parentId,
      parentTurnId: validId(parentTurnId) ? parentTurnId : null });
  };
  const promoteDeferredStartupLinks = parentId => {
    for (const [childId, link] of deferredStartupLinks) {
      if (link.parentId !== parentId) continue;
      deferredStartupLinks.delete(childId);
      addChildCandidate(link.id, link.parentId, link.parentTurnId);
    }
  };
  const addSkillInventory = (entries, agentId = null) => {
    for (const entry of entries ?? []) for (const raw of entry?.skills ?? []) {
      const projected = skillProjection(raw, entry.cwd, run.profile.home);
      if (!projected) continue;
      projected.catalogs[0].agentId = validId(agentId) ? agentId : null;
      let existing = skillById.get(projected.id);
      if (!existing && run.skills.length >= Math.min(MAX_SKILLS, limits.maxSkills ?? MAX_SKILLS)) {
        capped = true; recordWarning('skill-inventory-limit'); continue;
      }
      if (!existing) { run.skills.push(projected); skillById.set(projected.id, projected); }
      else if (!existing.catalogs.some(catalog => catalog.agentId === projected.catalogs[0].agentId && catalog.cwd === projected.catalogs[0].cwd))
        existing.catalogs.push(projected.catalogs[0]);
    }
    for (const entry of entries ?? []) for (const error of entry?.errors ?? [])
      if (error && typeof error === 'object') recordWarning('skills-origin-unavailable');
  };
  const comparisonPath = path => {
    if (comparisonPaths.has(path)) return comparisonPaths.get(path);
    let comparable = path;
    try { comparable = realpathSync.native(path); } catch {}
    comparisonPaths.set(path, comparable);
    return comparable;
  };
  const findSkill = (path, agentId) => {
    const comparablePath = comparisonPath(path);
    const candidates = run.skills.flatMap(skill => {
      if (!skill.catalogs?.some(catalog => catalog.agentId === agentId) || typeof skill.path !== 'string') return [];
      const canonicalSkillPath = comparisonPath(skill.path);
      const packageRoot = skill.path.replace(/\/SKILL\.md$/i, '');
      const canonicalRoot = comparisonPath(packageRoot);
      const isDefinition = comparablePath === canonicalSkillPath;
      const isResource = comparablePath.startsWith(`${canonicalRoot.replace(/\/$/, '')}${sep}`);
      return isDefinition || isResource ? [{ skill, canonicalSkillPath, canonicalRoot: canonicalRoot.replace(/\/$/, '') }] : [];
    }).sort((a, b) => b.canonicalRoot.length - a.canonicalRoot.length);
    if (!candidates.length) return null;
    const closest = candidates.filter(candidate => candidate.canonicalRoot === candidates[0].canonicalRoot);
    if (closest.length !== 1) { recordWarning('ambiguous-skill-read'); return null; }
    return closest[0].skill;
  };
  const consumeItem = (item, agentId, turnId, sourceLine, at, { emitEvent = true } = {}) => {
    if (!item || typeof item !== 'object') return;
    const rawType = typeof item.type === 'string' ? item.type : '';
    if (/^(?:CommandExecution|commandExecution)$/i.test(rawType)) {
      const cwd = nativePath(item.cwd);
      const actions = Array.isArray(item.commandActions) ? item.commandActions : Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
      const readActions = actions.filter(action => action && String(action.type ?? '').toLowerCase() === 'read' && typeof action.path === 'string');
      const literalCommand = parseLiteralSkillReadDetails(item.command);
      const literalTarget = literalCommand?.target ?? null;
      // file:// has meaning in native catalog/action metadata, but `cat`
      // treats it as an ordinary filesystem operand. Do not URI-decode the
      // executed command target when establishing direct-read evidence.
      const literalPath = cwd && literalTarget ? resolve(cwd, literalTarget) : null;
      const success = item.status === 'completed' && item.exitCode === 0;
      // Native .163 classifies absolute cat executables as unknown actions.
      // Accept that exact shape only when both the executed command and its
      // single native action independently parse as the same literal absolute
      // cat. No missing actions, compounds, expansions or failed reads qualify.
      const absoluteCommand = parseLiteralSkillReadDetails(item.command, { absoluteExecutableOnly: true });
      const unknownAction = actions.length === 1 && actions[0]?.type === 'unknown'
        ? parseLiteralSkillReadDetails(actions[0].command, { absoluteExecutableOnly: true }) : null;
      const absoluteCorroboration = absoluteCommand && unknownAction?.wrapper === 'direct' && cwd
        && resolve(cwd, unknownAction.target) === literalPath;
      const directSkill = success && (readActions.length === 1 || absoluteCorroboration) && literalPath ? findSkill(literalPath, agentId) : null;
      const directPath = directSkill ? literalPath : null;
      const observations = directSkill ? [{ path: directPath, skill: directSkill, direct: true }] : readActions.map(action => {
        const path = nativePath(action.path, cwd);
        const skill = path ? findSkill(path, agentId) : null;
        return skill ? { path, skill, direct: false } : null;
      }).filter(Boolean);
      for (const { path, skill, direct } of observations) {
        const kind = direct ? (comparisonPath(path) === comparisonPath(skill.path) ? 'definition-read-observed' : 'package-resource-read-observed') : 'resource-read-intent';
        const itemId = validId(item.id) ? item.id : null;
        const observationKey = `${agentId}\0${turnId ?? ''}\0${itemId ?? sourceLine ?? ''}\0${kind}\0${path}`;
        if (!observationKeys.has(observationKey) && observationCount < Math.min(MAX_OBSERVATIONS, limits.maxObservations ?? MAX_OBSERVATIONS)) {
          observationKeys.add(observationKey); observationCount++;
          skill.observations.push({ kind, agentId, turnId: validId(turnId) ? turnId : null, itemId, sourceLine,
            evidence: { source: direct ? 'app-server-command' : 'app-server-command-action', confidence: direct ? 'single-literal-cat-completed' : 'native-read-action', path: safeText(path, 512) ?? null,
              ...(direct ? { pathAuthority: 'literal-command-target', commandWrapper: literalCommand.wrapper,
                readCorroboration: readActions.length === 1 ? 'native-read-action' : 'native-unknown-absolute-cat' }
                : { directReadChecks: { singleLiteral: Boolean(literalTarget), pathMatches: Boolean(literalPath && literalPath === path), success, actionCount: readActions.length } }) } });
        } else if (!observationKeys.has(observationKey)) { capped = true; recordWarning('skill-observation-limit'); }
      }
      if (emitEvent && run.events.length < maxEvents) run.events.push({ kind: 'command-execution', agentId, turnId: validId(turnId) ? turnId : null,
        recordedAt: Number.isFinite(at) ? at : null, sourceLine,
        metadata: { operation: readActions.length || directSkill ? 'read' : 'command', status: safeText(item.status, 40) ?? 'unknown',
          exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : null, durationMs: count(item.durationMs) } });
    } else if (/^(?:FileChange|fileChange)$/i.test(rawType)) {
      const changes = Array.isArray(item.changes) ? item.changes
        : item.changes && typeof item.changes === 'object' ? Object.entries(item.changes).map(([path, detail]) => ({ path, detail })) : [];
      const available = Math.max(0, Math.min(MAX_ARTIFACTS, limits.maxArtifacts ?? MAX_ARTIFACTS) - run.artifacts.length);
      const retained = changes.slice(0, Math.min(100, available));
      if (changes.length > retained.length) { capped = true; recordWarning('file-change-limit'); }
      for (const change of retained) {
        const path = typeof change?.path === 'string' ? safeText(change.path, 512) : undefined;
        const detail = change?.detail;
        const artifact = { kind: 'recorded-file-change', path: path ?? null, status: safeText(change?.kind ?? change?.type ?? detail?.kind ?? detail?.type ?? item.status, 48) ?? 'unknown',
          agentId, turnId: validId(turnId) ? turnId : null, sourceLine };
        const duplicate = run.artifacts.some(existing => existing.agentId === agentId && existing.turnId === artifact.turnId && existing.path === artifact.path && existing.status === artifact.status);
        if (!duplicate && run.artifacts.length < Math.min(MAX_ARTIFACTS, limits.maxArtifacts ?? MAX_ARTIFACTS)) run.artifacts.push(artifact);
        else if (!duplicate) { capped = true; recordWarning('artifact-limit'); }
      }
    }
  };
  const addEvent = (method, params, sourceLine, observedAtMs = null) => {
    if (eventIndex >= maxEvents) { capped = true; recordWarning('event-limit'); return; }
    eventIndex++;
    const tid = params?.threadId;
    if (!validId(tid) || !threadMap.has(tid)) return;
    if (method === 'hook/started' || method === 'hook/completed') {
      // A thread-scoped hook can explicitly have no turn. Never assign the
      // currently active turn merely because its notification arrived nearby.
      const turnId = validId(params.turnId) ? params.turnId : null;
      const hookRun = params.run && typeof params.run === 'object' ? Object.fromEntries(
        ['id', 'eventName', 'handlerType', 'executionMode', 'scope', 'status', 'source', 'startedAt', 'completedAt', 'durationMs']
          .filter(key => Object.hasOwn(params.run, key)).map(key => [key, params.run[key]])) : null;
      hookPackets.push({ phase: method === 'hook/started' ? 'started' : 'completed',
        agentId: tid, turnId: params.turnId ?? null, run: hookRun, source: method, sourceLine });
      run.events.push({ kind: method, agentId: tid, turnId, recordedAt: null,
        sourceLine: sourceLine ?? null, ...(Number.isSafeInteger(observedAtMs) ? { observedAtMs } : {}) });
      capture.byAgent[tid].events++;
      return;
    }
    if (!CAPTURE_NATIVE_EVENTS.has(method)) {
      recordWarning('unknown-native-event');
      run.events.push({ kind: 'unknown-native-event', agentId: tid, turnId: threadMap.get(tid).currentTurnId ?? null,
        recordedAt: null, sourceLine: sourceLine ?? null });
      capture.byAgent[tid].events++;
      return;
    }
    const event = eventProjection(method, params, sourceLine ?? null);
    if (Number.isSafeInteger(observedAtMs)) event.observedAtMs = observedAtMs;
    event.agentId = tid;
    if (method !== 'thread/readState/changed') event.turnId ??= threadMap.get(tid).currentTurnId;
    if (event.turnId && !validId(event.turnId)) delete event.turnId;
    run.events.push(event);
    capture.byAgent[tid].events++;
    if (method === 'thread/status/changed') {
      const status = params?.status?.type;
      threadMap.get(tid).terminal = status === 'idle' || status === 'systemError';
      if (status === 'systemError') recordWarning('linked-child-system-error');
    }
    if (method === 'mcpServer/startupStatus/updated')
      toolCapture.consumeMcpStatus({ params, agentId: tid, sourceLine });
    if (method === 'turn/started' && params?.turn?.id && validId(params.turn.id)) {
      threadMap.get(tid).currentTurnId = params.turn.id;
      const existing = run.turns.find(turn => turn.agentId === tid && turn.turnId === params.turn.id);
      if (!existing?.observedCompletedAt) threadMap.get(tid).terminal = false;
      // turn/start can resolve before this notification. Merge its placeholder,
      // and never regress a terminal turn when a late start is delivered.
      if (existing) {
        existing.observedStartedAt ??= new Date(observedAtMs ?? Date.now()).toISOString();
        if (!existing.observedCompletedAt) existing.status = safeText(params.turn.status, 60) ?? 'in-progress';
      } else run.turns.push({ agentId: tid, turnId: params.turn.id, status: safeText(params.turn.status, 60) ?? 'in-progress', observedStartedAt: new Date(observedAtMs ?? Date.now()).toISOString() });
    }
    if (method === 'turn/completed' && validId(params?.turn?.id)) {
      if (tid === rootThreadId) threadMap.get(tid).terminal = true;
      const turn = run.turns.find(t => t.agentId === tid && t.turnId === params.turn.id);
      const completedAt = new Date(observedAtMs ?? Date.now()).toISOString();
      if (turn) { turn.status = safeText(params.turn.status, 60) ?? 'completed'; turn.observedCompletedAt ??= completedAt; }
      else run.turns.push({ agentId: tid, turnId: params.turn.id,
        status: safeText(params.turn.status, 60) ?? 'completed', observedCompletedAt: completedAt });
      if (tid === rootThreadId) rootTerminalTurn = params.turn;
      if (tid === rootThreadId && (!rootTurnId || params.turn.id === rootTurnId) && !endedTaskAt) {
        endedTaskAt = Date.now();
        run.outcome = { status: 'native-claim', nativeTurnStatus: safeText(params.turn.status, 60) ?? 'completed', acceptance: 'not-checked' };
      }
    }
    if (method === 'item/completed' || method === 'item/started') {
      itemCount++;
      if (itemCount > maxItems) { capped = true; recordWarning('item-limit'); }
      else capture.byAgent[tid].items++;
      const itemId = validId(params?.item?.id) ? params.item.id : null;
      const itemKey = itemId ? `${tid}\u0000${event.turnId ?? ''}\u0000${itemId}\u0000${method}` : null;
      if (itemCount <= maxItems) toolCapture.consumeItem({ item: params.item, agentId: tid, turnId: event.turnId,
        phase: method === 'item/completed' ? 'completed' : 'started', source: 'item-lifecycle', sourceLine,
        startedAtMs: params.startedAtMs, completedAtMs: params.completedAtMs, observedAtMs });
      if (method === 'item/completed' && itemKey) seenCompletedItems.add(itemKey);
      if (method === 'item/completed' && itemCount <= maxItems)
        consumeItem(params.item, tid, event.turnId, sourceLine, event.recordedAt);
      const receivers = linkedAgentCandidates(params.item);
      for (const childId of receivers) addChildCandidate(childId, tid, event.turnId);
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = safeUsage(params.tokenUsage);
      if (usage) {
        const slot = run.usage[tid] ?? (run.usage[tid] = emptyUsage());
        slot.last = usage.last; slot.total = usage.total; slot.snapshots++;
        run.usage.observations.push(normalizeUsageSnapshot({ agentId: tid, turnId: event.turnId ?? null,
          source: method, sourceLine: event.sourceLine, recordedAt: event.recordedAt,
          last: params.tokenUsage?.last, total: params.tokenUsage?.total,
          modelContextWindow: params.tokenUsage?.modelContextWindow }));
        event.usage = usage;
      }
    }
  };
  const onEvent = async packet => {
    const observedAtMs = Date.now();
    if (captureStopped) return;
    if (packet.stream !== 'stdout') return;
    if (packet.parseError) { recordWarning('invalid-app-server-json'); return; }
    const message = packet.value;
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = pending.get(String(message.id));
      if (waiter) {
        if (message.result && typeof message.result === 'object') rpcEvidence.set(message.result, { sourceLine: packet.lineNumber });
        pending.delete(String(message.id)); waiter(message);
      }
      else recordWarning('unmatched-rpc-response');
      return;
    }
    if (typeof message.method !== 'string' || !message.params || typeof message.params !== 'object') return;
    const p = message.params;
    // A direct actor event proves the sole initialized audit connection has
    // that actor's listener. Keep it open across loaded-child snapshots so the
    // native zero-subscriber idle-unload timer cannot cold-reconstruct a child.
    if (['turn/started', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(message.method) && validId(p.threadId))
      streamedAgentIds.add(p.threadId);
    if (['hook/started', 'hook/completed', 'thread/tokenUsage/updated'].includes(message.method) && !validId(p.threadId)) {
      recordWarning('invalid-native-event-ownership');
      return;
    }
    // Startup notifications may precede thread creation and have no threadId.
    // They describe this owned app-server process, never a guessed agent.
    if (message.method === 'mcpServer/startupStatus/updated' && !validId(p.threadId)) {
      if (eventIndex++ >= maxEvents) { capped = true; recordWarning('event-limit'); }
      else toolCapture.consumeMcpStatus({ params: p, source: 'app-server-process', sourceLine: packet.lineNumber });
      return;
    }
    if (message.method === 'thread/started' && validId(p.thread?.id)) {
      const parentId = p.thread.parentThreadId ?? p.parentThreadId;
      // Notifications may arrive parent-first, child-first, or before the
      // parent has been admitted. Retain bounded ID-only edges and promote
      // them only after their parent is independently verified below.
      deferStartupLink(p.thread.id, parentId, p.parentTurnId);
    }
    if (message.method === 'turn/started' && validId(p.threadId) && threadMap.has(p.threadId) && validId(p.turn?.id))
      threadMap.get(p.threadId).currentTurnId = p.turn.id;
    if (validId(p.threadId) && !threadMap.has(p.threadId)) {
      // A child's first event can precede the collaboration/startup link.
      // Keep bounded source evidence until ownership is corroborated; never
      // silently drop it and later call the owned tree complete.
      if (CAPTURE_NATIVE_EVENTS.has(message.method)) {
        const waiting = pendingChildMessages.get(p.threadId) ?? [];
        if (pendingChildMessageCount < maxEvents && (pendingChildMessages.has(p.threadId) || pendingChildMessages.size < MAX_LINKED_AGENTS)) {
          waiting.push({ message, lineNumber: packet.lineNumber, observedAtMs });
          pendingChildMessageCount++;
          pendingChildMessages.set(p.threadId, waiting);
        }
        else { capped = true; recordWarning('pending-child-event-limit'); }
      }
      if (notifications.length < MAX_EVENTS) { notifications.push(message); notify(); }
      return;
    }
    addEvent(message.method, p, packet.lineNumber, observedAtMs);
    if (notifications.length < MAX_EVENTS) { notifications.push(message); notify(); }
    else { capped = true; recordWarning('notification-limit'); }
  };
  const request = async (method, params, timeoutMs = 30000) => {
    if (captureStopped) throw new Error('capture-stopped');
    const id = ++sequence;
    const key = String(id);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); rpcTimers.delete(key); reject(new Error(`rpc-timeout:${method}`)); }, timeoutMs);
      pending.set(key, message => {
        clearTimeout(timer); rpcTimers.delete(key);
        if (message.error) {
          const error = new Error(`rpc-error:${method}`);
          if (Number.isSafeInteger(message.error.code)) error.rpcCode = message.error.code;
          reject(error);
        } else resolve(message.result);
      });
      rpcTimers.set(key, timer);
    });
    pushOutgoing(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return response;
  };
  const takeNotification = (predicate, timeoutMs = 30000) => {
    if (captureStopped) return Promise.resolve(null);
    const i = notifications.findIndex(predicate);
    if (i >= 0) return Promise.resolve(notifications.splice(i, 1)[0]);
    return new Promise(resolve => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = notificationWaiters.indexOf(waiter);
        if (index >= 0) notificationWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      notificationWaiters.push(waiter);
    });
  };
  const input = (async function* () {
    inputStarted = true;
    try {
      // Paginated history and bounded child-item hydration require the native
      // experimental API opt-in; this is scoped to this connection.
      const initialized = await request('initialize', { clientInfo: { name: 'xfx-audit', title: 'Xenoflux Audit', version: '1' }, capabilities: { experimentalApi: true } });
      capture.capabilities.appServerV2 = initialized ? 'available' : 'partial';
      pushOutgoing(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
      await onPhase?.('discovery');
      let skillsResult;
      try { skillsResult = await request('skills/list', { cwds: [workspace], forceReload: false }); }
      catch { capture.capabilities.skillsList = 'unavailable'; recordWarning('skills-list-unavailable'); }
      if (skillsResult && Array.isArray(skillsResult.data)) {
        capture.capabilities.skillsList = 'available';
        addSkillInventory(skillsResult.data);
      }
      const names = Array.isArray(selectedSkills) ? selectedSkills.filter(x => typeof x === 'string') : [];
      for (const name of names) {
        const matches = run.skills.filter(s => s.name === name && s.enabled);
        if (matches.length !== 1) {
          capture.errors.push({ code: matches.length ? 'ambiguous-skill-selection' : 'unknown-skill-selection', name: safeText(name, 120) });
          run.status = 'unavailable'; run.reason = 'Selected skill could not be resolved uniquely';
          run.coverage.skills = capture.capabilities.skillsList === 'available' ? 'complete' : 'partial';
          return;
        }
      }
      const structuredSelections = names.map(name => run.skills.find(s => s.name === name && s.enabled));
      await onPhase?.('task');
      // The owned app-server already runs in this private checkout. An explicit
      // thread/start cwd makes native writable startup persist project trust in
      // the saved profile. Inherit the process cwd instead, preserving native
      // trust/config/managed-policy decisions, and verify it before any task.
      const started = await request('thread/start', { ephemeral: false, experimentalRawEvents: false,
        sandbox, approvalPolicy: 'never', historyMode: 'paginated' });
      const nativeCwds = [started?.cwd, started?.thread?.cwd].filter(cwd => cwd !== undefined);
      if (!nativeCwds.length || nativeCwds.some(cwd => nativePath(cwd) !== nativePath(workspace))) {
        recordWarning('native-workspace-mismatch');
        throw new Error('thread-start-workspace-mismatch');
      }
      if (capture.observer?.runtime) capture.observer.runtime.workspace = 'verified-process-cwd';
      rootThreadId = started?.thread?.id;
      if (!validId(rootThreadId)) throw new Error('thread-start-missing-id');
      rootSessionId = validId(started?.thread?.sessionId) ? started.thread.sessionId : null;
      agentFor(rootThreadId, null, 0, rootSessionId, workspace);
      for (const skill of run.skills) for (const catalog of skill.catalogs ?? []) if (!catalog.agentId) catalog.agentId = rootThreadId;
      await provenance.observeCatalog(capture.capabilities.skillsList === 'available' ? run.skills : null,
        { agentId: rootThreadId, phase: 'before-task', cwd: workspace });
      if (run.warnings.some(w => ['skills-origin-unavailable', 'skill-inventory-limit'].includes(w)))
        await provenance.observeCatalog(null, { agentId: rootThreadId, phase: 'before-task', cwd: workspace });
      updateProvenance();
      capture.capabilities.runtimeEvents = 'available';
      const rootAgent = threadMap.get(rootThreadId);
      instructionSnapshot(rootAgent, started, 'thread/start');
      rootAgent.model = safeText(started.model, 100);
      rootAgent.reasoningEffort = safeText(started.reasoningEffort, 40);
      run.source = { kind: 'native-app-server-v2', version: safeText(profile.version, 100), threadId: rootThreadId,
        model: safeText(started.model, 100), reasoningEffort: safeText(started.reasoningEffort, 40), workspace: safeText(workspace, 512),
        persistence: 'native-owned-session', historyMode: 'paginated', freshThread: true };
      // Verified only for the exact native release in the source receipt. Its
      // paginated child-spawn paths also start independent usage counters.
      // Historical/legacy histories and other native versions remain unknown.
      run.usage.accounting = nativeUsageAccounting(profile.version);
      capture.checkpoint = 'native-session-started';
      updateInstructionCoverage();
      try { await onSession?.(run, capture); }
      catch {
        recordWarning('session-checkpoint-failed');
        run.status = 'partial'; capture.status = 'partial';
        run.reason = 'Could not checkpoint the native session before task start';
        return;
      }
      const turnResponse = await request('turn/start', { threadId: rootThreadId, cwd: workspace,
        sandboxPolicy: sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
          : sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
            : { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        approvalPolicy: 'never', input: [{ type: 'text', text: task }, ...structuredSelections.map(skill => ({ type: 'skill', name: skill.name, path: skill.path }))] }, processOptions.timeoutMs ?? 300000);
      rootTurnId = turnResponse?.turn?.id;
      if (!validId(rootTurnId)) throw new Error('turn-start-missing-id');
      if (rootTerminalTurn?.id !== rootTurnId) { endedTaskAt = null; run.outcome = { status: 'unknown', acceptance: 'not-checked' }; }
      threadMap.get(rootThreadId).currentTurnId = rootTurnId;
      for (const skill of structuredSelections) skill.observations.push({ kind: 'native-selection-accepted', agentId: rootThreadId, turnId: rootTurnId, evidence: 'structured turn/start skill input' });
      if (!run.turns.some(t => t.agentId === rootThreadId && t.turnId === rootTurnId)) run.turns.push({ agentId: rootThreadId, turnId: rootTurnId, status: 'in-progress', observedStartedAt: new Date().toISOString() });
      // Capture notifications until root terminal state, then boundedly hydrate
      // only child IDs positively linked by native collaboration metadata.
      const completionWait = limits.completionWaitMs ?? processOptions.timeoutMs ?? 300000;
      const deadline = Date.now() + completionWait;
      let complete = false;
      while (!complete && Date.now() < deadline && !capped && !captureStopped) {
        const remaining = deadline - Date.now();
        const message = await takeNotification(m => m?.params?.threadId === rootThreadId && m.method === 'turn/completed'
          && m.params?.turn?.id === rootTurnId, Math.min(remaining, 1000));
        if (message) complete = true;
      }
      if (captureStopped) return;
      if (!complete) { recordWarning('root-turn-completion-missing'); capture.capabilities.runtimeEvents = 'partial'; }
      await onPhase?.('capture');
      // Receiver IDs and thread/started metadata are candidates only. Admit a
      // child after thread/read corroborates exact ID, parent, and root session.
      const verifiedChildren = [];
      const processedCandidates = new Set();
      const admitCandidates = async () => {
        while (!captureStopped && processedCandidates.size < childCandidates.size && processedCandidates.size < MAX_LINKED_AGENTS) {
          const candidate = [...childCandidates.values()].find(entry => !processedCandidates.has(entry.id));
          if (!candidate) break;
          processedCandidates.add(candidate.id);
          const parent = threadMap.get(candidate.parentId);
          if (!parent || !rootSessionId || parent.sessionId && parent.sessionId !== rootSessionId
            || (candidate.parentId !== rootThreadId && parent.sessionId !== rootSessionId)) {
            recordWarning('unverified-child-link'); continue;
          }
          let readResult;
          try { readResult = await request('thread/read', { threadId: candidate.id, includeTurns: false }, 10000); }
          catch { recordWarning('linked-child-unavailable'); continue; }
          const metadata = readResult?.thread;
          if (metadata?.id !== candidate.id || metadata?.parentThreadId !== candidate.parentId || metadata?.sessionId !== rootSessionId) {
            recordWarning('unverified-child-link'); continue;
          }
          const child = agentFor(candidate.id, candidate.parentId, parent.depth + 1, metadata.sessionId, metadata.cwd);
          if (!child) continue;
          childNativeMetadata.set(child.id, metadata);
          promoteDeferredStartupLinks(child.id);
          child.terminal = metadata.status?.type === 'idle' || metadata.status?.type === 'systemError';
          const provenancePhase = child.terminal ? 'after-task' : 'late-observation';
          if (metadata.status?.type === 'systemError') recordWarning('linked-child-system-error');
          verifiedChildren.push(child);
          const childCwd = typeof metadata.cwd === 'string' ? nativePath(metadata.cwd) : null;
          if (childCwd) {
            try {
              const childSkills = await request('skills/list', { cwds: [childCwd], forceReload: false }, 10000);
              if (Array.isArray(childSkills?.data)) {
                addSkillInventory(childSkills.data, child.id);
                // Active descendants have only a late filesystem observation;
                // never label their bytes as sampled after task completion.
                await provenance.observeCatalog(run.skills.filter(skill =>
                  skill.catalogs?.some(catalog => catalog.agentId === child.id)),
                { agentId: child.id, phase: provenancePhase, cwd: childCwd });
                if (childSkills.data.some(entry => entry?.errors?.some(error => error && typeof error === 'object'))
                  || run.warnings.includes('skill-inventory-limit'))
                  await provenance.observeCatalog(null, { agentId: child.id, phase: provenancePhase, cwd: childCwd });
                updateProvenance();
              }
              else {
                await provenance.observeCatalog(null, { agentId: child.id, phase: provenancePhase, cwd: childCwd });
                updateProvenance(); recordWarning('child-skills-unavailable');
              }
            } catch {
              await provenance.observeCatalog(null, { agentId: child.id, phase: provenancePhase, cwd: childCwd });
              updateProvenance(); recordWarning('child-skills-unavailable');
            }
          } else {
            await provenance.observeCatalog(null, { agentId: child.id, phase: provenancePhase, cwd: childCwd });
            updateProvenance(); recordWarning('child-cwd-unavailable');
          }
          const pending = pendingChildMessages.get(candidate.id) ?? [];
          for (const queued of pending) addEvent(queued.message.method, queued.message.params, queued.lineNumber, queued.observedAtMs);
          pendingChildMessageCount -= pending.length;
          pendingChildMessages.delete(candidate.id);
        }
        if (processedCandidates.size < childCandidates.size || childCandidates.size > MAX_LINKED_AGENTS)
          recordWarning('linked-agent-limit');
      };
      await admitCandidates();
      let childWaitIncomplete = false;
      const childDeadline = Date.now() + (limits.childCompletionWaitMs ?? 5000);
      const consumeHydratedItem = (entry, child, source) => {
        const item = entry?.item;
        if (!item || typeof item !== 'object') return;
        for (const receiverId of linkedAgentCandidates(item)) addChildCandidate(receiverId, child.id, entry.turnId);
        const hydratedKey = validId(item.id) ? `${child.id}\u0000${entry.turnId ?? ''}\u0000${item.id}\u0000item/completed` : null;
        if (hydratedKey && seenCompletedItems.has(hydratedKey)) {
          toolCapture.consumeItem({ item, agentId: child.id, turnId: entry.turnId, phase: 'completed',
            source, startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs });
          consumeItem(item, child.id, entry.turnId, null, entry.completedAtMs ?? entry.startedAtMs, { emitEvent: false });
          return;
        }
        if (++itemCount > maxItems) { capped = true; recordWarning('item-limit'); recordWarning('linked-child-items-incomplete'); return; }
        if (run.events.length >= maxEvents) { capped = true; recordWarning('event-limit'); return; }
        eventIndex++;
        const e = eventProjection('hydrated:item', { threadId: child.id, turnId: entry.turnId, item,
          startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs }, null);
        e.source = source;
        e.agentId = child.id;
        run.events.push(e);
        toolCapture.consumeItem({ item, agentId: child.id, turnId: entry.turnId, phase: 'completed',
          source, startedAtMs: entry.startedAtMs, completedAtMs: entry.completedAtMs });
        capture.byAgent[child.id].items++;
        consumeItem(item, child.id, entry.turnId, null, entry.completedAtMs ?? entry.startedAtMs);
        if (hydratedKey) seenCompletedItems.add(hydratedKey);
      };
      // Process each verified child completely before advancing. Hydrated
      // collaboration links can reveal grandchildren whose live notifications
      // were not present in the root stream.
      for (let childIndex = 0; childIndex < verifiedChildren.length && !captureStopped; childIndex++) {
        const child = verifiedChildren[childIndex];
        while (!captureStopped && !threadMap.get(child.id)?.terminal && Date.now() < childDeadline) {
          const message = await takeNotification(candidate => candidate?.params?.threadId === child.id
            && (candidate.method === 'turn/completed' || candidate.method === 'thread/status/changed'),
            Math.min(500, Math.max(1, childDeadline - Date.now())));
          if (!message && Date.now() >= childDeadline) break;
          if (message?.method === 'turn/completed') {
            try {
              const fresh = await request('thread/read', { threadId: child.id, includeTurns: false }, 10000);
              const freshThread = fresh?.thread;
              if (freshThread?.id === child.id && freshThread?.parentThreadId === child.parentId && freshThread?.sessionId === rootSessionId) {
                child.terminal = freshThread.status?.type === 'idle' || freshThread.status?.type === 'systemError';
                if (freshThread.status?.type === 'systemError') recordWarning('linked-child-system-error');
              } else recordWarning('unverified-child-status');
            } catch { recordWarning('linked-child-status-unavailable'); }
          }
        }
        if (!threadMap.get(child.id)?.terminal) childWaitIncomplete = true;
        if (!threadMap.get(child.id)?.terminal) continue;
        if (itemCount >= maxItems) {
          capped = true;
          recordWarning('item-limit');
          recordWarning('linked-child-items-incomplete');
          continue;
        }
        let cursor = null;
        let page = 0;
        let turnsFallback = false;
        const seenHistoryCursors = new Set();
        for (; !captureStopped && page < MAX_PAGES && itemCount < maxItems; page++) {
          let pageResult;
          if (!turnsFallback) {
            try { pageResult = await request('thread/items/list', { threadId: child.id, ...(cursor ? { cursor } : {}), limit: Math.min(100, maxItems - itemCount) }, 10000); }
            catch (error) {
              if (error.rpcCode !== -32601) { recordWarning('linked-child-items-unavailable'); break; }
              turnsFallback = true;
              cursor = null;
              page = -1;
              continue;
            }
          } else {
            try { pageResult = await request('thread/turns/list', { threadId: child.id, itemsView: 'full', sortDirection: 'asc',
              ...(cursor ? { cursor } : {}), limit: Math.min(100, maxItems - itemCount) }, 10000); }
            catch (error) {
              recordWarning(error.rpcCode === -32601 ? 'linked-child-turns-list-unavailable' : 'linked-child-items-unavailable');
              break;
            }
            if (!Array.isArray(pageResult?.data)) {
              recordWarning('linked-child-turns-malformed');
              cursor = null;
              break;
            }
            const turns = pageResult.data;
            for (const turn of turns) {
              if (!validId(turn?.id) || !['completed','failed','interrupted','inProgress','in_progress'].includes(turn?.status)) {
                recordWarning('linked-child-turns-malformed'); continue;
              }
              if (turn.itemsView !== 'full') { recordWarning('linked-child-items-not-full'); continue; }
              const startedAt = timestampFromNativeSeconds(turn.startedAt);
              const completedAt = timestampFromNativeSeconds(turn.completedAt);
              const existingTurn = run.turns.find(row => row.agentId === child.id && row.turnId === turn.id);
              if (existingTurn) {
                existingTurn.status ??= safeText(turn.status, 60) ?? 'unknown';
                existingTurn.observedStartedAt ??= startedAt;
                existingTurn.observedCompletedAt ??= completedAt;
                existingTurn.source ??= 'thread/turns/list';
              } else run.turns.push({ agentId: child.id, turnId: turn.id, status: safeText(turn.status, 60) ?? 'unknown',
                observedStartedAt: startedAt, observedCompletedAt: completedAt, source: 'thread/turns/list' });
              if (!Array.isArray(turn.items)) { recordWarning('linked-child-items-malformed'); continue; }
              for (const item of turn.items) {
                if (!item || typeof item !== 'object' || Array.isArray(item) || !validId(item.id) || typeof item.type !== 'string') {
                  recordWarning('linked-child-items-malformed');
                  continue;
                }
                // These timestamps bound the turn, not each tool within it.
                // Retain a tool's native duration but never assign the entire
                // turn's interval to every hydrated item.
                consumeHydratedItem({ turnId: turn.id, item }, child, 'thread/turns/list');
                if (capped) break;
              }
              if (capped) break;
            }
            cursor = pageResult?.nextCursor;
            if (!cursor) break;
            if (typeof cursor !== 'string' || cursor.length > 4096) { recordWarning('linked-child-page-cursor-invalid'); break; }
            if (seenHistoryCursors.has(cursor)) { recordWarning('linked-child-page-cursor-repeated'); break; }
            seenHistoryCursors.add(cursor);
            continue;
          }
          const items = Array.isArray(pageResult?.data) ? pageResult.data : [];
          for (const entry of items) {
            // Extract links before the duplicate fast path too. The stream is
            // usually enough, but a hydrated item remains valid evidence if
            // notification ordering or a reconnect omitted that link.
            consumeHydratedItem(entry, child, 'thread/items/list');
          }
          cursor = pageResult?.nextCursor;
          if (!cursor || !items.length) break;
        }
        if (cursor) {
          capped = true;
          recordWarning(itemCount >= maxItems ? 'item-limit' : 'linked-child-page-limit');
          recordWarning('linked-child-items-incomplete');
        } else if (page >= MAX_PAGES) {
          // A cursor remaining at the page boundary means the listing is
          // incomplete even when the last page happened to be empty.
          recordWarning('linked-child-items-incomplete');
        }
        await admitCandidates();
      }
      if (deferredStartupLinks.size) recordWarning('unresolved-agent-links');
      if (pendingChildMessages.size) recordWarning('unresolved-agent-events');
      if (childWaitIncomplete) recordWarning('linked-child-incomplete');
      if (!complete) recordWarning('root-turn-incomplete');
      const incompleteAgentWarnings = new Set(['linked-child-unavailable', 'linked-child-status-unavailable',
        'linked-child-system-error', 'linked-child-items-unavailable', 'linked-child-turns-list-unavailable',
        'linked-child-items-not-full', 'linked-child-turns-malformed', 'linked-child-items-malformed', 'linked-child-page-cursor-repeated',
        'linked-child-page-cursor-invalid',
        'unverified-child-link', 'unverified-child-status',
        'linked-child-incomplete', 'linked-child-items-incomplete', 'linked-agent-limit', 'pending-child-event-limit',
        'deferred-agent-link-limit', 'unresolved-agent-links', 'unresolved-agent-events']);
      // This API is deliberately limited to our quiescent, already-loaded
      // descendants in the private audit process. It updates their in-memory
      // client/listener metadata; it must never attach to historical/user work.
      const loadedThreads = async () => {
        const ids = new Set(), cursors = new Set(); let cursor;
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await request('thread/loaded/list', { limit: MAX_LINKED_AGENTS + 1, ...(cursor ? { cursor } : {}) }, 10000);
          if (!Array.isArray(result?.data)) throw new Error('loaded-list-malformed');
          for (const id of result.data) {
            if (!validId(id) || ids.has(id) || ids.size >= MAX_LINKED_AGENTS + 1) throw new Error('loaded-list-malformed');
            ids.add(id);
          }
          if (result.nextCursor == null) return ids;
          if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096 || cursors.has(result.nextCursor))
            throw new Error('loaded-list-malformed');
          cursor = result.nextCursor; cursors.add(cursor);
        }
        throw new Error('loaded-list-limit');
      };
      const descendants = run.agents.filter(agent => agent.parentId);
      const quiescent = complete && !capped && !childWaitIncomplete && descendants.every(agent => agent.terminal === true)
        && !run.warnings.some(w => incompleteAgentWarnings.has(w));
      for (const child of descendants) {
        if (!instructionContract || !quiescent) {
          instructionSnapshot(child, null, 'thread/resume-loaded', 'agent-not-idle');
          continue;
        }
        if (!streamedAgentIds.has(child.id)) {
          instructionSnapshot(child, null, 'thread/resume-loaded', 'agent-not-subscribed'); continue;
        }
        let loaded;
        try { loaded = await loadedThreads(); }
        catch { instructionSnapshot(child, null, 'thread/resume-loaded', 'loaded-list-unavailable'); continue; }
        if (!loaded.has(child.id) || !loaded.has(rootThreadId)) {
          instructionSnapshot(child, null, 'thread/resume-loaded', 'agent-not-loaded'); continue;
        }
        const before = childNativeMetadata.get(child.id);
        if (!nativePath(before?.cwd) || !nativePath(before?.path)) {
          instructionSnapshot(child, null, 'thread/resume-loaded', 'resume-identity-mismatch'); continue;
        }
        let resumed;
        try { resumed = await request('thread/resume', { threadId: child.id, excludeTurns: true }, 10000); }
        catch {
          run.usage.accounting = null;
          recordWarning('instruction-snapshot-continuity-unknown');
          instructionSnapshot(child, null, 'thread/resume-loaded', 'resume-unavailable'); continue;
        }
        const metadata = resumed?.thread;
        const cwds = [resumed?.cwd, metadata?.cwd].filter(cwd => cwd !== undefined);
        const matches = metadata?.id === child.id && metadata?.parentThreadId === child.parentId
          && metadata?.sessionId === rootSessionId && cwds.length > 0
          && cwds.every(cwd => nativePath(cwd) === nativePath(before?.cwd))
          && metadata?.path === before.path && metadata?.status?.type === 'idle';
        let stillLoaded = false;
        try { const after = await loadedThreads(); stillLoaded = after.has(child.id) && after.has(rootThreadId); } catch {}
        if (!matches || !stillLoaded) {
          run.usage.accounting = null;
          recordWarning('instruction-snapshot-continuity-unknown');
        }
        instructionSnapshot(child, resumed, 'thread/resume-loaded', !matches ? 'resume-identity-mismatch' : !stillLoaded ? 'resumed-thread-changed' : null);
      }
      if (!endedTaskAt) endedTaskAt = Date.now();
      // The workspace snapshot now follows bounded recursive discovery and
      // hydration, so callers do not record a "complete" result before a
      // known descendant has been admitted or rejected.
      const taskEndComplete = complete && !childWaitIncomplete && !run.warnings.some(w => incompleteAgentWarnings.has(w));
      const incompleteAgentTree = run.warnings.some(w => ['linked-agent-limit', 'pending-child-event-limit', 'unverified-child-link', 'unverified-child-status',
        'deferred-agent-link-limit', 'unresolved-agent-links', 'unresolved-agent-events'].includes(w));
      capture.capabilities.childHydration = incompleteAgentTree ? 'partial'
        : run.agents.some(a => a.parentId)
          ? (run.warnings.some(w => w.startsWith('linked-child')) ? 'partial' : 'available') : 'no-linked-children';
      run.status = capped || run.warnings.length || !complete ? 'partial' : 'ready';
      run.reason = run.status === 'ready' ? null : 'Capture is incomplete; inspect warnings and coverage';
      run.coverage.timeline = complete && !capped && !run.warnings.some(w => ['invalid-app-server-json', 'invalid-native-event-ownership'].includes(w)) ? 'complete' : 'partial';
      run.coverage.agents = run.agents.length > 0 && !run.warnings.some(w => incompleteAgentWarnings.has(w)) ? 'complete' : 'partial';
      updateInstructionCoverage();
      run.coverage.skillInventory = capture.capabilities.skillsList === 'available'
        && !run.warnings.some(w => ['skills-origin-unavailable','child-skills-unavailable','child-cwd-unavailable','skill-inventory-limit'].includes(w)) ? 'complete' : 'partial';
      run.coverage.skills = 'partial';
      run.coverage.skillUsage = 'partial';
      // Child notifications buffered before their ownership link retain the
      // app-server's physical source line; restore that order before validation.
      run.usage.observations.sort((a, b) => a.sourceLine - b.sourceLine);
      const assessedUsage = assessUsageSequence(run.usage.observations);
      run.usage.observations = assessedUsage.observations;
      // New notifications may arrive while an admitted child's catalog RPC
      // is pending, before older buffered messages are replayed. Summaries
      // follow the final source-ordered observation, never replay arrival order.
      for (const row of assessedUsage.observations) {
        const slot = run.usage[row.agentId];
        if (!slot) continue;
        slot.last = row.present.last ? { ...row.last } : null;
        slot.total = row.present.total ? { ...row.total } : null;
      }
      capture.coverageDetails ??= {};
      capture.coverageDetails.usage = { byAgent: assessedUsage.byAgent,
        observations: assessedUsage.observations.length, attributed: assessedUsage.observations.filter(x => x.disposition !== 'unattributed').length,
        continuity: Object.values(assessedUsage.byAgent).some(x => x.regressed || x.resets || x.inconsistent || x.invalid) ? 'invalid' : assessedUsage.observations.length ? 'observed' : 'unavailable' };
      for (const [agentId, detail] of Object.entries(assessedUsage.byAgent)) {
        const slot = run.usage[agentId]; if (!slot) continue;
        for (const field of USAGE_FIELDS) if (detail.fields.total[field].invalid) slot.total[field] = null;
      }
      const usageAgentsComplete = run.agents.length > 0 && run.coverage.agents === 'complete'
        && run.agents.every(agent => (run.usage[agent.id]?.snapshots ?? 0) > 0);
      const usageContinuityClean = capture.coverageDetails.usage.continuity !== 'invalid'
        && assessedUsage.observations.every(row => ['accepted','duplicate'].includes(row.disposition));
      const turnKeys = run.turns.map(turn => `${turn.agentId}\0${turn.turnId}`);
      const observedTurnKeys = new Set(assessedUsage.observations.filter(row => ['accepted','duplicate'].includes(row.disposition)
        && (Object.values(row.total).some(Number.isSafeInteger) || Object.values(row.last).some(Number.isSafeInteger)))
        .map(row => `${row.agentId}\0${row.turnId ?? ''}`));
      const everyTurnHasUsableUsage = turnKeys.length > 0 && turnKeys.every(key => observedTurnKeys.has(key));
      run.coverage.usage = !run.usage.observations.length ? 'unavailable'
        : run.coverage.timeline === 'complete' && usageAgentsComplete && everyTurnHasUsableUsage && usageContinuityClean ? 'complete' : 'partial';
      recordWarning('skill-use-observability-limited');
      run.status = 'partial';
      run.reason = 'Skill invocation detection and delivery are best effort; exhaustive use cannot be established';
      capture.status = run.status;
      capture.byOrigin = run.skills.reduce((acc, skill) => { acc[skill.origin] = (acc[skill.origin] ?? 0) + 1; return acc; }, {});
      // Persist the fully hydrated tree and its tool/skill events before the
      // workspace task-end snapshot. The final callback below adds OTel events
      // delivered during process shutdown.
      capture.checkpoint = 'agent-tree-hydrated';
      try { await onSession?.(run, capture); }
      catch { recordWarning('session-checkpoint-failed'); run.status = 'partial'; capture.status = 'partial'; }
      taskEndEvidence = { nativeEndedAt: new Date(endedTaskAt).toISOString(), complete: taskEndComplete,
        rootComplete: complete, childAgentsComplete: !childWaitIncomplete };
    } catch (error) {
      run.status = 'partial'; run.reason = 'App-server capture failed';
      capture.errors.push({ code: 'app-server-capture-failed' });
      recordWarning('app-server-capture-failed');
      capture.status = 'partial';
    } finally {
      rpcClosed = true;
      settleInput();
    }
    // Drain output iterator after all orchestration has finished.
    return;
  })();
  // Drive the orchestration generator while servicing its queued JSON-RPC
  // requests. It waits for responses through onEvent before advancing.
  const drive = (async function* () {
    let iterator = input[Symbol.asyncIterator]();
    let pendingStep = iterator.next();
    while (!rpcClosed) {
      if (outgoing.length) { yield outgoing.shift(); continue; }
      const item = await Promise.race([pendingStep.then(step => ({ step })), new Promise(resolve => outgoingWaiters.push(value => resolve({ value })))]);
      if (item.step) {
        if (item.step.done) break;
        // input generator's work is side-effect driven; it normally emits no chunks.
        if (item.step.value) yield item.step.value;
        pendingStep = iterator.next();
      } else if (item.value?.value) yield item.value.value;
    }
  })();
  let receiver = null, runtime = null, nativeArgs = [], nativeEnv = processOptions.env;
  let telemetrySnapshot = { events: [], metadata: { delivery: 'unknown',
    warnings: ['skill-telemetry-unavailable'] } };
  // Arbitrary process arguments are a test/embedding seam, not a Codex CLI.
  // An explicit factory can exercise the same merge without changing that process.
  if (!processOptions.args || telemetryFactory !== startAuditTelemetry) {
    if (!processOptions.args) {
      runtime = await privateRuntimeDirectory(processOptions.stdoutPath, processOptions.runtimeDirectory);
      const isolated = isolatedNativeOptions(processOptions.env, runtime);
      nativeArgs = isolated.args;
      nativeEnv = isolated.env;
      capture.observer = { transport: 'loopback-otlp-http-json', savedSettingsChanged: false,
        profileHomeUsedForReadOnlySettingsAndSkills: true,
        nativeSessionStorage: 'profile-owned-new-rollouts',
        runtime: { sqlite: 'private-per-process', logs: 'private-per-process', temporaryFiles: 'private-per-process', threadPersistence: 'native-owned-session', workspace: 'process-cwd-unverified' },
        effects: ['native-owned session files in profile-owned new rollouts', 'inherited thread cwd without persistent trust grant', 'owned loaded-descendant resume snapshots may update private runtime client metadata and listeners', 'per-process sqlite_home override', 'per-process log_dir override', 'private TMPDIR', 'per-process native log exporter override', 'prompt logging disabled', 'non-skill telemetry discarded'] };
    }
    try { receiver = await telemetryFactory({ maxBytes: limits.maxTelemetryBytes, maxEvents: limits.maxTelemetryEvents,
      journalPath: join(dirname(processOptions.stdoutPath), 'skill-telemetry.jsonl') }); }
    catch { recordWarning('skill-telemetry-unavailable'); }
  }
  let process;
  try {
    process = await runAuditProcess({ executable: profile.executable,
      args: [...(receiver?.args ?? []), ...nativeArgs, ...(processOptions.args ?? ['app-server'])], cwd: workspace,
      env: nativeEnv, timeoutMs: processOptions.timeoutMs ?? 300000, outputLimitBytes: processOptions.outputLimitBytes,
      stdoutPath: processOptions.stdoutPath, stderrPath: processOptions.stderrPath, signal: processOptions.signal,
      onSpawn: processOptions.onSpawn, onEvent, input: drive });
  } finally {
    if (receiver) {
      try { telemetrySnapshot = await receiver.close() ?? receiver.snapshot(); }
      catch { recordWarning('skill-telemetry-close-failed'); }
    }
    if (runtime && (!process || process.shutdown?.groupTerminated !== false))
      await rm(runtime.root, { recursive: true, force: true }).catch(() => recordWarning('runtime-cleanup-failed'));
    else if (runtime) recordWarning('runtime-preserved-after-uncertain-shutdown');
  }
  // A server that exits or hits a runner limit may leave an RPC request open.
  // Cancel it explicitly, then let the orchestration coroutine settle before
  // returning so no late callback can mutate the persisted run snapshot.
  if (process.status !== 'exited' || process.exitCode !== 0 || process.output?.truncated) captureStopped = true;
  for (const waiter of notificationWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(null); }
  for (const [key, finish] of [...pending]) finish({ error: { code: -32000 } });
  for (const timer of rpcTimers.values()) clearTimeout(timer);
  rpcTimers.clear();
  if (!inputStarted) { rpcClosed = true; settleInput(); }
  await inputSettled;
  const tools = toolCapture.result();
  run.toolInvocations = tools.toolInvocations;
  run.mcp = tools.mcp;
  run.coverage.tools = tools.coverage.tools;
  run.coverage.mcp = tools.coverage.mcp;
  run.toolCaptureBoundary = tools.coverage.boundary;
  if (run.coverage.timeline !== 'complete' || run.coverage.agents !== 'complete') {
    run.coverage.tools = 'partial'; run.coverage.mcp = 'partial'; run.coverage.hooks = 'partial';
  }
  for (const warning of tools.warnings) recordWarning(warning);
  // Child admission can replay older notifications after newer live phases.
  // Hook occurrence pairing must follow native source order, not replay order.
  hookPackets.sort((a, b) => a.sourceLine - b.sourceLine);
  for (const packet of hookPackets) hookCapture.consume(packet);
  const hooks = hookCapture.result();
  run.hookInvocations = hooks.hookInvocations;
  run.coverage.hooks = run.coverage.timeline === 'complete' && run.coverage.agents === 'complete'
    ? hooks.coverage.hooks : 'partial';
  for (const warning of hooks.warnings) recordWarning(warning);
  mergeAuditSkillTelemetry(run, telemetrySnapshot);
  capture.capabilities.skillUseObservability = run.skillInvocations?.length ? 'native-runtime-detected' : receiver ? 'enabled-unverified' : 'unavailable';
  capture.skillTelemetry = run.skillTelemetry;
  if (receiver && telemetrySnapshot.metadata?.journal)
    capture.skillTelemetryJournal = telemetrySnapshot.metadata.journal;
  if (!runtime) capture.observer = { transport: receiver ? 'loopback-otlp-http-json' : 'unavailable', savedSettingsChanged: false,
    effects: receiver ? ['per-process native log exporter override', 'prompt logging disabled', 'non-skill telemetry discarded'] : [] };
  run.metrics.wallMs = Date.now() - startedAt;
  run.metrics.processElapsedMs = process.elapsedMs;
  // This protocol does not expose active-vs-waiting intervals.
  run.metrics.toolsActiveIntervalMs = null;
  if (process.status !== 'exited' || process.exitCode !== 0 || process.output?.truncated) {
    recordWarning(process.output?.truncated ? 'process-output-truncated' : process.status !== 'exited' ? `process-${process.status}` : 'process-exit-failed');
    run.status = 'partial'; capture.status = 'partial';
    run.coverage.timeline = 'partial';
    run.coverage.agents = 'partial';
    if (run.coverage.usage !== 'unavailable') run.coverage.usage = 'partial';
    run.coverage.tools = 'partial'; run.coverage.mcp = 'partial'; run.coverage.hooks = 'partial';
    if (!run.reason) run.reason = 'App-server process did not complete cleanly';
  }
  if (run.status === 'unavailable') capture.status = 'unavailable';
  else if (process.status !== 'exited' || process.exitCode !== 0 || process.output?.truncated) capture.status = 'partial';
  else capture.status = run.status;
  run.usage.total = null;
  updateInstructionCoverage();
  run.usage.workflow = summarizeWorkflowUsage(run);
  run.usage.turns = summarizeTurnUsage(run);
  await provenance.finish();
  updateProvenance();
  capture.checkpoint = 'final';
  try { await onSession?.(run, capture); }
  catch { recordWarning('session-checkpoint-failed'); run.status = 'partial'; capture.status = 'partial'; }
  // Snapshot workspace evidence only after the owned group is confirmed stopped.
  // Terminal turn notifications alone cannot rule out late writes by tool children.
  if (taskEndEvidence) {
    taskEndPromise = Promise.resolve(onTaskEnd?.({ ...taskEndEvidence, at: new Date().toISOString(),
      complete: taskEndEvidence.complete && process.shutdown?.groupTerminated === true,
      processGroupStopped: process.shutdown?.groupTerminated === true,
      boundary: 'owned-process-group-stopped-before-checks', run }))
      .catch(() => recordWarning('task-end-callback-failed'));
    await taskEndPromise;
  }
  return { process, run, capabilities: capture.capabilities, capture };
}
