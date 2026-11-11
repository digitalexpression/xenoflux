// Shared identities describe native execution; they do not enable a client or transport.
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const CLIENTS = ['codex', 'claude-code', 'copilot'];
const NATIVE_IDS = ['sessionId', 'turnId', 'itemId', 'requestId'];
const STAGES = ['requested', 'sent', 'confirmed', 'observed'];

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`Invalid ${label}`);
  return value;
}

function text(value, label, max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function choice(value, values, label) {
  if (!values.includes(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function path(value, label, nullable = false) {
  if (nullable && value === null) return null;
  text(value, label, 16384);
  if (!isAbsolute(value) || resolve(value) !== value) throw new Error(`Invalid ${label}`);
  return value;
}

/** Stable, credential-free identity for a resolved profile environment. */
export function createEnvironmentBinding(input) {
  record(input, 'environment binding');
  const roots = record(input.roots, 'environment roots');
  const executable = record(input.executable, 'executable binding');
  const settings = input.settingsIdentity;
  if (settings !== null) {
    record(settings, 'settings identity');
    if (!['sha256-file-stat-metadata-v1', 'sha256-settings-metadata-v2'].includes(settings.algorithm) || !/^[a-f0-9]{64}$/.test(settings.digest))
      throw new Error('Invalid settings identity');
  }
  return {
    client: choice(input.client, CLIENTS, 'client'),
    surface: choice(input.surface, ['cli', 'desktop'], 'surface'),
    executionLocation: choice(input.executionLocation, ['local', 'ssh', 'cloud'], 'execution location'),
    profileId: text(input.profileId, 'profile ID'),
    rootMode: choice(input.rootMode, ['implicit', 'explicit'], 'root mode'),
    roots: { config: path(roots.config, 'configuration root'), runtime: path(roots.runtime, 'runtime root', true),
      user: path(roots.user, 'user root'), reservation: path(roots.reservation, 'reservation root') },
    workspace: path(input.workspace, 'workspace', true),
    executable: { path: path(executable.path, 'executable path'), identity: text(executable.identity, 'executable identity'),
      version: executable.version === null ? null : text(executable.version, 'executable version') },
    settingsIdentity: settings === null ? null : { algorithm: settings.algorithm, digest: settings.digest },
  };
}

export function assertEnvironmentBinding(actual, expected) {
  const left = createEnvironmentBinding(actual), right = createEnvironmentBinding(expected);
  if (!isDeepStrictEqual(left, right)) throw new Error('Environment binding does not match');
  return left;
}

/** Native IDs stay opaque and qualified; absence never becomes a local surrogate ID. */
export function createNativeReference(input) {
  record(input, 'native reference');
  const reference = { client: choice(input.client, CLIENTS, 'client'), jobId: text(input.jobId, 'job ID'),
    profileId: text(input.profileId, 'profile ID') };
  for (const field of NATIVE_IDS) reference[field] = input[field] == null ? null : text(input[field], field);
  return reference;
}

export function assertNativeReference(reference, scope) {
  const value = createNativeReference(reference);
  record(scope, 'native reference scope');
  for (const field of ['client', 'jobId', 'profileId']) {
    if (value[field] !== scope[field]) throw new Error(`Native reference ${field} does not match`);
  }
  for (const field of NATIVE_IDS) {
    if (Object.hasOwn(scope, field) && value[field] !== scope[field])
      throw new Error(`Native reference ${field} does not match`);
  }
  return value;
}

export function nativeReferenceKey(reference) {
  const value = createNativeReference(reference);
  return JSON.stringify([value.client, value.jobId, value.profileId, ...NATIVE_IDS.map(field => value[field])]);
}

export function capabilityState(value) {
  return value == null ? 'unknown' : choice(value, ['supported', 'unsupported', 'unknown'], 'capability state');
}

/** Every stage has its own source; an accepted option is not an observed setting. */
export function createSettingsEvidence(input = {}) {
  record(input, 'settings evidence');
  if (Object.keys(input).some(key => !STAGES.includes(key))) throw new Error('Invalid settings evidence stage');
  return Object.fromEntries(STAGES.map(stage => [stage,
    input[stage] == null ? null : structuredClone(record(input[stage], `${stage} settings evidence`))]));
}
