// Requirements for positively reported native loaded instruction sources.
import { instructionReferenceId } from './audit-instructions.js';

const REF = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const ORIGINS = new Set(['repository', 'profile', 'user']);
const SOURCE_ORIGINS = new Set(['repository', 'profile', 'user', 'external']);
const AGENTS = new Set(['root', 'all', 'descendants']);
const PHASES = new Set(['before-task', 'after-task']);
const SOURCES = new Set(['thread/start', 'thread/resume-loaded']);
const NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'instruction-file']);
const list = value => Array.isArray(value) ? value : [];

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024
    && !path.startsWith('/') && !path.includes('\\') && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path)
    && !/(?:^|\/)(?:\.|\.\.)(?:\/|$)/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..')
    && !path.split('/').some(part => /^(?:\.env(?:\..*)?|.*(?:secret|credential|password|token|access[-_]?key|api[-_]?key|auth\.json).*)$/i.test(part));
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error('Invalid captureRequirements context');
}

export function validateRequiredContextRules(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error('Invalid captureRequirements context');
  return value.map(item => {
    object(item, ['agents', 'origin', 'path', 'phase']);
    const agents = item.agents ?? 'root';
    if (!AGENTS.has(agents) || !ORIGINS.has(item.origin) || !safePath(item.path)
      || item.phase !== undefined && !PHASES.has(item.phase)) throw new Error('Invalid captureRequirements context selector');
    return { agents, origin: item.origin, path: item.path, ...(item.phase ? { phase: item.phase } : {}) };
  });
}

function structurallyComplete(row) {
  const rowKeys = ['agentId', 'source', 'phase', 'sourceLine', 'status', 'reportedCount', 'sources', 'omittedCount', 'rejectedCount', 'reason'];
  if (!row || !ID.test(row.agentId ?? '') || !SOURCES.has(row.source) || !PHASES.has(row.phase)
    || Object.keys(row).some(key => !rowKeys.includes(key))
    || row.sourceLine !== null && (!Number.isSafeInteger(row.sourceLine) || row.sourceLine < 1)
    || !['reported', 'reported-empty'].includes(row.status) || !Number.isSafeInteger(row.reportedCount)
    || row.reportedCount < 0 || row.omittedCount !== 0 || row.rejectedCount !== 0 || row.reason !== null
    || !Array.isArray(row.sources)) return false;
  if (row.status === 'reported-empty' && (row.reportedCount !== 0 || row.sources.length)) return false;
  if (row.status === 'reported' && (!row.sources.length || row.reportedCount !== row.sources.length)) return false;
  return row.sources.every(source => source && Object.keys(source).every(key => ['id', 'origin', 'name'].includes(key))
    && REF.test(source.id ?? '') && SOURCE_ORIGINS.has(source.origin) && NAMES.has(source.name));
}

/** Pure evaluator over frozen capture evidence; it never reads paths or files. */
export function evaluateRequiredContext(run, contextRules, { rootOnly = false } = {}) {
  const rules = validateRequiredContextRules(contextRules);
  const agents = list(run?.agents), rootId = run?.source?.threadId;
  const validAgents = agents.filter(agent => agent && typeof agent === 'object' && !Array.isArray(agent)
    && ID.test(agent.id ?? '') && (agent.parentId === null || ID.test(agent.parentId ?? '')));
  const agentIds = validAgents.map(agent => agent.id);
  const uniqueAgents = validAgents.length === agents.length && new Set(agentIds).size === agentIds.length;
  const known = new Map(validAgents.map(agent => [agent.id, agent]));
  const validRoot = uniqueAgents && ID.test(rootId ?? '') && known.has(rootId) && known.get(rootId).parentId === null;
  const descendants = new Set();
  for (const agent of agents) {
    const seen = new Set(); let current = agent;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parentId === rootId) { descendants.add(agent.id); break; }
      current = known.get(current.parentId);
    }
  }
  const rows = list(run?.instructionSources), checks = [];
  const supportedNative = run?.source?.kind === 'native-app-server-v2';
  for (const [index, rule] of rules.entries()) {
    if (rootOnly && rule.agents === 'descendants') continue;
    const selected = rootOnly ? [rootId].filter(id => validRoot)
      : rule.agents === 'root' ? [rootId].filter(id => validRoot)
      : rule.agents === 'descendants' ? [...descendants]
        : [...new Set([rootId, ...descendants])].filter(id => validRoot && known.has(id));
    const actorChecks = [];
    {
      if (!selected.length) actorChecks.push({ agentId: null, referenceId: instructionReferenceId(rule.origin, rule.path), phase: rule.phase ?? null, source: null, reason: 'selected-agents-unavailable' });
      for (const agentId of selected) {
        const isRoot = agentId === rootId;
        const phase = isRoot ? 'before-task' : 'after-task';
        const source = isRoot ? 'thread/start' : 'thread/resume-loaded';
        const referenceId = instructionReferenceId(rule.origin, rule.path);
        const actorRows = rows.filter(row => row?.agentId === agentId);
        const evidenceComplete = uniqueAgents && validRoot && supportedNative
          && ['observed', 'partial'].includes(run?.coverage?.instructions)
          && (rootOnly || run?.coverage?.agents === 'complete')
          && actorRows.length === 1 && actorRows.every(structurallyComplete)
          && !actorRows.some(row => row?.status === 'partial' || row?.status === 'unavailable');
        const match = actorRows.some(row => structurallyComplete(row) && row.source === source && row.phase === phase
          && (rule.phase === undefined || rule.phase === phase)
          && row.sources.some(ref => ref.id === referenceId && ref.origin === rule.origin));
        actorChecks.push({ agentId, referenceId, phase, source,
          reason: !evidenceComplete ? 'instruction-evidence-incomplete' : rule.phase && rule.phase !== phase ? 'phase-source-mismatch'
              : match ? null : 'required-context-not-observed' });
      }
    }
    checks.push({ id: `context:${index}`, status: actorChecks.length && actorChecks.every(check => check.reason === null) ? 'passed' : 'failed',
      reason: actorChecks.find(check => check.reason)?.reason ?? null,
      selector: rule, checks: actorChecks });
  }
  const status = checks.every(check => check.status === 'passed') ? 'passed' : 'failed';
  return { requirements: rules, checks, status };
}

