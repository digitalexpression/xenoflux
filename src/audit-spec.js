import { open, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { validateAuditQuality } from './audit-quality.js';
import { validateCaptureRequirements } from './audit-evidence.js';

const plain = (value, limit = 4096) => typeof value === 'string' && value.trim().length > 0
  && value.length <= limit && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const allowed = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw new Error(`Invalid or unsupported ${label} field`);
};
const integer = (value, fallback, min, max, label) => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return selected;
};

const NATIVE_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** Validate the narrow set of per-process native Codex config overrides accepted by audit recipes. */
export function validateAuditNativeConfig(value) {
  if (value === undefined) return undefined;
  allowed(value, ['model', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'forced_login_method'], 'native config');
  const result = {};
  if (value.model !== undefined) {
    if (!plain(value.model, 120)) throw new Error('Native config model must be a plain string');
    result.model = value.model;
  }
  for (const key of ['model_reasoning_effort', 'plan_mode_reasoning_effort']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !NATIVE_REASONING_EFFORTS.has(value[key]))
      throw new Error(`Native config ${key} must be a recognized reasoning effort`);
    result[key] = value[key];
  }
  if (value.forced_login_method !== undefined) {
    if (!['chatgpt', 'api'].includes(value.forced_login_method))
      throw new Error('Native config forced_login_method must be chatgpt or api');
    result.forced_login_method = value.forced_login_method;
  }
  return Object.keys(result).length ? Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))) : {};
}

