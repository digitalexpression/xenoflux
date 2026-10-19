import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAuditSkillTelemetry } from '../src/audit-skill-usage.js';

const event = (threadId, skillName, scope, extra = {}) => ({ threadId, turnId: 'turn-1', skillName, scope,
  invocationType: 'explicit', timestampNs: '123456789', source: 'native-otel-skill-invocation', ...extra });
const skill = (id, name, scope, nativeScope, agentId = 'root', extra = {}) => ({ id, name, scope, nativeScope,
  origin: scope === 'project' ? 'repository' : scope === 'plugin' ? 'plugin' : scope,
  ...(extra.provider ? { provider: extra.provider } : {}),
  catalogs: [{ agentId, cwd: '/workspace' }], observations: [] });
const runWith = skills => ({ status: 'ready', agents: [{ id: 'root' }, { id: 'child' }], skills, coverage: { skills: 'complete' } });
const snapshot = events => ({ events, metadata: { delivery: 'best-effort' } });

test('attributes by actor, exact audited scope, and plugin identity without joining distinct origins', () => {
  const skills = [
    skill('profile', 'profile-only', 'profile', 'user'),
    skill('profile-shared', 'shared', 'profile', 'user'),
    skill('user', 'shared', 'user', 'user'),
    skill('project', 'shared', 'project', 'repo'),
    skill('system', 'shared', 'system', 'system'),
    skill('admin', 'shared', 'admin', 'admin'),
    skill('plugin', 'product-design:image-to-code', 'plugin', 'user', 'root', { provider: 'product-design' }),
  ];
  const run = mergeAuditSkillTelemetry(runWith(skills), snapshot([
    event('root', 'profile-only', 'user'), event('root', 'shared', 'user'), event('root', 'shared', 'project'),
    event('root', 'shared', 'system'), event('root', 'shared', 'admin'),
    event('root', 'product-design:image-to-code', 'user', { pluginId: 'product-design' }),
  ]));
  assert.deepEqual(run.skillInvocations.map(row => row.resolution), ['catalogued', 'ambiguous', 'catalogued', 'catalogued', 'catalogued', 'catalogued']);
  assert.deepEqual(run.skillInvocations.map(row => row.skillId ?? null), ['profile', null, 'project', 'system', 'admin', 'plugin']);
  assert.equal(skills.filter(row => !['profile-shared', 'user'].includes(row.id)).every(row => row.observations.length === 1 && row.observations[0].kind === 'native-invocation-observed'), true);
  assert.equal(skills.find(row => row.id === 'user').observations.length, 0);
  assert.equal(skills.find(row => row.id === 'profile-shared').observations.length, 0);
  assert.equal(run.coverage.skills, 'complete');
  assert.equal(run.coverage.skillInvocationTelemetry, 'observed');
  assert.equal(run.skillTelemetry.capability, 'events-observed');
  assert.equal(run.skillTelemetry.diagnostics.missingness.byAgent.root.profile.status, 'observed');
});

test('attributes every supported origin independently in parent and child catalogs without copy eligibility', () => {
  const origins = ['profile', 'user', 'repository', 'system', 'admin', 'plugin'];
  const skills = [], events = [];
  for (const actor of ['root', 'child']) for (const origin of origins) {
    const scope = origin === 'repository' ? 'project' : origin;
    const nativeScope = ['profile', 'user', 'plugin'].includes(origin) ? 'user' : origin === 'repository' ? 'repo' : origin;
    const name = `${actor}-${origin}`;
    skills.push(skill(name, name, scope, nativeScope, actor, origin === 'plugin' ? { provider: 'vendor/package' } : {}));
    events.push(event(actor, name, nativeScope, { turnId: `${actor}-turn`, invocationType: actor === 'root' ? 'explicit' : 'implicit',
      ...(origin === 'plugin' ? { pluginId: 'vendor/package' } : {}) }));
  }
  const run = mergeAuditSkillTelemetry(runWith(skills), snapshot(events));
  assert.equal(run.skillInvocations.length, 12);
  assert.ok(run.skillInvocations.every(row => row.resolution === 'catalogued'));
  for (const actor of ['root', 'child']) for (const origin of origins) {
    const selected = run.skills.find(row => row.id === `${actor}-${origin}`);
    assert.equal(selected.observations.length, 1);
    assert.equal(selected.observations[0].agentId, actor);
    assert.equal(selected.observations[0].turnId, `${actor}-turn`);
    assert.equal(run.skillTelemetry.diagnostics.missingness.byAgent[actor][origin].invocationCount, 1);
  }
});

test('retains same-name same-scope matches as ambiguous and never guesses a catalog path', () => {
  const run = mergeAuditSkillTelemetry(runWith([
    skill('one', 'review', 'project', 'repo'), skill('two', 'review', 'project', 'repo', 'root', { provider: 'irrelevant' }),
  ]), snapshot([event('root', 'review', 'project')]));
  assert.equal(run.skillInvocations[0].resolution, 'ambiguous');
  assert.deepEqual(run.skillInvocations[0].candidateSkillIds, ['one', 'two']);
  assert.equal('path' in run.skillInvocations[0], false);
  assert.equal(run.skills.every(row => row.observations.length === 0), true);
});

