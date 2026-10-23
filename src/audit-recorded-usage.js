import { createHash } from 'node:crypto';

const VERSION = '0.163.0-alpha.10.2';
const SOURCE_REVISION = 'd9151c94a70013f176ff370fa93da02734662e41';
const CONTRACT = Object.freeze({ contract: 'codex-rollout-own-response-usage-v1', version: VERSION,
  sourceRevision: SOURCE_REVISION, historyMode: 'recorded-response-sequence',
  counterScope: 'thread-owned-responses' });
const FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cachedInputTokens',
  'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']);
const NATIVE_FIELDS = Object.freeze({ inputTokens: 'input_tokens', outputTokens: 'output_tokens',
  cachedInputTokens: 'cached_input_tokens', reasoningOutputTokens: 'reasoning_output_tokens',
  cacheWriteInputTokens: 'cache_write_input_tokens', totalTokens: 'total_tokens' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^sha256:[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_RECORDS = 512, MAX_TURNS = 1000;
const MAX_SELECTED_THREADS = 160, MAX_SELECTED_RECORDS = 2048;
const UNAVAILABLE_REASONS = new Set(['source-version-unsupported', 'source-incomplete', 'ownership-invalid',
  'root-turn-ownership-invalid', 'record-bound-exceeded', 'turn-bound-or-sequence-invalid',
  'turn-sequence-invalid', 'response-records-missing', 'response-record-invalid', 'response-order-invalid',
  'root-turn-identity-inconsistent', 'duplicate-response-id', 'response-counter-invalid',
  'turn-counter-inconsistent', 'thread-baseline-invalid', 'thread-counter-inconsistent', 'counter-overflow',
  'turn-response-missing', 'projection-invalid', 'projection-summary-mismatch', 'selected-response-bound-exceeded',
  'selected-thread-incomplete', 'selected-agent-ownership-invalid', 'selected-root-invalid',
  'selected-parent-or-root-context-unverified', 'selected-parent-cycle', 'selected-counter-overflow',
  'source-binding-unverified']);
const validVersion = value => typeof value === 'string' && value.length <= 128
  && /^[A-Za-z0-9.+_-]+$/.test(value);

export function recordedUsageAccounting(version) {
  return version === VERSION ? { ...CONTRACT } : null;
}

const blank = () => Object.fromEntries(FIELDS.map(field => [field, null]));
const unavailableFields = () => Object.fromEntries(FIELDS.map(field => [field,
  { status: 'unavailable', contributingResponses: 0, responseCount: 0 }]));
const safeInt = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const validUuid = value => typeof value === 'string' && UUID.test(value);
const add = (left, right) => {
  const result = left + right;
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
};

function readCounters(value, projected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const counters = {};
  for (const field of FIELDS) {
    const key = projected ? field : NATIVE_FIELDS[field];
    const number = safeInt(value[key]);
    if (number === null) return null;
    counters[field] = number;
  }
  if (counters.inputTokens + counters.outputTokens !== counters.totalTokens
    || !Number.isSafeInteger(counters.inputTokens + counters.outputTokens)
    || counters.cachedInputTokens > counters.inputTokens
    || counters.reasoningOutputTokens > counters.outputTokens) return null;
  return counters;
}

function sumCounters(left, right) {
  const result = {};
  for (const field of FIELDS) {
    result[field] = add(left[field], right[field]);
    if (result[field] === null) return null;
  }
  return result;
}

function difference(later, earlier) {
  const result = {};
  for (const field of FIELDS) {
    result[field] = later[field] - earlier[field];
    if (!Number.isSafeInteger(result[field]) || result[field] < 0) return null;
  }
  if (result.inputTokens + result.outputTokens !== result.totalTokens
    || !Number.isSafeInteger(result.inputTokens + result.outputTokens)
    || result.cachedInputTokens > result.inputTokens
    || result.reasoningOutputTokens > result.outputTokens) return null;
  return result;
}

function unavailable(reason, input = {}) {
  const version = recordedUsageAccounting(input.version) ? VERSION : null;
  const contract = recordedUsageAccounting(version);
  return { status: 'unavailable', reason, contract,
    agentId: validUuid(input.agentId) ? input.agentId : null,
    sessionId: validUuid(input.sessionId) ? input.sessionId : null,
    parentId: input.parentId === null || validUuid(input.parentId) ? input.parentId : null,
    rootTurnIds: Array.isArray(input.rootTurnIds) ? input.rootTurnIds.filter(validUuid).slice(0, MAX_TURNS) : [],
    version, sourceComplete: typeof input.sourceComplete === 'boolean' ? input.sourceComplete : null,
    sourceBinding: sourceBinding(input.source, input.agentId),
    baseline: blank(), values: blank(), fields: unavailableFields(), turns: [], records: [] };
}

function unavailableReason(input) {
  if (recordedUsageAccounting(input.version) === null) return 'source-version-unsupported';
  if (input.sourceComplete !== true) return 'source-incomplete';
  if (!validUuid(input.agentId) || !validUuid(input.sessionId)
    || !(input.parentId === null || validUuid(input.parentId))) return 'ownership-invalid';
  if (!Array.isArray(input.rootTurnIds) || input.rootTurnIds.length > MAX_TURNS
    || input.rootTurnIds.some(id => !validUuid(id)) || new Set(input.rootTurnIds).size !== input.rootTurnIds.length)
    return 'root-turn-ownership-invalid';
  if (!Array.isArray(input.records) || input.records.length > MAX_RECORDS) return 'record-bound-exceeded';
  if (!Array.isArray(input.turns) || input.turns.length === 0 || input.turns.length > MAX_TURNS)
    return 'turn-bound-or-sequence-invalid';
  return null;
}

function evaluate(input, projected = false) {
  const reason = unavailableReason(input);
  if (reason) return unavailable(reason, input);
  const contract = recordedUsageAccounting(input.version);
  const turnMap = new Map();
  let priorTerminal = 0;
  for (const turn of input.turns) {
    if (!turn || !validUuid(turn.turnId) || turnMap.has(turn.turnId)
      || !Number.isSafeInteger(turn.contextLine) || turn.contextLine <= 0
      || !Number.isSafeInteger(turn.terminalLine) || turn.terminalLine <= turn.contextLine
      || turn.contextLine <= priorTerminal
      || !['completed', 'failed', 'interrupted'].includes(turn.status))
      return unavailable('turn-sequence-invalid', input);
    priorTerminal = turn.terminalLine;
    turnMap.set(turn.turnId, { turnId: turn.turnId, rootTurnId: null,
      contextLine: turn.contextLine, terminalLine: turn.terminalLine, status: turn.status,
      responseCount: 0, values: blank() });
  }
  if (!input.records.length) return unavailable('response-records-missing', input);

  const records = [];
  const responseIds = new Set();
  let previousLine = 0, baseline = null, threadRunning = null;
  const turnRunning = new Map();
  for (const raw of input.records) {
    const id = projected ? raw?.responseRef : raw?.response_id;
    const threadId = projected ? raw?.threadId : raw?.thread_id;
    const sessionId = projected ? raw?.sessionId : raw?.session_id;
    const turnId = projected ? raw?.turnId : raw?.turn_id;
    const rootTurnId = projected ? raw?.rootTurnId : raw?.root_turn_id;
    const sourceLine = raw?.sourceLine;
    if (!validUuid(threadId) || threadId !== input.agentId || !validUuid(sessionId)
      || sessionId !== input.sessionId || !validUuid(turnId) || !turnMap.has(turnId)
      || !validUuid(rootTurnId) || !Number.isSafeInteger(sourceLine) || sourceLine <= previousLine
      || !((projected && typeof id === 'string' && HASH.test(id))
        || (!projected && typeof id === 'string' && id.length > 0)))
      return unavailable('response-record-invalid', input);
    const turn = turnMap.get(turnId);
    if (sourceLine <= turn.contextLine || sourceLine >= turn.terminalLine
      || (projected && (raw.contextLine !== turn.contextLine || raw.terminalLine !== turn.terminalLine)))
      return unavailable('response-order-invalid', input);
    if (input.parentId === null ? rootTurnId !== turnId : !input.rootTurnIds.includes(rootTurnId))
      return unavailable('root-turn-ownership-invalid', input);
    if (turn.rootTurnId !== null && turn.rootTurnId !== rootTurnId)
      return unavailable('root-turn-identity-inconsistent', input);
    turn.rootTurnId = rootTurnId;
    previousLine = sourceLine;
    if (responseIds.has(id)) return unavailable('duplicate-response-id', input);
    responseIds.add(id);

    const usage = readCounters(projected ? raw.usage : raw.usage, projected);
    const turnSnapshot = readCounters(projected ? raw.turnTokenUsage : raw.turn_token_usage, projected);
    const threadSnapshot = readCounters(projected ? raw.threadTokenUsage : raw.thread_token_usage, projected);
    if (!usage || !turnSnapshot || !threadSnapshot) return unavailable('response-counter-invalid', input);
    const nextTurn = sumCounters(turnRunning.get(turnId) ?? blankZeros(), usage);
    if (!nextTurn || !sameCounters(nextTurn, turnSnapshot)) return unavailable('turn-counter-inconsistent', input);
    turnRunning.set(turnId, nextTurn);
    if (threadRunning === null) {
      baseline = difference(threadSnapshot, usage);
      if (!baseline) return unavailable('thread-baseline-invalid', input);
      threadRunning = sumCounters(baseline, usage);
    } else threadRunning = sumCounters(threadRunning, usage);
    if (!threadRunning || !sameCounters(threadRunning, threadSnapshot))
      return unavailable('thread-counter-inconsistent', input);

    turn.responseCount++;
    const turnValues = sumCounters(turn.values.inputTokens === null ? blankZeros() : turn.values, usage);
    if (!turnValues) return unavailable('counter-overflow', input);
    turn.values = turnValues;
    records.push({ threadId, sessionId, turnId, rootTurnId,
      responseRef: projected ? id : `sha256:${createHash('sha256').update(raw.response_id, 'utf8').digest('hex')}`,
      sourceLine, contextLine: turn.contextLine, terminalLine: turn.terminalLine,
      usage, turnTokenUsage: turnSnapshot, threadTokenUsage: threadSnapshot });
  }
  if ([...turnMap.values()].some(turn => turn.responseCount === 0))
    return unavailable('turn-response-missing', input);
  const values = blankZeros();
  for (const record of records) {
    const next = sumCounters(values, record.usage);
    if (!next) return unavailable('counter-overflow', input);
    Object.assign(values, next);
  }
  const fields = Object.fromEntries(FIELDS.map(field => [field,
    { status: 'observed', contributingResponses: records.length, responseCount: records.length }]));
  return { status: 'complete', reason: null, contract, agentId: input.agentId, sessionId: input.sessionId,
    parentId: input.parentId, rootTurnIds: [...input.rootTurnIds], version: input.version,
    sourceComplete: true, sourceBinding: sourceBinding(input.source, input.agentId), baseline, values, fields,
    turns: [...turnMap.values()], records };
}

function blankZeros() { return Object.fromEntries(FIELDS.map(field => [field, 0])); }
function sameCounters(left, right) {
  return !!left && typeof left === 'object' && !!right && typeof right === 'object'
    && FIELDS.every(field => safeInt(left[field]) !== null && left[field] === right[field]);
}
function projectedThreadInput(value, source = value?.sourceBinding) {
  return { version: value?.version, agentId: value?.agentId, sessionId: value?.sessionId,
    parentId: value?.parentId, rootTurnIds: value?.rootTurnIds,
    sourceComplete: value?.sourceComplete, source };
}

export function deriveRecordedThreadUsage(input) { return evaluate(input ?? {}); }

/** Revalidate the metadata-only persisted projection and rebuild its summaries. */
export function projectRecordedThreadUsage(value) {
  if (!value || typeof value !== 'object') return unavailable('projection-invalid');
  if (value.status === 'unavailable') {
    const version = validVersion(value.version) ? value.version : null;
    const contract = recordedUsageAccounting(version);
    const identityOkay = (value.agentId === null || validUuid(value.agentId))
      && (value.sessionId === null || validUuid(value.sessionId))
      && (value.parentId === null || validUuid(value.parentId));
    if (!identityOkay || !UNAVAILABLE_REASONS.has(value.reason)
      || !(value.sourceBinding === null || sourceBinding(value.sourceBinding, value.agentId)
        && JSON.stringify(value.sourceBinding) === JSON.stringify(sourceBinding(value.sourceBinding, value.agentId)))
      || (value.contract !== null && (!contract || Object.keys(CONTRACT).some(key => value.contract?.[key] !== CONTRACT[key]))))
      return unavailable('projection-invalid', projectedThreadInput(value));
    return unavailable(value.reason, projectedThreadInput(value));
  }
  if (value.status !== 'complete' || value.version !== VERSION || value.sourceComplete !== true
    || !value.contract || Object.keys(CONTRACT).some(key => value.contract[key] !== CONTRACT[key])
    || !(value.sourceBinding === null || sourceBinding(value.sourceBinding, value.agentId)
      && JSON.stringify(value.sourceBinding) === JSON.stringify(sourceBinding(value.sourceBinding, value.agentId))))
    return unavailable('projection-invalid', projectedThreadInput(value));
  const rebuilt = evaluate({ agentId: value.agentId, sessionId: value.sessionId, parentId: value.parentId,
    rootTurnIds: value.rootTurnIds,
    version: value.version, sourceComplete: true, source: value.sourceBinding,
    records: value.records, turns: value.turns }, true);
  if (rebuilt.status !== 'complete') return rebuilt;
  if (!sameCounters(value.baseline, rebuilt.baseline) || !sameCounters(value.values, rebuilt.values)
    || JSON.stringify(value.sourceBinding ?? null) !== JSON.stringify(rebuilt.sourceBinding)
    || JSON.stringify(value.fields) !== JSON.stringify(rebuilt.fields)
    || JSON.stringify(value.turns) !== JSON.stringify(rebuilt.turns)) return unavailable('projection-summary-mismatch', value);
  return rebuilt;
}

function sourceBinding(source, rootAgentId) {
  if (!validUuid(rootAgentId) || !source || source.kind !== 'native-rollout' || source.nativeSessionId !== rootAgentId
    || source.clientVersion !== VERSION || source.fingerprintScope !== 'source-snapshot'
    || typeof source.fingerprint !== 'string' || !FINGERPRINT.test(source.fingerprint)
    || !Number.isSafeInteger(source.bytes) || source.bytes <= 0
    || !Number.isSafeInteger(source.fileBytes) || source.bytes !== source.fileBytes) return null;
  return { kind: 'native-rollout', nativeSessionId: source.nativeSessionId,
    clientVersion: source.clientVersion, fingerprintScope: source.fingerprintScope,
    fingerprint: source.fingerprint, bytes: source.bytes, fileBytes: source.fileBytes };
}

function wrapperBase(rootAgentId, threads, binding = null) {
  return { schemaVersion: 1, scope: 'recorded-selected-thread-responses', contract: { ...CONTRACT },
    rootAgentId: validUuid(rootAgentId) ? rootAgentId : null, sourceBinding: binding,
    status: 'unavailable', reason: 'selected-thread-incomplete', values: blank(), fields: unavailableFields(), threads };
}

function aggregateThreads(rootAgentId, threads, binding = null) {
  const base = wrapperBase(rootAgentId, threads, binding);
  const records = threads.reduce((count, thread) => count + thread.records.length, 0);
  if (records > MAX_SELECTED_RECORDS || threads.some(thread => thread.status !== 'complete')) {
    base.reason = records > MAX_SELECTED_RECORDS ? 'selected-response-bound-exceeded' : 'selected-thread-incomplete';
    base.status = threads.some(thread => thread.status === 'complete') ? 'partial' : 'unavailable';
    return base;
  }
  if (!validUuid(rootAgentId) || new Set(threads.map(thread => thread.agentId)).size !== threads.length) {
    base.reason = 'selected-agent-ownership-invalid';
    return base;
  }
  const byId = new Map(threads.map(thread => [thread.agentId, thread]));
  const root = byId.get(rootAgentId);
  if (!root || root.parentId !== null) { base.reason = 'selected-root-invalid'; return base; }
  const rootTurnIds = new Set(root.turns.map(turn => turn.turnId));
  for (const thread of threads) {
    if (thread.agentId === root.agentId) continue;
    if (thread.parentId === null || !byId.has(thread.parentId)
      || thread.sessionId !== root.sessionId
      || thread.rootTurnIds.length === 0
      || thread.rootTurnIds.some(id => !rootTurnIds.has(id))) {
      base.reason = 'selected-parent-or-root-context-unverified';
      return base;
    }
    const seen = new Set([thread.agentId]);
    let current = thread;
    while (current.agentId !== root.agentId) {
      if (seen.has(current.parentId)) { base.reason = 'selected-parent-cycle'; return base; }
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      if (!current) { base.reason = 'selected-parent-or-root-context-unverified'; return base; }
    }
  }
  const totals = blankZeros();
  for (const thread of threads) {
    const next = sumCounters(totals, thread.values);
    if (!next) { base.reason = 'selected-counter-overflow'; return base; }
    Object.assign(totals, next);
  }
  base.status = 'complete'; base.reason = null; base.values = totals;
  base.fields = Object.fromEntries(FIELDS.map(field => [field, { status: 'observed',
    contributingResponses: records, responseCount: records }]));
  return base;
}

/** Build canonical aggregate summaries from projected per-thread blocks. */
export function deriveRecordedUsage({ rootAgentId, threads, source } = {}) {
  const binding = sourceBinding(source, rootAgentId);
  if (!Array.isArray(threads) || threads.length === 0 || threads.length > MAX_SELECTED_THREADS)
    return wrapperBase(rootAgentId, [], binding);
  let recordCount = 0;
  for (const thread of threads) {
    recordCount += Array.isArray(thread?.records) ? thread.records.length : 0;
    if (recordCount > MAX_SELECTED_RECORDS) {
      const bounded = wrapperBase(rootAgentId, threads.slice(0, MAX_SELECTED_THREADS).map(row =>
        unavailable('selected-response-bound-exceeded', row)), binding);
      bounded.reason = 'selected-response-bound-exceeded';
      return bounded;
    }
  }
  return aggregateThreads(rootAgentId, threads.map(projectRecordedThreadUsage), binding);
}

/** Revalidate a canonical selected-thread wrapper and its native source binding. */
export function projectRecordedUsage(value) {
  const invalid = wrapperBase(value?.rootAgentId, []);
  invalid.reason = 'projection-invalid';
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1
    || value.scope !== 'recorded-selected-thread-responses' || !value.contract
    || Object.keys(CONTRACT).some(key => value.contract[key] !== CONTRACT[key])
    || !['complete', 'partial', 'unavailable'].includes(value.status)
    || !(value.reason === null || UNAVAILABLE_REASONS.has(value.reason))
    || !(value.sourceBinding === null || sourceBinding(value.sourceBinding, value.rootAgentId)
      && JSON.stringify(value.sourceBinding) === JSON.stringify(sourceBinding(value.sourceBinding, value.rootAgentId)))
    || !value.values || typeof value.values !== 'object' || !value.fields || typeof value.fields !== 'object'
    || !Array.isArray(value.threads) || value.threads.length === 0
    || value.threads.length > MAX_SELECTED_THREADS) return invalid;
  let inputRecordCount = 0;
  for (const thread of value.threads) {
    inputRecordCount += Array.isArray(thread?.records) ? thread.records.length : 0;
    if (inputRecordCount > MAX_SELECTED_RECORDS) {
      const bounded = wrapperBase(value.rootAgentId, value.threads.slice(0, MAX_SELECTED_THREADS).map(row =>
        unavailable('selected-response-bound-exceeded', row)), sourceBinding(value.sourceBinding, value.rootAgentId));
      bounded.reason = 'selected-response-bound-exceeded';
      return bounded;
    }
  }
  const binding = sourceBinding(value.sourceBinding, value.rootAgentId);
  const rebuilt = aggregateThreads(value.rootAgentId, value.threads.map(projectRecordedThreadUsage), binding);
  if (JSON.stringify(value.sourceBinding ?? null) !== JSON.stringify(rebuilt.sourceBinding)) {
    const rejected = wrapperBase(value.rootAgentId, rebuilt.threads);
    rejected.reason = 'projection-summary-mismatch';
    return rejected;
  }
  if (value.status === 'unavailable' && value.reason === 'source-binding-unverified'
    && Object.values(value.values).every(counter => counter === null)
    && JSON.stringify(value.fields) === JSON.stringify(unavailableFields())) {
    const rejected = wrapperBase(value.rootAgentId, rebuilt.threads, binding);
    rejected.reason = 'source-binding-unverified';
    return rejected;
  }
  if (value.status === 'unavailable' && value.reason === 'selected-response-bound-exceeded'
    && rebuilt.threads.length > 0 && rebuilt.threads.every(thread => thread.status === 'unavailable'
      && thread.reason === 'selected-response-bound-exceeded')
    && Object.values(value.values).every(counter => counter === null)
    && JSON.stringify(value.fields) === JSON.stringify(unavailableFields())) {
    const rejected = wrapperBase(value.rootAgentId, rebuilt.threads, binding);
    rejected.reason = 'selected-response-bound-exceeded';
    return rejected;
  }
  if (rebuilt.status !== value.status || rebuilt.reason !== value.reason
    || (rebuilt.status === 'complete'
      ? (!sameCounters(value.values, rebuilt.values) || JSON.stringify(value.fields) !== JSON.stringify(rebuilt.fields))
      : (Object.values(value.values).some(counter => counter !== null)
        || JSON.stringify(value.fields) !== JSON.stringify(unavailableFields())))) {
    const rejected = wrapperBase(value.rootAgentId, rebuilt.threads);
    rejected.reason = 'projection-summary-mismatch';
    return rejected;
  }
  return rebuilt;
}

/** Bind a stored wrapper back to a complete, exact-source native rollout. */
export function projectRunRecordedUsage(run) {
  if (run?.source?.kind !== 'native-rollout'
    || recordedUsageAccounting(run?.source?.clientVersion) === null
    || !run?.usage?.recorded) return null;
  const projected = projectRecordedUsage(run.usage.recorded);
  const source = run.source;
  const fail = () => {
    const rejected = wrapperBase(projected.rootAgentId, projected.threads, projected.sourceBinding);
    rejected.reason = 'source-binding-unverified';
    return rejected;
  };
  if (projected.status !== 'complete' || !projected.sourceBinding
    || source.nativeSessionId !== projected.rootAgentId
    || source.fingerprintScope !== 'source-snapshot'
    || !Number.isSafeInteger(source.bytes) || source.bytes <= 0
    || !Number.isSafeInteger(source.fileBytes) || source.bytes !== source.fileBytes
    || projected.sourceBinding.fingerprint !== source.fingerprint
    || projected.sourceBinding.bytes !== source.bytes
    || projected.sourceBinding.fileBytes !== source.fileBytes
    || projected.sourceBinding.clientVersion !== source.clientVersion) return fail();
  const agents = Array.isArray(run.agents) ? run.agents : [];
  const turns = Array.isArray(run.turns) ? run.turns : [];
  const byId = new Map();
  for (const agent of agents) {
    if (!agent || !validUuid(agent.id) || byId.has(agent.id)) return fail();
    byId.set(agent.id, agent);
  }
  const root = byId.get(projected.rootAgentId);
  if (!root || root.parentId !== null) return fail();
  for (const thread of projected.threads) {
    const agent = byId.get(thread.agentId);
    const agentBinding = sourceBinding(agent?.source, thread.agentId);
    if (!agent || (agent.parentId ?? null) !== thread.parentId || agent.sessionId !== agent.id
      || !thread.sourceBinding || !agentBinding
      || JSON.stringify(thread.sourceBinding) !== JSON.stringify(agentBinding)) return fail();
    for (const turn of thread.turns) {
      const matches = turns.filter(row => row?.agentId === thread.agentId && row?.turnId === turn.turnId
        && row?.sourceLine === turn.contextLine);
      if (matches.length !== 1) return fail();
    }
  }
  return projected;
}
