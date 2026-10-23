// Declared observation requirements are independent of exhaustive consumption.
// They validate only positively attributed, allowlisted native evidence.
import { safePluginScriptPath } from './audit-tools.js';
import { summarizeTurnUsage } from './audit-usage.js';
import { evaluateRequiredContext, validateRequiredContextRules } from './audit-context.js';
export { evaluateRequiredContext } from './audit-context.js';
const FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens'];
const ORIGINS = ['profile', 'user', 'repository', 'system', 'admin', 'plugin'];
const ACTORS = ['any', 'root', 'descendant'];
const HOOK_FIELDS = {
  eventName: ['preToolUse', 'permissionRequest', 'postToolUse', 'preCompact', 'postCompact', 'sessionStart', 'sessionEnd', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'interrupt'],
  sourceKind: ['system', 'user', 'project', 'mdm', 'sessionFlags', 'plugin', 'cloudRequirements', 'cloudManagedConfig', 'legacyManagedConfigFile', 'legacyManagedConfigMdm', 'unknown'],
  scope: ['thread', 'turn'], status: ['completed', 'failed', 'blocked', 'stopped'],
};
const list = value => Array.isArray(value) ? value : [];
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim() && value.length <= 160 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error('Invalid captureRequirements field');
}
function bounded(value, fallback, max) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('Invalid captureRequirements bound');
  return result;
}

export function validateCaptureRequirements(value) {
  if (value === undefined) return undefined;
  object(value, ['minAgents', 'usage', 'skills', 'tools', 'hooks', 'context']);
  if (!Object.keys(value).length) throw new Error('captureRequirements must request evidence');
  const result = { minAgents: bounded(value.minAgents, 1, 64) };
  if (value.usage !== undefined) {
    object(value.usage, ['agents', 'fields', 'minTurns', 'wholeTurns']);
    const agents = value.usage.agents ?? 'all', fields = value.usage.fields ?? ['inputTokens', 'outputTokens', 'totalTokens'];
    if (!['root', 'all'].includes(agents) || !Array.isArray(fields) || !fields.length || fields.length > FIELDS.length
      || fields.some(field => !FIELDS.includes(field)) || new Set(fields).size !== fields.length) throw new Error('Invalid captureRequirements usage');
    if (value.usage.wholeTurns !== undefined && typeof value.usage.wholeTurns !== 'boolean') throw new Error('Invalid captureRequirements wholeTurns');
    result.usage = { agents, fields: [...fields], minTurns: bounded(value.usage.minTurns, 1, 1000),
      ...(value.usage.wholeTurns !== undefined ? { wholeTurns: value.usage.wholeTurns } : {}) };
  }
  if (value.hooks !== undefined) {
    if (!Array.isArray(value.hooks) || !value.hooks.length || value.hooks.length > 50) throw new Error('Invalid captureRequirements hooks');
    result.hooks = value.hooks.map(item => {
      object(item, ['agent', ...Object.keys(HOOK_FIELDS), 'min']);
      const agent = item.agent ?? 'any';
      if (!ACTORS.includes(agent)) throw new Error('Invalid captureRequirements hook agent');
      for (const [field, choices] of Object.entries(HOOK_FIELDS))
        if (item[field] !== undefined && !choices.includes(item[field])) throw new Error('Invalid captureRequirements hook selector');
      return { ...item, agent, min: bounded(item.min, 1, 1000) };
    });
  }
  for (const kind of ['skills', 'tools']) if (value[kind] !== undefined) {
    if (!Array.isArray(value[kind]) || !value[kind].length || value[kind].length > 50) throw new Error('Invalid captureRequirements observations');
    result[kind] = value[kind].map(item => {
      object(item, kind === 'skills' ? ['agent', 'name', 'origin', 'invocationType', 'min'] : ['agent', 'kind', 'server', 'tool', 'pluginId', 'scriptPath', 'min']);
      const agent = item.agent ?? 'any';
      if (!ACTORS.includes(agent)) throw new Error('Invalid captureRequirements agent');
      for (const key of kind === 'skills' ? ['name'] : ['server', 'tool', 'pluginId'])
        if (item[key] !== undefined && !text(item[key])) throw new Error('Invalid captureRequirements identity');
      if (kind === 'tools' && item.scriptPath !== undefined && (!safePluginScriptPath(item.scriptPath)
        || !item.pluginId || item.kind !== undefined && item.kind !== 'command')) throw new Error('Invalid captureRequirements script identity');
      if (item.origin !== undefined && !ORIGINS.includes(item.origin)) throw new Error('Invalid captureRequirements origin');
      if (item.invocationType !== undefined && !['explicit', 'implicit'].includes(item.invocationType)) throw new Error('Invalid captureRequirements invocationType');
      if (item.kind !== undefined && !['command', 'mcp', 'dynamic', 'web-search', 'file-change', 'agent', 'image-view', 'sleep', 'image-generation'].includes(item.kind)) throw new Error('Invalid captureRequirements tool kind');
      return { ...item, agent, min: bounded(item.min, 1, 1000) };
    });
  }
  if (value.context !== undefined) result.context = validateRequiredContextRules(value.context);
  return result;
}