test('requires the actor catalog and leaves foreign child activity unattributed', () => {
  const run = mergeAuditSkillTelemetry(runWith([skill('root-only', 'child-tool', 'project', 'repo')]), snapshot([
    event('child', 'child-tool', 'project'), event('outside-child', 'child-tool', 'project'),
  ]));
  assert.equal(run.skillInvocations[0].resolution, 'not-in-catalog');
  assert.equal(run.skillInvocations[1].resolution, 'unattributed');
  assert.equal(run.skillInvocations[1].unattributedActorId, 'outside-child');
  assert.equal(run.agents.length, 2);
  assert.equal(run.skills[0].observations.length, 0);
});

test('native-only events remain standalone when no catalog entry exists and unknown turns stay null', () => {
  const run = mergeAuditSkillTelemetry(runWith([]), snapshot([
    { ...event('root', 'uncatalogued', null), turnId: null, path: '/private/SKILL.md', body: 'sensitive', arguments: 'secret' },
  ]));
  assert.equal(run.skillInvocations[0].resolution, 'not-in-catalog');
  assert.equal(run.skillInvocations[0].turnId, null);
  assert.equal(JSON.stringify(run.skillInvocations).includes('/private'), false);
  assert.equal(JSON.stringify(run.skillInvocations).includes('sensitive'), false);
  assert.equal(JSON.stringify(run.skillInvocations).includes('secret'), false);
  assert.equal(run.skillTelemetry.delivery, 'best-effort');
  assert.match(run.skillTelemetry.boundary, /not exhaustive/);
});

test('accepts colon-qualified plugin skill identifiers and plugin IDs but rejects paths and credential-like names', () => {
  const run = mergeAuditSkillTelemetry(runWith([
    skill('qualified', 'product-design:image-to-code', 'plugin', 'user', 'root', { provider: 'sites@openai-curated-remote' }),
  ]), snapshot([
    event('root', 'product-design:image-to-code', 'user', { pluginId: 'sites@openai-curated-remote' }),
    event('root', 'product-design/image-to-code', 'user', { pluginId: 'product-design' }),
    event('root', 'sk-12345678901234567890', 'user', { pluginId: 'product-design' }),
  ]));
  assert.equal(run.skillInvocations.length, 1);
  assert.equal(run.skillInvocations[0].resolution, 'catalogued');
  assert.equal(run.skillInvocations[0].skillName, 'product-design:image-to-code');
  assert.equal(run.skillInvocations[0].pluginId, 'sites@openai-curated-remote');
});

test('accepts bounded relative marketplace plugin IDs while rejecting filesystem paths', () => {
  const run = mergeAuditSkillTelemetry(runWith([
    skill('market', 'shared-plugin-skill', 'plugin', 'user', 'root', { provider: 'market/cache/shared' }),
  ]), snapshot([
    event('root', 'shared-plugin-skill', 'user', { pluginId: 'market/cache/shared' }),
    event('root', 'shared-plugin-skill', 'user', { pluginId: '/private/path' }),
    event('root', 'shared-plugin-skill', 'user', { pluginId: 'market/../plugin' }),
    event('root', 'shared-plugin-skill', 'user', { pluginId: 'market//plugin' }),
    event('root', 'shared-plugin-skill', 'user', { pluginId: 'http://market/plugin' }),
    event('root', 'shared-plugin-skill', 'user', { pluginId: 'market\\plugin' }),
  ]));
  assert.equal(run.skillInvocations.length, 2);
  assert.equal(run.skillInvocations[0].resolution, 'catalogued');
  assert.equal(run.skillInvocations[0].pluginId, 'market/cache/shared');
  assert.equal(run.skillInvocations[1].resolution, 'not-in-catalog');
  assert.equal(run.skillInvocations[1].reason, 'invalid-plugin-id');
  assert.equal(run.skillInvocations[1].pluginId, null);
  assert.equal(JSON.stringify(run.skillInvocations).includes('/private'), false);
});

test('does not attribute missing plugin IDs to plugin skills, while allowing unique non-plugin matches', () => {
  const run = mergeAuditSkillTelemetry(runWith([
    skill('plain', 'shared-name', 'user', 'user'),
    skill('plugin', 'shared-name', 'plugin', 'user', 'root', { provider: 'sites@openai-curated-remote' }),
    skill('plugin-only', 'plugin-only', 'plugin', 'user', 'root', { provider: 'sites@openai-curated-remote' }),
    skill('ordinary-only', 'ordinary-only', 'user', 'user'),
  ]), snapshot([
    event('root', 'shared-name', 'user'),
    event('root', 'plugin-only', 'user'),
    event('root', 'ordinary-only', 'user'),
  ]));
  assert.deepEqual(run.skillInvocations.map(row => row.resolution), ['ambiguous', 'ambiguous', 'catalogued']);
  assert.deepEqual(run.skillInvocations[0].candidateSkillIds, ['plain', 'plugin']);
  assert.equal(run.skillInvocations[0].reason, 'plugin-id-unavailable');
  assert.equal(run.skillInvocations[1].candidateSkillIds[0], 'plugin-only');
  assert.equal(run.skillInvocations[2].skillId, 'ordinary-only');
});

