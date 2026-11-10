import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentBinding, assertEnvironmentBinding, createNativeReference,
  assertNativeReference, nativeReferenceKey, capabilityState, createSettingsEvidence } from '../src/client-contracts.js';

function environment(overrides = {}) {
  return { client: 'codex', surface: 'cli', executionLocation: 'local', profileId: 'profile-one', rootMode: 'explicit',
    roots: { config: '/home/user/.codex', runtime: '/home/user/.codex', user: '/home/user', reservation: '/home/user/.codex' },
    workspace: '/repo', executable: { path: '/bin/codex', identity: '[1,2,3]', version: null },
    settingsIdentity: { algorithm: 'sha256-file-stat-metadata-v1', digest: 'a'.repeat(64) }, ...overrides };
}

test('environment identity distinguishes same-path root routing and preserves unknown build identity', () => {
  const explicit = createEnvironmentBinding(environment());
  const implicit = createEnvironmentBinding(environment({ rootMode: 'implicit' }));
  assert.equal(implicit.executable.version, null);
  assert.equal(createEnvironmentBinding(environment({ roots: { ...implicit.roots, runtime: null } })).roots.runtime, null);
  assert.deepEqual(implicit.roots, explicit.roots);
  assert.throws(() => assertEnvironmentBinding(explicit, implicit), /does not match/);
  assert.deepEqual(assertEnvironmentBinding(explicit, structuredClone(explicit)), explicit);
  for (const changes of [{ client: 'copilot' }, { surface: 'desktop' }, { executionLocation: 'cloud' }, { profileId: 'other' },
    { workspace: '/other' }, { executable: { path: '/bin/codex', identity: 'replaced', version: null } },
    { settingsIdentity: { algorithm: 'sha256-file-stat-metadata-v1', digest: 'b'.repeat(64) } }]) {
    assert.throws(() => assertEnvironmentBinding(explicit, environment(changes)), /does not match/);
  }
  for (const changes of [{ client: 'unknown' }, { rootMode: 'default' }, { workspace: '/repo/../other' },
    { executable: { path: 'codex', identity: 'abc', version: null } }, { settingsIdentity: {} }]) {
    assert.throws(() => createEnvironmentBinding(environment(changes)));
  }
});

test('native references retain opaque IDs and absence, reject foreign scopes and avoid collisions', () => {
  const input = { client: 'codex', jobId: 'job:1', profileId: 'profile-one', sessionId: 'native/non-uuid:session' };
  const reference = createNativeReference(input);
  assert.equal(reference.sessionId, input.sessionId);
  assert.equal(reference.turnId, null);
  assert.equal(reference.itemId, null);
  assert.equal(reference.requestId, null);
  assert.deepEqual(assertNativeReference(reference, input), reference);
  const keys = new Set([nativeReferenceKey(reference)]);
  for (const changes of [{ client: 'copilot' }, { jobId: 'job:2' }, { profileId: 'profile-two' }, { sessionId: 'other' },
    { turnId: 'native-turn' }]) {
    const other = createNativeReference({ ...input, ...changes });
    keys.add(nativeReferenceKey(other));
    assert.throws(() => assertNativeReference(reference, { ...input, ...changes }), /does not match/);
  }
  assert.equal(keys.size, 6);
  for (const sessionId of ['', ' ', 'a'.repeat(1025), 'a\nb', 'a\u200bb', 4, {}])
    assert.throws(() => createNativeReference({ ...input, sessionId }));
  // Delimiter-like IDs cannot collide when tuples are serialized.
  assert.notEqual(nativeReferenceKey({ ...input, sessionId: 'a:b', turnId: 'c' }),
    nativeReferenceKey({ ...input, sessionId: 'a', turnId: 'b:c' }));
});

test('capability absence stays unknown and settings evidence never fills another stage', () => {
  assert.equal(capabilityState(), 'unknown');
  assert.equal(capabilityState(null), 'unknown');
  for (const state of ['supported', 'unsupported', 'unknown']) assert.equal(capabilityState(state), state);
  for (const state of [false, true, '', 'ready']) assert.throws(() => capabilityState(state));
  assert.deepEqual(createSettingsEvidence(), { requested: null, sent: null, confirmed: null, observed: null });
  const requested = { model: 'native-model', effort: 'high', source: 'task' };
  const evidence = createSettingsEvidence({ requested, sent: { effort: 'high', source: 'native-request' } });
  requested.effort = 'low';
  assert.equal(evidence.requested.effort, 'high');
  assert.equal(evidence.confirmed, null);
  assert.equal(evidence.observed, null);
  for (const value of [{ confirmed: true }, { observed: [] }, { effective: {} }])
    assert.throws(() => createSettingsEvidence(value));
});