export function compactRequiredContext(value) {
  const rules = (() => { try { return validateRequiredContextRules(value?.requirements ?? []); } catch { return []; } })();
  const rawChecks = list(value?.checks), checks = [];
  let malformed = !rules.length || !Array.isArray(value?.requirements) || !Array.isArray(value?.checks)
    || value.requirements.length !== rules.length || rawChecks.length !== rules.length;
  for (let index = 0; index < Math.min(rawChecks.length, 50); index++) {
    const raw = rawChecks[index], rule = rules[index], expectedId = `context:${index}`;
    const selectorMatches = rule && raw?.selector && raw.selector.agents === rule.agents && raw.selector.origin === rule.origin
      && raw.selector.path === rule.path && raw.selector.phase === rule.phase
      && Object.keys(raw.selector).every(key => ['agents', 'origin', 'path', 'phase'].includes(key));
    if (raw?.id !== expectedId || !selectorMatches) malformed = true;
    const rawActors = list(raw?.checks), seenActors = new Set();
    if (!rawActors.length || rawActors.length > 160) malformed = true;
    const actorChecks = rawActors.slice(0, 160).map(row => {
      const agentId = ID.test(row?.agentId ?? '') ? row.agentId : null;
      const referenceId = REF.test(row?.referenceId ?? '') ? row.referenceId : null;
      const phase = row?.phase === null ? null : PHASES.has(row?.phase) ? row.phase : null;
      const source = row?.source === null ? null : SOURCES.has(row?.source) ? row.source : null;
      const reason = row?.reason === null ? null : typeof row?.reason === 'string' && /^[a-z-]{1,64}$/.test(row.reason) ? row.reason : 'malformed-context-check';
      const expectedReference = rule ? instructionReferenceId(rule.origin, rule.path) : null;
      const validPair = source === 'thread/start' ? phase === 'before-task' : source === 'thread/resume-loaded' && phase === 'after-task';
      const unavailableActor = row?.agentId === null && source === null && reason === 'selected-agents-unavailable'
        && (phase === null || PHASES.has(phase));
      const validActor = agentId && !seenActors.has(agentId) && referenceId === expectedReference && validPair;
      const requestedPhaseMatches = !rule?.phase || rule.phase === phase;
      if (!rule || !referenceId || referenceId !== expectedReference || !(validActor || unavailableActor)
        || reason === null && !requestedPhaseMatches || reason === 'malformed-context-check') malformed = true;
      if (agentId) seenActors.add(agentId);
      return { agentId, referenceId, phase, source, reason };
    });
    const status = raw?.status === 'passed' ? 'passed' : 'failed';
    const reason = raw?.reason === null ? null : typeof raw?.reason === 'string' && /^[a-z-]{1,64}$/.test(raw.reason) ? raw.reason : 'malformed-context-check';
    const checksPassed = actorChecks.length > 0 && actorChecks.every(row => row.reason === null);
    if ((status === 'passed') !== checksPassed || reason === 'malformed-context-check'
      || reason !== (actorChecks.find(row => row.reason)?.reason ?? null)) malformed = true;
    checks.push({ id: expectedId, status, reason, selector: rule,
      omittedActorChecks: Math.max(0, rawActors.length - 160), checks: actorChecks });
  }
  const omittedRequirements = Math.max(0, list(value?.requirements).length - 50);
  const omittedChecks = Math.max(0, list(value?.requirements).length - rawChecks.length) + Math.max(0, rawChecks.length - 50);
  if (omittedRequirements || omittedChecks) malformed = true;
  const checksPassed = checks.length > 0 && checks.every(check => check.status === 'passed');
  const status = !malformed && checksPassed ? 'passed' : 'failed';
  if ((value?.status === 'passed') !== checksPassed) malformed = true;
  return { requirements: rules, checks, omittedRequirements, omittedChecks, malformed, status: malformed ? 'failed' : status };
}
