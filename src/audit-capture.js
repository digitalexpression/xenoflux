// Live, bounded capture through the native Codex app-server JSON-RPC protocol.
// Audit reports receive projected metadata. Profile execution also returns the
// exact assistant response to its private task owner, separate from audit reports.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { realpathSync } from 'node:fs';
import { mkdir, lstat, realpath, rm } from 'node:fs/promises';
import { getAuditProcessIdentity } from './audit-process.js';
import { createCodexRuntime } from './codex-runtime.js';
import { CAPTURE_NATIVE_EVENTS, safeText, idHash, count, validId, timestampFromNativeSeconds, nativePath, emptyUsage, safeUsage, skillProjection, eventProjection, linkedAgentCandidates } from './codex-decoder.js';
import { validateNativeRequest } from './native-requests.js';
import { createAuditToolCapture } from './audit-tools.js';
import { createAuditHookCapture } from './audit-hooks.js';
import { startAuditTelemetry } from './audit-telemetry.js';
import { mergeAuditSkillTelemetry } from './audit-skill-usage.js';
import { assessUsageSequence, normalizeUsageSnapshot, nativeUsageAccounting, summarizeWorkflowUsage, summarizeTurnUsage, USAGE_FIELDS } from './audit-usage.js';
import { redactValue } from './redact.js';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseLiteralSkillReadDetails } from './audit-skill-read.js';
import { projectInstructionSources, compactInstructionSources } from './audit-instructions.js';
import { createResourceProvenance } from './audit-provenance.js';
import { evaluateRequiredContext, validateRequiredContextRules } from './audit-context.js';
import { prepareAuditStartup } from './audit-startup.js';
import { validateExecution, validateAuditNativeConfig, validateAuditApprovalsReviewer } from './audit-spec.js';
import { captureAuditChildDiscovery } from './audit-session.js';
import { createSettingsEvidence } from './client-contracts.js';
import { readCodexModels, validateCatalogSelection } from './client-catalog.js';

const MAX_SKILLS = 5000;
const MAX_EVENTS = 20000;
const MAX_ITEMS = 10000;
const MAX_ARTIFACTS = 10000;
const MAX_OBSERVATIONS = 20000;
const MAX_LINKED_AGENTS = 64;
const MAX_PAGES = 100;
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

/**
 * Run one task over the shared native app-server transport. The caller owns
 * profile resolution/access rechecks and durable onSession checkpoints. Profile
 * mode returns exact private response content; audit mode projects its evidence.
 */
