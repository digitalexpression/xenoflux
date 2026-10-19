// Shared, conservative normalization for source-reported token snapshots.
// `last` is retained as a snapshot; this module does not assign turn-increment
// semantics to it.
export const USAGE_FIELDS = Object.freeze([
  'inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens',
  'cacheWriteInputTokens', 'totalTokens',
]);

const NATIVE_USAGE_CONTRACT = Object.freeze({
  contract: 'codex-thread-own-cumulative-v1',
  version: '0.163.0-alpha.10.2',
  historyMode: 'paginated',
  freshThread: true,
  childCountersStartAtZero: true,
  sourceRevision: 'd9151c94a70013f176ff370fa93da02734662e41',
});

/** Return the verified source contract only for the exact inspected native version. */
export function nativeUsageAccounting(version) {
  return version === NATIVE_USAGE_CONTRACT.version ? { ...NATIVE_USAGE_CONTRACT } : null;
}

const nullCounters = () => Object.fromEntries(USAGE_FIELDS.map(field => [field, null]));
const unavailableFields = () => Object.fromEntries(USAGE_FIELDS.map(field => [field,
  { status: 'unavailable', contributingAgents: 0, agentCount: 0 }]));
const safeCounter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function verifiedAccounting(value) {
  return value && typeof value === 'object' && Object.entries(NATIVE_USAGE_CONTRACT)
    .every(([key, expected]) => value[key] === expected);
}

function workflowUsageResult(status, reason, contract = null) {
  return { status, scope: 'captured-workflow-agents', reason, contract: contract ? { ...contract } : null,
    values: nullCounters(), fields: unavailableFields() };
}

function ownedAgentTree(run) {
  const agents = Array.isArray(run?.agents) ? run.agents : [];
  const rootId = run?.source?.threadId;
  if (!rootId || !agents.length || run?.coverage?.agents !== 'complete') return null;
  const byId = new Map();
  for (const agent of agents) {
    if (!agent || typeof agent.id !== 'string' || !agent.id || byId.has(agent.id)
      || agent.status === 'unavailable' || agent.status === 'partial') return null;
    byId.set(agent.id, agent);
  }
  const root = byId.get(rootId);
  if (!root || root.parentId !== null || root.depth !== 0) return null;
  for (const agent of agents) {
    if (agent.id === rootId) continue;
    if (typeof agent.parentId !== 'string' || !byId.has(agent.parentId)) return null;
    const seen = new Set([agent.id]);
    let current = agent;
    while (current.id !== rootId) {
      if (seen.has(current.parentId)) return null;
      seen.add(current.parentId);
      current = byId.get(current.parentId);
      if (!current) return null;
    }
  }
  return [...byId.keys()];
}

function contextBudgetExceeded(run) {
  if ((Array.isArray(run?.events) && run.events.some(event => event?.errorCode === 'contextWindowExceeded'))
    || (Array.isArray(run?.warnings) && run.warnings.some(warning => typeof warning === 'string'
      && /context.{0,40}(?:window|budget)|(?:window|budget).{0,40}context/i.test(warning)))) return true;
  return false;
}

const INCOMPLETE_CAPTURE_WARNINGS = new Set([
  'event-limit', 'item-limit', 'notification-limit', 'linked-agent-limit', 'pending-child-event-limit',
  'deferred-agent-link-limit', 'unresolved-agent-links', 'unverified-child-link', 'unverified-child-status',
  'linked-child-incomplete', 'linked-child-items-incomplete', 'linked-child-page-limit',
  'linked-child-page-cursor-invalid', 'linked-child-page-cursor-repeated', 'linked-child-turns-malformed',
  'linked-child-items-malformed', 'linked-child-items-not-full', 'root-turn-incomplete',
  'root-turn-completion-missing', 'app-server-capture-failed', 'invalid-app-server-json',
]);

function captureIncomplete(run) {
  if (run?.capture?.capped === true || run?.capture?.truncated === true || run?.capped === true) return true;
  return Array.isArray(run?.warnings) && run.warnings.some(warning => {
    if (typeof warning !== 'string') return false;
    const code = warning.includes(': ') ? warning.slice(warning.indexOf(': ') + 2) : warning;
    return INCOMPLETE_CAPTURE_WARNINGS.has(code) || /\b(?:truncated|truncation)\b/i.test(code);
  });
}

