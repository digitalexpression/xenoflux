// Authored normalized inputs, never a measured baseline/workflow execution.
import { createHash } from 'node:crypto';
import { buildAuditComparisonConditions } from '../../src/audit-conditions.js';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function bookingLedgerPair() {
  const checks = [{ name: 'scope', argv: ['fixture-independent-scope'], timeoutMs: 1000 }];
  const spec = { task: 'Frozen synthetic booking-ledger capacity/cancellation/replay/immutability contract',
    taskContract: { id: 'booking-ledger', editableFiles: ['src/booking-ledger.js'] }, checks, setup: [],
    variables: ['selected workflow skill'], quality: { id: 'booking-ledger-fixture', version: '1', checks: [{ name: 'scope', required: true }] } };
  const baseline = { commit: digest('fixture-commit'), tree: digest('fixture-tree') };
  return ['A', 'B'].map((name, index) => {
    const agentId = `fixture-root-${name}`, turnId = `fixture-turn-${name}`;
    return { schemaVersion: 1, kind: 'audit-run', id: `fixture-run-${name}`, status: 'partial',
      profile: { profileId: `fixture-profile-${name}`, profileName: name },
      source: { kind: 'synthetic-fixture', nativeSessionId: agentId, clientVersion: 'fixture-1', fingerprint: digest(name) },
      sourceWorkspace: { sourceCommit: baseline.commit, sourceTree: baseline.tree },
      comparisonConditions: buildAuditComparisonConditions({ spec, baseline, profile: { skills: index ? ['evaluation-workflow'] : [] }, profileOrder: ['A', 'B'], trialIndex: 0,
        environment: { cache: 'uncontrolled-not-reset', integrations: 'not-fingerprinted' } }),
      agents: [{ id: agentId, parentId: null, depth: 0, source: { fingerprint: digest(`actor-${name}`) } }],
      turns: [{ agentId, turnId, model: 'fixture-model', reasoningEffort: 'high', status: 'completed', sourceLine: 3 }],
      artifacts: [{ kind: 'recorded-file-change', agentId, turnId, sourceLine: index ? 14 : 12,
        path: index ? 'test/visible.test.js' : 'src/booking-ledger.js', status: 'completed' }],
      events: [], toolInvocations: [], skills: [],
      execution: { status: 'exited', exitCode: 0, elapsedMs: 100 + index * 25 }, metrics: { taskMs: 100 + index * 25 },
      outcome: { status: 'claim-recorded', claim: { success: true, status: 'completed', agentId, turnId, sourceLine: 20 } },
      checks: [{ name: 'scope', status: index ? 'failed' : 'passed', exitCode: index ? 1 : 0 }],
      workspace: { taskEnd: null, checkEnd: null }, usage: { totals: null },
      coverage: { timeline: 'partial', agents: 'observed', tools: 'partial', skills: 'partial', workspaceDiff: 'partial', outcome: 'partial', usage: 'unknown' }, warnings: [] };
  });
}
