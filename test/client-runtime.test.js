import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientRuntime } from '../src/client-runtime.js';
import { createEnvironmentBinding, createNativeReference, nativeReferenceKey } from '../src/client-contracts.js';

function profile() {
  const value = { client: 'codex', surface: 'cli', executionLocation: 'local', rootMode: 'explicit', profileId: 'profile-a',
    home: '/fixture/config', userHome: '/fixture/user', nativeRoot: '/fixture/runtime', reservationRoot: '/fixture/reservation',
    cwd: '/fixture/workspace', executable: '/fixture/codex', executableIdentity: 'fixture-executable', version: 'fixture', settingsIdentity: null };
  value.environmentBinding = createEnvironmentBinding({ ...value, rootMode: 'explicit', workspace: value.cwd,
    roots: { config: value.home, runtime: value.home, user: value.userHome, reservation: value.reservationRoot },
    executable: { path: value.executable, identity: value.executableIdentity, version: value.version } });
  return value;
}
const nativeRun = () => ({ schemaVersion: 1, kind: 'audit-run', id: 'job-a', source: { threadId: 'shared-native-id' }, events: [], turns: [] });

test('runtime qualifies checkpoint and final evidence without manufacturing missing native IDs', async () => {
  const checkpoints = [], input = profile();
  const evidence = { settingsEvidence: { requested: {}, sent: {}, confirmed: null, observed: null } };
  const runtime = createClientRuntime({ capture: async options => {
    const run = { ...nativeRun(), source: {} };
    await options.onSession(run, evidence);
    return { run, capture: evidence };
  } });
  const result = await runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: input, workspace: input.cwd,
    onSession: async run => checkpoints.push(structuredClone(run)) });
  for (const run of [checkpoints[0], result.run]) {
    assert.deepEqual(run.nativeReference, { client: 'codex', jobId: 'job-a', profileId: 'profile-a',
      sessionId: null, turnId: null, itemId: null, requestId: null });
    assert.deepEqual(run.environmentBinding, input.environmentBinding);
    assert.deepEqual(run.settingsEvidence, evidence.settingsEvidence);
  }
  evidence.settingsEvidence.requested.changed = true;
  assert.equal(result.run.settingsEvidence.requested.changed, undefined);
});

test('same opaque native IDs remain distinct across jobs and profiles', async () => {
  const runtime = createClientRuntime({ capture: async options => ({ run: { ...nativeRun(), id: options.jobId }, capture: {} }) });
  const references = [];
  for (const [jobId, profileId] of [['job-a', 'profile-a'], ['job-b', 'profile-a'], ['job-a', 'profile-b']]) {
    const input = profile(); input.profileId = profileId; input.environmentBinding.profileId = profileId;
    const { run } = await runtime.capture({ executionMode: 'profile', jobId, profile: input, workspace: input.cwd });
    references.push(run.nativeReference);
  }
  references.push({ ...references[0], client: 'claude-code' });
  assert.equal(new Set(references.map(nativeReferenceKey)).size, 4);
  assert.ok(references.every(reference => reference.sessionId === 'shared-native-id'));
});

test('runtime refuses unsupported or mismatched bindings before transport', async t => {
  const mutations = {
    'client contradiction': value => { value.environmentBinding.client = 'claude-code'; },
    'surface contradiction': value => { value.environmentBinding.surface = 'desktop'; },
    'location contradiction': value => { value.environmentBinding.executionLocation = 'ssh'; },
    'profile identity': value => { value.environmentBinding.profileId = 'foreign-profile'; },
    'config root': value => { value.environmentBinding.roots.config = '/foreign/config'; },
    'executable identity': value => { value.environmentBinding.executable.identity = 'foreign-build'; },
    'workspace': value => { value.environmentBinding.workspace = '/foreign/workspace'; },
    'reservation root': value => { value.environmentBinding.roots.reservation = '/foreign/reservation'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    let calls = 0; const input = profile(); mutate(input);
    const runtime = createClientRuntime({ capture: async () => { calls++; return { run: nativeRun(), capture: {} }; } });
    await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: input, workspace: input.cwd }), /runtime|binding|profile|Codex/i);
    assert.equal(calls, 0);
  });
});

test('runtime rejects a returned native reference from a different job, client or profile', async t => {
  for (const [field, value] of [['jobId', 'foreign-job'], ['profileId', 'foreign-profile'], ['client', 'claude-code']]) await t.test(field, async () => {
    const run = nativeRun();
    run.nativeReference = createNativeReference({ client: 'codex', jobId: 'job-a', profileId: 'profile-a', sessionId: 'shared-native-id', [field]: value });
    const runtime = createClientRuntime({ capture: async () => ({ run, capture: {} }) });
    await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace' }), /reference|match|scope/i);
  });
});

