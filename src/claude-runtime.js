import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createEnvironmentBinding, createSettingsEvidence } from './client-contracts.js';
import { normalizeSessionReplay } from './audit-session-replay.js';
import { CATALOG_TTL_MS, validateCatalogSelection } from './client-catalog.js';
import { CLAUDE_CLIENT, canonicalClaudeDirectory, inspectClaudeExecutable } from './claude-profile.js';
import { CLAUDE_PERMISSION_MODES, claudeModels, createClaudeDecoder, nativeText, validateClaudeDecision } from './claude-decoder.js';
import { claudeDeadline, claudeProcessCwd, deferred, ownClaudeProcess } from './claude-process.js';

const SDK = '0.3.322';
const source = 'claude-agent-sdk/initialize';
const outputCap = 8 * 1024 * 1024;
const startupMs = 15000;
const OPTIONS = new Set(['model', 'reasoningEffort', 'permissionMode']);
// System subtypes the pinned SDK declares for hook lifecycle messages.
const HOOK_FRAMES = new Set(['hook_started', 'hook_progress', 'hook_response']);
const ASSISTANT_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required',
  'billing_error', 'rate_limit', 'overloaded', 'invalid_request', 'model_not_found', 'server_error', 'unknown', 'max_output_tokens', 'cloud_credential_error']);
const controlled = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: SDK, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' };
const permittedEnvironment = new Set(['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'PATH', 'HOME', 'CLAUDE_CONFIG_DIR']);

async function sdkQuery() {
  const url = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
  if (JSON.parse(await readFile(new URL('./package.json', url), 'utf8')).version !== SDK)
    throw new Error('Selected Claude Agent SDK does not match the pinned contract');
  return (await import(url)).query;
}

function launchArguments(sessionId, execution, probe) {
  return ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--permission-prompt-tool=stdio', '--setting-sources=user,project,local', '--session-id=' + sessionId,
    ...(probe ? ['--no-session-persistence'] : []),
    ...(execution.model ? ['--model=' + execution.model] : []),
    ...(execution.reasoningEffort ? ['--effort=' + execution.reasoningEffort] : []),
    ...(execution.permissionMode ? ['--permission-mode=' + execution.permissionMode] : [])].sort();
}

function accountOf(value) {
  if (value?.apiProvider !== 'firstParty' || !nativeText(value.subscriptionType)
    || value.apiKeySource != null && value.apiKeySource !== 'none'
    || value.tokenSource != null && !['none', 'claude.ai', 'oauth'].includes(value.tokenSource))
    throw Object.assign(new Error('Use native Claude Code to sign in to this profile with a Claude subscription'), { code: 'claude-profile-signed-out' });
  return { status: 'verified', type: 'native-claude-subscription', id: null };
}

const trustFileCap = 16 * 1024 * 1024;
const trustIdentity = row => JSON.stringify([row.dev, row.ino, row.uid, row.mode, row.nlink, row.size, row.mtimeMs, row.ctimeMs]);
const safeTrustFile = row => row.isFile() && !row.isSymbolicLink() && row.nlink === 1
  && row.uid === process.getuid() && !(row.mode & 0o022) && row.size <= trustFileCap;

/** Project only workspace/ancestor trust flags from native global configuration.
 * Never open credential stores or return unrelated account/MCP values.
 * A volatile file-stat identity is not evidence that native trust changed.
 */
export async function claudeWorkspaceTrust(profile, workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || resolve(workspace) !== workspace)
    throw new Error('Claude project trust workspace is invalid');
  const path = join(profile.rootMode === 'implicit' ? profile.userHome : profile.home, '.claude.json');
  for (let attempt = 0; ; attempt += 1) {
    let handle, projects;
    try {
      if (await realpath(dirname(path)) !== dirname(path)) throw new Error('Claude project trust metadata is unsafe');
      let before;
      try { before = await lstat(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (before) {
        if (!safeTrustFile(before)) throw new Error('Claude project trust metadata is unsafe');
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (trustIdentity(await handle.stat()) !== trustIdentity(before))
          throw new Error('Claude project trust metadata changed while reading');
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error('Claude project trust metadata changed while reading');
          offset += bytesRead;
        }
        const after = await handle.stat(), current = await lstat(path);
        if (await realpath(dirname(path)) !== dirname(path) || !safeTrustFile(current) || trustIdentity(after) !== trustIdentity(before)
          || trustIdentity(current) !== trustIdentity(before))
          throw new Error('Claude project trust metadata changed while reading');
        const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!config || typeof config !== 'object' || Array.isArray(config))
          throw new Error('Claude project trust metadata is unreadable');
        projects = config.projects;
        if (projects !== undefined && (!projects || typeof projects !== 'object' || Array.isArray(projects)))
          throw new Error('Claude project trust metadata is unreadable');
      }
      const flags = [];
      for (let current = workspace; ; current = dirname(current)) {
        const entry = projects && Object.hasOwn(projects, current) ? projects[current] : undefined;
        if (entry !== undefined && (!entry || typeof entry !== 'object' || Array.isArray(entry)))
          throw new Error('Claude project trust metadata is unreadable');
        const accepted = entry && Object.hasOwn(entry, 'hasTrustDialogAccepted') ? entry.hasTrustDialogAccepted : false;
        if (typeof accepted !== 'boolean') throw new Error('Claude project trust metadata is unreadable');
        flags.push([current, accepted]);
        if (dirname(current) === current) break;
      }
      return flags;
    } catch (error) {
      if (error.message === 'Claude project trust metadata is unsafe' || ['ELOOP', 'ENXIO'].includes(error.code))
        throw new Error('Claude project trust metadata is unsafe');
      if (attempt === 0) continue; // One bounded retry for a native atomic replacement.
      throw new Error('Claude project trust metadata is unreadable');
    } finally { await handle?.close(); }
  }
}