export async function runAuditCapture(options = {}) {
  const { executionMode, profile, workspace, task, selectedSkills = [], sandbox = 'workspace-write', processOptions = {},
    onSession, onPhase, onTaskEnd, onTurn, onNativeRequest, onProcessReady, requiredContext, preflightOnly = false, limits = {},
    telemetryFactory = startAuditTelemetry } = options;
  if (!['audit', 'profile'].includes(executionMode)) throw new TypeError('Select an explicit capture executionMode');
  const ordinary = executionMode === 'profile';
  const approvalsReviewer = validateAuditApprovalsReviewer(options.approvalsReviewer);
  const auditApprovalPolicy = typeof onNativeRequest === 'function' ? 'on-request' : 'never';
  if (ordinary && (['sandbox', 'sandboxPolicy', 'approvalPolicy', 'approvalsReviewer', 'model', 'effort', 'nativeConfig', 'selectedSkills', 'requiredContext', 'preflightOnly', 'telemetryFactory'].some(key => Object.hasOwn(options, key))
    || profile?.nativeConfig !== undefined || profile?.skills !== undefined
    || ['args', 'runtimeDirectory'].some(key => Object.hasOwn(processOptions, key))
    || ['completionWaitMs', 'maxTelemetryBytes', 'maxTelemetryEvents'].some(key => Object.hasOwn(limits, key))
    || (processOptions.outputLimitBytes !== undefined && processOptions.outputLimitBytes > 8 * 1024 * 1024)
    || (profile?.launchArgs !== undefined && !isDeepStrictEqual(profile.launchArgs, ['-c', `sqlite_home=${JSON.stringify(profile.home)}`]))))
    throw new TypeError('Profile execution does not accept audit policy overrides');
  if (approvalsReviewer && auditApprovalPolicy !== 'on-request')
    throw new TypeError('User approval routing requires a comparison request handler');
  if (ordinary && (typeof onSession !== 'function' || workspace !== profile?.cwd
    || !profile?.env || !isDeepStrictEqual(processOptions.env, profile.env)))
    throw new TypeError('Profile execution requires the selected cwd/environment and a durable session checkpoint');
  const timeoutMs = processOptions.timeoutMs === undefined ? (ordinary ? null : 300000) : processOptions.timeoutMs;
  if (!profile || typeof profile.executable !== 'string' || !profile.executable.startsWith('/')
    || typeof workspace !== 'string' || !workspace.startsWith('/') || typeof task !== 'string' || task.length === 0
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)
    || !processOptions.env || !processOptions.stdoutPath || !processOptions.stderrPath
    || typeof preflightOnly !== 'boolean' || preflightOnly && processOptions.args !== undefined) {
    throw new TypeError('Invalid audit capture input');
  }
  const contextRules = requiredContext === undefined ? null : validateRequiredContextRules(requiredContext);
  const execution = validateExecution(options.execution);
  const nativeConfig = { ...validateAuditNativeConfig(profile.nativeConfig),
    ...(execution?.model !== undefined ? { model: execution.model } : {}),
    ...(execution?.reasoningEffort !== undefined ? { model_reasoning_effort: execution.reasoningEffort } : {}) };
  const executionArgs = Object.entries(nativeConfig).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
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
  let response = ordinary ? { status: 'unavailable', threadId: null, turnId: null, source: null, items: [], text: null } : null;
  const capture = { status: 'partial', capabilities: { appServerV2: 'unknown', skillsList: 'unknown', runtimeEvents: 'unknown', childHydration: 'unknown', skillUseObservability: 'partial' }, errors: [], byAgent: {}, byOrigin: {} };
  capture.settingsEvidence = createSettingsEvidence({
    requested: { source: 'frozen-execution-selection', ...execution },
    sent: { source: 'process-local-native-config',
      model: nativeConfig.model ?? null, reasoningEffort: nativeConfig.model_reasoning_effort ?? null },
  });
  if (approvalsReviewer) capture.settingsEvidence.requested.approvalsReviewer = { value: approvalsReviewer, source: 'frozen-comparison-spec' };
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
  const nativeRuntime = createCodexRuntime();
  let nativeHandle = null;
  const rpcEvidence = { get: value => nativeHandle?.evidence.get(value) };
  const childNativeMetadata = new Map();
  const streamedAgentIds = new Set();
  const instructionSnapshot = (agent, result, source, reason = null) => {
    const row = projectInstructionSources(result?.instructionSources, { agentId: agent.id,
      source, phase: source === 'thread/start' ? 'before-task' : 'after-task',
      sourceLine: result && rpcEvidence.get(result)?.sourceLine,
      workspace, profileHome: profile.home, userHome: profile.userHome,
      reason });
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
  const nativeRequests = new Map();
  const approvalItems = new Map();
  const approvalItemKey = p => JSON.stringify([p.threadId, p.turnId, p.itemId ?? p.item?.id]);
  const assistantItems = new Map();
  const requestController = new AbortController();
  const captureSignal = AbortSignal.any([requestController.signal, ...(processOptions.signal ? [processOptions.signal] : [])]);
  let requestFailure = null;
  let rpcClosed = false;
  let captureStopped = false, spawnedProcess = null;
  let inputSettled = null;
  const notify = () => {
    for (let i = 0; i < notificationWaiters.length;) {
      const waiter = notificationWaiters[i];
      const messageIndex = notifications.findIndex(waiter.predicate);
      if (messageIndex < 0) { i++; continue; }
      const [message] = notifications.splice(messageIndex, 1);
      notificationWaiters.splice(i, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  };
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
          agentId, turnId: validId(turnId) ? turnId : null, sourceLine,
          ...(validId(item.id) ? { itemId: item.id } : {}) };
        const duplicate = run.artifacts.some(existing => existing.agentId === agentId && existing.turnId === artifact.turnId
          && existing.path === artifact.path && existing.status === artifact.status
          && (artifact.itemId ? existing.itemId === artifact.itemId
            : existing.itemId ? false : existing.sourceLine === artifact.sourceLine));
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
    if (['turn/started', 'turn/completed'].includes(method) && validId(params?.turn?.id)) {
      const fields = Object.fromEntries(['model', 'modelProvider', 'reasoningEffort']
        .filter(key => params.turn[key] !== undefined).map(key => [key, safeText(params.turn[key], 100) ?? null]));
      if (Object.keys(fields).length) {
        capture.settingsEvidence.observed ??= { source: 'native-turn-event', turns: [] };
        if (capture.settingsEvidence.observed.turns.length < maxEvents)
          capture.settingsEvidence.observed.turns.push({ threadId: tid, turnId: params.turn.id, sourceLine: sourceLine ?? null, ...fields });
      }
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
        endedTaskAt = Number.isSafeInteger(observedAtMs) ? observedAtMs : Date.now();
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
    if (message.id !== undefined && typeof message.method === 'string') {
      // Do not await human input in the stdout reader: cancellation and other
      // server traffic must continue while a request is visible.
      const key = `${typeof message.id}:${message.id}`;
      const failRequest = error => {
        if (captureSignal.aborted || captureStopped || rpcClosed) return;
        requestFailure ??= { code: 'native-request-failed', method: message.method, message: error.message };
        requestController.abort();
      };
      try {
        const validated = validateNativeRequest(message);
        const requestThread = threadMap.get(validated.params.threadId);
        const requestTurn = requestThread?.currentTurnId;
        if (!requestThread || requestTurn && requestTurn !== validated.params.turnId
          || requestThread.id === rootThreadId && rootTerminalTurn?.id === validated.params.turnId)
          throw new Error('Native request does not belong to the active session and turn');
        if (nativeRequests.size >= MAX_ITEMS) throw new Error(`Native request limit exceeded: ${message.method}`);
        if (nativeRequests.has(key)) throw new Error(`Duplicate native request: ${message.method}`);
        if (typeof onNativeRequest !== 'function') throw new Error(`Native request requires user input: ${message.method}`);
        const item = approvalItems.get(approvalItemKey(validated.params)) ?? null;
        if (validated.method === 'item/fileChange/requestApproval'
          && (item?.type !== 'fileChange' || !Array.isArray(item.changes) || !item.changes.length
            || item.changes.some(change => typeof change?.path !== 'string' || !change.path
              || typeof change.diff !== 'string' || !['add', 'delete', 'update'].includes(change.kind?.type))))
          throw new Error(`Native request details unavailable: ${validated.method}`);
        nativeRequests.set(key, validated);
        Promise.resolve().then(() => onNativeRequest(structuredClone(validated), { signal: captureSignal,
          item: item ? structuredClone(item) : null }))
          .then(result => {
            if (captureSignal.aborted || rpcClosed || captureStopped) return;
            nativeRuntime.respond(nativeHandle, validated, result);
            nativeRequests.delete(key);
          }).catch(failRequest);
      } catch (error) { failRequest(error); }
      return;
    }
    if (typeof message.method !== 'string' || !message.params || typeof message.params !== 'object') return;
    const p = message.params;
    // Approval payloads can omit the action itself. Keep the bounded native
    // lifecycle item on this connection, keyed by its exact actor/turn/item.
    if (message.method === 'item/started' && validId(p.threadId) && validId(p.turnId)
      && validId(p.item?.id) && ['commandExecution', 'fileChange'].includes(p.item.type)
      && approvalItems.size < maxItems) approvalItems.set(approvalItemKey(p), p.item);
    if (message.method === 'item/completed') approvalItems.delete(approvalItemKey(p));
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
    if (ordinary && message.method === 'item/completed' && p.threadId === rootThreadId
      && validId(p.turnId) && p.item?.type === 'agentMessage' && validId(p.item.id)
      && typeof p.item.text === 'string' && (p.item.phase == null || p.item.phase === 'final_answer')
      && assistantItems.size < maxItems) {
      assistantItems.set(`${p.turnId}:${p.item.id}`, { turnId: p.turnId, id: p.item.id, text: p.item.text, phase: p.item.phase ?? null });
    }
    addEvent(message.method, p, packet.lineNumber, observedAtMs);
    if (notifications.length < MAX_EVENTS) { notifications.push(message); notify(); }
    else { capped = true; recordWarning('notification-limit'); }
  };
  const request = (method, params, timeoutMs) => nativeRuntime.request(nativeHandle, method, params, timeoutMs);
  const takeNotification = (predicate, timeoutMs = 30000) => {
    if (captureStopped) return Promise.resolve(null);
    const i = notifications.findIndex(predicate);
    if (i >= 0) return Promise.resolve(notifications.splice(i, 1)[0]);
    return new Promise(resolve => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = timeoutMs === null ? null : setTimeout(() => {
        const index = notificationWaiters.indexOf(waiter);
        if (index >= 0) notificationWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      notificationWaiters.push(waiter);
    });
  };
  const input = async launch => {
    try {
      // Paginated history and bounded child-item hydration require the native
      // experimental API opt-in; this is scoped to this connection.
      nativeHandle = await nativeRuntime.initialize(launch, { onEvent, onWarning: recordWarning,
        onSpawn: async info => { spawnedProcess = info; await processOptions.onSpawn?.(info); },
        initializeParams: { clientInfo: { name: ordinary ? 'xfx-review' : 'xfx-audit', title: ordinary ? 'Xenoflux Review' : 'Xenoflux Audit', version: '1' }, capabilities: { experimentalApi: true } } }, captureSignal);
      const initialized = nativeHandle.capabilities;
      if (onProcessReady) {
        const initial = spawnedProcess?.processIdentity;
        const ready = await getAuditProcessIdentity(spawnedProcess?.pid);
        if (!initial || !ready || ready.pid !== initial.pid || ready.started !== initial.started || ready.host !== initial.host)
          throw new Error('Native process identity changed during initialization');
        // The initialized owned connection proves the launcher's exec transition.
        await onProcessReady({ pid: ready.pid, processIdentity: ready });
      }
      capture.capabilities.appServerV2 = initialized ? 'available' : 'partial';
      if (execution?.model !== undefined || execution?.reasoningEffort !== undefined) {
        const models = await readCodexModels(request, { signal: processOptions.signal });
        capture.selectionValidation = validateCatalogSelection({ status: 'ready', models }, execution);
      }
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
      // The owned app-server already runs in the verified workspace. An explicit
      // thread/start cwd makes native writable startup persist project trust in
      // the saved profile. Inherit the process cwd instead, preserving native
      // trust/config/managed-policy decisions, and verify it before any task.
      if (approvalsReviewer) capture.settingsEvidence.sent.approvalsReviewer = { value: approvalsReviewer, source: 'thread/start' };
      let started;
      try {
        started = await nativeRuntime.createSession(nativeHandle, { ephemeral: false, experimentalRawEvents: false,
          ...(!ordinary ? { sandbox, approvalPolicy: auditApprovalPolicy, historyMode: 'paginated' } : {}),
          ...(approvalsReviewer ? { approvalsReviewer } : {}) });
      } catch (error) {
        if (!approvalsReviewer) throw error;
        throw Object.assign(new Error('Codex could not confirm the requested user approval routing; no model task was started'),
          { code: 'requested-approval-reviewer-unconfirmed', cause: error });
      }
      const nativeCwds = [started?.cwd, started?.thread?.cwd].filter(cwd => cwd !== undefined);
      if (!nativeCwds.length || nativeCwds.some(cwd => nativePath(cwd) !== nativePath(workspace))) {
        recordWarning('native-workspace-mismatch');
        throw new Error('thread-start-workspace-mismatch');
      }
      if (capture.observer?.runtime) capture.observer.runtime.workspace = 'verified-process-cwd';
      rootThreadId = started?.thread?.id;
      if (!validId(rootThreadId)) throw new Error('thread-start-missing-id');
      rootSessionId = validId(started?.thread?.sessionId) ? started.thread.sessionId : null;
      if (ordinary) response.threadId = rootThreadId;
      capture.effectiveSettings = Object.fromEntries(['model', 'modelProvider', 'reasoningEffort', 'approvalPolicy', 'sandbox']
        .map(key => [key, ordinary ? started[key] ?? null : safeText(started[key], 100)]));
      capture.settingsEvidence.confirmed = { source: 'thread/start', ...capture.effectiveSettings };
      if (approvalsReviewer) {
        const value = ['user', 'auto_review', 'guardian_subagent'].includes(started.approvalsReviewer) ? started.approvalsReviewer : null;
        capture.effectiveSettings.approvalsReviewer = value;
        capture.settingsEvidence.confirmed.approvalsReviewer = { value, source: 'thread/start' };
      }
      if ((execution?.model !== undefined && started.model !== execution.model)
        || (execution?.reasoningEffort !== undefined && started.reasoningEffort !== execution.reasoningEffort))
        throw Object.assign(new Error('Native app-server did not confirm the requested model or reasoning effort'), { code: 'requested-execution-unconfirmed' });
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
      run.source = { kind: 'native-app-server-v2', provider: 'codex', client: 'cli', clientEvidence: 'xfx-cli-runner',
        version: safeText(profile.version, 100), threadId: rootThreadId,
        model: safeText(started.model, 100), reasoningEffort: safeText(started.reasoningEffort, 40), workspace: safeText(workspace, 512),
        persistence: 'native-owned-session', historyMode: 'paginated', freshThread: true };
      // Verified only for the exact native release in the source receipt. Its
      // paginated child-spawn paths also start independent usage counters.
      // Historical/legacy histories and other native versions remain unknown.
      run.usage.accounting = nativeUsageAccounting(profile.version);
      capture.checkpoint = 'native-session-started';
      updateInstructionCoverage();
      const reviewerRejected = Boolean(approvalsReviewer && (started.approvalsReviewer !== approvalsReviewer || started.approvalPolicy !== auditApprovalPolicy));
      if (reviewerRejected) {
        capture.errors.push({ code: 'requested-approval-reviewer-unconfirmed' });
        capture.checkpoint = 'approval-reviewer-rejected';
        run.status = 'unavailable'; capture.status = 'unavailable';
        run.reason = 'Codex did not confirm user approval routing with on-request policy; no model task was started';
      }
      let contextRejected = false;
      if (contextRules && !reviewerRejected) {
        const rootRules = contextRules.filter(rule => rule.agents !== 'descendants');
        if (rootRules.length) {
          const acceptance = evaluateRequiredContext(run, rootRules, { rootOnly: true });
          run.captureAcceptance = { schemaVersion: 1, mode: 'required-context-preflight',
            status: acceptance.status, requirements: { context: acceptance.requirements }, checks: acceptance.checks,
            exhaustiveConsumption: false,
            boundary: 'Validates reported root instruction-source references before task start; descendant requirements remain pending. It does not establish loaded bytes, trust grants or instruction effects.' };
          run.coverage.captureRequirements = acceptance.status;
          contextRejected = acceptance.status === 'failed';
          if (contextRejected) {
            capture.errors.push({ code: 'required-context-unavailable' });
            capture.checkpoint = 'required-context-rejected';
            run.status = 'unavailable'; capture.status = 'unavailable';
            run.reason = 'Required root loaded context was not verified; no model task was started';
          }
        }
      }
      try { await onSession?.(run, capture); }
      catch {
        recordWarning('session-checkpoint-failed');
        run.status = 'partial'; capture.status = 'partial';
        run.reason = 'Could not checkpoint the native session before task start';
        return;
      }
      if (contextRejected || reviewerRejected) return;
      const sandboxPolicy = sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
        : sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
          : { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
      if (runtime) {
        // The outer profile write guard must coexist with the native command
        // sandbox. Check that before spending a model turn; never bypass either.
        let result;
        try { result = await request('command/exec', { command: ['/usr/bin/true'], cwd: workspace, sandboxPolicy }, 5000); }
        catch { /* Unsupported or timed-out capability is unavailable, not success. */ }
        const verified = result?.exitCode === 0;
        capture.observer.startupPreservation.commandSandbox = verified ? 'verified-noop' : 'unavailable';
        if (!verified) {
          capture.errors.push({ code: 'startup-command-sandbox-unavailable' });
          capture.checkpoint = 'startup-command-sandbox-rejected';
          capture.status = 'unavailable'; run.status = 'unavailable';
          run.reason = 'Profile write protection and native command sandbox could not be verified together; no model task was started';
          return;
        }
      }
      if (preflightOnly) {
        capture.nativeReadiness = { status: 'ready', taskStarted: false, commandSandbox: 'verified-noop' };
        run.reason = 'Native readiness only; no model task was requested';
        return;
      }
      const turnResponse = await nativeRuntime.submit(nativeHandle, { threadId: rootThreadId, cwd: workspace,
        ...(ordinary ? {} : { sandboxPolicy, approvalPolicy: auditApprovalPolicy }), input: [{ type: 'text', text: task }, ...structuredSelections.map(skill => ({ type: 'skill', name: skill.name, path: skill.path }))] }, ordinary ? 30000 : timeoutMs);
      rootTurnId = turnResponse?.turn?.id;
      if (!validId(rootTurnId)) throw new Error('turn-start-missing-id');
      capture.nativeReference = { sessionId: rootThreadId, turnId: rootTurnId };
      if (ordinary) response.turnId = rootTurnId;
      if (rootTerminalTurn?.id !== rootTurnId) { endedTaskAt = null; run.outcome = { status: 'unknown', acceptance: 'not-checked' }; }
      threadMap.get(rootThreadId).currentTurnId = rootTurnId;
      for (const skill of structuredSelections) skill.observations.push({ kind: 'native-selection-accepted', agentId: rootThreadId, turnId: rootTurnId, evidence: 'structured turn/start skill input' });
      if (!run.turns.some(t => t.agentId === rootThreadId && t.turnId === rootTurnId)) run.turns.push({ agentId: rootThreadId, turnId: rootTurnId, status: 'in-progress', observedStartedAt: new Date().toISOString() });
      await onTurn?.({ threadId: rootThreadId, turnId: rootTurnId });
      // Capture notifications until root terminal state, then boundedly hydrate
      // only child IDs positively linked by native collaboration metadata.
      const completionWait = limits.completionWaitMs === undefined
        ? timeoutMs : limits.completionWaitMs;
      const deadline = completionWait === null ? null : Date.now() + completionWait;
      let complete = false;
      while (!complete && (deadline === null || Date.now() < deadline) && !capped && !captureStopped) {
        const remaining = deadline === null ? 1000 : deadline - Date.now();
        const message = await takeNotification(m => m?.params?.threadId === rootThreadId && m.method === 'turn/completed'
          && m.params?.turn?.id === rootTurnId, Math.min(remaining, 1000));
        if (message) complete = true;
      }
      if (captureStopped) return;
      if (!complete) { recordWarning('root-turn-completion-missing'); capture.capabilities.runtimeEvents = 'partial'; }
      await onPhase?.('capture');
      if (ordinary) {
        // Read the exact owned thread and turn; streamed commentary or another
        // history entry can never substitute for its recorded assistant output.
        const recorded = await nativeRuntime.inspect(nativeHandle, { sessionId: rootThreadId, turnId: rootTurnId });
        if (recorded?.thread?.id !== rootThreadId || !Array.isArray(recorded.thread.turns))
          throw new Error('response-thread-mismatch');
        const turns = recorded.thread.turns.filter(turn => turn?.id === rootTurnId);
        if (turns.length !== 1 || !Array.isArray(turns[0].items)) throw new Error('response-turn-unavailable');
        const turn = turns[0];
        if (turn.items.length > maxItems) throw new Error('response-item-limit');
        if (turn.itemsView != null && turn.itemsView !== 'full') throw new Error('response-items-not-full');
        const items = turn.items.filter(item => item?.type === 'agentMessage'
          && (item.phase == null || item.phase === 'final_answer'));
        if (new Set(items.map(item => item.id)).size !== items.length
          || items.some(item => !validId(item.id) || typeof item.text !== 'string')) throw new Error('response-item-malformed');
        response = { threadId: rootThreadId, turnId: rootTurnId, source: 'thread/read',
          status: complete && rootTerminalTurn?.id === rootTurnId && rootTerminalTurn.status === 'completed'
            && turn.status === 'completed' && items.some(item => item.text.trim()) ? 'complete' : 'partial',
          items: items.map(item => ({ id: item.id, text: item.text, phase: item.phase ?? null })),
          text: items.length ? items.map(item => item.text).join('\n\n') : null };
        run.status = response.status === 'complete' ? 'ready' : 'partial';
        run.reason = response.status === 'complete' ? null : 'Recorded assistant response is incomplete';
        run.coverage.timeline = complete && !capped ? 'complete' : 'partial';
        capture.status = run.status;
        return;
      }
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
        if (!quiescent) {
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
      run.status = 'partial'; run.reason = ordinary ? `App-server capture failed: ${error.message}` : 'App-server capture failed';
      const code = ['requested-execution-unconfirmed', 'requested-approval-reviewer-unconfirmed'].includes(error.code)
        ? error.code : 'app-server-capture-failed';
      if (code !== 'app-server-capture-failed') run.reason = error.message;
      capture.errors.push({ code });
      recordWarning(code);
      capture.status = 'partial';
    } finally {
      rpcClosed = true;
      if (nativeHandle) nativeRuntime.finish(nativeHandle);
    }
  };
  let receiver = null, runtime = null, nativeArgs = [], nativeEnv = processOptions.env;
  let telemetrySnapshot = { events: [], metadata: { delivery: 'unknown',
    warnings: ['skill-telemetry-unavailable'] } };
  // Arbitrary process arguments are a test/embedding seam, not a Codex CLI.
  // An explicit factory can exercise the same merge without changing that process.
  if (!ordinary && (!processOptions.args || telemetryFactory !== startAuditTelemetry)) {
    if (!processOptions.args) {
      runtime = await privateRuntimeDirectory(processOptions.stdoutPath, processOptions.runtimeDirectory);
      capture.runtimeRoots = { mode: 'per-job-private', config: profile.home, ...runtime };
      const isolated = isolatedNativeOptions(processOptions.env, runtime);
      nativeArgs = [...executionArgs, ...isolated.args];
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
    const args = [...(receiver?.args ?? []), ...(ordinary ? executionArgs : nativeArgs), ...(ordinary ? (profile.launchArgs ?? []) : []), ...(processOptions.args ?? ['app-server'])];
    const launch = runtime ? await prepareAuditStartup({ profile,
      directory: join(runtime.root, 'startup-protection'), args, commandSandbox: true }) : { executable: profile.executable, args };
    if (runtime) capture.observer.startupPreservation = { status: 'write-protected',
      mechanism: 'macos-process-policy', scope: 'saved-profile-auth-config-instructions-agents-skills-rules',
      credentialCopies: false, savedPermissionsChanged: false,
      commandSandboxTransition: 'native-image-only-with-reentry-denied' };
    inputSettled = input({ client: 'codex', jobId: limits.id, profileId: profile.profileId,
      executable: launch.executable, args: launch.args, workspace,
      processOptions: { env: nativeEnv, timeoutMs, outputLimitBytes: processOptions.outputLimitBytes,
        stdoutPath: processOptions.stdoutPath, stderrPath: processOptions.stderrPath } });
    process = await nativeRuntime.completion;

  } finally {
    if (receiver) {
      try { telemetrySnapshot = await receiver.close() ?? receiver.snapshot(); }
      catch { recordWarning('skill-telemetry-close-failed'); }
    }
    if (runtime && process?.shutdown?.groupTerminated === true && validId(rootThreadId)) {
      run.childDiscovery = await captureAuditChildDiscovery(profile.home, runtime.sqlite, rootThreadId);
    }
    if (runtime && (!process || process.shutdown?.groupTerminated !== false))
      await rm(runtime.root, { recursive: true, force: true }).catch(() => recordWarning('runtime-cleanup-failed'));
    else if (runtime) recordWarning('runtime-preserved-after-uncertain-shutdown');
  }
  requestController.abort();
  // A server that exits or hits a runner limit may leave an RPC request open.
  // Cancel it explicitly, then let the orchestration coroutine settle before
  // returning so no late callback can mutate the persisted run snapshot.
  captureStopped = true;
  for (const waiter of notificationWaiters.splice(0)) { if (waiter.timer) clearTimeout(waiter.timer); waiter.resolve(null); }
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
  if (!runtime && !ordinary) capture.observer = { transport: receiver ? 'loopback-otlp-http-json' : 'unavailable', savedSettingsChanged: false,
    effects: receiver ? ['per-process native log exporter override', 'prompt logging disabled', 'non-skill telemetry discarded'] : [] };
  if (ordinary) capture.observer = { transport: 'native-app-server', executionMode: 'profile',
    effects: ['normal native profile history, authentication and runtime state writes'] };
  if (requestFailure) {
    capture.errors.push(requestFailure);
    run.reason = requestFailure.message;
  }
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
  if (ordinary && response.text === null) {
    const items = [...assistantItems.values()].filter(item => item.turnId === rootTurnId)
      .map(({ turnId, ...item }) => item);
    if (items.length) response = { ...response, turnId: rootTurnId, status: 'partial', source: 'item/completed',
      items, text: items.map(item => item.text).join('\n\n') };
  }
  return { process, run, capabilities: capture.capabilities, capture, ...(ordinary ? { response } : {}) };
}
