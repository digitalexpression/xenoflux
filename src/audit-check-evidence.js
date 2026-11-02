import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { canonicalAuditChecks } from './audit-explanation.js';
import { redactText } from './redact.js';

const MAX_OUTPUT_BYTES = 64 * 1024;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length <= 12000 ? value : null;
const safeTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
const statuses = new Set(['passed', 'failed', 'timeout', 'cancelled', 'not-run', 'recovery-required', 'spawn-failed', 'output-limit', 'unknown']);

function safeContent(value, path) {
  if (typeof value !== 'string') return null;
  const redacted = redactText(value, path);
  const bytes = Buffer.from(redacted);
  if (bytes.length <= MAX_OUTPUT_BYTES) return { text: redacted, truncated: false };
  let end = MAX_OUTPUT_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

function validIncompleteUtf8Suffix(bytes) {
  if (!bytes.length) return false;
  const lead = bytes[0];
  const expected = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3
    : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  if (!expected || bytes.length >= expected) return false;
  if (bytes.subarray(1).some(byte => (byte & 0xc0) !== 0x80)) return false;
  if (bytes.length > 1 && (lead === 0xe0 && bytes[1] < 0xa0 || lead === 0xed && bytes[1] >= 0xa0
    || lead === 0xf0 && bytes[1] < 0x90 || lead === 0xf4 && bytes[1] > 0x8f)) return false;
  return true;
}

function decodeBoundedOutput(bytes, truncated) {
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated }; }
  catch (error) {
    if (!truncated) throw error;
    for (let removed = 1; removed <= 3 && removed < bytes.length; removed++) {
      const suffix = bytes.subarray(bytes.length - removed);
      if (!validIncompleteUtf8Suffix(suffix)) continue;
      try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - removed)), truncated: true }; }
      catch { /* The invalid byte is earlier in the buffer; keep trying only for a valid trailing partial sequence. */ }
    }
    throw error;
  }
}

/** Read only runner-owned check-N output files; callers never pass report-supplied paths. */
export async function readAuditCheckOutput(directory, index, { outputLimitBytes = MAX_OUTPUT_BYTES } = {}) {
  if (typeof directory !== 'string' || !Number.isSafeInteger(index) || index < 0
    || !Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < 1) return { stdout: null, stderr: null, status: 'unavailable', truncated: false };
  let root;
  try { root = await realpath(directory); } catch { return { stdout: null, stderr: null, status: 'unavailable', truncated: false }; }
  const streams = [];
  let truncated = false;
  for (const stream of ['stdout', 'stderr']) {
    const path = join(root, `check-${index}.${stream}`);
    let handle;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || await realpath(path) !== path)
        throw new Error('unsafe check output');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1)
        throw new Error('changed check output');
      const size = Math.min(stat.size, outputLimitBytes + 1);
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await handle.read(bytes, 0, size, 0);
      const wasTruncated = stat.size > outputLimitBytes || bytesRead > outputLimitBytes;
      if (wasTruncated) truncated = true;
      const selected = bytes.subarray(0, Math.min(bytesRead, outputLimitBytes));
      const decoded = decodeBoundedOutput(selected, wasTruncated);
      streams.push(decoded.text);
      truncated ||= decoded.truncated;
    } catch {
      return { stdout: null, stderr: null, status: 'unavailable', truncated };
    } finally { await handle?.close().catch(() => {}); }
  }
  const stdout = safeContent(streams[0], 'check.stdout'), stderr = safeContent(streams[1], 'check.stderr');
  return { stdout: stdout?.text ?? null, stderr: stderr?.text ?? null, status: 'retained',
    truncated: truncated || stdout?.truncated === true || stderr?.truncated === true };
}

/** Build retained evidence from the validated recipe and the runner's own process results. */
export function buildAuditCheckEvidence({ checks = [], results = [], workspaceFingerprint = null, outputs = [] } = {}) {
  if (!Array.isArray(checks) || !Array.isArray(results) || !Array.isArray(outputs))
    return { schemaVersion: 1, origin: 'runner-check', records: [] };
  const recipes = checks.map(check => ({ name: check?.name, fingerprint: fingerprint(check) }));
  return { schemaVersion: 1, origin: 'runner-check', records: checks.map((check, index) => {
    const recipe = recipes[index], result = results[index] ?? null;
    const output = outputs[index] ?? { stdout: null, stderr: null, status: 'unavailable', truncated: false };
    return {
      id: `check-${recipe.fingerprint}`,
      name: recipe.name,
      definitionFingerprint: recipe.fingerprint,
      definition: { command: Array.isArray(check.argv) ? redactText(JSON.stringify(check.argv), 'check.command') : null,
        purpose: null, timeoutMs: Number.isSafeInteger(check.timeoutMs) ? check.timeoutMs : null,
        passCondition: 'The runner records a pass only when the process exits with code 0.' },
      execution: { status: statuses.has(result?.status) ? result.status : 'not-run',
        exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
        startedAt: safeTime(result?.startedAt), elapsedMs: Number.isSafeInteger(result?.elapsedMs) && result.elapsedMs >= 0 ? result.elapsedMs : null,
        workspaceFingerprint: hash(workspaceFingerprint) ? workspaceFingerprint : null },
      output: { stdout: output.status === 'retained' ? output.stdout : null,
        stderr: output.status === 'retained' ? output.stderr : null,
        status: ['retained', 'omitted', 'unavailable'].includes(output.status) ? output.status : 'unavailable',
        truncated: output.truncated === true || result?.output?.truncated === true },
    };
  }) };
}