function startupAdvisory(frame) {
  if (frame.subtype === 'commands_changed')
    return Array.isArray(frame.commands) && frame.commands.length <= 5000
      && frame.commands.every(command => nativeText(command?.name));
  if (frame.subtype === 'status') return frame.status === null
    && (frame.permissionMode === undefined || ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(frame.permissionMode));
  if (frame.subtype === 'plugin_install')
    return ['started', 'installed', 'completed'].includes(frame.status)
      && (frame.name === undefined || nativeText(frame.name));
  return false;
}

function validHookFrame(frame) {
  if (!nativeText(frame.uuid) || !nativeText(frame.hook_id) || !nativeText(frame.hook_name) || !nativeText(frame.hook_event))
    return false;
  if (frame.subtype === 'hook_started') return true;
  if (frame.subtype === 'hook_progress') return ['stdout', 'stderr', 'output'].every(key => typeof frame[key] === 'string');
  return ['success', 'error', 'cancelled'].includes(frame.outcome)
    && ['stdout', 'stderr', 'output'].every(key => typeof frame[key] === 'string')
    && (frame.exit_code === undefined || Number.isSafeInteger(frame.exit_code));
}

function errorRecord(error) {
  const message = typeof error?.message === 'string' && /^Claude |^Selected Claude |^Use native Claude |^The selected |^Model discovery |^Refresh available |^Invalid Claude /.test(error.message)
    ? error.message.slice(0, 512) : 'Claude native execution could not be verified';
  return { code: nativeText(error?.code) ?? 'claude-runtime-failed', message };
}

function compareModel(model, selected) {
  return !selected || model === selected.model || model === selected.resolvedModel;
}