test('runtime preserves exact native turn, item and request identities already returned by its implementation', async () => {
  const run = nativeRun();
  run.nativeReference = createNativeReference({ client: 'codex', jobId: 'job-a', profileId: 'profile-a',
    sessionId: 'shared-native-id', turnId: 'native-turn', itemId: 'native-item', requestId: 'native-request' });
  const expected = structuredClone(run.nativeReference);
  const runtime = createClientRuntime({ capture: async () => ({ run, capture: {} }) });
  const result = await runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace' });
  assert.deepEqual(result.run.nativeReference, expected);
});

test('runtime refuses a local run ID from a different job', async () => {
  const runtime = createClientRuntime({ capture: async () => ({ run: { ...nativeRun(), id: 'foreign-job' }, capture: {} }) });
  await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace' }), /job|identity|match/i);
});

test('runtime refuses native evidence scoped to a different job', async () => {
  const foreign = createNativeReference({ client: 'codex', jobId: 'foreign-job', profileId: 'profile-a', sessionId: 'shared-native-id', turnId: 'foreign-turn' });
  const runtime = createClientRuntime({ capture: async () => ({ run: nativeRun(), capture: { nativeReference: foreign } }) });
  await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace' }), /reference|scope|match/i);
});

test('runtime refuses conflicting coordinator job IDs before transport', async () => {
  let calls = 0;
  const runtime = createClientRuntime({ capture: async () => { calls++; return { run: nativeRun(), capture: {} }; } });
  await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', limits: { id: 'job-b' }, profile: profile(), workspace: '/fixture/workspace' }), /job identity/i);
  assert.equal(calls, 0);
});


test('runtime rejects contradictory captured client identity before checkpoint publication and preserves its source', async t => {
  for (const [field, value] of [['client', 'claude-code'], ['surface', 'desktop'], ['executionLocation', 'cloud']])
    await t.test(field, async () => {
      const identity = { client: 'codex', surface: 'cli', executionLocation: 'local', [field]: value };
      const run = { ...nativeRun(), clientIdentity: identity };
      let published = 0;
      const runtime = createClientRuntime({ capture: async options => {
        await options.onSession(run, {});
        return { run, capture: {} };
      } });
      await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace',
        onSession: async () => { published++; } }), /client identity does not match/);
      assert.equal(published, 0);
      assert.deepEqual(run.clientIdentity, identity);
    });
});

test('runtime also rejects contradictory final-only identity and malformed supplied identities', async () => {
  for (const clientIdentity of [{ client: 'copilot' }, null, 'codex', [], new Date(0), Object.create({ client: 'copilot' }), { surface: false }]) {
    const run = { ...nativeRun(), clientIdentity };
    const runtime = createClientRuntime({ capture: async () => ({ run, capture: {} }) });
    await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace' }),
      /client identity does not match/);
    assert.deepEqual(run.clientIdentity, clientIdentity);
  }
});

test('runtime retains partial captured identity and source metadata without inventing missing observations', async () => {
  for (const clientIdentity of [{}, { client: 'codex', backendVersion: 'retained-source-build' }]) {
    const run = { ...nativeRun(), clientIdentity };
    const runtime = createClientRuntime({ capture: async options => {
      await options.onSession(run, {});
      return { run, capture: {} };
    } });
    const result = await runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace',
      onSession: async checkpoint => assert.deepEqual(checkpoint.clientIdentity, clientIdentity) });
    assert.deepEqual(result.run.clientIdentity, clientIdentity);
    assert.equal(Object.hasOwn(result.run.clientIdentity, 'surface'), false);
    assert.equal(Object.hasOwn(result.run.clientIdentity, 'executionLocation'), false);
  }
});


test('runtime preserves explicit unknown client identity fields', async () => {
  const clientIdentity = { client: null, surface: null, executionLocation: null, backendVersion: null };
  const run = { ...nativeRun(), clientIdentity };
  const runtime = createClientRuntime({ capture: async options => {
    await options.onSession(run, {});
    return { run, capture: {} };
  } });
  const result = await runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: profile(), workspace: '/fixture/workspace',
    onSession: async checkpoint => assert.deepEqual(checkpoint.clientIdentity, clientIdentity) });
  assert.deepEqual(result.run.clientIdentity, clientIdentity);
});

