// Merge bounded native skill-invocation telemetry into an already-normalized
// audit run. Events identify a skill by name/scope, never by resource path.
import { redactValue } from './redact.js';
import { projectDeliveryAccounting, projectTelemetryJournal } from './audit-delivery.js';
import { projectSkillSourceTime } from './audit-source-time.js';
const MAX_RECORDS = 20_000;
const MAX_OBSERVATIONS = 20_000;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
// Match the receiver's safe native identifier alphabet. Colons are needed for
// plugin-qualified names such as `product-design:image-to-code`; separators
// that can smuggle a filesystem path remain excluded.
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:@+-]{0,119}$/;
const SCOPES = new Set(['profile', 'user', 'project', 'repo', 'system', 'admin']);
const TYPES = new Set(['explicit', 'implicit']);
const SOURCE = 'native-otel-skill-invocation';
const ORIGINS = new Set(['profile', 'user', 'repository', 'project', 'system', 'admin', 'plugin', 'unknown']);
const observationId = value => typeof value === 'string' && /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/.test(value) ? value : null;

const safeId = value => typeof value === 'string' && ID.test(value) && redactValue(value) === value ? value : null;
function safeName(value) {
  return typeof value === 'string' && NAME.test(value) && redactValue(value) === value ? value : null;
}
function safeScope(value) { return typeof value === 'string' && SCOPES.has(value) ? value : null; }
function safeTimestamp(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d{1,24}$/.test(value)) return value;
  return null;
}
function safePluginId(value) {
  // Match the receiver's bounded opaque identity alphabet while excluding
  // absolute paths, URL schemes, backslashes, empty segments, and dot segments.
  if (typeof value !== 'string' || value.length === 0 || value.length > 120
    || /^https?:\/\//i.test(value) || value.includes('\\')
    || value.startsWith('/') || redactValue(value) !== value) return null;
  const segments = value.split('/');
  return segments.length > 0 && segments.every(segment => segment !== '.' && segment !== '..'
    && /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/.test(segment)) ? value : null;
}
function eventKey(event) {
  if (observationId(event.observationId)) return JSON.stringify(['received-record', event.observationId]);
  return JSON.stringify([event.agentId ?? null, event.unattributedActorId ?? null, event.turnId ?? null,
    event.skillName, event.scope ?? null, event.pluginId ?? null, event.invocationType ?? null,
    event.timestampNs ?? null, event.source]);
}
function scopeMatches(skill, scope) {
  if (!scope) return true;
  // Native scope is intentionally independent of audit-side origin: profile
  // skills also have native scope `user`. Preserve that distinction during
  // matching so same-name profile and ordinary user entries remain ambiguous.
  if (scope === 'profile') return skill?.scope === 'profile';
  if (scope === 'user') return skill?.nativeScope === 'user' || (!skill?.nativeScope && skill?.scope === 'user');
  if (scope === 'repo' || scope === 'project') return skill?.nativeScope === 'repo' || skill?.scope === 'project';
  return skill?.nativeScope === scope || skill?.scope === scope;
}
function cataloguedBy(skill, actorId) {
  return Array.isArray(skill?.catalogs) && skill.catalogs.some(catalog => catalog?.agentId === actorId);
}

/**
 * Attach allowlisted OTel skill invocation events to a normalized audit run.
 * No catalog path is inferred from telemetry. Unknown actors remain standalone.
 */
