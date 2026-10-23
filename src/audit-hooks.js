import { createHash } from 'node:crypto';

const MAX_ID = 256;
const MAX_NATIVE_RUN_ID = 8192;
const MAX_SOURCE = 96;
const MAX_WARNINGS = 32;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const ENUMS = {
  eventName: new Set(['preToolUse', 'permissionRequest', 'postToolUse', 'preCompact', 'postCompact', 'sessionStart', 'sessionEnd', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'interrupt']),
  handlerType: new Set(['command', 'mcpTool', 'prompt', 'agent']),
  executionMode: new Set(['sync', 'async']),
  scope: new Set(['thread', 'turn']),
  sourceKind: new Set(['system', 'user', 'project', 'mdm', 'sessionFlags', 'plugin', 'cloudRequirements', 'cloudManagedConfig', 'legacyManagedConfigFile', 'legacyManagedConfigMdm', 'unknown']),
  status: new Set(['running', 'completed', 'failed', 'blocked', 'stopped']),
};
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'stopped']);
const SPECIAL_SOURCES = new Set(['hook/started', 'hook/completed']);
const safeIdentifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ? value : null;
const opaqueRunId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_NATIVE_RUN_ID && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ? `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}` : null;
const safeSource = (value) => typeof value === 'string' && value.length <= MAX_SOURCE &&
  (SPECIAL_SOURCES.has(value) || /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) ? value : null;
const safeInt = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
const known = (field, value) => ENUMS[field].has(value);

