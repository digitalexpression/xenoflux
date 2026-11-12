// Each worker owns one SDK connection and intercepts only that isolate's spawn.
import { createHmac } from 'node:crypto';
import cp, { execFile } from 'node:child_process';
import { once } from 'node:events';
import { openSync, writeSync, closeSync } from 'node:fs';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { promisify } from 'node:util';
import { getAuditProcessIdentity } from './audit-process.js';
import { assertCopilotEnvironment, assertCopilotRoots, copilotAccountRootIdentities, copilotAuth, copilotExecutableIdentity, copilotId, qualifiedCopilotRoute, COPILOT_SDK_VERSION } from './copilot-profile.js';
import { decodeCopilotCatalog, selectCopilotSettings } from './copilot-catalog.js';
import { readCopilotJournal } from './copilot-transcript-reader.mjs';
import { copilotDecision } from './copilot-events.js';

const ps = promisify(execFile);
const { binding, env, accountQualification, paths, limit, operation, input } = workerData;
const stop = new AbortController();
const send = message => parentPort.postMessage(message);
const pending = new Map();
let child, closed, client, session, cleaning = false, bytes = 0, truncated = false, started = false, processIdentity, processFailure;
let abortIdleObserved = false;
let monitor, sampled = Promise.resolve(), sampling = false, inspectionFailed = false, unsubscribe;
const tracked = new Map();
const originalSpawn = cp.spawn;
const captureFailures = Object.freeze({
  startup: 'Copilot could not initialize the selected native runtime.',
  catalog: 'Copilot did not advertise the requested execution settings.',
  'session-create': 'Copilot could not create the owned native session.',
  'cwd-confirmation': 'Copilot did not confirm the exact working directory.',
  'model-confirmation': 'Copilot did not confirm the requested model, effort or route.',
  'permission-confirmation': 'Copilot did not confirm the native permission mode.',
  'session-checkpoint': 'Copilot could not checkpoint the owned native session.',
  'account-recheck': 'Copilot could not verify the account before initial submission.',
  'turn-execution': 'Copilot could not complete the owned native turn.',
});
let captureStage = null;
let next = 0;
parentPort.on('message', message => {
  if (message.cancel) stop.abort();
  else if (pending.has(message.id)) pending.get(message.id)(message);
});

async function bounded(work, ms, signal) {
  signal?.throwIfAborted();
  let timer, abort;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Copilot RPC deadline exceeded.')), ms);
      if (signal) {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
const rpc = work => { stop.signal.throwIfAborted(); return bounded(work(), 12000, stop.signal); };
const accountToken = auth => createHmac('sha256', input.accountScopeKey)
  .update(JSON.stringify([auth.authType, auth.login, auth.host])).digest('hex');
function checkAccount(auth, version) {
  const account = copilotAuth(auth, binding, accountQualification, version);
  if (accountQualification?.accountToken && accountToken(auth) !== accountQualification.accountToken)
    throw new Error('Copilot account changed. Check sign-in again for this profile.');
  return account;
}
async function checkpoint(type, value) {
  const id = ++next;
  const reply = new Promise(resolve => pending.set(id, resolve));
  send({ id, type, value });
  try {
    const result = await bounded(reply, 15000, stop.signal);
    if (result.error) throw new Error('Copilot checkpoint was refused.');
    return result.value;
  } finally { pending.delete(id); }
}

async function processTable() {
  const { stdout } = await ps('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,uid=,lstart=,state=,args='],
    { timeout: 2000, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: 'C', TZ: 'UTC' } });
  const rows = new Map();
  for (const line of stdout.trimEnd().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, group, uid, birth, state, args] = match;
    if (Number(uid) === process.getuid() && !state.startsWith('Z'))
      rows.set(Number(pid), { ppid: Number(ppid), group: Number(group), birth, args });
  }
  return rows;
}