function streamCountersConsistent(row, stream) {
  const values = row?.[stream] ?? {};
  for (const field of USAGE_FIELDS) {
    const raw = values[field];
    if (raw !== null && raw !== undefined && safeCounter(raw) === null) return false;
  }
  const input = safeCounter(values.inputTokens), output = safeCounter(values.outputTokens), total = safeCounter(values.totalTokens);
  if (input !== null && output !== null && total !== null) {
    const sum = input + output;
    if (!Number.isSafeInteger(sum) || sum !== total) return false;
  }
  const cached = safeCounter(values.cachedInputTokens), reasoning = safeCounter(values.reasoningOutputTokens);
  if (cached !== null && input !== null && cached > input) return false;
  if (reasoning !== null && output !== null && reasoning > output) return false;
  return true;
}

function usageRows(run, agentIds) {
  const usage = run?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const observations = usage.observations;
  const omitted = value => Number.isSafeInteger(value) ? value > 0 : value !== undefined && value !== null;
  if (!Array.isArray(observations) || omitted(usage.observationsOmitted)
    || omitted(run?.evidenceBounds?.omitted?.usageObservations)) return null;
  const frozen = Array.isArray(usage.byAgent) ? usage.byAgent : null;
  if (frozen && (omitted(usage.byAgentOmitted) || omitted(run?.evidenceBounds?.omitted?.usageAgents))) return null;
  const byAgent = new Map();
  if (frozen) {
    for (const row of frozen) {
      if (!row || typeof row.agentId !== 'string' || byAgent.has(row.agentId)) return null;
      byAgent.set(row.agentId, row);
    }
  }
  const counters = new Map(agentIds.map(id => [id, nullCounters()]));
  const turnUsage = new Set();
  const sourceRows = [];
  for (const row of observations) {
    if (!row || typeof row.agentId !== 'string' || !counters.has(row.agentId)
      || typeof row.turnId !== 'string' || !row.turnId
      || !['accepted', 'duplicate'].includes(row.disposition)) return null;
    if (Array.isArray(row.invalidFields?.total) && row.invalidFields.total.length
      || Array.isArray(row.invalidFields?.last) && row.invalidFields.last.length
      || Array.isArray(row.malformedFields?.total) && row.malformedFields.total.length
      || Array.isArray(row.malformedFields?.last) && row.malformedFields.last.length) return null;
    if (!streamCountersConsistent(row, 'last') || !streamCountersConsistent(row, 'total')) return { inconsistent: true };
    sourceRows.push(row);
  }
  const reassessed = assessUsageSequence(sourceRows).observations;
  if (reassessed.some(row => !['accepted', 'duplicate'].includes(row.disposition))) return null;
  for (const row of reassessed) {
    let usable = false;
    const final = counters.get(row.agentId);
    for (const field of USAGE_FIELDS) {
      const value = safeCounter(row.total?.[field]);
      final[field] = value;
      if (value !== null) usable = true;
      else if (row.total?.[field] !== null && row.total?.[field] !== undefined) return null;
    }
    if (usable) turnUsage.add(`${row.agentId}\0${row.turnId}`);
  }
  // Validate any available summary against the ordered observations. The
  // observations remain the authority for field-by-field final values.
  for (const id of agentIds) {
    const summaries = [usage[id], byAgent.get(id)].filter(summary => summary && typeof summary === 'object');
    if (!summaries.length) return null;
    for (const field of USAGE_FIELDS) {
      const observed = counters.get(id)[field];
      for (const summary of summaries) {
        const total = summary.total ?? summary.totals?.values;
        if (!total || !Object.hasOwn(total, field)) continue;
        const raw = total[field];
        const reported = safeCounter(raw);
        if (raw !== null && raw !== undefined && reported === null) return null;
        if (reported !== observed) return null;
      }
    }
  }
  return { counters, turnUsage };
}

/**
 * Sum verified final cumulative counters once per captured, owned agent.
 * This intentionally excludes opaque external activity and billing totals.
 */
