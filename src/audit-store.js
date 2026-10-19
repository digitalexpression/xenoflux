// Explicit immutable report export. Native transcripts remain in their owning homes.
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { renderAudit } from './audit-report.js';
import { projectResourceProvenance, compareResourceProvenance } from './audit-provenance.js';

const KINDS = new Set(['audit-run', 'audit-comparison', 'audit-profile', 'audit-profile-comparison', 'audit-experiment-report', 'audit-series-report', 'audit-evaluation-report']);
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

function validate(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || !KINDS.has(value.kind))
    throw new Error('Unsupported frozen audit report; use an exported schemaVersion 1 JSON report');
  return value;
}

// Normalize only documented report locations; arbitrary nested user data is never traversed.
function normalizeRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return run;
  return Object.hasOwn(run, 'resourceProvenance') ? { ...run, resourceProvenance: projectResourceProvenance(run.resourceProvenance) } : run;
}
function normalizeTrial(trial) {
  if (!trial || typeof trial !== 'object' || Array.isArray(trial)) return trial;
  return { ...trial,
    ...(Array.isArray(trial.runs) ? { runs: trial.runs.map(normalizeRun) } : {}),
    ...(Array.isArray(trial.profiles) ? { profiles: trial.profiles.map(profile => ({ ...profile,
      ...(profile?.run ? { run: normalizeRun(profile.run) } : {}) })) } : {}) };
}
function verifiedSameBaseline(left, right) {
  const a = left?.sourceWorkspace ?? left?.source?.baseline ?? left?.baseline ?? {};
  const b = right?.sourceWorkspace ?? right?.source?.baseline ?? right?.baseline ?? {};
  const aCommit = a.sourceCommit ?? a.commit, bCommit = b.sourceCommit ?? b.commit;
  const aTree = a.sourceTree ?? a.tree, bTree = b.sourceTree ?? b.tree;
  return Boolean(aCommit && aTree && bCommit && bTree && aCommit === bCommit && aTree === bTree);
}
/** Normalize provenance only at the fixed report and checkpoint layouts. */
export function projectReportResourceProvenance(value, depth = 0) {
  if (depth > 6) {
    const hasKnownLayout = value && typeof value === 'object' && (Array.isArray(value) || Object.hasOwn(value, 'resourceProvenance')
      || ['captureCheckpoint', 'state', 'record', 'report', 'run', 'series', 'trials', 'runs'].some(key => Object.hasOwn(value, key)));
    if (hasKnownLayout) throw new Error('Frozen report provenance layout exceeds the supported nesting depth');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => projectReportResourceProvenance(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  if (value.kind === 'audit-run') return normalizeRun(value);
  if (value.kind === 'audit-comparison') return { ...value,
    ...(value.left ? { left: normalizeRun(value.left) } : {}), ...(value.right ? { right: normalizeRun(value.right) } : {}),
    ...(value.comparison?.resourceProvenance || value.left?.resourceProvenance || value.right?.resourceProvenance ? {
      comparison: { ...value.comparison, resourceProvenance: compareResourceProvenance(value.left?.resourceProvenance, value.right?.resourceProvenance,
        { sameBaseline: verifiedSameBaseline(value.left, value.right) }) } } : {}) };
  if (value.kind === 'audit-series-report') return { ...value,
    ...(Array.isArray(value.trials) ? { trials: value.trials.map(normalizeTrial) } : {}) };
  if (value.kind === 'audit-evaluation-report' && value.series?.kind === 'audit-series-report')
    return { ...value, series: projectReportResourceProvenance(value.series, depth + 1) };
  let out = value, changed = false;
  const set = (key, next) => { if (!changed) out = { ...value }; out[key] = next; changed = true; };
  if (Array.isArray(value.runs)) set('runs', value.runs.map(normalizeRun));
  if (Array.isArray(value.trials)) set('trials', value.trials.map(normalizeTrial));
  if (value.kind === 'audit-capture-checkpoint' && value.run) set('run', normalizeRun(value.run));
  if (value.captureCheckpoint && typeof value.captureCheckpoint === 'object') set('captureCheckpoint', projectReportResourceProvenance(value.captureCheckpoint, depth + 1));
  if (Array.isArray(value.state?.trials)) set('state', { ...value.state, trials: value.state.trials.map(trial => ({ ...trial,
    ...(trial?.summary ? { summary: projectReportResourceProvenance(trial.summary, depth + 1) } : {}) })) });
  if (value.record && typeof value.record === 'object') set('record', projectReportResourceProvenance(value.record, depth + 1));
  if (value.report && typeof value.report === 'object') set('report', projectReportResourceProvenance(value.report, depth + 1));
  if (value.run && typeof value.run === 'object') set('run', normalizeRun(value.run));
  if (value.series && typeof value.series === 'object') set('series', projectReportResourceProvenance(value.series, depth + 1));
  if (value.resourceProvenance !== undefined) set('resourceProvenance', projectResourceProvenance(value.resourceProvenance));
  return changed ? out : value;
}

export async function readAuditReport(path) {
  let handle;
  try {
    const requested = resolve(path);
    const selected = join(await realpath(dirname(requested)), basename(requested)), before = await lstat(selected);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_REPORT_BYTES
      || await realpath(selected) !== selected) throw new Error('unsafe');
    handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('changed');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, Math.min(65536, buffer.length - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    const after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('changed');
    return projectReportResourceProvenance(validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
  } catch (error) {
    if (error.message.startsWith('Unsupported frozen audit')) throw error;
    throw new Error('The frozen audit report is missing, unsafe, changed, or invalid');
  } finally { await handle?.close(); }
}

async function removeOwned(path, identity) {
  try {
    const now = await lstat(path);
    if (now.dev === identity.dev && now.ino === identity.ino) await unlink(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Create all output files exclusively; roll back only files created by this call. */
export async function exportAuditReport(value, { output, format = 'json' } = {}) {
  validate(value);
  value = projectReportResourceProvenance(value);
  if (!['json', 'markdown'].includes(format)) throw new Error('Choose export --format json or markdown');
  if (typeof output !== 'string' || !output.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(output))
    throw new Error('Export requires a plain --output file path');
  const requested = resolve(output);
  const path = join(await realpath(dirname(requested)), basename(requested));
  const json = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(json) > MAX_REPORT_BYTES) throw new Error('Frozen audit report exceeds the export size limit');
  const evidencePath = format === 'json' ? path : `${path}.audit.json`;
  const writes = format === 'json' ? [[path, json]] : [[evidencePath, json], [path, renderAudit(value, { format: 'markdown' })]];
  // Refuse collisions before creating anything; exclusive open also handles races.
  for (const [target] of writes) {
    try { await lstat(target); throw new Error('Audit export refuses to overwrite an existing file'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const created = [];
  try {
    for (const [target, content] of writes) {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        created.push([target, await handle.stat()]);
        await handle.writeFile(content); await handle.sync();
      } finally { await handle.close(); }
    }
  } catch {
    for (const [target, identity] of created.reverse()) await removeOwned(target, identity);
    throw new Error('Audit export could not create its files; existing files were preserved');
  }
  return { schemaVersion: 1, kind: 'audit-export', output: path, format, evidencePath,
    sha256: createHash('sha256').update(json).digest('hex'), sourceKind: value.kind,
    sourceStatus: value.status ?? null, retention: 'Frozen normalized evidence; native transcripts were not copied.' };
}
