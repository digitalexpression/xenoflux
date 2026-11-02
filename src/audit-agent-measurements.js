import { projectRunRecordedUsage } from './audit-recorded-usage.js';
import { summarizeWorkflowUsage } from './audit-usage.js';

const emptyCounters = () => ({ input: null, cachedInput: null, output: null, reasoning: null, total: null });
const safeCounter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const SOURCE_FIELDS = Object.freeze({ input: ['inputTokens', 'input_tokens'], cachedInput: ['cachedInputTokens', 'cached_input_tokens'],
  output: ['outputTokens', 'output_tokens'], reasoning: ['reasoningOutputTokens', 'reasoning_output_tokens'],
  total: ['totalTokens', 'total_tokens'] });

function actorName(agent, childIndex) {
  if (typeof agent.name === 'string' && agent.name.trim()) return agent.name.trim();
  if (agent.role === 'root' || agent.parentId === null) return 'Main session';
  return agent.depth > 1 ? `Nested child ${childIndex}` : `Child session ${childIndex}`;
}

function turnSpan(turns, id) {
  const owned = turns.filter(turn => turn?.agentId === id);
  if (!owned.length) return null;
  const boundaries = owned.map(turn => ({ start: Date.parse(turn?.observedStartedAt), end: Date.parse(turn?.observedCompletedAt) }));
  if (boundaries.some(row => !Number.isFinite(row.start) || !Number.isFinite(row.end) || row.end < row.start))
    return { durationMs: null, timingNote: 'Recorded turn start or completion timestamps are incomplete.' };
  const start = Math.min(...boundaries.map(row => row.start));
  const end = Math.max(...boundaries.map(row => row.end));
  return { durationMs: end - start, timingNote: `Recorded turn start to completion span; not active working time${owned.length > 1 ? ` across ${owned.length} turns` : ''}.` };
}

function observedSpan(session, turns, id) {
  const events = Array.isArray(session?.events) ? session.events : null;
  const missing = reason => turnSpan(turns, id) ?? { durationMs: null, timingNote: reason };
  if (!events?.length) return missing('No recorded replay events for this session.');
  const timestamps = events.map(event => Date.parse(event?.timestamp)).filter(Number.isFinite);
  if (timestamps.length < 2) return missing(timestamps.length
    ? 'Elapsed span needs at least two timestamped events.' : 'Replay events have no usable timestamps.');
  const durationMs = Math.max(...timestamps) - Math.min(...timestamps);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0)
    return { durationMs: null, timingNote: 'A valid elapsed span could not be derived from event timestamps.' };
  const gapNote = timestamps.length === events.length ? '' : ` Only ${timestamps.length} of ${events.length} events had usable timestamps.`;
  return { durationMs, timingNote: `First to last recorded replay event; not active working time.${gapNote}` };
}

function countersFromSource(source) {
  const counters = emptyCounters();
  for (const [field, aliases] of Object.entries(SOURCE_FIELDS)) {
    const found = aliases.filter(name => Object.hasOwn(source, name));
    if (found.length > 1 && source[found[0]] !== source[found[1]]) return {
      counters, inconsistent: true, malformed: false };
    if (found.length) counters[field] = safeCounter(source[found[0]]);
  }
  let inconsistent = false;
  if (counters.input !== null && counters.output !== null && counters.total !== null) {
    const sum = counters.input + counters.output;
    if (!Number.isSafeInteger(sum) || sum !== counters.total) {
      counters.input = counters.output = counters.total = null;
      inconsistent = true;
    }
  }
  if (counters.cachedInput !== null && counters.input !== null && counters.cachedInput > counters.input) {
    counters.cachedInput = null;
    inconsistent = true;
  }
  if (counters.reasoning !== null && counters.output !== null && counters.reasoning > counters.output) {
    counters.reasoning = null;
    inconsistent = true;
  }
  const malformed = Object.values(SOURCE_FIELDS).flat().some(field => source[field] !== null
    && source[field] !== undefined && safeCounter(source[field]) === null);
  return { counters, inconsistent, malformed };
}

function recordedThreadCounters(run, id, parentId) {
  const aggregate = projectRunRecordedUsage(run);
  if (!aggregate || aggregate.scope !== 'recorded-selected-thread-responses' || aggregate.status !== 'complete') return null;
  const matching = aggregate.threads.filter(thread => thread?.agentId === id);
  if (matching.length !== 1) return null;
  const thread = matching[0];
  if (thread.status !== 'complete' || thread.parentId !== parentId || !thread.sourceBinding
    || thread.sourceBinding.nativeSessionId !== id || thread.sourceBinding.clientVersion !== aggregate.contract.version
    || !thread.values || typeof thread.values !== 'object') return null;
  const projected = countersFromSource(thread.values);
  if (projected.inconsistent || projected.malformed || Object.values(projected.counters).some(value => value === null)) return null;
  return { counters: projected.counters,
    usageNote: 'Summed from recorded responses belonging to this session under the captured thread-owned response contract.' };
}

