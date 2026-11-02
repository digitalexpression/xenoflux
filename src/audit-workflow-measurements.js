import { summarizeWorkflowUsage } from './audit-usage.js';
import { projectRunRecordedUsage } from './audit-recorded-usage.js';
import { presentAgentMeasurements } from './audit-agent-measurements.js';

const blank = () => ({ input: null, cachedInput: null, output: null, reasoning: null, total: null });
const safe = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function counters(values) {
  const result = { input: safe(values?.inputTokens), cachedInput: safe(values?.cachedInputTokens),
    output: safe(values?.outputTokens), reasoning: safe(values?.reasoningOutputTokens), total: safe(values?.totalTokens) };
  if (result.input !== null && result.output !== null && result.total !== null
    && (!Number.isSafeInteger(result.input + result.output) || result.input + result.output !== result.total)) return blank();
  if (result.cachedInput !== null && result.input !== null && result.cachedInput > result.input) return blank();
  if (result.reasoning !== null && result.output !== null && result.reasoning > result.output) return blank();
  return result;
}

function workflowSpan(run) {
  const agents = Array.isArray(run?.agents) ? run.agents : [];
  const sessions = Array.isArray(run?.sessionReplay?.sessions) ? run.sessionReplay.sessions : [];
  const unknown = { durationMs: null, timingNote: 'A workflow span cannot be established from the retained session timestamps.' };
  if (agents.some(agent => !agent || typeof agent.id !== 'string' || !agent.id)) return unknown;
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const roots = agents.filter(agent => agent.parentId === null);
  if (roots.length !== 1 || byId.size !== agents.length) return unknown;
  for (const agent of agents) {
    const seen = new Set(); let current = agent;
    while (current?.parentId !== null) {
      if (!current || seen.has(current.id)) return unknown;
      seen.add(current.id); current = byId.get(current.parentId);
    }
    if (current.id !== roots[0].id) return unknown;
  }
  const seen = new Set(); let start = Infinity, end = -Infinity, timestamps = 0, missing = 0;
  for (const session of sessions) {
    if (!session || typeof session.id !== 'string') return unknown;
    const agent = byId.get(session.id);
    if (!agent || seen.has(session.id) || session.parentId !== agent.parentId) return unknown;
    seen.add(session.id);
    for (const event of session.events ?? []) {
      const time = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
      if (!Number.isFinite(time)) { missing++; continue; }
      start = Math.min(start, time); end = Math.max(end, time); timestamps++;
    }
  }
  if (timestamps < 2 || !Number.isSafeInteger(end - start)) return unknown;
  const gap = missing || seen.size !== agents.length
    ? ' Some sessions or event timestamps are missing; the full workflow duration is unknown.' : '';
  return { durationMs: end - start,
    timingNote: `Earliest to latest recorded event across captured sessions. Concurrent agent spans are not added; this is not active working time.${gap}` };
}

/** Revalidate retained evidence; never promote a stored aggregate or sum display rows. */
export function presentWorkflowMeasurements(run) {
  const agents = presentAgentMeasurements(run);
  const measured = agents.filter(agent => agent.counters.total !== null).length;
  const usage = run?.source?.kind === 'native-rollout' ? projectRunRecordedUsage(run) : summarizeWorkflowUsage(run);
  const complete = usage?.status === 'complete' && run?.coverage?.agents === 'complete';
  const values = complete ? counters(usage.values) : blank();
  const validated = complete && values.total !== null;
  const sessions = Array.isArray(run?.sessionReplay?.sessions) ? run.sessionReplay.sessions : [];
  const discoveryPartial = !sessions.length || sessions.length !== agents.length
    || new Set(sessions.map(session => session.id)).size !== agents.length
    || sessions.some(session => !agents.some(agent => agent.id === session.id && agent.parentId === session.parentId)
      || (session.limits ?? []).some(limit => /^child-(discovery|count|depth)/.test(limit.kind)));
  const version = run?.source?.version ?? run?.source?.clientVersion;
  const reason = usage?.reason;
  const unverified = reason === 'accounting-contract-unverified' || reason === 'source-version-unsupported' || !usage;
  const usageStatus = validated ? discoveryPartial ? 'partial' : 'validated' : unverified ? 'unvalidated' : 'unavailable';
  const usageNote = validated
    ? `Validated from independently owned session usage, counted once per captured session. Includes the main session and captured descendants; not billed cost.${discoveryPartial ? ' This captured total is not a validated whole-workflow total: additional native sessions cannot be ruled out.' : ''}`
    : unverified
      ? `Workflow token accounting${version ? ` for Codex ${version}` : ''} has not been validated. Parent and child source counters are not added until their ownership and starting baselines are proven.`
      : `A complete workflow token total cannot be established from the retained evidence (${reason ?? 'agent coverage incomplete'}). Missing usage is not zero.`;
  return { ...workflowSpan(run), counters: values, usageStatus, usageNote,
    coverageNote: `${agents.length} captured sessions; ${measured} with reported token totals.${discoveryPartial ? ' Replay discovery is incomplete or unavailable; the replay alone does not prove that every child was found.' : ''}`,
    runnerDurationMs: safe(run?.metrics?.taskMs) };
}
