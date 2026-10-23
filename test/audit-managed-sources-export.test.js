import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditHookCapture } from '../src/audit-hooks.js';
import { mergeAuditSkillTelemetry } from '../src/audit-skill-usage.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { auditExitCode, compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const managedSources = ['mdm', 'cloudRequirements', 'cloudManagedConfig',
  'legacyManagedConfigFile', 'legacyManagedConfigMdm'];

function runFixture(id, hookSources = managedSources) {
  const capture = createAuditHookCapture();
  hookSources.forEach((source, index) => {
    capture.consume({ phase: 'completed', agentId: 'root', turnId: null, source: 'hook/completed', sourceLine: index + 1,
      run: { id: `${id}-hook-${index}`, eventName: 'sessionStart', handlerType: 'command', executionMode: 'sync',
        scope: 'thread', source, status: 'completed', startedAt: 100, completedAt: 101, durationMs: 1000,
        command: 'PRIVATE_MANAGED_COMMAND', entries: [{ text: 'PRIVATE_MANAGED_OUTPUT' }], policy: { token: 'PRIVATE_POLICY_SECRET' } } });
  });
  const hooks = capture.result();
  const run = { schemaVersion: 1, kind: 'audit-run', id, status: 'partial',
    source: { threadId: 'root', kind: 'native-app-server-v2' },
    execution: { status: 'exited', exitCode: 2 }, agents: [{ id: 'root', parentId: null }], turns: [],
    coverage: { agents: 'complete', ...hooks.coverage }, hookInvocations: hooks.hookInvocations, warnings: hooks.warnings,
    skills: [
      { id: 'system-skill', name: 'shared-system', origin: 'system', scope: 'system',
        catalogs: [{ agentId: 'root' }], observations: [] },
      { id: 'admin-skill', name: 'shared-admin', origin: 'admin', scope: 'admin',
        catalogs: [{ agentId: 'root' }], observations: [] },
    ], skillInvocations: [] };
  mergeAuditSkillTelemetry(run, { events: [
    { source: 'native-otel-skill-invocation', threadId: 'root', turnId: 'turn-a', skillName: 'shared-system',
      scope: 'system', invocationType: 'explicit', timestampNs: '1000' },
    { source: 'native-otel-skill-invocation', threadId: 'root', turnId: 'turn-b', skillName: 'shared-admin',
      scope: 'admin', invocationType: 'explicit', timestampNs: '2000' },
  ] });
  return run;
}

test('managed and native admin/system labels survive fixture merge, freeze, comparison, and reopen as provenance', async t => {
  const left = runFixture('managed-left');
  const right = runFixture('managed-right');
  assert.deepEqual(left.hookInvocations.map(row => row.sourceKind), managedSources);
  assert.deepEqual(left.skillInvocations.map(row => [row.scope, row.resolution]), [
    ['system', 'catalogued'], ['admin', 'catalogued'],
  ]);
  assert.deepEqual(left.skills.map(skill => [skill.origin, skill.scope]), [['system', 'system'], ['admin', 'admin']]);

  const frozen = compactAuditTrial({ runs: [left] }).runs[0];
  assert.deepEqual(frozen.hookInvocations.map(row => row.sourceKind), managedSources);
  assert.deepEqual(frozen.skills.map(skill => [skill.origin, skill.scope]), [['system', 'system'], ['admin', 'admin']]);
  assert.deepEqual(compactAuditTrial({ runs: [frozen] }).runs[0].hookInvocations, frozen.hookInvocations);
  const comparison = compareAuditRuns(left, right);
  assert.equal(comparison.comparison.hooks.status, 'recorded-observations-comparable');
  assert.ok(comparison.comparison.hooks.counts.some(row => managedSources.includes(row.identity.sourceKind)));
  assert.ok(comparison.comparison.skillInvocations.left.invocations.some(row => row.scope === 'admin'));

  const dir = await mkdtemp(join(tmpdir(), 'xfx-managed-source-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, candidate] of [['full', left], ['compact', { ...frozen, schemaVersion: 1, kind: 'audit-run' }]]) {
    for (const format of ['json', 'markdown']) {
      const receipt = await exportAuditReport(candidate, { output: join(dir, `${name}.${format}`), format });
      const reopened = await readAuditReport(receipt.evidencePath);
      assert.deepEqual(reopened.hookInvocations.map(row => row.sourceKind), managedSources);
      assert.deepEqual(reopened.skills.map(skill => [skill.origin, skill.scope]), [['system', 'system'], ['admin', 'admin']]);
      assert.deepEqual(reopened.skillInvocations.map(row => row.scope), ['system', 'admin']);
      assert.equal(auditExitCode(reopened), 2);
      assert.match(renderAudit(reopened, { format: 'markdown' }), /cloudRequirements/);
      assert.match(renderAudit(reopened, { format: 'markdown' }), /legacyManagedConfigMdm/);
      assert.match(renderAudit(reopened, { format: 'markdown' }), /admin/);
      assert.equal(JSON.stringify(reopened).includes('PRIVATE_'), false);
      assert.equal(compareAuditRuns(candidate, reopened).comparison.hooks.status, 'recorded-observations-comparable');
    }
  }
});

test('unsupported hook source is unknown or rejected with partial coverage, never upgraded to managed', () => {
  const acceptedUnknown = runFixture('unknown-source', ['unknown']);
  assert.equal(acceptedUnknown.hookInvocations[0].sourceKind, 'unknown');
  assert.equal(acceptedUnknown.coverage.hooks, 'observed');
  const capture = createAuditHookCapture();
  const accepted = capture.consume({ phase: 'completed', agentId: 'root', turnId: null, source: 'hook/completed', sourceLine: 1,
    run: { id: 'bad-source', eventName: 'sessionStart', handlerType: 'command', executionMode: 'sync', scope: 'thread',
      source: '/private/managed policy', status: 'completed', startedAt: 100, completedAt: 101 } });
  assert.equal(accepted, false);
  assert.deepEqual(capture.result().hookInvocations, []);
  assert.equal(capture.result().coverage.hooks, 'partial');
});