function agentUsageRows(usage) {
  const rows = Array.isArray(usage?.byAgent) ? usage.byAgent : [];
  const map = new Map(), ambiguous = new Set();
  for (const row of rows) {
    if (typeof row?.agentId !== 'string') continue;
    if (map.has(row.agentId)) ambiguous.add(row.agentId);
    else map.set(row.agentId, row);
  }
  return { map, ambiguous };
}

function actorCounters(run, byAgent, ambiguousByAgent, id, parentId, validatedNative) {
  const usage = run?.usage;
  const thread = recordedThreadCounters(run, id, parentId);
  if (thread) return thread;
  const direct = usage?.[id];
  let record = direct, source = direct?.total;
  if (!record && !ambiguousByAgent.has(id)) {
    record = byAgent.get(id);
    source = record?.total ?? record?.totals?.values;
  }
  if (!record || ambiguousByAgent.has(id)) return { counters: emptyCounters(),
    usageNote: ambiguousByAgent.has(id) ? 'More than one source row has this session identity; usage cannot be attributed.'
      : 'Token usage was not recorded for this session.' };
  if (!source || typeof source !== 'object') return { counters: emptyCounters(),
    usageNote: 'Per-session source-reported token counters are unavailable.' };
  const projected = countersFromSource(source);
  const snapshotNote = Number.isSafeInteger(record.snapshots) && record.snapshots >= 0
    ? ` ${record.snapshots} cumulative snapshots were captured.` : '';
  const sourceScope = record.scope ?? record.totals?.scope ?? 'not specified';
  const baselineNote = parentId === null ? '' : ' The child starting baseline is not independently verified.';
  const note = projected.inconsistent || projected.malformed
    ? `Source-reported per-session counters contain invalid or inconsistent fields; affected values are hidden.${snapshotNote}`
    : validatedNative ? `Validated independently owned session counters under the captured Codex accounting contract.${snapshotNote}`
      : `Source-reported per-session counters (scope: ${sourceScope}). They are not a validated workflow contribution.${baselineNote}${snapshotNote}`;
  return { counters: projected.counters, usageNote: note };
}

/**
 * Project source-reported measurements for each captured replay actor.
 * Agent spans are first-to-last event timestamps, and may overlap. Per-agent
 * token values are retained as reported; this helper never sums workflow usage.
 */
export function presentAgentMeasurements(run) {
  const agents = Array.isArray(run?.agents) ? run.agents : [];
  if (!agents.length) return [];
  const counts = new Map();
  for (const agent of agents) {
    if (!agent || typeof agent.id !== 'string' || !agent.id || counts.has(agent.id)) return [];
    counts.set(agent.id, 0);
  }
  const sessions = Array.isArray(run?.sessionReplay?.sessions) ? run.sessionReplay.sessions : [];
  const usageRows = agentUsageRows(run?.usage);
  const validatedNative = summarizeWorkflowUsage(run)?.status === 'complete';
  const sessionsById = new Map();
  const ambiguousSessions = new Set();
  for (const session of sessions) {
    if (typeof session?.id !== 'string') continue;
    if (sessionsById.has(session.id)) ambiguousSessions.add(session.id);
    else sessionsById.set(session.id, session);
  }
  const childIndexes = new Map();
  return agents.map(agent => {
    const childIndex = (childIndexes.get(agent.parentId) ?? 0) + 1;
    childIndexes.set(agent.parentId, childIndex);
    const session = ambiguousSessions.has(agent.id) ? null : sessionsById.get(agent.id);
    const span = observedSpan(session, Array.isArray(run?.turns) ? run.turns : [], agent.id);
    const usage = actorCounters(run, usageRows.map, usageRows.ambiguous, agent.id, agent.parentId ?? null, validatedNative);
    return {
      id: agent.id,
      parentId: typeof agent.parentId === 'string' ? agent.parentId : null,
      name: actorName(agent, childIndex),
      role: agent.role === 'root' || agent.parentId === null ? 'root' : 'child',
      durationMs: span.durationMs,
      timingNote: ambiguousSessions.has(agent.id)
        ? `Replay session identity is ambiguous; ${span.timingNote}` : span.timingNote,
      counters: usage.counters,
      usageNote: usage.usageNote,
    };
  });
}