export function summarizeWorkflowUsage(run) {
  const accounting = run?.usage?.accounting;
  if (!verifiedAccounting(accounting)) return workflowUsageResult('unavailable', 'accounting-contract-unverified');
  const contract = { ...NATIVE_USAGE_CONTRACT };
  const sourceVersion = run?.source?.version ?? run?.source?.accountingVersion;
  if (run?.source?.kind !== 'native-app-server-v2' || sourceVersion !== contract.version
    || run?.source?.historyMode !== contract.historyMode || run?.source?.freshThread !== contract.freshThread)
    return workflowUsageResult('unavailable', 'accounting-contract-unverified', contract);
  if (run?.coverage?.usage !== 'complete' || run?.coverage?.timeline !== 'complete'
    || contextBudgetExceeded(run) || captureIncomplete(run))
    return workflowUsageResult('unavailable', contextBudgetExceeded(run) ? 'native-context-budget-exceeded'
      : captureIncomplete(run) ? 'capture-incomplete' : 'usage-coverage-incomplete', contract);
  const agentIds = ownedAgentTree(run);
  if (!agentIds) return workflowUsageResult('unavailable', 'owned-agent-tree-incomplete', contract);
  const turns = Array.isArray(run.turns) ? run.turns : [];
  const terminal = new Set(['completed', 'failed', 'interrupted', 'systemError', 'cancelled']);
  const turnKeys = new Set();
  const terminalTurnIds = new Set();
  const turnsByAgent = new Map(agentIds.map(id => [id, 0]));
  for (const turn of turns) {
    if (!turn || !turnsByAgent.has(turn.agentId) || typeof turn.turnId !== 'string' || !turn.turnId
      || !terminal.has(turn.status)) return workflowUsageResult('unavailable', 'turn-sequence-incomplete', contract);
    const key = `${turn.agentId}\0${turn.turnId}`;
    if (turnKeys.has(key)) return workflowUsageResult('unavailable', 'turn-sequence-incomplete', contract);
    turnKeys.add(key);
    terminalTurnIds.add(key);
    turnsByAgent.set(turn.agentId, turnsByAgent.get(turn.agentId) + 1);
  }
  if ([...turnsByAgent.values()].some(count => count === 0))
    return workflowUsageResult('unavailable', 'turn-sequence-incomplete', contract);
  const usage = usageRows(run, agentIds);
  if (usage?.inconsistent) return workflowUsageResult('unavailable', 'source-counter-inconsistent', contract);
  if (!usage || [...turnKeys].some(key => !usage.turnUsage.has(key))
    || [...usage.turnUsage].some(key => !terminalTurnIds.has(key)))
    return workflowUsageResult('unavailable', 'usage-sequence-incomplete', contract);

  const perAgent = [...usage.counters.values()];
  for (const counters of perAgent) {
    const input = counters.inputTokens, output = counters.outputTokens, total = counters.totalTokens;
    if (input !== null && output !== null && total !== null) {
      const sum = input + output;
      if (!Number.isSafeInteger(sum) || sum !== total) return workflowUsageResult('unavailable', 'source-counter-inconsistent', contract);
    }
    if (counters.cachedInputTokens !== null && input !== null && counters.cachedInputTokens > input)
      return workflowUsageResult('unavailable', 'source-counter-inconsistent', contract);
    if (counters.reasoningOutputTokens !== null && output !== null && counters.reasoningOutputTokens > output)
      return workflowUsageResult('unavailable', 'source-counter-inconsistent', contract);
  }

  const values = nullCounters(), fields = {};
  let incomplete = false;
  for (const field of USAGE_FIELDS) {
    const present = perAgent.map(row => row[field]).filter(value => value !== null);
    let sum = 0, overflow = false;
    for (const value of present) {
      sum += value;
      if (!Number.isSafeInteger(sum)) { overflow = true; break; }
    }
    const complete = present.length === agentIds.length && !overflow;
    if (complete) values[field] = sum;
    else incomplete = true;
    fields[field] = { status: overflow ? 'invalid' : complete ? 'observed' : present.length ? 'partial' : 'unavailable',
      contributingAgents: present.length, agentCount: agentIds.length };
  }
  return { status: incomplete ? 'partial' : 'complete', scope: 'captured-workflow-agents',
    reason: incomplete ? 'usage-fields-incomplete' : null, contract, values, fields,
    derivation: { method: 'sum-final-owned-thread-counters-once', basis: 'full-capture-before-export-bounds',
      agents: agentIds.length, turns: turnKeys.size, observations: run.usage.observations.length } };
}

