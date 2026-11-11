import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { normalizeSessionReplay, REPLAY_LIMITS } from './audit-session-replay.js';
import { assertEnvironmentBinding, createNativeReference, createSettingsEvidence } from './client-contracts.js';
import { assertCopilotEnvironment, copilotBinding, copilotId, isCopilotNativeAuthType, qualifiedCopilotRoute, COPILOT_SDK_VERSION, COPILOT_SESSION_ID } from './copilot-profile.js';
import { copilotDecision, createCopilotDecoder } from './copilot-events.js';

const sdk = `@github/copilot-sdk@${COPILOT_SDK_VERSION}`;
const maxBytes = 8 * 1024 * 1024;
const accountScopeKey = randomBytes(32);

function startWorker(data, receive) {
  const worker = new Worker(new URL('./copilot-worker.mjs', import.meta.url), { workerData: data, execArgv: [] });
  let result, failure;
  const resultPromise = new Promise((resolve, reject) => {
    worker.on('message', message => {
      if (message.type === 'result') { result = message.value; return; }
      receive(message, reply => worker.postMessage(reply));
    });
    worker.on('error', () => { failure = new Error('Copilot worker failed before confirming shutdown.'); });
    worker.on('exit', () => result ? resolve(result) : reject(failure ?? new Error('Copilot worker stopped without a shutdown receipt.')));
  });
  return { result: resultPromise, send: message => worker.postMessage(message) };
}

function workerInput(operation, { profile, workspace, stdoutPath, stderrPath, outputLimitBytes = maxBytes, input = {} }) {
  const binding = copilotBinding(profile, workspace);
  assertCopilotEnvironment(process.env);
  assertCopilotEnvironment(profile.env);
  if (operation !== 'account-status' && binding.rootMode === 'explicit' && !qualifiedCopilotRoute(binding, profile.accountQualification))
    throw new Error('The selected Copilot root has no verified account scope.');
  return { binding, env: profile.env, paths: { stdoutPath, stderrPath }, limit: outputLimitBytes,
    accountQualification: profile.accountQualification, operation, input: { ...input, accountScopeKey } };
}

function sessionRows(result, binding, account, limit) {
  if (!Array.isArray(result) || result.length > 10000) throw new Error('Invalid Copilot session listing.');
  const ids = new Set();
  return result.filter(row => {
    if (row?.isRemote !== false || !COPILOT_SESSION_ID.test(row.sessionId ?? '') || ids.has(row.sessionId)
      || !Number.isFinite(Date.parse(row.modifiedTime))) return false;
    ids.add(row.sessionId);
    return true;
  }).sort((left, right) => Date.parse(right.modifiedTime) - Date.parse(left.modifiedTime)).slice(0, limit)
    .map(row => ({
      sessionId: row.sessionId, title: typeof row.summary === 'string' ? row.summary.slice(0, 1024) : null,
      workspace: typeof row.context?.workingDirectory === 'string' ? row.context.workingDirectory.slice(0, 16384) : null,
      modifiedAt: new Date(row.modifiedTime).toISOString(),
      selection: { sessionId: row.sessionId, client: 'copilot', binding, authType: account.type, accountScope: account.scope ?? null, accountToken: account.token },
    }));
}

export function assertCopilotSessionSelection(selection, profile) {
  if (selection?.client !== 'copilot' || !COPILOT_SESSION_ID.test(selection.sessionId ?? '') || !isCopilotNativeAuthType(selection.authType)
    || typeof selection.accountToken !== 'string' || !/^[a-f0-9]{64}$/.test(selection.accountToken))
    throw new Error('Invalid Copilot session selection.');
  const binding = copilotBinding(profile, profile.cwd);
  assertEnvironmentBinding(selection.binding, binding);
  const qualification = profile.accountQualification;
  if (qualification && (!qualifiedCopilotRoute(binding, qualification) || selection.authType !== qualification.authType
    || selection.accountScope !== qualification.scope) || !qualification && (selection.authType !== 'gh-cli' || selection.accountScope !== null))
    throw new Error('Copilot session account scope changed.');
  return binding;
}