async function observe() {
  const rows = await processTable();
  const root = rows.get(child?.pid);
  if (root && (root.ppid !== process.pid || root.group !== child.pid)) throw new Error('Copilot process owner changed.');
  let added = true;
  while (added) {
    added = false;
    for (const [pid, row] of rows) {
      if (tracked.has(pid) || !(pid === child?.pid || rows.get(row.ppid)?.birth === tracked.get(row.ppid)?.birth && tracked.has(row.ppid))) continue;
      tracked.set(pid, row);
      added = true;
    }
  }
  return rows;
}
const absent = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};

async function inspectStop() {
  if (!child?.pid) return true;
  await sampled;
  const deadline = Date.now() + 1500;
  do {
    const rows = await observe();
    if (absent(-child.pid) && [...tracked].every(([pid, before]) => {
      const row = rows.get(pid);
      return row ? row.birth !== before.birth : absent(pid);
    })) return !inspectionFailed;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

function installSpawn(out, err) {
  cp.spawn = (command, args, options) => {
    stop.signal.throwIfAborted();
    const executable = binding.executable.path;
    const expected = ['--log-dir', join(dirname(paths.stdoutPath), 'copilot-logs'), '--headless', '--no-auto-update', '--log-level', 'error', '--stdio'];
    const actual = command === executable ? args : command === process.execPath && args[0] === executable ? args.slice(1) : null;
    if (child || JSON.stringify(actual) !== JSON.stringify(expected) || options.cwd !== binding.workspace
      || options.env.COPILOT_HOME !== (binding.rootMode === 'explicit' ? binding.roots.config : undefined))
      throw new Error('Unexpected Copilot launch binding.');
    const ambient = { ...options.env };
    delete ambient.COPILOT_HOME;
    assertCopilotEnvironment(ambient);
    child = originalSpawn(command, args, { ...options, detached: true });
    closed = once(child, 'close');
    closed.catch(() => {});
    child.once('close', () => {
      if (cleaning) return;
      processFailure = 'Copilot process exited before capture finished.';
      stop.abort();
    });
    const track = () => {
      if (sampling) return;
      sampling = true;
      sampled = observe().catch(() => { inspectionFailed = true; }).finally(() => { sampling = false; });
    };
    track();
    monitor = setInterval(track, 150);
    for (const [stream, fd] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', data => {
      try {
        const left = Math.max(0, limit - bytes);
        // Metadata reads only persist their projected result in the coordinator.
        if (left && operation === 'capture') writeSync(fd, data.subarray(0, left));
        bytes += data.length;
        if (bytes > limit) { truncated = true; stop.abort(); }
      } catch { processFailure = 'Copilot evidence write failed.'; stop.abort(); }
    });
    return child;
  };
  syncBuiltinESMExports();
}

async function initialize() {
  assertCopilotEnvironment(env);
  await assertCopilotRoots(binding);
  if (operation !== 'account-status' && binding.rootMode === 'explicit' && !qualifiedCopilotRoute(binding, accountQualification))
    throw new Error('Copilot account scope is unverified for the selected binding.');
  if (accountQualification?.rootIdentities && JSON.stringify(accountQualification.rootIdentities)
    !== JSON.stringify(await copilotAccountRootIdentities(binding))) throw new Error('Copilot account roots changed. Check sign-in again.');
  const executable = binding.executable.path;
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.mode & 0o022 || await realpath(executable) !== executable
    || copilotExecutableIdentity(stat) !== binding.executable.identity)
    throw new Error('Selected Copilot executable is no longer safe.');
  const sdkUrl = import.meta.resolve('@github/copilot-sdk');
  const pkg = JSON.parse(await readFile(new URL('../package.json', sdkUrl), 'utf8'));
  if (pkg.version !== COPILOT_SDK_VERSION) throw new Error('Copilot SDK pin changed.');
  const { CopilotClient, RuntimeConnection } = await import(sdkUrl);
  client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: executable,
    args: ['--log-dir', join(dirname(paths.stdoutPath), 'copilot-logs')] }),
    workingDirectory: binding.workspace, env, logLevel: 'error',
    ...(binding.rootMode === 'explicit' ? { baseDirectory: binding.roots.config } : {}) });
  await rpc(() => client.start());
  const status = await rpc(() => client.getStatus());
  if (status.protocolVersion !== 3 || typeof status.version !== 'string' || !/^[\w.+-]{1,128}$/.test(status.version))
    throw new Error('Unrecognized Copilot runtime protocol.');
  const auth = await rpc(() => client.getAuthStatus());
  const publicAccount = operation === 'account-status' ? null : checkAccount(auth, status.version);
  processIdentity = await getAuditProcessIdentity(child?.pid);
  if (!processIdentity) throw new Error('Copilot process identity unavailable.');
  await sampled;
  if (inspectionFailed || !tracked.has(child.pid)) throw new Error('Copilot process ancestry unavailable.');
  await checkpoint('process', { pid: child.pid, processIdentity });
  return { status, auth, publicAccount };
}