/**
 * Derive native turn usage only from cumulative thread snapshots captured in
 * source order for the exact fresh-thread contract. `last` is one response's
 * snapshot, so only `total` boundaries can establish a complete turn delta.
 */
export function summarizeTurnUsage(run) {
  const unavailable = (reason, contract = null) => ({ status: 'unavailable',
    scope: 'captured-owned-thread-turns', reason, contract: contract ? { ...contract } : null,
    turns: [], derivation: null });
  const workflow = summarizeWorkflowUsage(run);
  if (workflow.status === 'unavailable') return unavailable(workflow.reason, workflow.contract);
  const contract = workflow.contract;
  const observations = run?.usage?.observations;
  if (!Array.isArray(observations) || observations.some(row => row.source !== 'thread/tokenUsage/updated'))
    return unavailable('native-turn-source-unverified', contract);

  const byAgentTurns = new Map();
  for (const turn of run.turns) {
    const list = byAgentTurns.get(turn.agentId) ?? [];
    list.push(turn);
    byAgentTurns.set(turn.agentId, list);
  }
  const turnIndex = new Map();
  for (const [agentId, turns] of byAgentTurns) turns.forEach((turn, index) =>
    turnIndex.set(`${agentId}\0${turn.turnId}`, index));

  // Per-thread source order must match the terminal turn sequence. Otherwise
  // an apparently valid pair of cumulative values could straddle hidden work.
  const lastIndex = new Map();
  const boundaries = new Map();
  let previousSourceLine = null;
  for (const row of observations) {
    const key = `${row.agentId}\0${row.turnId}`;
    const index = turnIndex.get(key);
    if (index === undefined || (lastIndex.has(row.agentId) && index < lastIndex.get(row.agentId))
      || !Number.isSafeInteger(row.sourceLine) || (previousSourceLine !== null && row.sourceLine <= previousSourceLine))
      return unavailable('turn-boundary-order-unverified', contract);
    previousSourceLine = row.sourceLine;
    lastIndex.set(row.agentId, index);
    const rows = boundaries.get(key) ?? [];
    rows.push(row);
    boundaries.set(key, rows);
  }

  const turns = [];
  let anyPartial = false;
  for (const [agentId, agentTurns] of byAgentTurns) {
    let prior = Object.fromEntries(USAGE_FIELDS.map(field => [field, 0]));
    let priorKnown = Object.fromEntries(USAGE_FIELDS.map(field => [field, true]));
    for (let index = 0; index < agentTurns.length; index++) {
      const turn = agentTurns[index], key = `${agentId}\0${turn.turnId}`;
      const rows = boundaries.get(key) ?? [];
      if (!rows.length) return unavailable('turn-boundary-missing', contract);
      const terminal = rows.at(-1);
      const values = nullCounters(), fields = {}, baseline = {}, source = {
        sourceObservations: rows.map(row => ({ source: row.source, sourceLine: row.sourceLine })),
      };
      let complete = true;
      for (const field of USAGE_FIELDS) {
        baseline[field] = priorKnown[field] ? prior[field] : null;
        const current = safeCounter(terminal.total?.[field]);
        if (current === null) {
          complete = false;
          priorKnown[field] = false;
          fields[field] = { status: 'unavailable', reason: 'terminal-counter-missing' };
          continue;
        }
        if (!priorKnown[field]) {
          complete = false;
          fields[field] = { status: 'unavailable', reason: 'prior-turn-boundary-missing' };
          continue;
        }
        const delta = current - prior[field];
        if (!Number.isSafeInteger(delta) || delta < 0) {
          complete = false;
          priorKnown[field] = false;
          fields[field] = { status: 'invalid', reason: 'counter-regressed-or-overflowed' };
          continue;
        }
        values[field] = delta;
        fields[field] = { status: 'observed', reason: null };
        prior[field] = current;
      }
      const invalidate = (field, reason) => {
        values[field] = null;
        fields[field] = { status: 'invalid', reason };
        complete = false;
      };
      if (values.inputTokens !== null && values.outputTokens !== null && values.totalTokens !== null) {
        const expectedTotal = values.inputTokens + values.outputTokens;
        if (!Number.isSafeInteger(expectedTotal) || expectedTotal !== values.totalTokens)
          invalidate('totalTokens', 'turn-counter-inconsistent');
      }
      if (values.cachedInputTokens !== null && values.inputTokens !== null
        && values.cachedInputTokens > values.inputTokens)
        invalidate('cachedInputTokens', 'turn-counter-inconsistent');
      if (values.reasoningOutputTokens !== null && values.outputTokens !== null
        && values.reasoningOutputTokens > values.outputTokens)
        invalidate('reasoningOutputTokens', 'turn-counter-inconsistent');
      if (!complete) anyPartial = true;
      turns.push({ agentId, turnId: turn.turnId, status: complete ? 'complete' : 'partial',
        values, fields, baseline, derivation: { method: 'difference-cumulative-thread-boundaries',
          initialBaseline: index === 0 ? 'verified-fresh-thread-zero' : 'prior-terminal-boundary',
          sourceObservations: source.sourceObservations } });
    }
  }
  return { status: anyPartial ? 'partial' : 'complete', scope: 'captured-owned-thread-turns',
    reason: anyPartial ? 'turn-fields-incomplete' : null, contract, turns,
    derivation: { method: 'difference-cumulative-thread-boundaries',
      basis: 'verified-fresh-owned-thread-counters', agents: byAgentTurns.size,
      turns: turns.length, observations: observations.length } };
}