test('deduplicates replayed flushes and caps retained rows with partial telemetry coverage', () => {
  const one = event('root', 'missing', 'system');
  const replay = mergeAuditSkillTelemetry(runWith([]), snapshot([one, { ...one }]));
  assert.equal(replay.skillInvocations.length, 1);

  const many = Array.from({ length: 20_001 }, (_, index) => event('root', `missing-${index}`, 'system', { timestampNs: String(index) }));
  const capped = mergeAuditSkillTelemetry(runWith([]), snapshot(many));
  assert.equal(capped.skillInvocations.length, 20_000);
  assert.equal(capped.skillTelemetry.status, 'partial');
  assert.equal(capped.coverage.skillInvocationTelemetry, 'partial');
  assert.ok(capped.skillTelemetry.warnings.includes('skill-telemetry-limit'));
  assert.equal(capped.coverage.skills, 'complete');
});

test('counts distinct observer receipts without timestamps and replays them idempotently across actors', () => {
  const skills = ['root', 'child'].map(actor => skill(actor, 'repeat', 'user', 'user', actor));
  const events = ['root', 'root', 'child', 'child'].map((actor, index) => ({ ...event(actor, 'repeat', 'user'),
    timestampNs: null, observationId: `${'a'.repeat(32)}:${index + 1}` }));
  const run = runWith(skills); run.coverage.skills = 'partial';
  mergeAuditSkillTelemetry(run, snapshot(events.slice(0, 2)));
  mergeAuditSkillTelemetry(run, snapshot(events));
  mergeAuditSkillTelemetry(run, snapshot(events));
  assert.equal(run.skillInvocations.length, 4);
  for (const actor of ['root', 'child']) {
    assert.equal(run.skills.find(s => s.id === actor).observations.length, 2);
    assert.equal(run.skillTelemetry.diagnostics.missingness.byAgent[actor].user.invocationCount, 2);
  }
  assert.equal(run.coverage.skills, 'partial');
  assert.ok(run.skillInvocations.every(e => e.observationId && e.timestampNs === null));
});

test('preserves enabled-empty, bounded transport and journal diagnostics without claiming no use', () => {
  const skills = [skill('root-sys', 'one', 'system', 'system'), skill('child-repo', 'two', 'project', 'repo', 'child')];
  const run = mergeAuditSkillTelemetry(runWith(skills), { events: [], metadata: {
    transport: 'otlp-http-json', capability: 'unknown', delivery: 'best-effort', receivedBytes: 512,
    rejectedRequests: 2, warnings: ['telemetry-unauthorized-request'],
    journal: { status: 'partial', bytes: 100, eventCount: 0, filePath: '/private/x' },
  } });
  assert.equal(run.skillTelemetry.status, 'partial');
  assert.equal(run.skillTelemetry.capability, 'enabled-empty');
  assert.equal(run.skillTelemetry.diagnostics.transport.receivedBytes, 512);
  assert.equal(run.skillTelemetry.diagnostics.transport.rejectedRequests, 2);
  assert.equal(run.skillTelemetry.diagnostics.journal.status, 'partial');
  assert.equal(run.skillTelemetry.diagnostics.journal.eventCount, 0);
  assert.equal(run.skillTelemetry.diagnostics.missingness.byAgent.root.system.catalogCount, 1);
  assert.equal(run.skillTelemetry.diagnostics.missingness.byAgent.root.system.status, 'unknown');
  assert.equal(run.skillTelemetry.diagnostics.missingness.byAgent.root.system.reason, 'no-event-observed');
  assert.equal(JSON.stringify(run.skillTelemetry).includes('/private/x'), false);
});

test('keeps unsupported and unknown capability distinct from an enabled empty receiver', () => {
  const unsupported = mergeAuditSkillTelemetry(runWith([]), { events: [], metadata: { capability: 'unsupported' } });
  const unknown = mergeAuditSkillTelemetry(runWith([]), { events: [], metadata: {} });
  assert.equal(unsupported.skillTelemetry.capability, 'unsupported');
  assert.equal(unsupported.skillTelemetry.status, 'unsupported');
  assert.equal(unknown.skillTelemetry.capability, 'unknown');
  assert.equal(unknown.skillTelemetry.status, 'unknown');
});

test('reports root and child origin coverage without treating absent events as proof of no use', () => {
  const skills = [
    skill('root-user', 'root-only', 'user', 'user', 'root'),
    skill('child-plugin', 'child-only', 'plugin', 'user', 'child', { provider: 'vendor/plugin' }),
  ];
  const run = mergeAuditSkillTelemetry(runWith(skills), snapshot([event('root', 'root-only', 'user')]));
  const coverage = run.skillTelemetry.diagnostics.missingness.byAgent;
  assert.deepEqual(coverage.root.user, { catalogCount: 1, invocationCount: 1, status: 'observed', reason: null });
  assert.deepEqual(coverage.child.plugin, { catalogCount: 1, invocationCount: 0, status: 'unknown', reason: 'no-event-observed' });
});
