import { createHash } from 'node:crypto';
import { buildAuditReviewPacket } from './audit-review.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const cleanText = (value, max = 500) => text(value, max) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const timestamp = value => cleanText(value, 80) && Number.isFinite(Date.parse(value));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function onlyKeys(value, keys, label) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
}
function safeRelative(value) {
  return text(value, 500) && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').some(part => !part || part === '.' || part === '..')
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}
function collectRuns(subject) {
  const runs = [], seen = new Set();
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!object(value) || seen.has(value)) return;
    seen.add(value);
    if (value.kind === 'audit-run' && typeof value.id === 'string') runs.push(value);
    for (const child of Object.values(value)) if (object(child) || Array.isArray(child)) visit(child);
  };
  visit(subject);
  return runs;
}

function runProfileId(run) { return run.profile?.profileId ?? run.profileId; }
function runNativeSessionId(run) { return run.source?.nativeSessionId ?? run.source?.threadId; }
const unfinished = new Set(['unavailable', 'not-found', 'pending', 'running', 'in-progress', 'started', 'unfinished']);
function validateContract(value) {
  onlyKeys(value, ['id', 'editableFiles'], 'task contract');
  if (!cleanText(value.id, 160) || !Array.isArray(value.editableFiles) || !value.editableFiles.length
    || value.editableFiles.length > 100 || value.editableFiles.some(path => !safeRelative(path))
    || new Set(value.editableFiles).size !== value.editableFiles.length)
    throw new Error('Task contract requires an ID and distinct safe relative editable files');
  return { id: value.id, editableFiles: [...value.editableFiles].sort() };
}
function validateManifest(value) {
  if (!object(value)) throw new Error('Task-end evidence must be an object');
  onlyKeys(value, ['capturedAt', 'files', 'fingerprint'], 'task-end evidence');
  if (!timestamp(value.capturedAt) || !Array.isArray(value.files) || !value.files.length || value.files.length > 500)
    throw new Error('Task-end evidence requires a bounded timestamp and file manifest');
  const files = value.files.map(file => {
    onlyKeys(file, ['path', 'sha256'], 'task-end file');
    if (!safeRelative(file.path) || !sha(file.sha256)) throw new Error('Task-end file needs a safe relative path and SHA-256 digest');
    return { path: file.path, sha256: file.sha256.toLowerCase() };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate task-end file path');
  return { capturedAt: value.capturedAt, files, fingerprint: hash(files) };
}
function validateRecipeInputs(value) {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new Error('Recipe requires a bounded nonempty input manifest');
  const inputs = value.map(file => {
    onlyKeys(file, ['path', 'sha256'], 'check input');
    if (!safeRelative(file.path) || !sha(file.sha256)) throw new Error('Check input needs a safe relative path and SHA-256 digest');
    return { path: file.path, sha256: file.sha256.toLowerCase() };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(inputs.map(file => file.path)).size !== inputs.length) throw new Error('Duplicate check input path');
  return inputs;
}

function validateAttachment(raw, runs, ids) {
  onlyKeys(raw, ['runId', 'profileId', 'nativeSessionId', 'sourceFingerprint', 'attributed', 'recordedAt', 'taskContract', 'taskEnd', 'checkRecipes'], 'session evidence attachment');
  for (const key of ['runId', 'profileId', 'nativeSessionId', 'sourceFingerprint']) if (!cleanText(raw[key], 300)) throw new Error(`Session evidence requires ${key}`);
  if (!sha(raw.sourceFingerprint)) throw new Error('Session evidence source fingerprint must be SHA-256');
  if (ids.has(raw.runId)) throw new Error('Duplicate session evidence attachment for run');
  const run = runs.find(candidate => candidate.id === raw.runId);
  if (!run || run.source?.kind !== 'native-rollout') throw new Error('Session evidence must bind an included native-rollout run');
  if (runProfileId(run) !== raw.profileId || runNativeSessionId(run) !== raw.nativeSessionId
      || run.source?.fingerprint !== raw.sourceFingerprint)
    throw new Error('Session evidence run, profile, native session, or source fingerprint does not match frozen evidence');
  if (!object(raw.attributed)) throw new Error('Session evidence requires attribution');
  onlyKeys(raw.attributed, ['type', 'name'], 'session evidence attribution');
  if (!['human', 'agent', 'automation'].includes(raw.attributed.type) || !cleanText(raw.attributed.name, 200))
    throw new Error('Session evidence attribution must identify a human, agent, or automation');
  if (!timestamp(raw.recordedAt)) throw new Error('Session evidence recordedAt must be a bounded valid timestamp');
  const result = { runId: raw.runId, profileId: raw.profileId, nativeSessionId: raw.nativeSessionId,
    sourceFingerprint: raw.sourceFingerprint, attributed: { ...raw.attributed }, recordedAt: raw.recordedAt,
    origin: 'supplied-session-evidence' };
  if (raw.taskContract !== undefined) {
    result.taskContract = validateContract(raw.taskContract);
  }
  if (raw.taskEnd !== undefined) {
    onlyKeys(raw.taskEnd, ['capturedAt', 'files'], 'task-end evidence');
    result.taskEnd = validateManifest(raw.taskEnd);
  }
  if (raw.checkRecipes !== undefined) {
    if (!Array.isArray(raw.checkRecipes) || raw.checkRecipes.length > 40) throw new Error('Check recipes must be a bounded array');
    const names = new Set();
    const recipes = raw.checkRecipes.map(recipe => {
      onlyKeys(recipe, ['name', 'argv', 'inputs'], 'check recipe');
      if (!cleanText(recipe.name, 120) || names.has(recipe.name) || !Array.isArray(recipe.argv) || recipe.argv.length < 1
        || recipe.argv.length > 64 || recipe.argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
        || !Array.isArray(recipe.inputs) || recipe.inputs.length < 1 || recipe.inputs.length > 200)
        throw new Error('Check recipe requires a unique name, bounded argv, and nonempty input manifest');
      names.add(recipe.name);
      const inputs = validateRecipeInputs(recipe.inputs);
      const recipeFingerprint = hash({ argv: recipe.argv, inputs });
      return { name: recipe.name, fingerprint: recipeFingerprint, inputs };
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (recipes.length) result.checkRecipes = recipes;
  }
  if (!result.taskContract && !result.taskEnd && !result.checkRecipes?.length)
    throw new Error('Session evidence attachment must contain a task contract, task-end candidate, or check recipes');
  ids.add(raw.runId);
  return result;
}

/** Attach externally supplied, source-bound evidence without mutating the original frozen report. */
export function attachAuditSessionEvidence(subject, submission) {
  if (!object(subject) || !['audit-run', 'audit-comparison'].includes(subject.kind))
    throw new Error('Session evidence can only be attached to an original audit-run or audit-comparison');
  const sourceRuns = collectRuns(subject);
  if (subject.kind === 'audit-run' && subject.source?.kind !== 'native-rollout')
    throw new Error('Session evidence requires native-rollout source runs');
  if (!sourceRuns.length || !sourceRuns.every(run => run.source?.kind === 'native-rollout' && !unfinished.has(run.status)))
    throw new Error('Session evidence requires a native-rollout comparison');
  if (unfinished.has(subject.status)) throw new Error('Session evidence requires completed frozen evidence');
  onlyKeys(submission, ['schemaVersion', 'kind', 'evidenceFingerprint', 'attachments'], 'session evidence submission');
  if (submission.schemaVersion !== 1 || submission.kind !== 'xfx-audit-session-evidence'
    || submission.evidenceFingerprint !== buildAuditReviewPacket(subject).evidenceFingerprint
    || !Array.isArray(submission.attachments) || !submission.attachments.length || submission.attachments.length > 160)
    throw new Error('Session evidence submission is invalid or bound to different frozen evidence');
  if (subject.sessionEvidence || sourceRuns.some(run => run.sessionEvidence !== undefined))
    throw new Error('Session evidence is already attached; attach to the original source before review');
  const runs = collectRuns(subject), ids = new Set();
  const attachments = submission.attachments.map(item => validateAttachment(item, runs, ids));
  const byRun = new Map(attachments.map(item => [item.runId, item]));
  const clone = value => {
    if (Array.isArray(value)) return value.map(clone);
    if (!object(value)) return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
    if (value.kind === 'audit-run' && byRun.has(value.id))
      result.sessionEvidence = { schemaVersion: 1, kind: 'xfx-audit-session-evidence',
        evidenceFingerprint: submission.evidenceFingerprint, ...structuredClone(byRun.get(value.id)) };
    return result;
  };
  return clone(subject);
}

/** Validate and return the evidence attached to a particular projected run. */
export function projectAuditSessionEvidence(run) {
  const evidence = run?.sessionEvidence;
  if (evidence === undefined) return null;
  if (!object(evidence) || evidence.schemaVersion !== 1 || evidence.kind !== 'xfx-audit-session-evidence'
    || evidence.origin !== 'supplied-session-evidence' || evidence.runId !== run.id
    || !sha(evidence.evidenceFingerprint) || !object(evidence.attributed))
    throw new Error('Stored session evidence projection is invalid');
  if (evidence.profileId !== runProfileId(run) || evidence.nativeSessionId !== runNativeSessionId(run)
    || evidence.sourceFingerprint !== run.source?.fingerprint)
    throw new Error('Stored session evidence no longer matches its native run binding');
  onlyKeys(evidence, ['schemaVersion', 'kind', 'evidenceFingerprint', 'origin', 'runId', 'profileId', 'nativeSessionId',
    'sourceFingerprint', 'attributed', 'recordedAt', 'taskContract', 'taskEnd', 'checkRecipes'], 'stored session evidence');
  onlyKeys(evidence.attributed, ['type', 'name'], 'stored session evidence attribution');
  if (!['human', 'agent', 'automation'].includes(evidence.attributed.type) || !cleanText(evidence.attributed.name, 200)
    || !timestamp(evidence.recordedAt) || !sha(evidence.sourceFingerprint))
    throw new Error('Stored session evidence attribution or timestamp is invalid');
  if (evidence.taskContract !== undefined) validateContract(evidence.taskContract);
  if (evidence.taskEnd !== undefined) {
    onlyKeys(evidence.taskEnd, ['capturedAt', 'files', 'fingerprint'], 'stored task-end evidence');
    const taskEnd = validateManifest(evidence.taskEnd);
    if (taskEnd.fingerprint !== evidence.taskEnd.fingerprint) throw new Error('Stored task-end manifest fingerprint is invalid');
  }
  if (evidence.checkRecipes !== undefined) {
    if (!Array.isArray(evidence.checkRecipes) || !evidence.checkRecipes.length || evidence.checkRecipes.length > 40)
      throw new Error('Stored check recipe evidence must be nonempty and bounded');
    const seen = new Set();
    for (const recipe of evidence.checkRecipes) {
      onlyKeys(recipe, ['name', 'fingerprint', 'inputs'], 'stored check recipe');
      if (!cleanText(recipe.name, 120) || seen.has(recipe.name) || !sha(recipe.fingerprint))
        throw new Error('Stored check recipe identity is invalid');
      seen.add(recipe.name);
      validateRecipeInputs(recipe.inputs);
    }
  }
  if (unfinished.has(run.status)) throw new Error('Stored session evidence is bound to an unfinished native run');
  if (!cleanText(evidence.runId, 300) || !cleanText(evidence.profileId, 300) || !cleanText(evidence.nativeSessionId, 300))
    throw new Error('Stored session evidence run binding contains invalid text');
  if (!evidence.taskContract && !evidence.taskEnd && !evidence.checkRecipes?.length)
    throw new Error('Stored session evidence attachment is empty');
  return structuredClone(evidence);
}