async function metadata({ status, auth, publicAccount }) {
  let result;
  if (operation === 'account-status') {
    if (auth?.isAuthenticated === false) return { state: 'signed-out', version: status.version };
    if (auth?.isAuthenticated !== true || auth.authType !== 'gh-cli' || !copilotId(auth.login) || !copilotId(auth.host))
      return { state: 'unverified', version: status.version };
    return { state: 'signed-in', route: auth.authType, version: status.version, token: accountToken(auth) };
  }
  // Bind list-to-read to account metadata without retaining the login or host.
  const token = operation === 'list' || operation === 'journal' ? accountToken(auth) : null;
  if (operation === 'catalog') {
    result = decodeCopilotCatalog(await rpc(() => client.rpc.models.list({})));
  } else if (operation === 'list') {
    const { sessions } = await rpc(() => client.rpc.sessions.list({ source: 'local', metadataLimit: input.limit }));
    if (!Array.isArray(sessions) || sessions.length > 10000) throw new Error('Invalid Copilot session list.');
    result = sessions.slice(0, input.limit).map(row => ({
      sessionId: row.sessionId, modifiedTime: row.modifiedTime, summary: row.summary,
      isRemote: row.isRemote, context: { workingDirectory: row.context?.cwd },
    }));
  } else if (operation === 'journal') {
    if (publicAccount.type !== input.authType || (publicAccount.scope ?? null) !== input.accountScope || token !== input.accountToken) throw new Error('Copilot session account route changed.');
    result = await readCopilotJournal(params => rpc(() => client.rpc.sessions.readPersistedEvents(params)), {
      sessionId: input.sessionId, signal: stop.signal,
      savePage: (file, bytes) => writeFile(join(input.directory, file), bytes, { flag: 'wx', mode: 0o600 }),
    });
  } else throw new Error('Unexpected Copilot operation.');
  const after = await rpc(() => client.getAuthStatus());
  checkAccount(after, status.version);
  if (auth.login !== after.login || auth.host !== after.host || auth.authType !== after.authType)
    throw new Error('Copilot account changed during discovery.');
  return operation === 'catalog'
    ? { ...result, account: { status: 'unverified', type: publicAccount.type, scope: publicAccount.scope ?? null, id: null }, runtime: status }
    : operation === 'list' ? { sessions: result, account: { ...publicAccount, token }, runtime: status }
      : { ...result, sessionId: input.sessionId, runtime: status };
}