const ALIASES = Object.freeze({
  inputTokens: ['inputTokens', 'input_tokens', 'input'],
  outputTokens: ['outputTokens', 'output_tokens', 'output'],
  cachedInputTokens: ['cachedInputTokens', 'cached_input_tokens', 'cached_input'],
  reasoningOutputTokens: ['reasoningOutputTokens', 'reasoning_output_tokens', 'reasoning_output'],
  cacheWriteInputTokens: ['cacheWriteInputTokens', 'cache_write_input_tokens', 'cache_write'],
  totalTokens: ['totalTokens', 'total_tokens', 'total'],
});

function project(value) {
  const result = Object.fromEntries(USAGE_FIELDS.map(field => [field, null]));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { values: result, present: false, invalid: [] };
  const invalid = [];
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const key = aliases.find(candidate => Object.hasOwn(value, candidate));
    const n = key === undefined ? null : value[key];
    if (Number.isSafeInteger(n) && n >= 0) result[field] = n;
    else if (key !== undefined && n !== null) invalid.push(field);
  }
  return { values: result, present: true, invalid };
}

export function normalizeUsageSnapshot({ agentId = null, turnId = null, source = 'unknown', sourceLine = null,
  recordedAt = null, last = null, total = null, modelContextWindow = null, scope = null, invalidFields = null } = {}) {
  const lastProjection = project(last), totalProjection = project(total);
  return {
    agentId, turnId, source, sourceLine, recordedAt, ...(scope ? { scope } : {}), mode: 'snapshot',
    last: lastProjection.values, total: totalProjection.values,
    modelContextWindow: Number.isSafeInteger(modelContextWindow) && modelContextWindow >= 0 ? modelContextWindow : null,
    present: { last: lastProjection.present, total: totalProjection.present,
      modelContextWindow: modelContextWindow !== null && modelContextWindow !== undefined },
    malformedFields: { last: [...new Set([...lastProjection.invalid, ...(invalidFields?.last ?? [])])],
      total: [...new Set([...totalProjection.invalid, ...(invalidFields?.total ?? [])])] },
    invalidFields: { last: [], total: [] },
    disposition: agentId === null ? 'unattributed' : 'accepted',
  };
}