test('runtime refuses contradictory captured environment bindings before checkpoints and at finalization', async t => {
  const mutations = {
    client: binding => { binding.client = 'claude-code'; },
    surface: binding => { binding.surface = 'desktop'; },
    location: binding => { binding.executionLocation = 'cloud'; },
    profile: binding => { binding.profileId = 'foreign-profile'; },
    rootMode: binding => { binding.rootMode = 'implicit'; },
    configRoot: binding => { binding.roots.config = '/foreign/config'; },
    runtimeRoot: binding => { binding.roots.runtime = '/foreign/runtime'; },
    executable: binding => { binding.executable.identity = 'foreign-executable'; },
    settings: binding => { binding.settingsIdentity = { algorithm: 'sha256-file-stat-metadata-v1', digest: 'b'.repeat(64) }; },
    workspace: binding => { binding.workspace = '/foreign/workspace'; },
  };
  for (const stage of ['checkpoint', 'final']) for (const [name, mutate] of Object.entries(mutations)) await t.test(`${stage}: ${name}`, async () => {
    const input = profile(), capturedBinding = structuredClone(input.environmentBinding);
    mutate(capturedBinding);
    const run = { ...nativeRun(), environmentBinding: capturedBinding };
    let published = 0;
    const runtime = createClientRuntime({ capture: async options => {
      if (stage === 'checkpoint') await options.onSession(run, {});
      return { run, capture: {} };
    } });
    await assert.rejects(runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: input, workspace: input.cwd,
      onSession: async () => { published++; } }), /[Ee]nvironment binding/);
    assert.equal(published, 0);
    assert.equal(run.environmentBinding, capturedBinding);
  });
});

test('runtime retains a matching captured binding and its extra unknown observations', async () => {
  const input = profile(), capturedBinding = { ...structuredClone(input.environmentBinding), sdkIdentity: null, observedAccount: null };
  capturedBinding.executable.observedBuild = null;
  const run = { ...nativeRun(), environmentBinding: capturedBinding };
  const runtime = createClientRuntime({ capture: async options => {
    await options.onSession(run, {});
    return { run, capture: {} };
  } });
  const result = await runtime.capture({ executionMode: 'profile', jobId: 'job-a', profile: input, workspace: input.cwd,
    onSession: async checkpoint => assert.equal(checkpoint.environmentBinding, capturedBinding) });
  assert.equal(result.run.environmentBinding, capturedBinding);
  assert.equal(result.run.environmentBinding.sdkIdentity, null);
  assert.equal(result.run.environmentBinding.executable.observedBuild, null);
});

test('runtime verifies captured binding against its existing audit dispatch fallback', async () => {
  const input = profile(); delete input.environmentBinding;
  const expected = createEnvironmentBinding({ client: input.client, surface: input.surface, executionLocation: input.executionLocation,
    profileId: input.profileId, rootMode: input.rootMode, workspace: input.cwd,
    roots: { config: input.home, runtime: '/fixture/private-runtime', user: input.userHome, reservation: input.reservationRoot },
    executable: { path: input.executable, identity: input.executableIdentity, version: input.version }, settingsIdentity: null });
  for (const matching of [true, false]) {
    const captured = structuredClone(expected);
    if (!matching) captured.roots.config = '/foreign/config';
    const run = { ...nativeRun(), environmentBinding: captured };
    const runtime = createClientRuntime({ capture: async () => ({ run, capture: { runtimeRoots: { sqlite: '/fixture/private-runtime' } } }) });
    const work = runtime.capture({ executionMode: 'audit', jobId: 'job-a', profile: input, workspace: input.cwd });
    if (matching) assert.equal((await work).run.environmentBinding, captured);
    else await assert.rejects(work, /[Ee]nvironment binding/);
  }
});

test('runtime cannot accept supplied environment attribution without a verifiable dispatch binding', async () => {
  const capturedBinding = profile().environmentBinding;
  const run = { ...nativeRun(), environmentBinding: capturedBinding };
  const runtime = createClientRuntime({ capture: async options => {
    await options.onSession(run, {});
    return { run, capture: {} };
  } });
  let published = false;
  await assert.rejects(runtime.capture({ executionMode: 'audit', jobId: 'job-a', profile: { profileId: 'profile-a' },
    workspace: '/fixture/workspace', onSession: async () => { published = true; } }), /cannot be verified/);
  assert.equal(published, false);
  assert.equal(run.environmentBinding, capturedBinding);
});