async function capture({ status, auth, publicAccount }) {
  captureStage = 'catalog';
  const wanted = input.execution ?? {};
  const catalog = wanted.model != null || wanted.reasoningEffort != null
    ? decodeCopilotCatalog(await rpc(() => client.rpc.models.list({}))) : null;
  const selection = selectCopilotSettings(catalog, wanted);
  const permissionMode = selection.permissionMode ?? null;
  const onPermissionRequest = () => ({ kind: 'no-result' });
  let startProof, startCount = 0, resolveStart;
  const observedStart = new Promise(resolve => { resolveStart = resolve; });
  const onEvent = event => {
    if (event?.type !== 'session.start' || Object.hasOwn(event, 'agentId') || Object.hasOwn(event.data ?? {}, 'agentId')
      || event.checkpoint === true || event.data?.checkpoint === true) return;
    startCount++;
    startProof = { eventId: event.id, sessionId: event.data?.sessionId, cwd: event.data?.context?.cwd,
      streamSessionId: event.sessionId };
    resolveStart();
  };
  captureStage = 'session-create';
  session = await rpc(() => client.createSession({ onPermissionRequest, onEvent,
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    ...(selection.route ? { capi: { autoTier: selection.route } } : {}) }));
  const sessionId = session.sessionId;
  let nativeIdle = false;
  const permissions = new Set(), seenPermissions = new Set();
  let finish, fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  done.catch(() => {});
  unsubscribe = session.on(event => {
    if (event?.type === 'session.idle' && !event.agentId && !event.data?.agentId && !event.checkpoint && event.data?.aborted === true) {
      abortIdleObserved = true;
      send({ type: 'aborted-idle', value: true });
    }
    if (!started || stop.signal.aborted) return;
    if (event?.type === 'session.idle' && !event.agentId && !event.data?.agentId && !event.checkpoint) {
      nativeIdle = true;
      permissions.clear();
    }
    if (event?.type === 'permission.requested' && !event.agentId && !event.checkpoint && !event.data?.resolvedByHook) {
      const requestId = event.data?.requestId;
      if (!copilotId(requestId) || seenPermissions.has(requestId) || event.data.ownerSessionId !== sessionId) {
        fail(new Error('Copilot supplied an invalid permission identity.'));
        return;
      }
      permissions.add(requestId);
      seenPermissions.add(requestId);
    }
    send({ type: 'event', value: event });
  });
  captureStage = 'cwd-confirmation';
  await bounded(observedStart, 12000, stop.signal);
  const cwdConfirmed = () => startCount === 1 && copilotId(startProof?.eventId) && startProof.sessionId === sessionId
    && (startProof.streamSessionId === undefined || startProof.streamSessionId === sessionId) && startProof.cwd === binding.workspace;
  if (!cwdConfirmed()) throw new Error('Copilot did not confirm the exact working directory.');
  captureStage = 'model-confirmation';
  const confirmed = await rpc(() => session.rpc.model.getCurrent());
  if (selection.model && confirmed.modelId !== selection.model || selection.route && confirmed.autoTier !== selection.route
    || selection.reasoningEffort && confirmed.reasoningEffort !== selection.reasoningEffort)
    throw new Error('Copilot did not confirm the requested model, effort or route.');
  captureStage = 'permission-confirmation';
  let appliedPermission = null;
  if (permissionMode) {
    const applied = await rpc(() => session.rpc.permissions.setMode({ mode: permissionMode }));
    if (!applied.success || applied.mode !== permissionMode) throw new Error('Copilot did not confirm the requested permission mode.');
    appliedPermission = applied.mode;
  } else {
    const mode = await rpc(() => session.rpc.permissions.getMode());
    appliedPermission = ['manual', 'assisted', 'allow-all'].includes(mode.mode) ? mode.mode : null;
  }
  captureStage = 'session-checkpoint';
  await checkpoint('session', { sessionId, version: status.version, account: publicAccount, selection, confirmed: {
    model: copilotId(confirmed.modelId) ? confirmed.modelId : null,
    reasoningEffort: copilotId(confirmed.reasoningEffort) ? confirmed.reasoningEffort : null,
    route: copilotId(confirmed.autoTier) ? confirmed.autoTier : null, permissionMode: appliedPermission,
  } });
  captureStage = 'account-recheck';
  const currentAccount = await rpc(() => client.getAuthStatus());
  checkAccount(currentAccount, status.version);
  if (auth.login !== currentAccount.login || auth.host !== currentAccount.host || auth.authType !== currentAccount.authType)
    throw new Error('Copilot account changed before initial submission.');
  const handleControl = message => {
    if (message.done && nativeIdle) finish(true);
    if (message.permission && started && !nativeIdle && !stop.signal.aborted) {
      const { requestId, result } = message.permission;
      if (!permissions.delete(requestId)) { fail(new Error('Copilot permission request is stale.')); return; }
      rpc(() => session.rpc.permissions.handlePendingPermissionRequest({ requestId, result: copilotDecision(result) }))
        .then(response => { if (response?.success !== true) throw new Error('Copilot did not apply the user decision.'); })
        .catch(fail);
    }
  };
  parentPort.on('message', handleControl);
  try {
    if (!cwdConfirmed()) {
      captureStage = 'cwd-confirmation';
      throw new Error('Copilot did not confirm the exact working directory.');
    }
    captureStage = 'turn-execution';
    started = true;
    const submission = session.send({ prompt: input.task });
    await bounded(Promise.all([submission, done]), input.timeoutMs ?? 2147483647, stop.signal);
  } finally { parentPort.off('message', handleControl); }
  return { completed: true };
}

