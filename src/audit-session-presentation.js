import { presentSessionControls } from './audit-session-controls.js';
import { presentRunExecution } from './audit-presentation.js';
import { presentAgentMeasurements } from './audit-agent-measurements.js';
import { presentWorkflowMeasurements } from './audit-workflow-measurements.js';
import { nsToSourceIso, projectSkillSourceTime, sourceTimeNs } from './audit-source-time.js';

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' && value ? value : null;

function skillSourceReference(observation) {
  if (Number.isSafeInteger(observation.sourceLine) && observation.sourceLine > 0) return {
    kind: 'file-line', line: observation.sourceLine, itemId: text(observation.itemId), source: text(observation.evidence?.source),
  };
  if (observation.kind === 'native-selection-accepted' && text(observation.evidence)) return {
    kind: 'structured-selection', source: observation.evidence,
  };
  if (observation.kind === 'native-invocation-observed') {
    const sourceTime = projectSkillSourceTime(observation.metadata?.sourceTime);
    const timestampNs = sourceTimeNs(observation.metadata?.timestampNs);
    const timestamps = sourceTime ? ['nativeEvent', 'otlpEvent', 'otlpObserved'].flatMap(key => {
      const { clock, source, unixNano } = sourceTime[key];
      const iso = nsToSourceIso(unixNano);
      return iso ? [{ clock, source, iso }] : [];
    }) : timestampNs ? [{ clock: 'unattributed', source: 'timestampNs', iso: nsToSourceIso(timestampNs) }] : [];
    return { kind: 'native-telemetry', source: text(observation.metadata?.source),
      observationId: text(observation.metadata?.observationId), invocationType: text(observation.metadata?.invocationType),
      sourceTime, timestampNs, timestamps };
  }
  return { kind: 'unavailable' };
}

export function presentSession(run, { title = 'Session inspection' } = {}) {
  const context = run.source?.readContext;
  const client = run.clientIdentity?.client ?? run.nativeReference?.client ?? run.profile?.client
    ?? (run.source?.kind === 'native-rollout' ? 'codex' : null);
  const owned = ['native-app-server-v2', 'claude-agent-sdk', 'copilot-sdk-stdio'].includes(run.source?.kind);
  const imported = !owned && (['native-rollout', 'claude-code-sdk-file-import', 'copilot-sdk-session-import'].includes(run.source?.kind)
    || Boolean(context) || /import/.test(run.source?.kind ?? ''));
  const profile = context?.profileName ?? run.profile?.profileName ?? 'Profile not recorded';
  const replay = run.sessionReplay ?? null;
  const events = list(replay?.sessions).flatMap(session => session.events);
  const native = run.nativeReference ?? {};
  const coverage = ['timeline', 'agents', 'skills', 'tools', 'mcp', 'hooks', 'usage', 'outcome'].flatMap(key => {
    if (key === 'skills' && (text(run.coverage?.skillInventory) || text(run.coverage?.skillUsage) || text(run.coverage?.skillInvocationTelemetry))) return [
      { name: 'Skill catalog', state: text(run.coverage.skillInventory) ?? 'unknown',
        note: 'Catalog presence does not prove skill loading or invocation.' },
      { name: 'Skill use', state: text(run.coverage.skillInvocationTelemetry) ?? text(run.coverage.skillUsage) ?? 'unknown',
        note: run.coverage.skillInvocationTelemetry === 'empty'
          ? 'No invocation telemetry was recorded; unobserved skill use remains unknown.'
          : 'Recorded observations do not establish every skill that was loaded or invoked.' },
    ];
    if (key === 'outcome' && owned && Array.isArray(run.comparisonConditions?.checkRecipes)
      && run.comparisonConditions.checkRecipes.length === 0) return [{ name: 'Task verification', state: 'No checks selected',
      note: 'Native completion is reported separately; no independent verification checks were selected.' }];
    const state = text(run.coverage?.[key]) ?? (key === 'timeline' && replay ? 'partial replay' : 'unknown');
    const eventNotes = {
      tools: 'Tool invocations were not recorded. This does not prove that no tool ran.',
      mcp: 'MCP events were not recorded. This does not prove that no integration ran.',
      hooks: 'Hook events were not recorded. This does not prove that no hook ran.',
    };
    const note = state === 'none-recorded' ? eventNotes[key]
      : key === 'skills' && imported ? 'Skill evidence is limited to what the history reader retained; catalog presence does not prove use.' : null;
    return [{
      name: { timeline: 'Recorded history', agents: 'Delegated sessions', skills: 'Skills', tools: 'Tools', mcp: 'MCP', hooks: 'Hooks', usage: 'Token usage', outcome: 'Outcome' }[key],
      state, ...(note ? { note } : {}),
    }];
  });
  if (text(run.coverage?.captureRequirements)) coverage.push({ name: 'Required capture', state: run.coverage.captureRequirements,
    note: 'This status covers only the declared capture checks; unobserved activity remains unknown.' });
  return { title, profile, client, sessionId: native.sessionId ?? run.source?.nativeSessionId ?? run.source?.threadId ?? null,
    mode: owned ? 'Retained xfx capture' : imported ? 'Historical import' : 'Capture origin unknown',
    sourceKind: run.source?.kind ?? 'unknown',
    surface: imported && client !== 'codex' ? null : run.clientIdentity?.surface ?? (['cli', 'desktop'].includes(run.source?.client) ? run.source.client : null),
    readContext: context ? `${context.profileName ?? profile} · ${context.rootMode ?? 'root unknown'} · ${context.surface ?? 'surface unknown'} · ${context.executionLocation ?? 'location unknown'}` : null,
    execution: presentRunExecution(run), coverage, replay, ...presentSessionControls(run),
    setupHref: ['codex', 'claude-code', 'copilot'].includes(client) && (context?.profileId || run.profile?.profileId)
      ? `/profiles/${encodeURIComponent(profile)}/setup?client=${encodeURIComponent(client)}` : null,
    workflow: { ...presentWorkflowMeasurements(run), ...(imported && !list(run.agents).length
      ? { coverageNote: 'This import retains conversation text; execution actor ownership and usage were not captured.' } : {}) },
    agents: presentAgentMeasurements(run),
    skills: list(run.skills).map(skill => ({ name: skill.name ?? skill.id, observations: list(skill.observations).map(observation => ({
      kind: observation.kind, agentId: observation.agentId ?? null, turnId: observation.turnId ?? null, sourceLine: observation.sourceLine ?? null,
      sourceRef: skillSourceReference(observation),
    })) })),
    compactions: events.filter(event => event.kind === 'compaction').map(event => ({ sessionId: event.sessionId, eventId: event.id, label: event.label })),
    limits: [...new Set([
      'The full effective context and historical harness are not reconstructed from today’s profile files. A compaction summary does not establish whether scope was preserved.',
      'Token counters do not establish per-skill cost or billed spend. Missing usage is unknown, not zero.',
      ...(imported ? ['Imported history has the coverage exposed by its reader; it is not an xfx-owned execution capture.'] : []),
      ...(run.reason ? [run.reason] : []), ...list(run.warnings), ...list(replay?.limits),
    ])],
  };
}

export function presentSessionHarness(run) {
  const { settings, turns, skills, compactions, setupHref, mode, coverage } = presentSession(run);
  return { settings, turns, skills, compactions, setupHref, mode, coverage };
}