/** Bind check details to both frozen recipe fingerprints and canonical runner results. */
export function normalizeAuditCheckEvidence(run, { includeContent = false } = {}) {
  const evidence = run?.checkEvidence;
  if (!evidence || evidence.schemaVersion !== 1 || evidence.origin !== 'runner-check'
    || !Array.isArray(evidence.records) || evidence.records.length > 20) return null;
  const contentOmitted = evidence.contentBoundary === 'check-command-and-output-omitted';
  const includeBodies = includeContent && !contentOmitted;
  const recipes = run?.comparisonConditions?.checkRecipes;
  if (!Array.isArray(recipes)) return null;
  const checks = canonicalAuditChecks(run).filter(row => row.origin === 'runner-check');
  const seen = new Set(), records = [];
  for (const record of evidence.records) {
    if (!record || !hash(record.definitionFingerprint) || typeof record.name !== 'string'
      || record.id !== `check-${record.definitionFingerprint}` || seen.has(record.id)) return null;
    seen.add(record.id);
    const matchingRecipes = recipes.filter(recipe => recipe?.name === record.name
      && recipe.fingerprint === record.definitionFingerprint);
    if (matchingRecipes.length !== 1) continue;
    const results = checks.filter(check => check.name === record.name);
    const execution = record.execution;
    if (results.length !== 1 && execution?.status !== 'not-run') continue;
    if (results.length === 1 && (results[0].status !== execution?.status || results[0].exitCode !== execution?.exitCode)) continue;
    if (!execution || !statuses.has(execution.status)
      || (execution.exitCode !== null && !Number.isSafeInteger(execution.exitCode))
      || (execution.elapsedMs !== null && (!Number.isSafeInteger(execution.elapsedMs) || execution.elapsedMs < 0))
      || (execution.startedAt !== null && !safeTime(execution.startedAt))
      || (execution.workspaceFingerprint !== null && !hash(execution.workspaceFingerprint))) continue;
    const definition = record.definition, output = record.output;
    if (!definition || typeof definition !== 'object' || !output || typeof output !== 'object'
      || !['retained', 'omitted', 'unavailable'].includes(output.status) || typeof output.truncated !== 'boolean') continue;
    const safeDefinition = { command: includeBodies ? safeContent(definition.command, 'check.command')?.text ?? null : null,
      purpose: text(definition.purpose), timeoutMs: Number.isSafeInteger(definition.timeoutMs) && definition.timeoutMs >= 1 ? definition.timeoutMs : null,
      passCondition: text(definition.passCondition) ?? 'Pass condition was not retained.' };
    let safeOutput;
    if (!includeBodies || output.status !== 'retained') safeOutput = { stdout: null, stderr: null,
      status: output.status === 'unavailable' ? 'unavailable' : 'omitted', truncated: output.truncated };
    else {
      const stdout = safeContent(output.stdout, 'check.stdout'), stderr = safeContent(output.stderr, 'check.stderr');
      if (!stdout || !stderr) safeOutput = { stdout: null, stderr: null, status: 'unavailable', truncated: output.truncated };
      else safeOutput = { stdout: stdout.text, stderr: stderr.text, status: 'retained',
        truncated: output.truncated || stdout.truncated || stderr.truncated };
    }
    records.push({ id: record.id, name: record.name, definitionFingerprint: record.definitionFingerprint,
      definition: safeDefinition, execution: { status: execution.status, exitCode: execution.exitCode,
        startedAt: execution.startedAt, elapsedMs: execution.elapsedMs, workspaceFingerprint: execution.workspaceFingerprint }, output: safeOutput });
  }
  const budgetOmitted = evidence.contentBoundary === 'check-command-and-output-omitted-by-byte-budget';
  return { schemaVersion: 1, origin: 'runner-check', contentBoundary: budgetOmitted
    ? evidence.contentBoundary : includeBodies ? 'selected-redacted-check-content' : 'check-command-and-output-omitted', records };
}