async function run() {
  let out, err, result, failure, abortAcknowledged = false, sdkStopJoined = false, childClosed = false, groupTerminated = false;
  try {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8 * 1024 * 1024) throw new Error('Invalid Copilot output limit.');
    out = openSync(paths.stdoutPath, 'wx', 0o600);
    err = openSync(paths.stderrPath, 'wx', 0o600);
    installSpawn(out, err);
    if (operation === 'capture') captureStage = 'startup';
    const initialized = await initialize();
    result = operation === 'capture' ? await capture(initialized) : await metadata(initialized);
  } catch (error) {
    failure = processFailure ?? (truncated ? 'Copilot native output limit reached.' : stop.signal.aborted ? 'Copilot operation cancelled.'
      : captureStage ? captureFailures[captureStage]
      : /^Copilot |^Unrecognized Copilot |^Selected Copilot |^Unexpected Copilot |^Unsafe Copilot |^Remove ambient Copilot /.test(error.message)
        ? error.message : 'Copilot native operation failed.');
  } finally {
    cleaning = true;
    if (session && !result?.completed) {
      try { await bounded(session.abort(), 4000); abortAcknowledged = true; } catch { /* Shutdown remains separately observed. */ }
      if (abortAcknowledged && !abortIdleObserved) await new Promise(resolve => setTimeout(resolve, 250));
    }
    unsubscribe?.();
    if (client) {
      try { sdkStopJoined = (await bounded(client.stop(), 6000)).length === 0; } catch { /* Keep ownership uncertain. */ }
    }
    if (child) {
      try { await bounded(closed, 2000); childClosed = true; } catch { /* Keep ownership uncertain. */ }
    }
    clearInterval(monitor);
    try { groupTerminated = child ? childClosed && sdkStopJoined && await inspectStop() : true; } catch { /* Keep ownership uncertain. */ }
    if (out !== undefined) closeSync(out);
    if (err !== undefined) closeSync(err);
    cp.spawn = originalSpawn;
    syncBuiltinESMExports();
    send({ type: 'result', value: { result, failure, ...(failure && captureStage ? { failureStage: captureStage } : {}), started, processIdentity, output: { bytes, truncated },
      shutdown: { groupTerminated, sdkStopJoined, childClosed, abortAcknowledged, trackedProcesses: tracked.size, ancestryCoverage: 'sampled', ancestryUncertain: !groupTerminated } } });
    parentPort.close();
  }
}
await run();
