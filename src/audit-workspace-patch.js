import { createHash } from 'node:crypto';
import { redactText } from './redact.js';

export const MAX_AUDIT_WORKSPACE_PATCH_BYTES = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OMIT_REASONS = new Set(['binary-content', 'size-limit', 'invalid-utf8', 'unsafe-redaction', 'no-changes', 'source-baseline-unavailable', 'recorded-content-not-included']);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function redactUnifiedDiff(text) {
  const lines = text.split('\n');
  let inHunk = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^(?:diff --git |diff --cc |diff --combined )/.test(line)) { inHunk = false; lines[index] = redactText(line, 'task-end.patch'); continue; }
    if (/^@{2,3} /.test(line)) { inHunk = true; continue; }
    if (!inHunk || ![' ', '+', '-'].includes(line[0])) { lines[index] = redactText(line, 'task-end.patch'); continue; }
    const prefix = line[0], payload = line.slice(1);
    const privateKeyStart = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/.exec(payload);
    if (privateKeyStart) {
      const endPattern = /-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/;
      let end = index;
      for (; end < lines.length; end++) {
        const candidate = lines[end];
        if (![' ', '+', '-'].includes(candidate[0])) break;
        if (endPattern.test(candidate.slice(1))) { end++; break; }
      }
      const before = payload.slice(0, privateKeyStart.index);
      lines[index] = `${prefix}${before}[REDACTED PRIVATE KEY]`;
      for (let row = index + 1; row < end; row++) lines[row] = `${lines[row][0]}[REDACTED PRIVATE KEY CONTINUED]`;
      index = end - 1;
      continue;
    }
    lines[index] = `${prefix}${redactText(payload, 'task-end.patch')}`;
  }
  return lines.join('\n');
}

function binding(taskEndFingerprint, baselineFingerprint, sourcePatchSha256) {
  return { basis: 'source-baseline-to-task-end', taskEndFingerprint, baselineFingerprint, sourcePatchSha256 };
}

/** Build bounded redacted patch evidence from a trusted, in-memory Git snapshot. */
export function captureAuditWorkspacePatch(patch, metadata, { sourceBaselineCommit, sourceBaselineTree, baselineFingerprint,
  hasBinary = false, captureProvenance = 'runner-in-memory-snapshot' } = {}) {
  if (!Buffer.isBuffer(patch) || !metadata || !SHA256.test(metadata.fingerprint ?? '')
    || !SHA256.test(metadata.patchSha256 ?? '') || sha256(patch) !== metadata.patchSha256
    || !SHA256.test(baselineFingerprint ?? '')
    || !['runner-in-memory-snapshot', 'verified-retained-artifact'].includes(captureProvenance))
    throw new Error('Task-end patch snapshot binding is invalid');
  const sourceBaseline = { commit: GIT_OBJECT_ID.test(sourceBaselineCommit ?? '') ? sourceBaselineCommit : null,
    tree: GIT_OBJECT_ID.test(sourceBaselineTree ?? '') ? sourceBaselineTree : null };
  const bound = binding(metadata.fingerprint, baselineFingerprint, metadata.patchSha256);
  let reason = null;
  if (!sourceBaseline.commit || !sourceBaseline.tree) reason = 'source-baseline-unavailable';
  else if (hasBinary) reason = 'binary-content';
  else if (patch.length === 0) reason = 'no-changes';
  else if (patch.length > MAX_AUDIT_WORKSPACE_PATCH_BYTES) reason = 'size-limit';
  if (reason) return { status: 'omitted', reason, ...bound, sourceBaseline, sourcePatchBytes: patch.length, captureProvenance };

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(patch);
    text = redactUnifiedDiff(text);
  } catch (error) {
    const omission = error instanceof TypeError ? 'invalid-utf8' : 'unsafe-redaction';
    return { status: 'omitted', reason: omission, ...bound, sourceBaseline, sourcePatchBytes: patch.length, captureProvenance };
  }
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_AUDIT_WORKSPACE_PATCH_BYTES)
    return { status: 'omitted', reason: 'size-limit', ...bound, sourceBaseline, sourcePatchBytes: patch.length, captureProvenance };
  return { status: 'available', ...bound, sourceBaseline, sourcePatchBytes: patch.length, captureProvenance,
    text, textSha256: sha256(Buffer.from(text)), bytes, redacted: true };
}

/** Validate and project persisted patch evidence against its owning task-end record. */
export function projectAuditWorkspacePatch(value, { taskEndFingerprint, baselineFingerprint, sourcePatchSha256,
  sourceBaselineCommit, sourceBaselineTree } = {}) {
  if (value == null) return null;
  const sourceBaselineValid = GIT_OBJECT_ID.test(value?.sourceBaseline?.commit ?? '') && GIT_OBJECT_ID.test(value?.sourceBaseline?.tree ?? '');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.basis !== 'source-baseline-to-task-end'
    || !SHA256.test(value.taskEndFingerprint ?? '') || value.taskEndFingerprint !== taskEndFingerprint
    || !SHA256.test(value.baselineFingerprint ?? '') || value.baselineFingerprint !== baselineFingerprint
    || !SHA256.test(value.sourcePatchSha256 ?? '') || value.sourcePatchSha256 !== sourcePatchSha256
    || !Number.isSafeInteger(value.sourcePatchBytes) || value.sourcePatchBytes < 0
    || !['runner-in-memory-snapshot', 'verified-retained-artifact'].includes(value.captureProvenance)
    || !value.sourceBaseline || (value.status === 'available' && !sourceBaselineValid)
    || (value.status === 'omitted' && !sourceBaselineValid && value.reason !== 'source-baseline-unavailable')
    || (sourceBaselineCommit !== undefined && value.sourceBaseline.commit !== sourceBaselineCommit)
    || (sourceBaselineTree !== undefined && value.sourceBaseline.tree !== sourceBaselineTree))
    throw new Error('Invalid or unbound task-end patch evidence');
  const out = { status: value.status, ...binding(value.taskEndFingerprint, value.baselineFingerprint, value.sourcePatchSha256),
    sourceBaseline: { commit: GIT_OBJECT_ID.test(value.sourceBaseline.commit ?? '') ? value.sourceBaseline.commit : null,
      tree: GIT_OBJECT_ID.test(value.sourceBaseline.tree ?? '') ? value.sourceBaseline.tree : null },
    sourcePatchBytes: value.sourcePatchBytes, captureProvenance: value.captureProvenance };
  if (value.status === 'omitted') {
    if (!OMIT_REASONS.has(value.reason) || Object.hasOwn(value, 'text') || Object.hasOwn(value, 'bytes') || Object.hasOwn(value, 'redacted'))
      throw new Error('Invalid omitted task-end patch evidence');
    out.reason = value.reason;
    if (value.textSha256 !== undefined) {
      if (!SHA256.test(value.textSha256)) throw new Error('Invalid omitted task-end patch digest');
      out.textSha256 = value.textSha256;
    }
    return out;
  }
  if (value.status !== 'available' || !value.redacted || typeof value.text !== 'string'
    || Buffer.byteLength(value.text) > MAX_AUDIT_WORKSPACE_PATCH_BYTES || value.bytes !== Buffer.byteLength(value.text)
    || !SHA256.test(value.textSha256 ?? '') || value.textSha256 !== sha256(Buffer.from(value.text))
    || redactUnifiedDiff(value.text) !== value.text)
    throw new Error('Invalid or unsafe task-end patch content');
  return { ...out, text: value.text, textSha256: value.textSha256, bytes: value.bytes, redacted: true };
}