export function createAuditHookCapture({ maxInvocations = 500 } = {}) {
  const cap = Number.isSafeInteger(maxInvocations) ? Math.max(0, Math.min(maxInvocations, 5000)) : 500;
  const records = new Map();
  const active = new Map();
  const latest = new Map();
  const occurrenceCounts = new Map();
  const seenEvents = new Set();
  const warnings = [];
  let partial = false;
  let dropped = 0;
  const warn = (message) => {
    partial = true;
    if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message);
  };

  function consume(input) {
    if (!input || !['started', 'completed'].includes(input.phase)) { warn('invalid hook notification envelope'); return false; }
    const run = input.run;
    const agentId = safeIdentifier(input.agentId);
    if (!agentId || !run || typeof run !== 'object' || Array.isArray(run)) { warn('hook notification missing safe identity or run'); return false; }
    const id = opaqueRunId(run.id);
    if (!id) { warn('hook run has invalid identifier'); return false; }
    const required = ['eventName', 'handlerType', 'executionMode', 'scope', 'status'];
    const bad = required.filter((field) => !known(field, run[field]));
    if (bad.length) { warn('hook run has invalid ' + bad.join(', ')); return false; }
    if (!known('sourceKind', run.source)) { warn('hook run has missing or invalid source kind'); return false; }
    const startedAtSeconds = safeInt(run.startedAt);
    if (startedAtSeconds === null) { warn('hook run has invalid start timestamp'); return false; }
    const completedAtSeconds = run.completedAt == null ? null : safeInt(run.completedAt);
    const durationMs = run.durationMs == null ? null : safeInt(run.durationMs, MAX_DURATION_MS);
    const turnId = input.turnId === null ? null : safeIdentifier(input.turnId);
    if (input.turnId !== null && !turnId) { warn('hook notification has invalid turn identifier'); return false; }
    const source = safeSource(input.source);
    const sourceLine = input.sourceLine == null ? null : safeInt(input.sourceLine);
    if (!source || (input.sourceLine != null && sourceLine === null)) { warn('hook notification has invalid capture location'); return false; }
    const timingContradiction = completedAtSeconds !== null && completedAtSeconds < startedAtSeconds;
    if ((run.completedAt != null && completedAtSeconds === null) || (run.durationMs != null && durationMs === null) || timingContradiction) warn('hook run has invalid timing metadata');

    const identity = `${agentId}\0${turnId === null ? '<null-turn>' : turnId}\0${id}`;
    const eventKey = sourceLine === null ? null : `${identity}\0${input.phase}\0${sourceLine}`;
    if (eventKey && seenEvents.has(eventKey)) return true;
    if (eventKey) seenEvents.add(eventKey);
    const metadata = {
      agentId, turnId, hookRunId: id, eventName: run.eventName, scope: run.scope,
      sourceKind: run.source, handlerType: run.handlerType,
      executionMode: run.executionMode, status: timingContradiction ? null : run.status,
      startedAtSeconds: timingContradiction ? null : startedAtSeconds,
      completedAtSeconds: timingContradiction ? null : completedAtSeconds,
      durationMs: timingContradiction ? null : durationMs, source, sourceLine,
    };
    let currentKey = input.phase === 'completed' ? active.get(identity)?.key : null;
    let current = currentKey ? records.get(currentKey) : null;
    const createOccurrence = (uncertain = false) => {
      if (records.size >= cap) { dropped++; warn('hook invocation limit reached'); return null; }
      const occurrenceIndex = occurrenceCounts.get(identity) ?? 0;
      occurrenceCounts.set(identity, occurrenceIndex + 1);
      const recordKey = `${identity}\0${occurrenceIndex}`;
      records.set(recordKey, { ...metadata, occurrenceIndex, uncertain });
      latest.set(identity, recordKey);
      return recordKey;
    };

    if (input.phase === 'started') {
      const activeRun = active.get(identity);
      const activeKey = activeRun?.key;
      if (activeKey) {
        const previous = records.get(activeKey);
        if (previous) {
          previous.status = null;
          previous.startedAtSeconds = null;
          previous.completedAtSeconds = null;
          previous.durationMs = null;
          previous.uncertain = true;
        }
        currentKey = createOccurrence(true);
        if (currentKey) {
          Object.assign(records.get(currentKey), { status: null, startedAtSeconds: null, completedAtSeconds: null, durationMs: null });
        }
        // Keep the ambiguity active until every outstanding start has a completion.
        active.set(identity, { key: currentKey ?? activeKey, pending: activeRun.pending + 1 });
        warn('overlapping indistinguishable hook runs');
        return Boolean(currentKey);
      }
      currentKey = createOccurrence(false);
      if (currentKey) {
        active.set(identity, { key: currentKey, pending: 1 });
      }
      return Boolean(currentKey);
    }

    if (!current) {
      const latestKey = latest.get(identity);
      const latestRecord = latestKey ? records.get(latestKey) : null;
      if (latestRecord?.uncertain) return true;
      if (latestRecord && latestRecord.startedAtSeconds === startedAtSeconds) {
        currentKey = latestKey;
        current = latestRecord;
      } else {
        currentKey = createOccurrence(false);
        current = currentKey ? records.get(currentKey) : null;
      }
    }
    if (!current) return false;
    const activeRun = active.get(identity);
    if (activeRun?.key === currentKey) {
      if (activeRun.pending > 1) activeRun.pending--;
      else active.delete(identity);
    }
    if (timingContradiction) {
      current.status = null;
      current.startedAtSeconds = null;
      current.completedAtSeconds = null;
      current.durationMs = null;
      current.uncertain = true;
      return true;
    }
    if (current.uncertain) return true;
    const stableFields = ['agentId', 'hookRunId', 'eventName', 'scope', 'sourceKind', 'handlerType', 'executionMode', 'startedAtSeconds'];
    if (stableFields.some((field) => current[field] !== metadata[field]) || (current.turnId !== metadata.turnId && current.turnId !== null && metadata.turnId !== null)) {
      current.status = null;
      current.startedAtSeconds = null;
      current.completedAtSeconds = null;
      current.durationMs = null;
      if (current.turnId !== metadata.turnId) current.turnId = null;
      current.uncertain = true;
      warn('conflicting lifecycle metadata for hook run');
      return true;
    }
    // A null turn id is meaningful native evidence and must not be filled from another event.
    if (TERMINAL.has(current.status) && TERMINAL.has(metadata.status) && current.status !== metadata.status) {
      current.status = null;
      current.startedAtSeconds = null;
      current.completedAtSeconds = null;
      current.durationMs = null;
      current.uncertain = true;
      warn('contradictory terminal hook statuses');
      return false;
    }
    if (TERMINAL.has(current.status) && metadata.status === 'running') return true;
    if (TERMINAL.has(current.status) && TERMINAL.has(metadata.status) &&
        ((current.completedAtSeconds !== null && metadata.completedAtSeconds !== null && current.completedAtSeconds !== metadata.completedAtSeconds) ||
         (current.durationMs !== null && metadata.durationMs !== null && current.durationMs !== metadata.durationMs))) {
      current.status = null;
      current.startedAtSeconds = null;
      current.completedAtSeconds = null;
      current.durationMs = null;
      current.uncertain = true;
      warn('conflicting hook completion timing');
      return true;
    }
    if (input.phase === 'completed' || TERMINAL.has(metadata.status)) {
      current.status = metadata.status;
      current.completedAtSeconds = metadata.completedAtSeconds ?? current.completedAtSeconds;
      current.durationMs = metadata.durationMs ?? current.durationMs;
    }
    return true;
  }

  function result() {
    return {
      hookInvocations: [...records.values()].map(({ uncertain, ...record }) => ({ ...record })),
      coverage: { hooks: partial || dropped > 0 ? 'partial' : records.size === 0 ? 'none-recorded' : 'observed' },
      warnings: warnings.slice(),
    };
  }

  return { consume, result };
}