export function createCopilotRuntime({ launch = startWorker } = {}) {
  async function read(operation, options) {
    const { signal, timeoutMs = 25000 } = options;
    const startedAt = Date.now();
    let data;
    try {
      signal?.throwIfAborted();
      data = workerInput(operation, options);
    } catch (cause) {
      const process = { status: signal?.aborted ? 'cancelled' : 'spawn-failed', exitCode: null, shutdown: { groupTerminated: true } };
      await options.onShutdown?.(process);
      throw Object.assign(new Error(cause?.message ?? 'Copilot did not start.'), { process });
    }
    const worker = launch(data, (message, reply) => {
      if (message.type !== 'process') return;
      Promise.resolve().then(() => options.onSpawn?.(message.value)).then(
        () => reply({ id: message.id, value: true }), () => reply({ id: message.id, error: true }));
    });
    const cancel = () => worker.send({ cancel: true });
    signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    try {
      const outcome = await worker.result;
      const process = { status: signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : outcome.failure ? 'failed' : 'exited',
        exitCode: outcome.failure ? null : 0, elapsedMs: Date.now() - startedAt, pid: outcome.processIdentity?.pid ?? null,
        processIdentity: outcome.processIdentity, shutdown: outcome.shutdown, output: outcome.output };
      await options.onShutdown?.(process);
      if (timedOut || signal?.aborted || !outcome.shutdown.groupTerminated || outcome.failure || !outcome.result)
        throw Object.assign(new Error(outcome.failure ?? 'Copilot discovery shutdown is uncertain.'), { process });
      return { result: outcome.result, binding: data.binding, process };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  async function discover(options) {
    const { result, binding, process } = await read('catalog', options);
    const discoveredAt = new Date().toISOString();
    return { ...result, status: 'ready', source: 'copilot-models.list', sdk, process,
      scope: { environmentBinding: binding, workspace: binding.workspace, account: result.account,
        accountScope: options.accountScope ?? null, connectionGeneration: options.connectionGeneration ?? null },
      capabilities: { models: 'supported', effort: result.models.some(model => model.effortCapability === 'supported') ? 'supported' : 'unknown' },
      discoveredAt, expiresAt: new Date(Date.parse(discoveredAt) + 300000).toISOString() };
  }

  async function listSessions(options) {
    const limit = options.limit ?? 30;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Copilot session list limit.');
    const { result, binding } = await read('list', { ...options, input: { limit } });
    return sessionRows(result.sessions, binding, result.account, limit);
  }

  async function accountStatus(options) {
    const { result } = await read('account-status', options);
    return result;
  }

  async function readJournal({ selection, profile, directory, signal, onSpawn, onShutdown }) {
    assertCopilotSessionSelection(selection, profile);
    const { result } = await read('journal', { profile, workspace: profile.cwd, signal, onSpawn, onShutdown,
      stdoutPath: join(directory, 'reader.stdout'), stderrPath: join(directory, 'reader.stderr'),
      input: { directory, sessionId: selection.sessionId, authType: selection.authType, accountScope: selection.accountScope,
        accountToken: selection.accountToken } });
    return { ...result, shutdown: { sdkStopJoined: true, childrenClosed: true } };
  }

  async function capture(options) {
    const { profile, workspace, execution, task, processOptions, onSession, onTurn, onNativeRequest, onProcessReady, onTaskEnd, onPhase } = options;
    if (!['profile', 'audit'].includes(options.executionMode) || !task?.trim() || typeof onSession !== 'function'
      || !isDeepStrictEqual(profile?.env, processOptions?.env) || options.requiredContext || options.selectedSkills?.length
      || options.approvalsReviewer || options.preflightOnly)
      throw new Error('Unsupported Copilot capture input.');
    const { signal, timeoutMs = options.executionMode === 'profile' ? null : 300000 } = processOptions;
    if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= 2147483647))
      throw new Error('Invalid Copilot capture deadline.');
    let data;
    try {
      signal?.throwIfAborted();
      data = workerInput('capture', { ...processOptions, profile, workspace, input: { execution, task, timeoutMs } });
    } catch (error) {
      throw Object.assign(new Error(error?.message ?? 'Copilot did not start.'), {
        ...(signal?.aborted ? { code: 'cancelled' } : {}),
        process: { status: 'spawn-failed', shutdown: { groupTerminated: true } },
      });
    }
    const startedAt = Date.now();
    const id = options.limits?.id ?? randomUUID();
    const scope = { client: 'copilot', profileId: data.binding.profileId, jobId: id };
    const run = { schemaVersion: 1, kind: 'audit-run', id, profile: { profileId: scope.profileId, profileName: profile.profileName,
      home: profile.home, userHome: profile.userHome, environmentId: profile.environmentId },
      clientIdentity: { client: 'copilot', surface: 'cli', executionLocation: 'local' }, environmentBinding: data.binding,
      status: 'partial', reason: null, agents: [], events: [], turns: [], usage: { observations: [], total: null },
      skills: [], skillInvocations: [], instructionSources: [], artifacts: [], warnings: [],
      metrics: { wallMs: null, processElapsedMs: null, toolsActiveIntervalMs: null, activeTime: 'unknown', waitingTime: 'unknown' },
      coverage: { timeline: 'partial', agents: 'partial', usage: 'unavailable', tools: 'unavailable', skills: 'unavailable',
        instructions: 'unavailable', workspaceDiff: 'unavailable', outcome: 'partial' },
      outcome: { status: 'unknown' },
    };
    const capture = { status: 'partial', checkpoint: 'starting', errors: [], capabilities: {
      runtimeEvents: 'supported', childHydration: 'unsupported', skillUseObservability: 'unavailable',
    }, settingsEvidence: createSettingsEvidence({ requested: { source: 'frozen-execution-selection', ...execution } }) };
    let decoder, sessionId, failure, nativeAborted = false, timedOut = false, worker;
    let sequence = Promise.resolve();
    const requests = new Map(), controls = new AbortController();
    const cancel = () => {
      controls.abort();
      worker?.send({ cancel: true });
      for (const controller of requests.values()) controller.abort();
    };
    const signalAbort = () => cancel();
    signal?.addEventListener('abort', signalAbort, { once: true });
    function refuse(error) {
      failure ??= error?.message ?? 'Copilot capture stopped.';
      cancel();
    }
    function queueRequest(request) {
      if (requests.has(request.id) || requests.size >= 128 || typeof onNativeRequest !== 'function')
        throw new Error('Copilot permission request cannot be presented to the user.');
      const controller = new AbortController();
      requests.set(request.id, controller);
      Promise.resolve().then(async () => {
        const answer = await onNativeRequest(request, { signal: controller.signal });
        if (controls.signal.aborted || controller.signal.aborted || requests.get(request.id) !== controller) return;
        worker.send({ permission: { requestId: request.id, result: copilotDecision(answer) } });
      }).catch(error => { if (!controller.signal.aborted) refuse(error); }).finally(() => {
        controller.abort();
        if (requests.get(request.id) === controller) requests.delete(request.id);
      });
    }
    const receive = (message, reply) => {
      if (message.type === 'aborted-idle') { nativeAborted = true; return; }
      sequence = sequence.then(async () => {
        controls.signal.throwIfAborted();
        if (message.type === 'process') {
          await processOptions.onSpawn?.(message.value);
          await onProcessReady?.(message.value);
        } else if (message.type === 'session') {
          const value = message.value;
          if (sessionId || !copilotId(value.sessionId)) throw new Error('Invalid Copilot session checkpoint.');
          sessionId = value.sessionId;
          decoder = createCopilotDecoder({ sessionId, cwd: workspace });
          run.nativeReference = createNativeReference({ ...scope, sessionId });
          run.source = { kind: 'copilot-sdk-stdio', provider: 'copilot', client: 'cli', clientEvidence: sdk,
            version: value.version, accountRoute: value.account, threadId: sessionId, workspace, persistence: 'native-owned-session', freshThread: true };
          run.agents.push({ id: sessionId, sessionId, parentId: null, depth: 0, cwd: workspace });
          capture.settingsEvidence.sent = { source: 'copilot-sdk:session.create/session.permissions.setMode',
            model: value.selection.model ?? null, reasoningEffort: value.selection.reasoningEffort ?? null,
            route: value.selection.route ?? null, permissionMode: value.selection.permissionMode ?? null };
          capture.settingsEvidence.confirmed = { source: 'copilot-sdk:session.model.getCurrent/session.permissions', ...value.confirmed };
          capture.effectiveSettings = value.confirmed;
          capture.checkpoint = 'native-session-started';
          await onSession(run, capture);
        } else if (message.type === 'event') {
          if (!decoder) throw new Error('Copilot event arrived before the session checkpoint.');
          const action = decoder.consume(message.value);
          if (action?.turnId) {
            if (requests.size) throw new Error('Copilot advanced while a user decision was pending.');
            await onTurn?.({ threadId: sessionId, turnId: action.turnId });
          }
          if (action?.request) queueRequest(action.request);
          if (action?.failed) throw new Error(`Copilot reported ${action.failed}.`);
          if (action?.idle) {
            for (const controller of requests.values()) controller.abort();
            requests.clear();
            worker.send({ done: true });
          }
        }
        if (message.id) reply({ id: message.id, value: true });
      }).catch(error => {
        if (message.id) reply({ id: message.id, error: true });
        if (!controls.signal.aborted) refuse(error);
      });
    };
    let result;
    const timer = timeoutMs === null ? null : setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    try {
      worker = launch(data, receive);
      if (controls.signal.aborted) cancel();
      result = await worker.result;
      await sequence;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', signalAbort);
      for (const controller of requests.values()) controller.abort();
    }
    const decoded = decoder?.snapshot();
    const completed = decoded?.complete === true && result.result?.completed === true && !failure;
    const reason = failure ?? result.failure ?? (completed ? null : 'Recorded assistant response is incomplete');
    const elapsedMs = Date.now() - startedAt;
    const process = { status: timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : result.failure || failure ? 'failed' : 'exited',
      exitCode: result.failure || failure ? null : 0, signal: null, elapsedMs, pid: result.processIdentity?.pid ?? null,
      processIdentity: result.processIdentity, shutdown: { ...result.shutdown, nativeAbortedIdle: nativeAborted }, output: result.output };
    run.status = completed ? 'ready' : 'partial';
    run.outcome = { status: completed ? 'native-claim' : 'unknown', nativeTurnStatus: completed ? 'completed' : null };
    run.reason = reason;
    run.metrics.wallMs = elapsedMs;
    run.metrics.processElapsedMs = elapsedMs;
    if (decoded) {
      run.nativeReference = createNativeReference({ ...scope, sessionId, turnId: decoded.turnId });
      run.events = decoded.events;
      run.toolInvocations = decoded.invocations;
      run.turns = decoded.turns;
      run.agents[0].terminal = !!decoded.idle;
      run.usage.observations = decoded.usage;
      run.coverage.usage = decoded.usage.length ? 'partial' : 'unavailable';
      run.coverage.tools = decoded.invocations.length || decoded.toolsComplete ? 'partial' : 'unavailable';
      capture.settingsEvidence.observed = decoded.observed;
      if (decoded.observed) {
        run.source.model = decoded.observed.model;
        run.source.reasoningEffort = decoded.observed.reasoningEffort;
      }
      if (COPILOT_SESSION_ID.test(sessionId) && decoded.replayMessages.length) {
        const records = decoded.replayMessages.slice(0, Math.min(2000, REPLAY_LIMITS.records));
        let retainedBytes = 0;
        const rows = records.map(({ id: itemId, text, at: timestamp, turnId, role }, index) => {
          const bodyBytes = Buffer.byteLength(text);
          const included = bodyBytes <= REPLAY_LIMITS.bodyBytes && retainedBytes + bodyBytes <= 1024 * 1024
            && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text);
          if (included) retainedBytes += bodyBytes;
          return { itemId, timestamp, role, turnId: COPILOT_SESSION_ID.test(turnId ?? '') ? turnId : null,
            kind: 'message', label: role === 'user' ? 'User message' : 'Assistant message',
            sessionId, sourceLine: index + 1, body: included ? text : null, bodyBytes, bodyStatus: included ? 'included' : 'omitted' };
        });
        const fingerprint = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        run.sessionReplay = normalizeSessionReplay({ schemaVersion: 1, kind: 'session-replay', sessions: [{
          id: sessionId, parentId: null, depth: 0, status: 'partial', source: { fingerprint },
          limits: [{ kind: 'capture-boundary', message: 'Public message text from the owned live Copilot event stream. Source lines are message projection ordinals.' }],
          events: rows.map(row => ({ ...row, id: `${sessionId}:${fingerprint}:${row.sourceLine}` })),
        }] });
        run.replayCapture = { status: 'partial', capturedAt: new Date().toISOString(), sourceFingerprint: fingerprint,
          boundary: 'owned-copilot-live-message-projection' };
      }
    }
    if (reason) capture.errors.push({ code: 'copilot-capture-partial', message: reason });
    capture.checkpoint = 'final';
    capture.rootResponse = completed ? 'complete' : 'partial';
    capture.nativeReference = run.nativeReference;
    await onPhase?.('capture');
    if (!controls.signal.aborted) await onSession(run, capture);
    if (decoded?.idle && process.shutdown.groupTerminated) await onTaskEnd?.({ nativeEndedAt: decoded.idle.at, at: new Date().toISOString(),
      complete: false, rootComplete: completed, childAgentsComplete: false,
      processGroupStopped: process.shutdown.groupTerminated, boundary: 'owned-copilot-process-ancestry-checked', run });
    const response = decoded?.response ? { ...decoded.response, status: completed ? 'complete' : 'partial' } : undefined;
    return { run, capture, process, response, capabilities: capture.capabilities };
  }

  return { capture, discover, listSessions, readJournal, accountStatus };
}

export async function discoverCopilotModels(options) {
  try { return await createCopilotRuntime().discover(options); }
  catch (error) {
    if (!error.process) throw error;
    const { profile, workspace } = options;
    return { status: error.process.status === 'cancelled' ? 'cancelled' : 'unavailable',
      reason: 'catalog-discovery-failed', source: 'copilot-models.list', sdk, process: error.process, models: [],
      scope: { environmentBinding: profile.environmentBinding, workspace, account: null },
      capabilities: { models: 'unknown', effort: 'unknown' } };
  }
}