// Input order is source order. Only cumulative `total` counters are checked
// for continuity; `last` is never treated as additive or turn-scoped.
export function assessUsageSequence(input = []) {
  const previous = new Map(), seen = new Set();
  const observations = input.map(raw => ({ ...raw,
    last: { ...Object.fromEntries(USAGE_FIELDS.map(f => [f, null])), ...(raw.last ?? {}) },
    total: { ...Object.fromEntries(USAGE_FIELDS.map(f => [f, null])), ...(raw.total ?? {}) },
    present: { last: false, total: false, modelContextWindow: false, ...(raw.present ?? {}) },
    invalidFields: { last: [], total: [], ...(raw.invalidFields ?? {}) },
    malformedFields: { last: [], total: [], ...(raw.malformedFields ?? {}) },
  }));
  for (const row of observations) {
    if (typeof row.agentId !== 'string' || !row.agentId) { row.disposition = 'unattributed'; continue; }
    const key = `${row.agentId}\0${row.turnId ?? ''}\0${JSON.stringify([row.last, row.total, row.modelContextWindow, row.present, row.malformedFields])}`;
    if (seen.has(key)) { row.disposition = 'duplicate'; continue; }
    seen.add(key);
    const prior = previous.get(row.agentId) ?? { turnId: null, total: {} };
    let decreased = false, crossTurn = false, inconsistent = false;
    for (const field of USAGE_FIELDS) {
      const a = prior.total[field], b = row.total[field];
      if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && b < a) {
        decreased = true;
        crossTurn ||= Boolean(prior.turnId && row.turnId && prior.turnId !== row.turnId);
        row.invalidFields.total.push(field);
      }
      if (Number.isSafeInteger(row.last[field]) && Number.isSafeInteger(b) && row.last[field] > b) {
        inconsistent = true;
        row.invalidFields.total.push(field);
      }
    }
    const malformed = row.malformedFields.last.length > 0 || row.malformedFields.total.length > 0;
    if (malformed) {
      row.invalidFields.last.push(...row.malformedFields.last);
      row.invalidFields.total.push(...row.malformedFields.total);
    }
    if (malformed) row.disposition = 'invalid';
    else if (decreased) row.disposition = crossTurn ? 'reset' : 'regressed';
    else if (inconsistent) row.disposition = 'inconsistent';
    // Missing fields do not erase the prior cumulative value. Once a counter
    // drops, retain the prior baseline so subsequent snapshots stay guarded.
    const next = { turnId: row.turnId ?? prior.turnId, total: { ...prior.total } };
    if (row.disposition === 'accepted' || row.disposition === 'duplicate')
      for (const field of USAGE_FIELDS) if (Number.isSafeInteger(row.total[field])) next.total[field] = row.total[field];
    if (row.disposition === 'accepted' || row.disposition === 'duplicate') previous.set(row.agentId, next);
  }
  const byAgent = {};
  for (const row of observations) {
    const key = row.agentId ?? 'unattributed';
    const entry = byAgent[key] ??= { observations: 0, accepted: 0, duplicates: 0, regressed: 0, resets: 0, inconsistent: 0, invalid: 0,
      fields: { last: Object.fromEntries(USAGE_FIELDS.map(f => [f, { present: 0, missing: 0, invalid: 0 }])),
        total: Object.fromEntries(USAGE_FIELDS.map(f => [f, { present: 0, missing: 0, invalid: 0 }])),
        modelContextWindow: { present: 0, missing: 0, invalid: 0 } } };
    entry.observations++;
    if (row.disposition === 'accepted') entry.accepted++;
    else if (row.disposition === 'duplicate') entry.duplicates++;
    else if (row.disposition === 'regressed') entry.regressed++;
    else if (row.disposition === 'reset') entry.resets++;
    else if (row.disposition === 'inconsistent') entry.inconsistent++;
    else if (row.disposition === 'invalid') entry.invalid++;
    for (const stream of ['last', 'total']) for (const field of USAGE_FIELDS) {
      if (row.present[stream] && row[stream][field] !== null) entry.fields[stream][field].present++;
      else entry.fields[stream][field].missing++;
      if (row.invalidFields[stream].includes(field)) entry.fields[stream][field].invalid++;
    }
    if (row.present.modelContextWindow && row.modelContextWindow !== null) entry.fields.modelContextWindow.present++;
    else entry.fields.modelContextWindow.missing++;
    row.coverage = { last: Object.fromEntries(Object.entries(entry.fields.last).map(([field, stats]) => [field,
      stats.invalid ? 'invalidated' : stats.present ? 'observed' : 'missing'])),
      total: Object.fromEntries(Object.entries(entry.fields.total).map(([field, stats]) => [field,
        stats.invalid ? 'invalidated' : stats.present ? 'observed' : 'missing'])),
      modelContextWindow: entry.fields.modelContextWindow.invalid ? 'invalidated'
        : entry.fields.modelContextWindow.present ? 'observed' : 'missing' };
  }
  return { observations, byAgent };
}