/** Evaluate the saved contract without turning absent events into zero use. */
export function evaluateCaptureRequirements(run, requirements, { protocolReady = true } = {}) {
  const requested = validateCaptureRequirements(requirements);
  if (!requested) return null;
  const checks = [], root = run?.source?.threadId;
  const agents = list(run?.agents), known = new Map(agents.map(agent => [agent.id, agent]));
  const descendants = new Set();
  for (const agent of agents) {
    const seen = new Set(); let current = agent;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parentId === root) { descendants.add(agent.id); break; }
      current = known.get(current.parentId);
    }
  }
  const actor = (id, role) => known.has(id) && (role === 'root' ? id === root : role === 'descendant' ? descendants.has(id) : id === root || descendants.has(id));
  const add = (id, passed, reason, details = {}) => checks.push({ id, status: passed ? 'passed' : 'failed', reason: passed ? null : reason, ...details });
  add('protocol', protocolReady, 'native-protocol-unavailable');
  add('agent-lineage', known.has(root) && run?.coverage?.agents === 'complete', 'agent-lineage-incomplete');
  add('min-agents', agents.filter(agent => actor(agent.id, 'any')).length >= requested.minAgents, 'insufficient-owned-agents', { required: requested.minAgents });
  const observations = list(run?.usage?.observations);
  if (requested.usage) {
    // Recompute against full source evidence; a user-supplied saved summary is
    // not sufficient proof for an acceptance requirement.
    const wholeTurns = requested.usage.wholeTurns ? summarizeTurnUsage(run) : null;
    const targets = agents.filter(agent => actor(agent.id, requested.usage.agents === 'root' ? 'root' : 'any'));
    if (!targets.length) add('usage:agents', false, 'usage-agents-unavailable');
    for (const agent of targets) {
      const turns = list(run?.turns).filter(turn => turn.agentId === agent.id && typeof turn.turnId === 'string');
      const turnIds = [...new Set(turns.map(turn => turn.turnId))];
      add(`usage:${agent.id}:turns`, turnIds.length >= requested.usage.minTurns, 'insufficient-recorded-turns', { required: requested.usage.minTurns });
      for (const turnId of turnIds) {
        if (wholeTurns) {
          const row = wholeTurns.turns.find(item => item.agentId === agent.id && item.turnId === turnId);
          const missingFields = requested.usage.fields.filter(field => row?.fields?.[field]?.status !== 'observed' || !count(row?.values?.[field]));
          add(`usage:${agent.id}:${turnId}`, Boolean(row) && !missingFields.length,
            wholeTurns.status === 'unavailable' ? wholeTurns.reason : 'whole-turn-fields-unavailable',
            { agentId: agent.id, turnId, scope: wholeTurns.scope, missingFields, observations: row?.derivation?.sourceObservations?.length ?? 0 });
          continue;
        }
        const rows = observations.filter(row => row.agentId === agent.id && row.turnId === turnId);
        const invalid = rows.some(row => !['accepted', 'duplicate'].includes(row.disposition));
        const fields = requested.usage.fields.filter(field => !rows.some(row => count(row.total?.[field])));
        // Per-agent safe totals are invalidated by continuity checks even when
        // an earlier snapshot for this turn happened to contain the field.
        const safe = run.usage?.[agent.id]?.total ?? list(run.usage?.byAgent).find(row => row.agentId === agent.id)?.total;
        const unsafe = safe && requested.usage.fields.some(field => !count(safe[field]));
        add(`usage:${agent.id}:${turnId}`, rows.length > 0 && !invalid && !fields.length && !unsafe,
          !rows.length ? 'usage-not-observed' : invalid || unsafe ? 'usage-sequence-unverified' : 'usage-fields-unavailable',
          { agentId: agent.id, turnId, missingFields: fields, observations: rows.length });
      }
    }
  }
  const skills = new Map(list(run?.skills).map(skill => [skill.id, skill]));
  for (const [index, rule] of list(requested.skills).entries()) {
    const matches = list(run?.skillInvocations).filter(event => {
      const skill = skills.get(event.skillId);
      return event.resolution === 'catalogued' && skill && actor(event.agentId, rule.agent)
        && typeof event.turnId === 'string' && list(run?.turns).some(turn => turn.agentId === event.agentId && turn.turnId === event.turnId)
        && (!rule.name || skill.name === rule.name) && (!rule.origin || skill.origin === rule.origin)
        && (!rule.invocationType || event.invocationType === rule.invocationType);
    });
    add(`skills:${index}`, matches.length >= rule.min, 'required-invocation-not-observed', { required: rule.min, observed: matches.length, selector: rule });
  }
  for (const [index, rule] of list(requested.tools).entries()) {
    const matches = list(run?.toolInvocations).filter(event => actor(event.agentId, rule.agent)
      && typeof event.turnId === 'string' && list(run?.turns).some(turn => turn.agentId === event.agentId && turn.turnId === event.turnId)
      && ['completed', 'failed'].includes(event.status) && (!rule.kind || event.kind === rule.kind)
      && (!rule.server || event.serverName === rule.server) && (!rule.tool || event.toolName === rule.tool)
      && (!rule.pluginId || event.pluginId === rule.pluginId)
      && (!rule.scriptPath || event.kind === 'command' && event.pluginId && safePluginScriptPath(event.scriptPath) === rule.scriptPath));
    add(`tools:${index}`, matches.length >= rule.min, 'required-tool-not-observed', { required: rule.min, observed: matches.length, selector: rule });
  }
  for (const [index, rule] of list(requested.hooks).entries()) {
    const matches = list(run?.hookInvocations).filter(event => actor(event.agentId, rule.agent)
      && HOOK_FIELDS.status.includes(event.status)
      && Object.entries(HOOK_FIELDS).every(([field, choices]) => choices.includes(event[field]))
      && (event.scope === 'thread' || typeof event.turnId === 'string'
        && list(run?.turns).some(turn => turn.agentId === event.agentId && turn.turnId === event.turnId))
      && Object.keys(HOOK_FIELDS).every(field => rule[field] === undefined || event[field] === rule[field]));
    add(`hooks:${index}`, matches.length >= rule.min, 'required-hook-not-observed',
      { required: rule.min, observed: matches.length, selector: rule });
  }
  if (requested.context) {
    const context = evaluateRequiredContext(run, requested.context);
    checks.push(...context.checks);
  }
  return { schemaVersion: 1, mode: 'declared-observations', status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
    requirements: requested, checks, exhaustiveConsumption: false,
    boundary: 'Validates requested observed events and source counters only; absent events never establish no use or exhaustive consumption.' };
}