function commands(value = [], label) {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} must contain at most twenty commands`);
  const names = new Set();
  return value.map(command => {
    allowed(command, ['name', 'argv', 'timeoutMs'], label);
    if (!plain(command.name, 100) || names.has(command.name) || !Array.isArray(command.argv)
      || command.argv.length < 1 || command.argv.length > 64
      || command.argv.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
      || !plain(command.argv[0])) throw new Error(`Each ${label} command needs a unique name and argv array`);
    names.add(command.name);
    return { name: command.name, argv: [...command.argv], timeoutMs: integer(command.timeoutMs, 60000, 1, 3600000, `${label} timeoutMs`) };
  });
}

function taskContract(value) {
  if (value === undefined) return undefined;
  allowed(value, ['id', 'editableFiles'], 'task contract');
  if (!plain(value.id, 120) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value.id)
    || !Array.isArray(value.editableFiles) || value.editableFiles.length > 100
    || value.editableFiles.some(path => typeof path !== 'string' || !path || path.length > 500
      || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path))
    || new Set(value.editableFiles).size !== value.editableFiles.length)
    throw new Error('Task contract requires a safe ID and distinct relative editable paths');
  return { id: value.id, editableFiles: [...value.editableFiles] };
}

/** Freeze one task, committed baseline, selected setups and bounded execution recipe. */
export function validateAuditSpec(value) {
  allowed(value, ['schemaVersion', 'repository', 'revision', 'task', 'taskContract', 'profiles', 'limits', 'setup', 'checks', 'sandbox', 'allowIncompleteCapture', 'captureRequirements', 'quality', 'trials', 'variables'], 'experiment specification');
  if (value.schemaVersion !== 1 || !plain(value.repository) || !value.repository.startsWith('/')
    || resolve(value.repository) !== value.repository || !plain(value.revision, 200))
    throw new Error('Specify schemaVersion 1, an absolute repository and explicit Git revision');
  if (typeof value.task !== 'string' || !value.task.trim() || Buffer.byteLength(value.task) > 65536 || value.task.includes('\0'))
    throw new Error('Experiment task must be nonempty text of at most 64 KiB');
  if (!Array.isArray(value.profiles) || value.profiles.length < 2 || value.profiles.length > 8)
    throw new Error('Select between two and eight distinct profiles');
  const names = new Set();
  const profiles = value.profiles.map(selection => {
    const profile = typeof selection === 'string' ? { name: selection } : selection;
    allowed(profile, ['name', 'executable', 'version', 'skills', 'nativeConfig'], 'profile selection');
    if (!plain(profile.name, 200) || names.has(profile.name.toLowerCase())) throw new Error('Select distinct plain profile names');
    names.add(profile.name.toLowerCase());
    if ((profile.executable !== undefined && (!plain(profile.executable) || !profile.executable.startsWith('/')
        || resolve(profile.executable) !== profile.executable))
      || (profile.version !== undefined && !plain(profile.version, 100)))
      throw new Error('An explicit profile executable requires an absolute path; optional version text is descriptive only');
    const skills = profile.skills ?? [];
    if (!Array.isArray(skills) || skills.length > 50 || skills.some(skill => !plain(skill, 160)) || new Set(skills).size !== skills.length)
      throw new Error('Selected skills must be distinct plain names');
    const nativeConfig = validateAuditNativeConfig(profile.nativeConfig);
    return { name: profile.name, ...(profile.executable ? { executable: profile.executable } : {}),
      ...(profile.version !== undefined ? { version: profile.version } : {}), skills: [...skills],
      ...(nativeConfig !== undefined ? { nativeConfig } : {}) };
  });
  allowed(value.limits ?? {}, ['runMs', 'experimentMs', 'outputBytes', 'maxRuns'], 'experiment limits');
  const runMs = integer(value.limits?.runMs, 900000, 1, 86400000, 'runMs');
  const limits = { runMs,
    experimentMs: integer(value.limits?.experimentMs, Math.min(86400000, runMs * profiles.length + 120000), 1, 86400000, 'experimentMs'),
    outputBytes: integer(value.limits?.outputBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024, 'outputBytes'),
    maxRuns: integer(value.limits?.maxRuns, profiles.length, profiles.length, 8, 'maxRuns') };
  const sandbox = value.sandbox ?? 'workspace-write';
  if (!['read-only', 'workspace-write'].includes(sandbox)) throw new Error('Audit sandbox must be read-only or workspace-write');
  if (value.allowIncompleteCapture !== undefined && typeof value.allowIncompleteCapture !== 'boolean') throw new Error('allowIncompleteCapture must be a boolean');
  const setup = commands(value.setup, 'setup'), checks = commands(value.checks, 'check');
  const contract = taskContract(value.taskContract);
  const captureRequirements = validateCaptureRequirements(value.captureRequirements);
  const quality = validateAuditQuality(value.quality, checks);
  let trials;
  if (value.trials !== undefined || quality !== undefined) {
    allowed(value.trials ?? {}, ['count', 'order', 'budgetMs'], 'trial schedule');
    if (!quality) throw new Error('Repeated trials require an explicit versioned quality definition');
    const count = integer(value.trials?.count, 1, 1, 20, 'trial count');
    const order = value.trials?.order ?? 'balanced';
    if (!['balanced', 'listed'].includes(order)) throw new Error('Trial order must be balanced or listed');
    trials = { count, order, budgetMs: integer(value.trials?.budgetMs,
      Math.min(86400000, count * limits.experimentMs), count, 86400000, 'series budgetMs') };
  }
  if (value.variables !== undefined && (!trials || !Array.isArray(value.variables) || value.variables.length > 20
    || value.variables.some(item => !plain(item, 160)) || new Set(value.variables).size !== value.variables.length))
    throw new Error('Intended setup variables require a trial schedule and distinct plain labels');
  return { schemaVersion: 1, repository: value.repository, revision: value.revision, task: value.task, profiles, limits,
    setup, checks, sandbox, allowIncompleteCapture: value.allowIncompleteCapture ?? false,
    ...(contract ? { taskContract: contract } : {}),
    ...(captureRequirements ? { captureRequirements } : {}),
    ...(quality ? { quality } : {}), ...(trials ? { trials, variables: value.variables ?? [] } : {}) };
}

export async function readAuditInput(path) {
  const selected = resolve(path), before = await lstat(selected);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024 || await realpath(selected) !== selected)
    throw new Error('Experiment spec must be a bounded regular JSON file');
  const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error('Experiment specification changed');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Experiment specification changed');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Experiment specification must contain valid UTF-8 JSON'); }
    return value;
  } finally { await handle.close(); }
}

export async function readAuditSpec(path) { return validateAuditSpec(await readAuditInput(path)); }