export function mergeAuditSkillTelemetry(run, telemetrySnapshot) {
  if (!run || typeof run !== 'object') throw new TypeError('Normalized audit run is required');
  const input = Array.isArray(telemetrySnapshot?.events) ? telemetrySnapshot.events : [];
  const knownAgents = new Set((Array.isArray(run.agents) ? run.agents : [])
    .map(agent => safeId(agent?.id)).filter(Boolean));
  run.skillInvocations = Array.isArray(run.skillInvocations) ? run.skillInvocations : [];
  run.coverage ??= {};
  run.coverage.skillInvocationTelemetry = 'unknown';
  const warnings = new Set(Array.isArray(run.skillTelemetry?.warnings) ? run.skillTelemetry.warnings.filter(x => typeof x === 'string') : []);
  for (const warning of Array.isArray(telemetrySnapshot?.metadata?.warnings) ? telemetrySnapshot.metadata.warnings : []) {
    if (typeof warning === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(warning)) warnings.add(warning);
  }
  const seen = new Set(run.skillInvocations.map(eventKey));
  const skills = Array.isArray(run.skills) ? run.skills : [];
  let added = 0, observationCount = skills.reduce((sum, skill) => sum + (Array.isArray(skill?.observations) ? skill.observations.length : 0), 0);
  let capped = false;
  for (const raw of input) {
    if (added >= MAX_RECORDS) { capped = true; break; }
    if (!raw || typeof raw !== 'object' || raw.source !== SOURCE) continue;
    const skillName = safeName(raw.skillName);
    if (!skillName) continue;
    const threadId = safeId(raw.threadId);
    const turnId = safeId(raw.turnId);
    const scope = safeScope(raw.scope);
    const pluginId = safePluginId(raw.pluginId);
    const invalidPluginId = raw.pluginId != null && pluginId === null;
    const invocationType = TYPES.has(raw.invocationType) ? raw.invocationType : null;
    const timestampNs = safeTimestamp(raw.timestampNs);
    const sourceTime = Object.hasOwn(raw, 'sourceTime') ? projectSkillSourceTime(raw.sourceTime) : null;
    const actorId = threadId && knownAgents.has(threadId) ? threadId : null;
    const event = {
      ...(observationId(raw.observationId) ? { observationId: raw.observationId } : {}),
      ...(actorId ? { agentId: actorId } : { agentId: null, ...(threadId ? { unattributedActorId: threadId } : {}) }),
      turnId, skillName, scope, pluginId, invocationType, timestampNs, source: SOURCE,
      ...(sourceTime ? { sourceTime } : {}),
    };
    if (!actorId) {
      event.resolution = 'unattributed';
      event.reason = 'unknown-thread';
    } else {
      // A turn is recorded only on the same event. A missing turn is never
      // backfilled from another turn, even if the actor is known.
      const namedCandidates = skills.filter(skill => skill?.name === skillName && cataloguedBy(skill, actorId)
        && scopeMatches(skill, scope));
      const candidates = invalidPluginId ? [] : pluginId === null ? namedCandidates
        : namedCandidates.filter(skill => skill.provider === pluginId && skill.origin === 'plugin');
      const ids = [...new Set(candidates.map(skill => safeId(skill.id)).filter(Boolean))].sort();
      const missingPluginIdAmbiguity = pluginId === null && candidates.some(skill => skill?.origin === 'plugin');
      if (ids.length === 1 && !missingPluginIdAmbiguity) {
        event.resolution = 'catalogued';
        event.skillId = ids[0];
      } else if (ids.length > 1 || missingPluginIdAmbiguity) {
        event.resolution = 'ambiguous';
        event.candidateSkillIds = ids.slice(0, 100);
        if (missingPluginIdAmbiguity) event.reason = 'plugin-id-unavailable';
      } else {
        event.resolution = 'not-in-catalog';
        if (invalidPluginId) event.reason = 'invalid-plugin-id';
      }
    }
    const key = eventKey(event);
    if (seen.has(key)) continue;
    if (run.skillInvocations.length >= MAX_RECORDS) { capped = true; break; }
    seen.add(key);
    run.skillInvocations.push(event);
    added++;
    if (event.resolution === 'catalogued' && observationCount < MAX_OBSERVATIONS) {
      const skill = skills.find(candidate => candidate.id === event.skillId);
      if (skill) {
        skill.observations ??= [];
        const duplicate = skill.observations.some(observation => observation?.kind === 'native-invocation-observed'
          && observation.agentId === actorId && observation.turnId === turnId
          && observation.metadata?.skillName === skillName && observation.metadata?.scope === scope
          && observation.metadata?.pluginId === pluginId && observation.metadata?.invocationType === invocationType
          && observationId(observation.metadata?.observationId) === observationId(event.observationId)
          && observation.metadata?.timestampNs === timestampNs);
        if (!duplicate) {
          skill.observations.push({ kind: 'native-invocation-observed', agentId: actorId, turnId,
            metadata: { skillName, scope, pluginId, invocationType, timestampNs, source: SOURCE,
              ...(sourceTime ? { sourceTime } : {}) } });
          if (event.observationId) skill.observations.at(-1).metadata.observationId = event.observationId;
          observationCount++;
        }
      }
    } else if (event.resolution === 'catalogued') {
      capped = true;
    }
  }
  if (capped) warnings.add('skill-telemetry-limit');
  const metadata = telemetrySnapshot?.metadata ?? {};
  const delivery = metadata.delivery === 'best-effort' ? 'best-effort' : 'unknown';
  const capability = metadata.capability === 'unsupported' ? 'unsupported'
    : metadata.capability === 'unknown' ? (metadata.transport === 'otlp-http-json' ? 'enabled-empty' : 'unknown')
      : run.skillInvocations.length ? 'events-observed'
        : metadata.transport === 'otlp-http-json' ? 'enabled-empty' : 'unknown';
  const status = capped || warnings.size ? 'partial' : run.skillInvocations.length ? 'observed'
    : capability === 'enabled-empty' ? 'empty' : capability === 'unsupported' ? 'unsupported' : 'unknown';
  const byAgent = {};
  for (const agentId of [...knownAgents].sort()) {
    const origins = {};
    for (const skill of skills) {
      if (!cataloguedBy(skill, agentId)) continue;
      const origin = ORIGINS.has(skill.origin) ? skill.origin : 'unknown';
      origins[origin] ??= { catalogCount: 0, invocationCount: 0, status: 'unknown', reason: 'no-event-observed' };
      origins[origin].catalogCount++;
    }
    for (const invocation of run.skillInvocations) {
      if (invocation.agentId !== agentId) continue;
      const skill = skills.find(candidate => candidate.id === invocation.skillId);
      const origin = skill && ORIGINS.has(skill.origin) ? skill.origin : 'unknown';
      origins[origin] ??= { catalogCount: 0, invocationCount: 0, status: 'unknown' };
      origins[origin].invocationCount++;
    }
    for (const row of Object.values(origins)) {
      row.status = row.invocationCount ? 'observed' : 'unknown';
      row.reason = row.invocationCount ? null : 'no-event-observed';
    }
    byAgent[agentId] = origins;
  }
  const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const transportWarnings = [...warnings].filter(value => value.startsWith('telemetry-')).slice(0, 100);
  // Older journal readers supplied flat health metadata. Keep that legacy
  // shape unverified; current readers and live capture use nested diagnostics.
  const rawJournal = metadata.journal ?? (Object.hasOwn(metadata, 'status')
    ? { status: metadata.status, bytes: metadata.bytes, eventCount: metadata.eventCount,
      mode: 'unknown', format: null, commit: 'legacy-unverified', committedBytes: null, committedEvents: null, uncertainBytes: null }
    : null);
  const journal = projectTelemetryJournal(rawJournal) ?? {
    status: 'unknown', mode: 'unknown', format: null, commit: 'unknown', bytes: null, eventCount: null,
    committedBytes: null, committedEvents: null, uncertainBytes: null,
  };
  const deliveryAccounting = projectDeliveryAccounting(metadata.deliveryAccounting);
  run.skillTelemetry = {
    status, delivery, capability,
    boundary: 'Native skill invocation events only; detection and delivery are best-effort and not exhaustive. Observer identities count received records, not guaranteed unique executions; legacy rows without identity retain coarse replay deduplication.',
    warnings: [...warnings].slice(0, 100),
    diagnostics: {
      transport: { status: transportWarnings.length ? 'partial' : metadata.transport === 'otlp-http-json' ? 'observed' : 'unknown',
        receivedBytes: safeCount(metadata.receivedBytes), rejectedRequests: safeCount(metadata.rejectedRequests), warnings: transportWarnings },
      journal,
      ...(deliveryAccounting ? { deliveryAccounting } : {}),
      missingness: { byAgent },
    },
  };
  run.coverage.skillInvocationTelemetry = status;
  if (status === 'partial' && run.status === 'ready') run.status = 'partial';
  return run;
}