export function createClaudeRuntime({ loadQuery = sdkQuery, processOwner = ownClaudeProcess,
  readCwd = claudeProcessCwd, readTrust = claudeWorkspaceTrust } = {}) {
  async function execute({ profile, workspace, task, execution = {}, processOptions, onProcessReady,
    onSession, onTurn, onNativeRequest, onTaskEnd, limits = {}, preflightOnly = false }) {
    const probe = preflightOnly === 'catalog', readiness = preflightOnly === true;
    const { signal, timeoutMs = probe ? startupMs : null, outputLimitBytes = outputCap, stdoutPath, stderrPath, onSpawn } = processOptions;
    if (profile?.client !== CLAUDE_CLIENT || !['implicit', 'explicit'].includes(profile.rootMode)
      || !isDeepStrictEqual(profile.env, processOptions.env) || !profile.env || profile.env.HOME !== profile.userHome
      || Object.entries(profile.env).some(([key, value]) => !permittedEnvironment.has(key) || typeof value !== 'string' || value.includes('\0'))
      || (profile.rootMode === 'explicit' ? profile.env.CLAUDE_CONFIG_DIR !== profile.home
        : Object.hasOwn(profile.env, 'CLAUDE_CONFIG_DIR') || profile.home !== join(profile.userHome, '.claude'))
      || !Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1 || outputLimitBytes > outputCap
      || timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      || !probe && !readiness && (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task) > 256 * 1024)
      || !execution || Object.entries(execution).some(([key, value]) => !OPTIONS.has(key) || !nativeText(value))
      || execution.permissionMode && !CLAUDE_PERMISSION_MODES.includes(execution.permissionMode)
      || execution.reasoningEffort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(execution.reasoningEffort))
      throw new Error('Invalid Claude runtime binding or settings');
    const sessionId = randomUUID(), promptId = randomUUID();
    const decoder = createClaudeDecoder({ sessionId, promptId, workspace });
    const nativeAbort = new AbortController(), actionAbort = new AbortController();
    const cancelled = deferred(), inputGate = deferred(), inputEnd = deferred(), inputJoined = deferred(), terminal = deferred(), cancelFrames = deferred();
    const errors = [], inFlight = new Set();
    let failure, nativeFailure, assistantError = null, query, pump, sent = false, initialized = false, dispatchAllowed = false, sessionObserved = false;
    let pumpJoined = false, inputStarted = false, inputFinished = false, initializeFrames = 0, interruptFrames = 0;
    let version = null, interruption = null, account = { status: 'unverified', type: null, id: null }, models = [];
    let selectedModel, trustBefore, closing = false, sessionAck, checkpointedTurn;
    const requestStop = error => {
      failure ??= error;
      actionAbort.abort(); cancelled.resolve();
    };
    const externalStop = () => requestStop(Object.assign(new Error('Claude task cancelled'), { code: 'claude-cancelled' }));
    signal?.addEventListener('abort', externalStop, { once: true });
    if (signal?.aborted) externalStop();
    const timeout = timeoutMs === null ? null : setTimeout(() =>
      requestStop(Object.assign(new Error('Claude operation reached its time limit'), { code: 'claude-timeout' })), timeoutMs);
    const capture = { status: 'partial', capabilities: { runtimeEvents: 'available', childHydration: 'unknown', skillUseObservability: 'unavailable' },
      errors, checkpoint: 'launch-bound', sessionBinding: { source: 'claude-sdk-sessionId', status: 'unconfirmed' },
      settingsEvidence: createSettingsEvidence({ requested: { source: 'frozen-execution-selection', ...execution },
        sent: { source: 'claude-agent-sdk-options', model: execution.model ?? null, reasoningEffort: execution.reasoningEffort ?? null,
          permissionMode: execution.permissionMode ?? null } }),
      observer: { transport: 'claude-agent-sdk', sdkVersion: SDK, effects: ['normal native profile history and startup settings'] } };
    const run = { schemaVersion: 1, kind: 'audit-run', id: limits.id ?? randomUUID(),
      profile: { profileId: profile.profileId, profileName: profile.profileName, home: profile.home, userHome: profile.userHome,
        environmentId: profile.environmentId }, status: 'partial', reason: null, source: null,
      clientIdentity: { client: CLAUDE_CLIENT, surface: 'cli', executionLocation: 'local' },
      events: decoder.events, turns: [], agents: [], skills: [], instructionSources: [], toolInvocations: [], warnings: [], artifacts: [],
      usage: { observations: [], total: null }, metrics: { wallMs: null, activeTime: 'unknown', waitingTime: 'unknown' },
      coverage: { timeline: 'partial', agents: 'partial', tools: 'partial', hooks: 'unavailable', mcp: 'unavailable',
        skills: 'unavailable', instructions: 'unavailable', usage: 'unavailable', outcome: 'partial' }, outcome: { status: 'unknown' } };
    function checkpoint() {
      capture.nativeReference = { sessionId, turnId: decoder.turnId };
      return onSession?.(run, capture);
    }
    function onFrame(frame) {
      if (['control_request', 'control_response', 'control_cancel_request', 'keep_alive', 'auth_status'].includes(frame.type)) return;
      if (frame.type === 'system' && HOOK_FRAMES.has(frame.subtype)) {
        // Configured native hooks run at startup, before submission, and around tools.
        // Record only that one ran; hook output is never interpreted as task evidence.
        if (frame.session_id !== sessionId) throw new Error('Claude hook event does not match the owned session');
        if (!validHookFrame(frame)) throw new Error('Claude hook event is malformed');
        if (!run.warnings.includes('claude-native-hook-observed')) run.warnings.push('claude-native-hook-observed');
        return;
      }
      if (!sent) {
        // Admit declared startup metadata only; unknown system events may carry work.
        if (frame.type === 'system' && frame.session_id === sessionId && nativeText(frame.uuid) && startupAdvisory(frame)) {
          if (!run.warnings.includes('claude-native-startup-metadata-observed'))
            run.warnings.push('claude-native-startup-metadata-observed');
          return;
        }
        throw new Error('Claude emitted a session event before the task was submitted');
      }
      decoder.consume(frame);
      if (frame.type === 'assistant' && frame.parent_tool_use_id == null && ASSISTANT_ERRORS.has(frame.error))
        assistantError = frame.error;
      if (frame.type === 'result') {
        // SDK success-subtype results with is_error=true carry an API failure, not task success.
        capture.terminalResult = { source: 'claude-sdk-result', subtype: decoder.result.subtype,
          isError: frame.is_error === true, assistantError,
          apiErrorStatus: Number.isInteger(frame.api_error_status) && frame.api_error_status >= 100 && frame.api_error_status <= 599
            ? frame.api_error_status : null };
        if (!decoder.result.complete && !failure) nativeFailure = Object.assign(new Error(
          `Claude native task failed${assistantError ? ': ' + assistantError : ''}${capture.terminalResult.apiErrorStatus
            ? ' (HTTP ' + capture.terminalResult.apiErrorStatus + ')' : ''}`),
        { code: assistantError === 'rate_limit' ? 'claude-native-rate-limit' : 'claude-native-task-failed' });
      }
      if (decoder.init && !sessionObserved) {
        const confirmed = decoder.init;
        if (!compareModel(confirmed.model, selectedModel) || execution.permissionMode && confirmed.permissionMode !== execution.permissionMode
          || execution.reasoningEffort && confirmed.reasoningEffort && execution.reasoningEffort !== confirmed.reasoningEffort)
          throw new Error('Claude native settings do not match the frozen execution choices');
        sessionObserved = true;
        capture.sessionBinding.status = 'native-confirmed';
        capture.settingsEvidence.confirmed = confirmed;
        capture.effectiveSettings = confirmed;
        capture.checkpoint = 'session';
        run.agents = [{ id: sessionId, sessionId, parentId: null, depth: 0, role: 'root', status: 'running' }];
      }
      if (sessionObserved && (!sessionAck || decoder.turnId !== checkpointedTurn)) {
        checkpointedTurn = decoder.turnId;
        const turnId = checkpointedTurn;
        sessionAck = Promise.resolve(sessionAck).then(async () => {
          await checkpoint();
          await onTurn?.({ threadId: sessionId, turnId });
        });
        void sessionAck.catch(requestStop);
      }
      if (decoder.result) terminal.resolve(decoder.result);
    }
    const owner = processOwner({ stdoutPath, stderrPath, outputLimitBytes, onFrame, stop: requestStop, onInput(frame) {
      if (frame.type === 'control_request') {
        if (frame.request?.subtype === 'initialize' && ++initializeFrames === 1) return;
        if (frame.request?.subtype === 'interrupt' && closing && sent && ++interruptFrames === 1) return;
        throw new Error('Claude SDK requested an unexpected native operation');
      }
      if (['control_response', 'control_cancel_request', 'keep_alive'].includes(frame.type)) return;
      if (frame.type !== 'user' || sent || !dispatchAllowed || actionAbort.signal.aborted || frame.uuid !== promptId || frame.session_id !== sessionId
        || frame.parent_tool_use_id !== null || !isDeepStrictEqual(frame.message, { role: 'user', content: task }))
        throw new Error('Claude SDK attempted to submit a different or duplicate task');
      sent = true;
    } });
    async function permission(name, input, meta) {
      if (!sent || !onNativeRequest || probe || readiness) {
        requestStop(new Error('Claude requested user input without an available approval handler'));
        return null;
      }
      if (['AskUserQuestion', 'ExitPlanMode'].includes(name)) {
        requestStop(new Error('Claude requested an interaction this controller does not support'));
        return null;
      }
      const requestSignal = AbortSignal.any([meta.signal, actionAbort.signal]);
      try {
        const bound = decoder.request(name, input, meta);
        await claudeDeadline(sessionAck, 5000, 'Claude session checkpoint did not finish', requestSignal);
        if (requestSignal.aborted) return null;
        const answer = await onNativeRequest(bound.request, { signal: requestSignal, item: bound.item });
        if (requestSignal.aborted || decoder.result) return null;
        validateClaudeDecision(bound.request, answer);
        return answer.decision === 'accept'
          ? { behavior: 'allow', updatedInput: structuredClone(bound.item.input), toolUseID: bound.item.id }
          : { behavior: 'deny', message: 'Declined by the user', toolUseID: bound.item.id };
      } catch (error) {
        if (!requestSignal.aborted) requestStop(error);
        return null;
      }
    }
    function canUseTool(...args) {
      const work = permission(...args);
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
      return work;
    }
    const prompt = { async *[Symbol.asyncIterator]() {
      inputStarted = true;
      try {
        if (await inputGate.promise && dispatchAllowed && !actionAbort.signal.aborted) {
          yield { type: 'user', uuid: promptId, session_id: sessionId, parent_tool_use_id: null,
            message: { role: 'user', content: task } };
        }
        await inputEnd.promise;
      } finally { inputFinished = true; inputJoined.resolve(); }
    } };
    const checkBinary = async () => {
      if (!isDeepStrictEqual(await inspectClaudeExecutable(profile.executable),
        { executable: profile.executable, executableIdentity: profile.executableIdentity }))
        throw new Error('Selected Claude executable changed after preview');
    };
    const stopStartup = (promise, label) => claudeDeadline(promise, startupMs, label, actionAbort.signal);
    let process;
    try {
      if (failure) throw failure;
      await canonicalClaudeDirectory(workspace, 'Claude working directory');
      await canonicalClaudeDirectory(profile.home, 'Claude configuration root');
      await checkBinary();
      trustBefore = await readTrust(profile, workspace);
      const createQuery = await stopStartup(loadQuery(), 'Claude Agent SDK load timed out');
      actionAbort.signal.throwIfAborted();
      query = createQuery({ prompt, options: {
        pathToClaudeCodeExecutable: profile.executable, cwd: workspace, env: { ...profile.env }, abortController: nativeAbort,
        sessionId, settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(probe ? { persistSession: false } : {}),
        ...(execution.model ? { model: execution.model } : {}),
        ...(execution.reasoningEffort ? { effort: execution.reasoningEffort } : {}),
        ...(execution.permissionMode ? { permissionMode: execution.permissionMode } : {}),
        canUseTool, spawnClaudeCodeProcess(options) {
          if (options.command !== profile.executable || options.cwd !== workspace
            || !isDeepStrictEqual(options.env, { ...profile.env, ...controlled })
            || !isDeepStrictEqual([...options.args].sort(), launchArguments(sessionId, execution, probe)))
            throw new Error('Claude SDK requested an unexpected native launch');
          return owner.start(options);
        },
      } });
      pump = (async () => {
        try { while (!(await query.next()).done) { if (decoder.result) break; } }
        catch (error) { if (!closing) requestStop(error); }
        finally { pumpJoined = true; cancelFrames.resolve(); }
      })();
      const identity = await owner.identity(actionAbort.signal);
      await stopStartup(Promise.resolve(onSpawn?.(identity)), 'Claude process checkpoint timed out');
      const init = await stopStartup(query.initializationResult(), 'Claude initialization timed out');
      account = accountOf(init?.account);
      version = nativeText(init?.claude_code_version);
      if (probe || execution.model || execution.reasoningEffort) {
        models = claudeModels(init?.models);
        if (!probe) {
          validateCatalogSelection({ status: 'ready', models, scope: { account } }, execution);
          selectedModel = models.find(model => model.model === execution.model);
        }
      }
      if (await readCwd(identity.pid) !== workspace) throw new Error('Claude process working directory does not match the selected workspace');
      await checkBinary();
      if (!isDeepStrictEqual(trustBefore, await readTrust(profile, workspace))) throw new Error('Claude project trust metadata changed during startup');
      const initializedIdentity = await owner.identity(actionAbort.signal, true);
      if (initializedIdentity.pid !== identity.pid || initializedIdentity.processIdentity.started !== identity.processIdentity.started
        || initializedIdentity.processIdentity.host !== identity.processIdentity.host)
        throw new Error('Claude process changed during initialization');
      await stopStartup(Promise.resolve(onProcessReady?.(initializedIdentity)), 'Claude process checkpoint timed out');
      initialized = true;
      if (!probe && !readiness) {
        run.source = { kind: 'claude-agent-sdk', client: CLAUDE_CLIENT, threadId: sessionId, workspace };
        capture.sessionBinding.status = 'launch-bound';
        await stopStartup(Promise.resolve(checkpoint()), 'Claude session checkpoint timed out');
        actionAbort.signal.throwIfAborted();
        dispatchAllowed = true; inputGate.resolve(true);
        await Promise.race([terminal.promise, cancelled.promise, cancelFrames.promise]);
        if (!failure && !decoder.result) throw new Error('Claude stream ended without a matching result');
        if (decoder.result && !failure) await stopStartup(sessionAck, 'Claude session checkpoint timed out');
      }
    } catch (error) { requestStop(error); }
    finally {
      closing = true; dispatchAllowed = false;
      actionAbort.abort();
      if (failure && sent && query && !decoder.result) {
        try {
          await claudeDeadline(query.interrupt(), 1500, 'Claude interrupt was not acknowledged');
          interruption = { acknowledged: true };
        } catch { interruption = { acknowledged: false }; }
        await Promise.race([terminal.promise, cancelFrames.promise, new Promise(resolve => setTimeout(resolve, 500))]);
      }
      inputGate.resolve(false); inputEnd.resolve();
      try { query?.close(); } catch (error) { failure ??= error; }
      nativeAbort.abort();
      process = await owner.stop();
      try { await claudeDeadline(Promise.allSettled([pump, inputStarted && inputJoined.promise, ...inFlight]), 1000, 'Claude SDK iterator or tool approvals did not close'); }
      catch (error) {
        failure ??= error; process.shutdown.groupTerminated = false; process.status = 'shutdown-failed';
        process.shutdown.sdkIteratorJoined = pumpJoined; process.shutdown.pendingApprovals = inFlight.size;
      }
      clearTimeout(timeout);
      signal?.removeEventListener('abort', externalStop);
    }
    // Keep the terminal cause ahead of later transport/protocol failures; preserve both.
    if (nativeFailure && failure?.code !== 'claude-cancelled') errors.push(errorRecord(nativeFailure));
    if (failure) errors.push(errorRecord(failure));
    if (interruption) capture.interruption = interruption;
    const nativeShutdown = process.shutdown ?? {};
    capture.shutdown = {
      ...Object.fromEntries(['groupTerminated', 'mainCloseJoined', 'escapedDescendantsUnverified']
        .map(key => [key, typeof nativeShutdown[key] === 'boolean' ? nativeShutdown[key] : null])),
      observedDescendants: Number.isSafeInteger(nativeShutdown.observedDescendants) && nativeShutdown.observedDescendants >= 0
        ? nativeShutdown.observedDescendants : null,
      remainingPids: Array.isArray(nativeShutdown.remainingPids) && nativeShutdown.remainingPids.length <= 2048
        && nativeShutdown.remainingPids.every(pid => Number.isSafeInteger(pid) && pid > 0) ? [...nativeShutdown.remainingPids] : null,
      observationFailed: nativeShutdown.observationError === null ? false : typeof nativeShutdown.observationError === 'string' ? true : null,
      sdkIteratorJoined: pump ? pumpJoined : null, inputIteratorJoined: inputStarted ? inputFinished : null,
      pendingApprovals: inFlight.size, interruptRequested: interruptFrames > 0,
      interruptAcknowledged: interruption?.acknowledged ?? null,
    };
    const result = decoder.result;
    const observedModel = decoder.observedModel === '<synthetic>' ? null : decoder.observedModel;
    const shutdown = process.shutdown.groupTerminated;
    const complete = Boolean(sessionObserved && result?.complete && (!failure || failure.code === 'claude-cancelled'));
    const cancellation = failure?.code === 'claude-cancelled';
    if (cancellation && shutdown) process.status = 'cancelled';
    capture.status = run.status = initialized ? 'partial' : 'unavailable';
    run.reason = errors[0]?.message ?? (!shutdown ? 'Claude shutdown could not be confirmed' : !complete && sent ? 'Claude did not complete the task' : null);
    run.metrics.wallMs = process.elapsedMs;
    if (sessionObserved) {
      capture.nativeReference = { sessionId, turnId: decoder.turnId };
      capture.settingsEvidence.observed = { source: 'claude-assistant/result', model: observedModel, reasoningEffort: result?.reasoningEffort ?? null };
      run.turns.push({ agentId: sessionId, turnId: decoder.turnId, status: complete ? 'completed' : cancellation ? 'interrupted' : 'unknown',
        model: observedModel, reasoningEffort: result?.reasoningEffort ?? null });
      run.agents[0].status = run.turns[0].status;
    }
    for (const tool of decoder.tools.values()) run.toolInvocations.push({ agentId: sessionId, turnId: decoder.turnId,
      itemId: tool.id, source: 'claude-agent-sdk', toolName: tool.name, kind: tool.name === 'Bash' ? 'command' : 'native-tool',
      status: tool.status === 'proposed' && tool.started ? 'running-observed' : tool.status,
      success: tool.status === 'completed' ? true : ['failed', 'stopped-while-running'].includes(tool.status) ? false : null });
    if (result?.usage) {
      run.coverage.usage = 'partial';
      run.usage.observations.push({ source: 'claude-sdk-result', scope: 'single-submission', values: result.usage });
    }
    run.outcome.status = complete ? 'completed' : cancellation ? 'interrupted' : 'unknown';
    run.outcome.nativeTurnStatus = complete ? 'completed' : cancellation ? 'interrupted' : result ? 'failed' : null;
    if (sessionObserved && run.source) {
      const replayComplete = complete && !cancellation;
      const items = [...decoder.assistant];
      if (replayComplete && result.text?.trim()) items.push({ itemId: result.id, text: result.text, label: 'Claude result response' });
      else if (!items.length && result?.text) items.push({ itemId: result.id, text: result.text });
      const terminalStatus = replayComplete ? 'completed' : cancellation ? 'interrupted' : result ? 'failed' : null;
      const fingerprint = createHash('sha256').update(JSON.stringify([sessionId, decoder.turnId, items, terminalStatus])).digest('hex');
      const turnId = /^[0-9a-f-]{36}$/i.test(decoder.turnId ?? '') ? decoder.turnId : null;
      const events = items.map((item, index) => ({ id: `${sessionId}:${fingerprint}:${index + 1}`, sessionId,
        turnId, sourceLine: index + 1, ...(item.itemId && item.itemId.length <= 256 ? { itemId: item.itemId } : {}),
        kind: 'message', role: 'assistant', label: item.label ?? 'Assistant message',
        timestamp: null, body: item.text, bodyStatus: 'included', bodyBytes: Buffer.byteLength(item.text) }));
      if (terminalStatus) events.push({ id: `${sessionId}:${fingerprint}:${events.length + 1}`, sessionId, turnId,
        sourceLine: events.length + 1, kind: 'session', label: 'Claude task result', status: terminalStatus,
        timestamp: null, body: null, bodyStatus: 'unavailable', bodyReason: 'not-recorded' });
      run.source.fingerprint = fingerprint;
      run.sessionReplay = normalizeSessionReplay({ schemaVersion: 1, kind: 'session-replay', sessions: [{
        id: sessionId, parentId: null, depth: 0, status: 'partial', source: { fingerprint },
        limits: [{ kind: 'capture-boundary', message: 'Owned SDK assistant text and matching task result. Source lines are projection ordinals; tool bodies and delegated transcripts are not included.' }],
        events,
      }] });
    }
    capture.checkpoint = 'final';
    if (run.source && !cancellation) {
      try { await checkpoint(); } catch { run.warnings.push('claude-checkpoint-failed'); }
    }
    if (sent && shutdown) {
      try { await onTaskEnd?.({ complete, processGroupStopped: true, boundary: 'observed-claude-ancestry-and-streams-stopped', run }); }
      catch { run.warnings.push('claude-task-end-callback-failed'); }
    }
    const response = { threadId: sessionObserved ? sessionId : null, turnId: decoder.turnId, source: complete ? 'claude-sdk-result' : 'claude-sdk-assistant',
      status: complete && result.text?.trim() ? 'complete' : decoder.assistant.length ? 'partial' : 'unavailable',
      text: complete && result.text?.trim() ? result.text : decoder.assistant.length ? decoder.assistant.map(item => item.text).join('\n\n') : null,
      items: decoder.assistant };
    return { process, run, capture, response, capabilities: capture.capabilities, models, account, initialized, version,
      failure: errors[0] ?? null };
  }

  return {
    capture(options) {
      if (options.approvalsReviewer || options.selectedSkills?.length || options.profile?.nativeConfig)
        throw new Error('Codex-specific comparison overrides cannot be used for Claude Code');
      return execute(options);
    },
    async discover({ profile, workspace, signal, stdoutPath, stderrPath, onSpawn, timeoutMs } = {}) {
      const result = await execute({ profile, workspace, preflightOnly: 'catalog',
        processOptions: { env: profile.env, signal, stdoutPath, stderrPath, onSpawn, timeoutMs } });
      const ready = !result.failure && result.initialized && result.process.shutdown.groupTerminated && result.models.length > 0;
      const discoveredAt = new Date().toISOString();
      return { status: ready ? 'ready' : signal?.aborted ? 'cancelled' : 'unavailable', source,
        scope: { environmentBinding: createEnvironmentBinding(profile.environmentBinding), workspace, account: result.account },
        models: ready ? result.models : [], capabilities: { models: ready ? 'supported' : 'unknown',
          effort: ready && result.models.some(model => model.effortCapability === 'supported') ? 'supported' : 'unknown',
          permissionModes: [...CLAUDE_PERMISSION_MODES] }, version: result.version, discoveredAt,
        expiresAt: new Date(Date.parse(discoveredAt) + CATALOG_TTL_MS).toISOString(), process: result.process,
        ...(!ready ? { reason: result.failure?.code ?? 'catalog-unavailable' } : {}) };
    },
  };
}

export const discoverClaudeModels = createClaudeRuntime().discover;
