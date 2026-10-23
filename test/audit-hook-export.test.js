import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditHookCapture } from '../src/audit-hooks.js';
import { evaluateCaptureRequirements } from '../src/audit-evidence.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { auditExitCode, compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

test('uncertain hook lifecycles remain actor scoped and cannot pass required execution after export/reopen', async t => {
  const capture = createAuditHookCapture();
  const run = { id: '/private/HOOK_PATH', eventName: 'sessionStart', handlerType: 'command', executionMode: 'async',
    scope: 'thread', source: 'user', status: 'running', startedAt: 100, completedAt: null, durationMs: null,
    entries: [{ text: 'PRIVATE_HOOK_OUTPUT' }], command: 'PRIVATE_HOOK_COMMAND' };
  const emit = (agentId, phase, sourceLine, overrides = {}) => capture.consume({ agentId, turnId: null, phase,
    source: `hook/${phase}`, sourceLine, run: { ...run, ...overrides } });
  // A replay-only ambiguity: three indistinguishable starts, then three completions.
  for (const line of [1, 2, 3]) emit('root', 'started', line);
  for (const line of [4, 5, 6]) emit('root', 'completed', line, { status: 'completed', completedAt: 101, durationMs: 1000 });
  // The child's same definition ID is independent and remains valid.
  emit('child', 'started', 7);
  emit('child', 'completed', 8, { status: 'completed', completedAt: 101, durationMs: 1000 });
  const result = capture.result();
  const value = { schemaVersion: 1, kind: 'audit-run', id: 'hooks-replay', status: 'partial',
    source: { threadId: 'root', kind: 'native-app-server-v2' }, coverage: { agents: 'complete', ...result.coverage },
    agents: [{ id: 'root', parentId: null }, { id: 'child', parentId: 'root' }], turns: [],
    hookInvocations: result.hookInvocations, warnings: result.warnings };
  const requirements = { hooks: [{ agent: 'root', eventName: 'sessionStart', status: 'completed' },
    { agent: 'descendant', eventName: 'sessionStart', status: 'completed' }] };
  value.captureAcceptance = evaluateCaptureRequirements(value, requirements);
  assert.deepEqual(value.captureAcceptance.checks.filter(c => c.id.startsWith('hooks:')).map(c => c.status), ['failed', 'passed']);
  const compact = compactAuditTrial({ runs: [value] }).runs[0];
  assert.deepEqual(compactAuditTrial({ runs: [compact] }).runs[0].hookInvocations, compact.hookInvocations);
  const dir = await mkdtemp(join(tmpdir(), 'xfx-hook-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const candidate of [value, { ...compact, schemaVersion: 1, kind: 'audit-run' }]) {
    for (const format of ['json', 'markdown']) {
      const exported = await exportAuditReport(candidate, { output: join(dir, `${candidate === value ? 'full' : 'compact'}.${format}`), format });
      const reopened = await readAuditReport(exported.evidencePath);
      assert.equal(reopened.coverage.hooks, 'partial');
      assert.deepEqual(reopened.hookInvocations, candidate.hookInvocations);
      assert.equal(auditExitCode(reopened), 2);
      assert.deepEqual(evaluateCaptureRequirements(reopened, requirements).checks.filter(c => c.id.startsWith('hooks:')).map(c => c.status), ['failed', 'passed']);
      assert.ok(reopened.hookInvocations.filter(h => h.agentId === 'root').every(h => [h.status, h.startedAtSeconds, h.completedAtSeconds, h.durationMs].every(v => v === null)));
      assert.ok(reopened.hookInvocations.every(h => h.turnId === null));
      assert.doesNotMatch(JSON.stringify(reopened) + renderAudit(reopened, { format: 'markdown' }), /HOOK_PATH|PRIVATE_HOOK_OUTPUT|PRIVATE_HOOK_COMMAND/);
      assert.equal(compareAuditRuns(candidate, reopened).comparison.hooks.status, 'partial-or-unknown');
    }
  }
});

test('impossible completion timing cannot satisfy a required hook or leave a prior completion certain', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-hook-invalid-timing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const priorCompletion of [false, true]) {
    const capture = createAuditHookCapture();
    const completion = (sourceLine, completedAt) => capture.consume({ phase: 'completed', agentId: 'root', turnId: null,
      source: 'hook/completed', sourceLine, run: { id: 'same-handler', eventName: 'stop', handlerType: 'command',
        executionMode: 'sync', scope: 'thread', source: 'user', status: 'completed', startedAt: 100, completedAt, durationMs: 1 } });
    if (priorCompletion) completion(1, 101);
    completion(2, 99);
    const result = capture.result();
    assert.equal(result.hookInvocations.length, 1);
    assert.equal(result.hookInvocations[0].status, null);
    const value = { schemaVersion: 1, kind: 'audit-run', id: 'impossible-timing', status: 'partial', source: { threadId: 'root' },
      agents: [{ id: 'root', parentId: null }], coverage: { agents: 'complete', ...result.coverage }, hookInvocations: result.hookInvocations };
    const requirement = { hooks: [{ agent: 'root', eventName: 'stop', status: 'completed' }] };
    assert.equal(evaluateCaptureRequirements(value, requirement).status, 'failed');
    const compact = compactAuditTrial({ runs: [value] }).runs[0];
    const exported = await exportAuditReport({ ...compact, schemaVersion: 1, kind: 'audit-run' }, { output: join(dir, `${priorCompletion}.json`), format: 'json' });
    const reopened = await readAuditReport(exported.evidencePath);
    assert.equal(reopened.hookInvocations[0].status, null);
    assert.equal(evaluateCaptureRequirements(reopened, requirement).status, 'failed');
    assert.equal(auditExitCode(reopened), 2);
  }
});
