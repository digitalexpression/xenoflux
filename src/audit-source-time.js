// Source-reported time domains only. No calibrated clock relationship, delivery
// latency, event ordering or occurrence identity is established by these fields.
import { isDeepStrictEqual } from 'node:util';

const MAX_NS = (1n << 64n) - 1n;
const DOMAINS = Object.freeze({
  nativeEvent: { source: 'event.timestamp', clock: 'producer-reported' },
  otlpEvent: { source: 'timeUnixNano', clock: 'otlp-event' },
  otlpObserved: { source: 'observedTimeUnixNano', clock: 'otlp-observed' },
});

/** OTLP JSON uses decimal strings. Zero is unset; numbers risk lost precision. */
export function sourceTimeNs(value) {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  const digits = value.replace(/^0+/, '');
  if (!digits || digits.length > 20) return null;
  const ns = BigInt(digits);
  return ns > 0n && ns <= MAX_NS ? ns.toString() : null;
}

/** Strict UTC Z calendar time, with at most nanosecond precision. */
export function nativeSourceTimeNs(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  // Round-trip the full calendar portion: Date.parse alone normalizes invalid
  // dates, and floating-point timestamp parsing would lose fractional ns.
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  const ms = date.getTime();
  if (!Number.isSafeInteger(ms) || ms < 0 || date.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  const ns = BigInt(ms) * 1000000n + BigInt(fraction.padEnd(9, '0'));
  return ns > 0n && ns <= MAX_NS ? ns.toString() : null;
}

/** Build metadata from allowlisted wire fields, ignoring caller projections. */
export function skillSourceTimeFromRecord(record, timestampAttribute) {
  const values = {
    nativeEvent: nativeSourceTimeNs(timestampAttribute),
    otlpEvent: sourceTimeNs(record?.timeUnixNano),
    otlpObserved: sourceTimeNs(record?.observedTimeUnixNano),
  };
  return { schemaVersion: 1, ...Object.fromEntries(Object.entries(DOMAINS)
    .map(([key, labels]) => [key, { ...labels, unixNano: values[key] }])), clockRelationship: 'unknown' };
}

/** Canonical frozen projection. Missing, invalid and unsupported time is unknown. */
export function projectSkillSourceTime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return null;
  const rows = Object.entries(DOMAINS).map(([key, labels]) => {
    const row = value[key];
    const validLabels = row && typeof row === 'object' && !Array.isArray(row)
      && row.source === labels.source && row.clock === labels.clock;
    return [key, { ...labels, unixNano: validLabels ? sourceTimeNs(row.unixNano) : null }];
  });
  return { schemaVersion: 1, ...Object.fromEntries(rows), clockRelationship: 'unknown' };
}

/** Journals accept only the canonical allowlist, never arbitrary nested data. */
export function validSkillSourceTime(value) {
  const projected = projectSkillSourceTime(value);
  return projected !== null && isDeepStrictEqual(value, projected);
}

/** Human-readable projection without dropping the retained fractional digits. */
export function nsToSourceIso(value) {
  const canonical = sourceTimeNs(value);
  if (canonical === null) return null;
  const ns = BigInt(canonical), seconds = ns / 1000000000n;
  return `${new Date(Number(seconds * 1000n)).toISOString().slice(0, 19)}.${String(ns % 1000000000n).padStart(9, '0')}Z`;
}

/** Project only documented source-time rows; preserve other evidence as supplied. */
export function projectSourceTimeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.hasOwn(row, 'sourceTime')) return row;
  const projected = projectSkillSourceTime(row.sourceTime), out = { ...row };
  if (projected) out.sourceTime = projected; else delete out.sourceTime;
  return out;
}

export function projectSourceTimeObservation(observation) {
  const out = projectSourceTimeRow(observation);
  if (!out || typeof out !== 'object' || Array.isArray(out) || !out.metadata
    || typeof out.metadata !== 'object' || Array.isArray(out.metadata)) return out;
  return { ...out, metadata: projectSourceTimeRow(out.metadata) };
}

/** Comparison APIs and frozen storage share the same source-time boundary. */
export function projectRunSkillSourceTimes(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return run;
  return { ...run,
    ...(Array.isArray(run.skillInvocations) ? { skillInvocations: run.skillInvocations.map(projectSourceTimeRow) } : {}),
    ...(Array.isArray(run.skills) ? { skills: run.skills.map(skill => skill && typeof skill === 'object' && Array.isArray(skill.observations)
      ? { ...skill, observations: skill.observations.map(projectSourceTimeObservation) } : skill) } : {}),
  };
}
