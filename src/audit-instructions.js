// Native loaded-source metadata only. Never read instruction text or export
// absolute paths; a reference identifies a logical location, not its contents.
import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactValue } from './redact.js';

const CONTRACT = 'codex-owned-loaded-instruction-sources-v1';
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const REFERENCE = /^sha256:[a-f0-9]{64}$/;
const STATUSES = new Set(['reported', 'reported-empty', 'partial', 'unavailable']);
const ORIGINS = new Set(['repository', 'profile', 'user', 'external']);
const NAMES = new Set(['AGENTS.md', 'AGENTS.override.md', 'instruction-file']);
const SOURCES = new Set(['thread/start', 'thread/resume-loaded']);
const PHASES = new Set(['before-task', 'after-task']);
const REASONS = new Set(['unsupported-native-version', 'field-unavailable', 'invalid-source-list',
  'source-list-limit', 'unsafe-source-path', 'agent-not-idle', 'agent-not-loaded', 'agent-not-subscribed',
  'loaded-list-unavailable', 'loaded-list-partial', 'resume-unavailable',
  'resume-identity-mismatch', 'resumed-thread-changed', 'capture-incomplete',
  'instruction-evidence-limit', 'malformed-snapshot', 'snapshot-unavailable']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const limit = (value, fallback, max) => Number.isSafeInteger(value) && value >= 0 ? Math.min(max, value) : fallback;

/** Accept native instruction metadata only when its shape positively proves the capability. */
export function nativeInstructionSourceContract(value, { maxSources = 128 } = {}) {
  const cap = limit(maxSources, 128, 128);
  if (!Array.isArray(value) || value.length > cap) return null;
  if (value.some(path => !absolutePath(path))) return null;
  return CONTRACT;
}

function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || redactValue(value) !== value) return null;
  let path = value;
  if (value.startsWith('file://')) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return null;
      path = fileURLToPath(url);
    } catch { return null; }
  }
  return isAbsolute(path) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path) && redactValue(path) === path ? resolve(path) : null;
}

function referenceFor(value, { workspace, profileHome, userHome } = {}) {
  const path = absolutePath(value);
  if (!path) return null;
  let origin = 'external', logicalPath = path;
  for (const [kind, candidate] of [['repository', workspace], ['profile', profileHome], ['user', userHome]]) {
    const root = absolutePath(candidate);
    if (!root) continue;
    const suffix = relative(root, path);
    if (suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
      origin = kind; logicalPath = suffix; break;
    }
  }
  const name = basename(path);
  return { id: `sha256:${createHash('sha256').update(`${origin}\0${logicalPath}`).digest('hex')}`,
    origin, name: NAMES.has(name) ? name : 'instruction-file' };
}

/** Stable identity for a validated logical source path; does not touch the filesystem. */
export function instructionReferenceId(origin, logicalPath) {
  if (!['repository', 'profile', 'user'].includes(origin) || typeof logicalPath !== 'string') return null;
  return `sha256:${createHash('sha256').update(`${origin}\0${logicalPath}`).digest('hex')}`;
}

export function projectInstructionSources(value, { agentId, source, phase, sourceLine = null,
  workspace, profileHome, userHome, reason = null, maxSources = 128 } = {}) {
  if (!ID.test(agentId ?? '') || !SOURCES.has(source) || !PHASES.has(phase)) throw new TypeError('Invalid instruction source ownership');
  const row = { agentId, source, phase, sourceLine: Number.isSafeInteger(sourceLine) && sourceLine > 0 ? sourceLine : null,
    status: 'unavailable', reportedCount: null, sources: [], omittedCount: 0, rejectedCount: 0,
    reason: REASONS.has(reason) ? reason : value === undefined ? 'field-unavailable' : null };
  if (reason || value === undefined) return row;
  if (!Array.isArray(value)) { row.reason = 'invalid-source-list'; return row; }
  const cap = limit(maxSources, 128, 128);
  row.reportedCount = value.length;
  row.omittedCount = Math.max(0, value.length - cap);
  for (const path of value.slice(0, cap)) {
    const reference = referenceFor(path, { workspace, profileHome, userHome });
    if (!reference) { row.rejectedCount++; continue; }
    row.sources.push(reference);
  }
  row.status = nativeInstructionSourceContract(value, { maxSources: cap })
    ? row.sources.length ? 'reported' : 'reported-empty' : 'partial';
  row.reason = row.omittedCount ? 'source-list-limit' : row.rejectedCount ? 'unsafe-source-path' : null;
  return row;
}

/** Re-project frozen metadata without retaining arbitrary fields or paths. */
export function compactInstructionSources(value, { maxAgents = 160, maxSources = 64 } = {}) {
  const input = Array.isArray(value) ? value : [];
  const agentCap = limit(maxAgents, 160, 160), sourceCap = limit(maxSources, 64, 128);
  const rows = []; let omittedAgents = Math.max(0, input.length - agentCap), omittedSources = 0;
  const seen = new Set();
  for (const raw of input.slice(0, agentCap)) {
    if (!raw || !ID.test(raw.agentId ?? '') || !SOURCES.has(raw.source) || !PHASES.has(raw.phase)
      || seen.has(raw.agentId)) { omittedAgents++; continue; }
    seen.add(raw.agentId);
    const sources = [];
    const originalSources = Array.isArray(raw.sources) ? raw.sources : [];
    let rejected = count(raw.rejectedCount) ?? 0;
    let omitted = (count(raw.omittedCount) ?? 0) + Math.max(0, originalSources.length - sourceCap);
    for (const entry of originalSources.slice(0, sourceCap)) {
      if (!entry || !REFERENCE.test(entry.id ?? '') || !ORIGINS.has(entry.origin) || !NAMES.has(entry.name)) { rejected++; continue; }
      sources.push({ id: entry.id, origin: entry.origin, name: entry.name });
    }
    let status = STATUSES.has(raw.status) ? raw.status : 'unavailable';
    const reportedCount = count(raw.reportedCount);
    let reason = REASONS.has(raw.reason) ? raw.reason : null;
    if (!STATUSES.has(raw.status) || !Array.isArray(raw.sources) || (status !== 'unavailable' && reportedCount === null)
      || (status === 'reported-empty' && (sources.length || reportedCount !== 0))
      || (status === 'reported' && !sources.length)
      || (reportedCount !== null && sources.length > reportedCount)) {
      status = 'partial'; reason = 'malformed-snapshot';
    }
    if (omitted || rejected) { status = 'partial'; reason ??= 'instruction-evidence-limit'; }
    if (status === 'unavailable') { sources.length = 0; reason ??= 'snapshot-unavailable'; }
    omittedSources += omitted;
    rows.push({ agentId: raw.agentId, source: raw.source, phase: raw.phase,
      sourceLine: Number.isSafeInteger(raw.sourceLine) && raw.sourceLine > 0 ? raw.sourceLine : null,
      status, reportedCount, sources, omittedCount: omitted, rejectedCount: rejected, reason });
  }
  const anyObserved = rows.some(row => row.status !== 'unavailable');
  const status = !anyObserved ? (omittedAgents ? 'partial' : 'unavailable')
    : omittedAgents || rows.some(row => !['reported', 'reported-empty'].includes(row.status)) ? 'partial' : 'observed';
  return { rows, omittedAgents, omittedSources, status };
}
