import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMetricSamples, compactAuditTrial, summarizeAuditSeries } from '../src/audit-statistics.js';
import { auditQualityFingerprint, validateAuditReview } from '../src/audit-quality.js';
import { compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateCaptureRequirements } from '../src/audit-evidence.js';
import { nativeUsageAccounting } from '../src/audit-usage.js';

const run = (id, name, elapsed, quality = 'passed') => ({ id, profileName: name, model: 'm',
  profile: { profileId: name.toLowerCase(), profileName: name }, source: { kind: 'native-app-server-v2', threadId: `root-${id}`, version: 'v1', clientVersion: 'test-client', model: 'm', reasoningEffort: 'high' },
  sourceWorkspace: { sourceCommit: 'commit-1', sourceTree: 'tree-1' },
  comparisonConditions: { schemaVersion: 1, taskFingerprint: 'a'.repeat(64), taskId: 'fixture-task',
    checkRecipes: [{ name: 'build', fingerprint: 'b'.repeat(64) }], qualityFingerprint: auditQualityFingerprint(spec.quality, spec.checks),
    setupFingerprint: 'd'.repeat(64), selectedSkills: [], variables: [], profileOrder: ['A', 'B'], trialIndex: null,
    environment: { platform: 'darwin' }, baseline: { commit: 'commit-1', tree: 'tree-1' } },
  agents: [{ id: `root-${id}`, parentId: null, depth: 0, role: 'root', source: { fingerprint: '1'.repeat(64) } },
    { id: 'child', parentId: `root-${id}`, depth: 1, role: 'worker', source: { fingerprint: '2'.repeat(64) } }],
  execution: { status: 'exited', exitCode: quality === 'failed' ? 1 : 0 },
  outcome: { nativeTurnStatus: 'completed' }, processElapsedMs: elapsed,
  task: { nativeTurnStatus: 'completed' }, metrics: { processElapsedMs: elapsed, tokens: elapsed },
  usage: { [`root-${id}`]: { scope: 'per-agent-source-reported', total: { inputTokens: elapsed } }, child: { scope: 'per-agent-source-reported', total: { inputTokens: 999 } } },
  turns: [{ agentId: `root-${id}`, turnId: `turn-${id}`, status: 'completed', model: 'm', reasoningEffort: 'high' },
    { agentId: 'child', turnId: 'child-turn', status: 'failed', model: 'm', reasoningEffort: 'high' }],
  checks: [{ name: 'build', status: quality, exitCode: quality === 'failed' ? 1 : 0 }],
  task: 'PRIVATE_TASK_SENTINEL', argv: ['PRIVATE_ARG_SENTINEL'], env: { SECRET: 'PRIVATE_ENV_SENTINEL' },
  coverage: { tools: 'complete' }, toolInvocations: [], skillInvocations: [], mcp: { servers: [] } });
const plan = [1, 2, 3, 4].map(index => ({ index, experimentId: `e${index}`, profileOrder: ['A', 'B'] }));
const profiles = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const spec = { checks: [{ name: 'build' }], quality: { schemaVersion: 1, id: 'q', version: '1', checks: [{ name: 'build' }] } };

test('frozen trials and exports preserve distinct timestamp-free skill receipts and plugin counts', async t => {
  const subject = run('receipts', 'A', 10);
  subject.skills = [{ id: 'p', name: 'repeat', origin: 'plugin', scope: 'user', provider: 'vendor.plugin', observations: [
    { kind: 'definition-read-observed', evidence: { readCorroboration: 'native-unknown-absolute-cat', pathAuthority: 'literal-command-target' } },
  ] }];
  subject.skillInvocations = [1, 2].map(n => ({ agentId: 'root-receipts', turnId: 'turn-receipts', skillName: 'repeat', skillId: 'p',
    pluginId: 'vendor.plugin', scope: 'user', resolution: 'catalogued', invocationType: 'implicit', source: 'native-otel-skill-invocation',
    observationId: `${'b'.repeat(32)}:${n}`, timestampNs: null }));
  subject.coverage.skills = 'partial'; subject.coverage.skillInvocationTelemetry = 'observed';
  const frozen = compactAuditTrial({ runs: [subject] });
  const retained = frozen.runs[0];
  assert.deepEqual(retained.skillInvocations.map(e => e.observationId), subject.skillInvocations.map(e => e.observationId));
  assert.equal(retained.skills[0].observations[0].readCorroboration, 'native-unknown-absolute-cat');
  assert.deepEqual(compactAuditTrial(frozen).runs[0].skillInvocations, retained.skillInvocations);
  const comparison = compareAuditRuns(retained, retained);
  assert.equal(comparison.comparison.skillInvocations.left.observedCount, 2);
  assert.equal(comparison.comparison.plugins.left.byPlugin[0].count, 2);
  const dir = await mkdtemp(join(tmpdir(), 'xfx-receipt-exports-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const format of ['json', 'markdown']) {
    const result = await exportAuditReport({ ...retained, schemaVersion: 1, kind: 'audit-run' }, { format, output: join(dir, format === 'json' ? 'run.json' : 'run.md') });
    const reopened = await readAuditReport(result.evidencePath);
    assert.deepEqual(reopened.skillInvocations, retained.skillInvocations);
    assert.equal(reopened.coverage.skills, 'partial');
  }
});

test('receiver delivery and journal health survive compact, frozen JSON export, and reopen as bounded private metadata', async t => {
  const subject = run('delivery', 'A', 10);
  subject.skillTelemetry = { status: 'observed', delivery: 'best-effort', diagnostics: {
    deliveryAccounting: { schemaVersion: 1, scope: 'committed-prefix', classification: 'bounded',
      requests: { received: 3, admitted: 2, rejected: 1, secret: 'PRIVATE_ACCOUNTING_SECRET' },
      records: { examined: 8, relevant: 4, accepted: 3, durable: 3, invalidRelevant: 1, unclassified: 0,
        ignored: 4, eventLimitDropped: 0, persistenceRejected: 0, unexamined: 7, path: '/private/evidence' },
      upstreamLoss: 'false-claim', acknowledgements: 'confirmed' },
    journal: { status: 'partial', mode: 'required', format: 2, commit: 'committed-prefix', bytes: 500,
      eventCount: 3, committedBytes: 420, committedEvents: 3, uncertainBytes: 80, path: '/private/journal',
      message: 'PRIVATE_JOURNAL_MESSAGE' },
  } };
  const compact = compactAuditTrial({ runs: [subject] });
  const retained = compact.runs[0].skillTelemetry.diagnostics;
  assert.deepEqual(retained.deliveryAccounting, { schemaVersion: 1, scope: 'committed-prefix', classification: 'bounded',
    requests: { received: 3, admitted: 2, rejected: 1 }, records: { examined: 8, relevant: 4, accepted: 3, durable: 3,
      invalidRelevant: 1, unclassified: 0, ignored: 4, eventLimitDropped: 0, persistenceRejected: 0, unexamined: null },
    upstreamLoss: 'unknown', acknowledgements: 'unknown' });
  assert.equal(retained.journal.committedBytes, 420);
  assert.equal(retained.journal.uncertainBytes, 80);
  assert.equal(JSON.stringify(compact).includes('PRIVATE_'), false);
  const dir = await mkdtemp(join(tmpdir(), 'xfx-delivery-export-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const exported = await exportAuditReport({ ...retainedRun(compact), schemaVersion: 1, kind: 'audit-run' },
    { format: 'json', output: join(dir, 'run.json') });
  const reopened = await readAuditReport(exported.evidencePath);
  assert.deepEqual(reopened.skillTelemetry.diagnostics.deliveryAccounting, retained.deliveryAccounting);
  assert.deepEqual(reopened.skillTelemetry.diagnostics.journal, retained.journal);
  assert.equal(JSON.stringify(reopened).includes('/private/'), false);
  const fullExport = await exportAuditReport({ id: 'full-delivery', schemaVersion: 1, kind: 'audit-run',
    skillTelemetry: subject.skillTelemetry, capture: { skillTelemetry: structuredClone(subject.skillTelemetry),
      skillTelemetryJournal: { path: '/private/duplicate', secret: 'PRIVATE_CAPTURE_JOURNAL' } } },
    { format: 'json', output: join(dir, 'full.json') });
  const fullReopened = await readAuditReport(fullExport.evidencePath);
  assert.equal(fullReopened.skillTelemetry.diagnostics.deliveryAccounting.requests.secret, undefined);
  assert.equal(fullReopened.skillTelemetry.diagnostics.journal.message, undefined);
  assert.equal(fullReopened.capture.skillTelemetryJournal, undefined);
  assert.equal(fullReopened.capture.skillTelemetry, undefined);
  assert.equal(JSON.stringify(fullReopened).includes('PRIVATE_'), false);
});

function retainedRun(compact) { return compact.runs[0]; }

test('compact trial persists bounded run evidence without task, argv, or environment secrets', () => {
  const compact = compactAuditTrial({ runs: [run('r1', 'A', 12)],
    failures: [{ code: 'profile-reservation-failed', message: 'PRIVATE_FAILURE_BODY' }],
    warnings: [{ code: 'final-report-write-failed', message: 'PRIVATE_WARNING_BODY' }] }, { index: 1, experimentId: 'e1' });
  const encoded = JSON.stringify(compact);
  for (const secret of ['PRIVATE_TASK_SENTINEL', 'PRIVATE_ARG_SENTINEL', 'PRIVATE_ENV_SENTINEL', 'PRIVATE_FAILURE_BODY', 'PRIVATE_WARNING_BODY']) assert.equal(encoded.includes(secret), false);
  const report = summarizeAuditSeries({ profiles, spec, plan: plan.slice(0, 1), trials: [compact] });
  assert.deepEqual(report.trials[0].failures, [{ code: 'profile-reservation-failed' }]);
  assert.deepEqual(report.trials[0].warnings, [{ code: 'final-report-write-failed' }]);
  assert.equal(compact.runs[0].metrics.processElapsedMs, 12);
  assert.equal(compact.runs[0].usage.scope, 'root-agent-source-reported');
  assert.equal(compact.runs[0].metrics['root.inputTokens'], 12);
  assert.equal(compact.runs[0].metrics['root.inputTokens'] === 999, false);
  assert.deepEqual(compact.runs[0].turns, [{ agentId: 'root-r1', turnId: 'turn-r1', status: 'completed', model: 'm', reasoningEffort: 'high', sourceLine: null },
    { agentId: 'child', turnId: 'child-turn', status: 'failed', model: 'm', reasoningEffort: 'high', sourceLine: null }]);
  assert.deepEqual(compactAuditTrial(compact).runs[0], compact.runs[0]);
});

test('compaction freezes safe actor-turn bindings and canonicalizes outcome checks before detail trimming', () => {
  const subject = run('bound-checks', 'A', 12);
  delete subject.checks;
  subject.outcome.checks = [{ name: 'build', status: 'passed', exitCode: 0, sourceLine: 14 }];
  subject.agents = [{ id: 'root-bound-checks', parentId: null, role: 'root', source: { fingerprint: 'e'.repeat(64) } }];
  subject.toolInvocations = [{ agentId: 'root-bound-checks', turnId: 'turn-bound-checks', itemId: 'item-1',
    kind: 'function', toolName: 'read', status: 'completed', sourceLine: 18 }];
  subject.outcome.claim = { status: 'completed', success: true, agentId: 'root-bound-checks',
    turnId: 'turn-bound-checks', sourceLine: 20, text: 'PRIVATE_CLAIM_TEXT' };
  const compact = compactAuditTrial({ runs: [subject] });
  const retained = compact.runs[0];
  assert.equal(retained.checks[0].status, 'passed');
  assert.ok(retained.checks[0].evidenceRefs.includes('check:build:line:14'));
  assert.deepEqual(retained.comparisonConditions, subject.comparisonConditions);
  assert.equal(retained.comparisonEvidence.status, 'recorded');
  assert.equal(retained.comparisonEvidence.actors[0].id, 'root-bound-checks');
  assert.equal(retained.comparisonEvidence.actions[0].agentId, 'root-bound-checks');
  assert.equal(retained.comparisonEvidence.actions[0].turnId, 'turn-bound-checks');
  assert.equal(retained.comparisonEvidence.actions[0].actorState, 'owned');
  assert.equal(retained.comparisonEvidence.verification.agentClaim.agentId, 'root-bound-checks');
  assert.equal(JSON.stringify(retained).includes('PRIVATE_CLAIM_TEXT'), false);

  subject.checks = [{ name: 'build', status: 'failed', exitCode: 1 }];
  const conflict = compactAuditTrial({ runs: [subject] }).runs[0];
  assert.equal(conflict.checks[0].status, 'unknown');
  assert.equal(conflict.checks[0].reason, 'conflicting-check-evidence');
});

test('frozen series retains canonical provenance and marks byte-budget detail loss', () => {
  const provenance = { schemaVersion: 1, status: 'complete', counts: { observed: 8, omitted: 0, snapshots: 2 }, omissionReasons: {}, resources: Array.from({ length: 8 }, (_, i) => ({
    identity: { origin: 'project', location: `workspace/skills/skill-${i}` }, nativeSkillIds: [i.toString(16).padStart(24, '0')], agentIds: ['root'], aliases: [], catalogs: [],
    name: `skill-${i}`, scope: 'project', snapshots: [{ phase: 'after-task', status: 'present', definition: { status: 'present', fingerprint: String(i).padStart(64, 'a').slice(-64) } }],
  })) };
  const frozen = compactAuditTrial({ runs: [{ ...run('provenance', 'A', 10), resourceProvenance: provenance }] });
  assert.deepEqual(frozen.runs[0].resourceProvenance, provenance);
  assert.deepEqual(compactAuditTrial(frozen).runs[0].resourceProvenance, provenance);
  const tight = compactAuditTrial({ runs: [{ ...run('provenance-tight', 'A', 10), resourceProvenance: provenance }] }, { maxBytes: 300 * 1024 });
  assert.ok(['complete', 'partial'].includes(tight.runs[0].resourceProvenance.status));
  assert.equal(tight.runs[0].resourceProvenance.counts.observed, 8);
  if (tight.runs[0].resourceProvenance.counts.omitted) assert.equal(tight.runs[0].resourceProvenance.status, 'partial');
  const dense = { ...provenance, counts: { observed: 160, omitted: 0, snapshots: 1 }, resources: Array.from({ length: 160 }, (_, i) => ({
    identity: { origin: 'project', location: `workspace/${'long-segment-'.repeat(4)}${i}` }, nativeSkillIds: [i.toString(16).padStart(24, '0')], agentIds: ['root'],
    aliases: Array.from({ length: 16 }, (_, n) => `alias-${n}-${'x'.repeat(80)}`), name: `skill-${i}-${'n'.repeat(80)}`, scope: 'project',
    snapshots: [{ phase: 'after-task', status: 'present', definition: { status: 'present', fingerprint: 'b'.repeat(64), before: '1:2:3:4.5', after: '1:2:3:4.5' } }],
  })) };
  const budgeted = compactAuditTrial({ runs: Array.from({ length: 4 }, (_, i) => ({ ...run(`provenance-budget-${i}`, 'A', 10), resourceProvenance: dense })) }, { maxBytes: 300 * 1024 });
  assert.ok(budgeted.runs.some(item => item.resourceProvenance.counts.omitted > 0), 'the trial budget records provenance rows it removes');
  assert.ok(budgeted.runs.every(item => item.resourceProvenance.counts.omitted === 0 || item.resourceProvenance.status === 'partial'));
  for (const item of budgeted.runs) assert.equal(item.resourceProvenance.omissionReasons['projection-limit'] ?? 0, item.resourceProvenance.counts.omitted);
  assert.deepEqual(compactAuditTrial(budgeted).runs, budgeted.runs);
  const series = summarizeAuditSeries({ profiles: [{ id: 'a', name: 'A' }], spec, plan: [{ index: 1, experimentId: 'budgeted', profileOrder: ['A'] }],
    trials: [{ ...budgeted, index: 1, experimentId: 'budgeted', status: 'complete', runs: [budgeted.runs[0]] }] });
  assert.equal(series.trials[0].profiles[0].run.coverage.resourceProvenance, 'partial');
  assert.equal(series.status, 'partial');
});

test('task-change counts survive frozen trial and export while raw snapshot counts remain distinct', async t => {
  const value = run('workspace-delta', 'A', 10);
  value.sourceWorkspace = { sourceCommit: 'commit-1', sourceTree: 'tree-1' };
  value.taskEnd = { fingerprint: 'task-hash', files: 40603, baselineFingerprint: 'baseline-hash', changedFileCount: 2,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' };
  value.finalWorkspace = { fingerprint: 'check-hash', fileCount: 40605 };
  const other = run('workspace-delta-b', 'B', 12);
  other.sourceWorkspace = { sourceCommit: 'commit-1', sourceTree: 'tree-1' };
  other.workspace = { taskEnd: { fingerprint: 'task-hash-b', fileCount: 40603, changedFileCount: 5,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1', captureComplete: true, timing: 'task-end' } };
  const unverified = run('workspace-delta-c', 'C', 14);
  unverified.sourceWorkspace = { sourceCommit: 'commit-1', sourceTree: 'tree-1' };
  unverified.workspace = { taskEnd: { fingerprint: 'task-hash-c', fileCount: 40603, changedFileCount: null,
    changeCountStatus: 'unknown', changeCountBasis: 'post-setup-snapshot-delta-v1',
    changeCountReason: 'workspace-file-origin-changed', captureComplete: true, timing: 'task-end' } };
  const compact = compactAuditTrial({ runs: [value, other, unverified] }, { index: 1, experimentId: 'workspace-delta' });
  assert.deepEqual(compact.runs[0].workspace.taskEnd, { fingerprint: 'task-hash', baselineFingerprint: 'baseline-hash',
    changedFileCount: 2, changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1',
    captureComplete: true, timing: 'task-end', fileCount: 40603 });
  assert.equal(compact.runs[0].workspace.taskEnd.files, undefined);
  assert.equal(compact.runs[0].workspace.checkEnd.fileCount, 40605);
  assert.equal(compact.runs[2].workspace.taskEnd.changeCountReason, 'workspace-file-origin-changed');
  const frozen = summarizeAuditSeries({ id: 'workspace-series', profiles: [...profiles, { id: 'c', name: 'C' }], spec,
    plan: [{ index: 1, experimentId: 'workspace-delta', profileOrder: ['A', 'B', 'C'] }], trials: [compact] });
  assert.equal(frozen.profiles[0].metrics['workspace.changedFileCount'].median, 2);
  assert.equal(frozen.profiles[0].metrics['workspace.changedFileCount'].scope, 'post-setup-snapshot-delta-v1');
  assert.equal(frozen.comparisons[0].metrics['workspace.changedFileCount'].pairedN, 1);
  assert.equal(frozen.comparisons[0].metrics['workspace.changedFileCount'].delta, 3);
  const markdown = renderAudit(frozen, { format: 'markdown' });
  assert.ok(markdown.includes('workspace\\.changedFileCount'));
  const directory = await mkdtemp(join(tmpdir(), 'xfx-audit-workspace-delta-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await exportAuditReport(frozen, { output: join(directory, 'workspace.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened, frozen);
  assert.equal(reopened.trials[0].profiles[2].run.workspace.taskEnd.changeCountStatus, 'unknown');
  assert.equal(reopened.trials[0].profiles[2].run.workspace.taskEnd.changeCountReason, 'workspace-file-origin-changed');
  const mismatchedTrial = structuredClone(compact);
  mismatchedTrial.runs[1].sourceWorkspace.sourceTree = 'tree-2';
  const mismatchedSeries = summarizeAuditSeries({ profiles, spec,
    plan: [{ index: 1, experimentId: 'workspace-delta', profileOrder: ['A', 'B'] }], trials: [mismatchedTrial] });
  const mismatchedMetric = mismatchedSeries.comparisons[0].metrics['workspace.changedFileCount'];
  assert.equal(mismatchedMetric.pairedN, 0);
  assert.equal(mismatchedMetric.delta, null, 'task-change metrics pair only on a verified shared baseline');
  assert.equal(mismatchedMetric.excludedN, 1, 'baseline mismatches are excluded at the pair eligibility gate');

  const fallback = run('workspace-fallback', 'D', 16);
  fallback.sourceWorkspace = { sourceCommit: 'commit-1', sourceTree: 'tree-1' };
  fallback.workspace = { taskEnd: { fingerprint: 'fallback-hash', fileCount: 40603, changedFileCount: 2,
    changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1',
    captureComplete: false, timing: 'after-process-fallback' } };
  const fallbackTrial = compactAuditTrial({ runs: [fallback] }, { index: 1, experimentId: 'fallback' });
  assert.equal(fallbackTrial.runs[0].workspace.taskEnd.changedFileCount, 2, 'retain observed raw delta metadata');
  assert.equal(fallbackTrial.runs[0].workspace.taskEnd.changeCountStatus, 'unknown');
  assert.equal(fallbackTrial.runs[0].workspace.taskEnd.changeCountReason, 'task-end-boundary-unverified');
  const fallbackSeries = summarizeAuditSeries({ profiles: [{ id: 'd', name: 'D' }], spec,
    plan: [{ index: 1, experimentId: 'fallback', profileOrder: ['D'] }], trials: [fallbackTrial] });
  assert.equal(fallbackSeries.profiles[0].metrics['workspace.changedFileCount'].median, null);
  assert.equal(fallbackSeries.profiles[0].metrics['workspace.changedFileCount'].missingReasons['task-end-boundary-unverified'], 1);

  const legacy = run('workspace-legacy', 'A', 10);
  legacy.workspace = { taskEnd: { fingerprint: 'legacy-hash', fileCount: 7 } };
  const legacyTrial = compactAuditTrial({ runs: [legacy] }, { index: 1, experimentId: 'legacy' });
  assert.equal(legacyTrial.runs[0].workspace.taskEnd.changedFileCount, undefined);
  const unknownSeries = summarizeAuditSeries({ profiles: [{ id: 'a', name: 'A' }], spec,
    plan: [{ index: 1, experimentId: 'legacy', profileOrder: ['A'] }], trials: [legacyTrial] });
  assert.equal(unknownSeries.profiles[0].metrics['workspace.changedFileCount'].median, null,
    'legacy raw snapshot counts are not a fallback task-change metric');
});

test('validated workflow token totals survive frozen export and pair only under the verified accounting contract', async t => {
  const accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
  const makeRun = (id, name, inputTokens) => {
    const value = run(id, name, 20);
    value.source.kind = 'native-app-server-v2';
    value.source.version = accounting.version;
    value.source.historyMode = 'paginated';
    value.source.freshThread = true;
    value.usage.accounting = accounting;
    value.usage.workflow = { status: 'complete', scope: 'captured-workflow-agents', derivation: { method: 'sum-final-owned-thread-counters-once', basis: 'full-capture-before-export-bounds', agents: 2, turns: 4, observations: 4 }, values: { inputTokens, outputTokens: inputTokens + 1,
      cachedInputTokens: 2, reasoningOutputTokens: 3, cacheWriteInputTokens: 4, totalTokens: inputTokens + 10 },
    fields: Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']
      .map(field => [field, { status: 'observed', contributingAgents: 2, agentCount: 2 }])) };
    return value;
  };
  const compact = compactAuditTrial({ runs: [makeRun('wf-a', 'A', 100), makeRun('wf-b', 'B', 80)] }, { index: 1, experimentId: 'wf-e' });
  assert.equal(compact.runs[0].usage.accounting.contract, accounting.contract);
  assert.equal(compact.runs[0].usage.workflow.values.inputTokens, 100);
  assert.equal(compact.runs[0].metrics['workflow.inputTokens'], 100);
  assert.equal(compact.runs[0].source.kind, 'native-app-server-v2');
  const frozen = summarizeAuditSeries({ id: 'workflow-series', profiles, spec, plan: [{ index: 1, experimentId: 'wf-e', profileOrder: ['A', 'B'] }], trials: [compact] });
  assert.equal(frozen.profiles[0].metrics['workflow.inputTokens'].scope, 'captured-workflow-agents');
  assert.equal(frozen.profiles[0].metrics['workflow.inputTokens'].source, 'source-reported-thread-counters-summed-once');
  assert.equal(frozen.comparisons[0].metrics['workflow.inputTokens'].pairedN, 1);
  assert.equal(frozen.comparisons[0].metrics['workflow.inputTokens'].delta, -20);
  const markdown = renderAudit(frozen, { format: 'markdown' });
  assert.ok(markdown.includes('Workflow total complete · scope captured\\-workflow\\-agents'));
  assert.ok(markdown.includes('"method"') && markdown.includes('sum'));
  const directory = await mkdtemp(join(tmpdir(), 'xfx-audit-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await exportAuditReport(frozen, { output: join(directory, 'workflow.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened, frozen);
  const wrongSource = makeRun('wf-bad', 'A', 7);
  wrongSource.source.kind = 'native-rollout';
  const rejected = compactAuditTrial({ runs: [wrongSource] }, { index: 1, experimentId: 'wf-bad' }).runs[0];
  assert.equal(rejected.metrics['workflow.inputTokens'], undefined);
  assert.equal(rejected.usage.workflow.values.inputTokens, 7);
});

test('frozen trials retain safe hook metadata and only verified precomputed whole-turn usage', () => {
  const accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
  const value = run('hooks-turns', 'A', 10);
  value.source.kind = 'native-app-server-v2'; value.source.version = accounting.version;
  value.source.historyMode = 'paginated'; value.source.freshThread = true;
  value.usage.accounting = accounting;
  value.usage.turns = { status: 'complete', scope: 'captured-owned-thread-turns', reason: null, contract: accounting,
    turns: [{ agentId: value.source.threadId, turnId: 'turn-hooks-turns', status: 'complete',
      values: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 1, cacheWriteInputTokens: 3, totalTokens: 16 },
      fields: Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']
        .map(field => [field, { status: 'observed', reason: null }])),
      baseline: { inputTokens: 8, outputTokens: 2, cachedInputTokens: 1, reasoningOutputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 10 },
      derivation: { method: 'difference-cumulative-thread-boundaries', initialBaseline: 'verified-fresh-thread-zero',
      sourceObservations: Array.from({ length: 10 }, (_, index) => ({ source: 'thread/tokenUsage/updated', sourceLine: index + 10 })) } }],
    derivation: { method: 'difference-cumulative-thread-boundaries', basis: 'verified-fresh-owned-thread-counters', agents: 1, turns: 1, observations: 2 } };
  value.hookInvocations = [{ agentId: value.source.threadId, turnId: null, hookRunId: 'hook-run-1', eventName: 'preToolUse', scope: 'thread',
    sourceKind: 'project', handlerType: 'command', executionMode: 'sync', status: 'completed', startedAtSeconds: 1792100000,
    completedAtSeconds: 1792100001, durationMs: 31, source: 'hook/completed', sourceLine: 20,
    sourcePath: '/private/SECRET_PATH', statusMessage: 'SECRET_HOOK_OUTPUT', entries: [{ command: 'SECRET_COMMAND' }] }];
  value.coverage.hooks = 'observed';
  value.captureAcceptance = { requirements: { usage: { agents: 'all', fields: ['inputTokens'], minTurns: 1, wholeTurns: true }, hooks: [
    { agent: 'root', eventName: 'preToolUse', sourceKind: 'project', scope: 'thread', status: 'completed', min: 1 }] }, checks: [
    { id: 'hook:root', status: 'passed', required: 1, observed: 1, observations: 1,
      selector: { agent: 'root', eventName: 'preToolUse', sourceKind: 'project', scope: 'thread', status: 'completed', min: 1 } }] };
  const compact = compactAuditTrial({ runs: [value] }).runs[0];
  assert.equal(compact.coverage.hooks, 'observed');
  assert.deepEqual(compact.hookInvocations[0], { agentId: value.source.threadId, turnId: null, hookRunId: 'hook-run-1', eventName: 'preToolUse', scope: 'thread',
    sourceKind: 'project', handlerType: 'command', executionMode: 'sync', status: 'completed', startedAtSeconds: 1792100000,
    completedAtSeconds: 1792100001, durationMs: 31, source: 'hook/completed', sourceLine: 20 });
  assert.equal(compact.usage.turns.turns[0].values.inputTokens, 12);
  assert.equal(compact.usage.turns.turns[0].baseline.inputTokens, 8);
  assert.equal(compact.usage.turns.turns[0].derivation.sourceObservations.length, 8);
  assert.equal(compact.usage.turns.turns[0].derivation.sourceObservationsOmitted, 2);
  assert.equal(compact.usage.turns.revalidation, 'detail-omitted-after-precomputation');
  assert.equal(compact.captureAcceptance.requirements.usage.wholeTurns, true);
  assert.equal(compact.captureAcceptance.requirements.hooks[0].sourceKind, 'project');
  assert.equal(compact.captureAcceptance.checks[0].selector.eventName, 'preToolUse');
  const encoded = JSON.stringify(compact);
  for (const secret of ['SECRET_PATH', 'SECRET_HOOK_OUTPUT', 'SECRET_COMMAND']) assert.equal(encoded.includes(secret), false);

  const invalid = structuredClone(value);
  invalid.usage.turns.contract.version = 'future-unverified';
  const rejected = compactAuditTrial({ runs: [invalid] }).runs[0];
  assert.equal(rejected.usage.turns, null);
});

test('initial source detail caps mark precomputed workflow and turn totals as compacted', () => {
  const accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
  const value = run('initial-bounds', 'A', 10);
  value.source.kind = 'native-app-server-v2'; value.source.version = accounting.version;
  value.source.historyMode = 'paginated'; value.source.freshThread = true;
  value.usage.accounting = accounting;
  value.usage.observations = Array.from({ length: 501 }, (_, index) => ({ agentId: value.source.threadId, turnId: `turn-${index}`,
    source: 'thread/tokenUsage/updated', sourceLine: index + 1, mode: 'snapshot', last: {}, total: {}, present: { last: true, total: true }, disposition: 'accepted' }));
  const fields = Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']
    .map(field => [field, { status: 'observed', reason: null }]));
  value.usage.workflow = { status: 'complete', scope: 'captured-workflow-agents', values: { inputTokens: 10 }, fields,
    derivation: { method: 'sum-final-owned-thread-counters-once', basis: 'full-capture-before-export-bounds', agents: 1, turns: 1, observations: 501 } };
  value.usage.turns = { status: 'complete', scope: 'captured-owned-thread-turns', contract: accounting,
    turns: [{ agentId: value.source.threadId, turnId: 'turn-0', status: 'complete', values: {}, fields, baseline: {}, derivation: { method: 'difference-cumulative-thread-boundaries',
      initialBaseline: 'verified-fresh-thread-zero', sourceObservations: [{ source: 'thread/tokenUsage/updated', sourceLine: 1 }] } }],
    derivation: { method: 'difference-cumulative-thread-boundaries', basis: 'verified-fresh-owned-thread-counters', agents: 1, turns: 1, observations: 501 } };
  const compact = compactAuditTrial({ runs: [value] }).runs[0];
  assert.equal(compact.usage.observations.length, 500);
  assert.equal(compact.usage.workflow.revalidation, 'detail-omitted-after-precomputation');
  assert.equal(compact.usage.turns.revalidation, 'source-detail-omitted-after-precomputation');
  assert.equal(compact.usage.workflow.values.inputTokens, 10);
  assert.equal(compact.usage.turns.turns[0].values.inputTokens, null);
});

test('frozen agent roles preserve child-turn alignment across profiles', () => {
  const accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
  const make = (id, childTokens) => {
    const value = run(id, id === 'role-left' ? 'A' : 'B', 10);
    value.source = { kind: 'native-app-server-v2', threadId: `root-${id}`, version: accounting.version,
      clientVersion: accounting.version, model: 'm', reasoningEffort: 'high',
      historyMode: accounting.historyMode, freshThread: accounting.freshThread };
    value.agents = [{ id: `root-${id}`, parentId: null, depth: 0, role: 'root' },
      { id: `child-${id}`, parentId: `root-${id}`, depth: 1, role: 'review' }];
    value.turns = [{ agentId: `root-${id}`, turnId: `root-turn-${id}`, model: 'm', reasoningEffort: 'high' },
      { agentId: `child-${id}`, turnId: `child-turn-${id}`, model: 'm', reasoningEffort: 'high' }];
    value.usage = { accounting, turns: { status: 'complete', scope: 'captured-owned-thread-turns', contract: accounting,
      turns: value.turns.map((turn, index) => ({ ...turn, status: 'complete',
        values: { inputTokens: index === 0 ? 2 : childTokens }, fields: { inputTokens: { status: 'observed', reason: null } },
        baseline: { inputTokens: 0 }, derivation: { method: 'difference-cumulative-thread-boundaries', initialBaseline: 'verified-fresh-thread-zero',
          sourceObservations: [{ source: 'thread/tokenUsage/updated', sourceLine: index + 1 }] } })),
      derivation: { method: 'difference-cumulative-thread-boundaries', basis: 'verified-fresh-owned-thread-counters', agents: 2, turns: 2, observations: 2 } } };
    return compactAuditTrial({ runs: [value] }).runs[0];
  };
  const left = make('role-left', 9), right = make('role-right', 6);
  assert.equal(left.agents[1].role, 'review');
  const comparison = compareAuditRuns(left, right).comparison.usage.turns;
  assert.equal(comparison.status, 'complete');
  assert.equal(comparison.fields.inputTokens.find(row => row.roleAndOrdinal === 'root/review · turn 0').delta, -3);
});

test('frozen trial byte limits count omitted hook and whole-turn rows and preserve precomputed totals', () => {
  const accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
  const value = run('bounded-turns', 'A', 10);
  value.source.kind = 'native-app-server-v2'; value.source.version = accounting.version;
  value.source.historyMode = 'paginated'; value.source.freshThread = true;
  value.usage.accounting = accounting;
  const fields = Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']
    .map(field => [field, { status: 'observed', reason: null }]));
  const counters = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningOutputTokens: 1, cacheWriteInputTokens: 2, totalTokens: 15 };
  value.usage.turns = { status: 'complete', scope: 'captured-owned-thread-turns', contract: accounting, reason: null,
    turns: Array.from({ length: 1000 }, (_, index) => ({ agentId: value.source.threadId, turnId: `turn-${index}`, status: 'complete', values: counters,
      fields, baseline: counters, derivation: { method: 'difference-cumulative-thread-boundaries', initialBaseline: 'prior-terminal-boundary',
        sourceObservations: [{ source: 'thread/tokenUsage/updated', sourceLine: index + 1 }] } })),
    derivation: { method: 'difference-cumulative-thread-boundaries', basis: 'verified-fresh-owned-thread-counters', agents: 1, turns: 1000, observations: 1000 } };
  value.hookInvocations = Array.from({ length: 500 }, (_, index) => ({ agentId: value.source.threadId, turnId: null, hookRunId: `hook-${index}`,
    eventName: 'preToolUse', scope: 'thread', sourceKind: 'project', handlerType: 'command', executionMode: 'sync', status: 'completed',
    startedAtSeconds: index + 1, completedAtSeconds: index + 2, durationMs: 10, source: 'hook/completed', sourceLine: index + 1 }));
  value.coverage.hooks = 'observed';
  const frozen = compactAuditTrial({ runs: [value] }, { maxBytes: 300 * 1024 }).runs[0];
  assert.ok(frozen.evidenceBounds.omitted.hookInvocations > 0 || frozen.evidenceBounds.omitted.turnUsageRows > 0);
  assert.equal(frozen.usage.turns.derivation.turns, 1000);
  assert.equal(frozen.usage.turns.status, 'complete');
  if (frozen.evidenceBounds.omitted.turnUsageRows > 0) {
    assert.equal(frozen.usage.turns.turnsOmitted, frozen.evidenceBounds.omitted.turnUsageRows);
    assert.equal(frozen.usage.turns.revalidation, 'detail-omitted-after-precomputation');
  }
  if (frozen.evidenceBounds.omitted.hookInvocations > 0) assert.equal(frozen.coverage.hooks, 'partial');
});

test('explicit profile IDs resolve plan rows even when display names are duplicated', () => {
  const left = run('same-name-left', 'Default', 10), right = run('same-name-right', 'Default', 20);
  left.profileId = 'left-id'; right.profileId = 'right-id';
  left.profile.profileId = 'left-id'; right.profile.profileId = 'right-id';
  const report = summarizeAuditSeries({ profiles: [
    { profileId: 'left-id', profileName: 'Default' }, { profileId: 'right-id', profileName: 'Default' },
  ], plan: [{ index: 1, experimentId: 'same-name', profileOrder: [
    { profileId: 'left-id', profileName: 'Default' }, { profileId: 'right-id', profileName: 'Default' },
  ] }], trials: [{ index: 1, status: 'complete', runs: [right, left] }] });
  assert.deepEqual(report.trials[0].profiles.map(row => row.run.id), ['same-name-left', 'same-name-right']);
  assert.deepEqual(report.trials[0].profileOrder.map(row => row.profileId), ['left-id', 'right-id']);
});

test('native rollout timestamps and scoped recorded tokens are sampled without execution evidence', () => {
  const version = '0.163.0-alpha.10.2';
  const native = { id: 'native-session', status: 'ready', source: { kind: 'native-rollout', clientVersion: version,
    nativeSessionId: 'native-session', fingerprintScope: 'source-snapshot' },
  metrics: { recordedSpanMs: 3200, recordedSpanKind: 'source-recorded-span' }, usage: { recorded: {
    status: 'complete', scope: 'recorded-selected-thread-responses',
    contract: { contract: 'codex-rollout-own-response-usage-v1', counterScope: 'thread-owned-responses' },
    values: { inputTokens: 12 }, fields: { inputTokens: { status: 'observed' } },
  } } };
  const samples = auditMetricSamples(native);
  assert.equal(samples.recordedSpanMs.value, 3200);
  assert.equal(samples.recordedSpanMs.scope, 'source-recorded-span');
  assert.equal(samples['recorded.inputTokens'].value, 12);
  assert.match(samples['recorded.inputTokens'].scope, /thread-owned-responses/);
  const frozen = compactAuditTrial({ runs: [native] }).runs[0];
  assert.equal(frozen.metrics.recordedSpanMs, 3200);
  assert.equal(frozen.metrics.recordedSpanKind, 'source-recorded-span');

  const nativePair = ['left', 'right'].map((side, index) => ({ ...native, id: `${side}-native`,
    profileId: `${side}-id`, profileName: side, profile: { profileId: `${side}-id`, profileName: side },
    source: { ...native.source, nativeSessionId: `${side}-native` },
    metrics: { recordedSpanMs: 2000 + index * 500, recordedSpanKind: 'source-recorded-span' },
    turns: [{ agentId: `${side}-native`, turnId: `${side}-turn`, status: 'completed' }],
    comparisonConditions: { schemaVersion: 1, taskFingerprint: null, taskId: null, editableFiles: [], checkRecipes: [],
      qualityFingerprint: null, setupFingerprint: null, selectedSkills: [], variables: [], profileOrder: [], trialIndex: null,
      environment: {}, baseline: {} },
    task: { nativeTurnStatus: 'completed' },
  }));
  const summary = summarizeAuditSeries({ profiles: [
    { profileId: 'left-id', profileName: 'left' }, { profileId: 'right-id', profileName: 'right' },
  ], plan: [{ index: 1, experimentId: 'native-pair', profileOrder: [
    { profileId: 'left-id', profileName: 'left' }, { profileId: 'right-id', profileName: 'right' },
  ] }], trials: [{ index: 1, status: 'complete', runs: nativePair,
    selection: { declaration: { status: 'user-declared', taskId: 'same-native-task' }, declaredVariables: [] } }] });
  const pairedSpan = summary.comparisons[0].metrics.recordedSpanMs;
  assert.equal(pairedSpan.pairedN, 1);
  assert.equal(pairedSpan.eligibleN, 1);
});

test('all planned profile slots remain in the denominator and unavailable measurements stay null', () => {
  const trials = [{ index: 1, status: 'complete', runs: [run('a1', 'A', 10), run('b1', 'B', 8)] },
    { index: 2, status: 'failed', runs: [run('a2', 'A', 30, 'failed')] }];
  const report = summarizeAuditSeries({ id: 's', profiles, plan, spec, trials });
  const a = report.profiles[0], b = report.profiles[1];
  assert.equal(a.quality.denominator, 4);
  assert.equal(a.quality.failed, 1);
  assert.equal(a.quality.incomplete, 2);
  assert.equal(a.metrics.processElapsedMs.median, 20);
  assert.equal(a.metrics.processElapsedMs.missingN, 2);
  assert.equal(b.metrics.processElapsedMs.median, 8);
  assert.equal(report.exitCode, 4);
  assert.equal(report.trials.length, 4);
  assert.equal(report.trials[3].profiles[0].run, null);
});

test('known quantiles and IQR are deterministic, and comparisons do not declare winners', () => {
  const trials = [1, 2, 3, 4].map((index) => ({ index, status: 'complete', runs: [run(`a${index}`, 'A', index * 10), run(`b${index}`, 'B', index * 5)] }));
  const input = { id: 's', profiles, plan, spec, trials };
  const first = summarizeAuditSeries(input), second = summarizeAuditSeries(input);
  assert.deepEqual(first, second);
  assert.equal(first.profiles[0].metrics.processElapsedMs.median, 25);
  assert.equal(first.profiles[0].metrics.processElapsedMs.q1, 17.5);
  assert.equal(first.profiles[0].metrics.processElapsedMs.q3, 32.5);
  assert.equal(first.profiles[0].metrics.processElapsedMs.iqr, 15);
  assert.ok(first.comparisons.every(row => !('winner' in row)));
  const insight = first.comparisons[0].insights[0];
  assert.deepEqual(insight.runIds, ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4']);
  assert.deepEqual(insight.models, { left: ['m'], right: ['m'] });
  assert.deepEqual(insight.agentCounts, { left: [2, 2, 2, 2], right: [2, 2, 2, 2] });
  assert.equal(insight.counts.left.tools[0].runId, 'a1');
  assert.equal(insight.counts.left.tools[0].count, 0);
  assert.equal(first.trials[0].profiles[0].run.coverage.instructions, 'unavailable');
  assert.equal(first.exitCode, 2);
});

test('series aggregate deltas include only eligible constituent profile pairs and bind quality definitions', async t => {
  const slots = [1, 2].map(index => ({ index, experimentId: `conditions-${index}`, profileOrder: ['A', 'B'] }));
  const matched = [run('ca1', 'A', 10), run('cb1', 'B', 8)];
  const incompatibleRight = run('cb2', 'B', 8);
  incompatibleRight.comparisonConditions.taskFingerprint = 'e'.repeat(64);
  const report = summarizeAuditSeries({ profiles, spec, plan: slots, trials: [
    { index: 1, status: 'complete', runs: matched },
    { index: 2, status: 'complete', runs: [run('ca2', 'A', 10), incompatibleRight] },
  ] });
  const metric = report.comparisons[0].metrics.processElapsedMs;
  assert.equal(metric.plannedN, 2);
  assert.equal(metric.eligibleN, 1);
  assert.equal(metric.excludedN, 1);
  assert.equal(metric.pairedN, 1);
  assert.equal(metric.delta, -2);
  assert.equal(metric.reason, 'ineligible-comparison-conditions');
  assert.equal(report.comparisons[0].qualityDelta, null,
    'quality delta is suppressed when the eligible paired denominator is not exact');
  assert.equal(report.comparisons[0].qualityDeltaEvidence.excludedN, 1);
  assert.equal(report.trials[0].comparisons.length, 1);
  assert.equal(report.trials[1].comparisons.length, 1);
  assert.equal(report.trials[1].comparisons[0].leftRunId, 'ca2');
  assert.equal(report.trials[1].comparisons[0].rightRunId, 'cb2');
  assert.equal(report.trials[1].comparisons[0].explanation.conditions.eligible, false);

  const qualityDefinitionLeft = run('quality-definition-a', 'A', 10);
  const wrongDefinition = run('quality-definition-b', 'B', 8);
  qualityDefinitionLeft.comparisonConditions.qualityFingerprint = 'f'.repeat(64);
  wrongDefinition.comparisonConditions.qualityFingerprint = 'f'.repeat(64);
  const qualityMismatch = summarizeAuditSeries({ profiles, spec, plan: slots.slice(0, 1), trials: [
    { index: 1, status: 'complete', runs: [qualityDefinitionLeft, wrongDefinition] },
  ] });
  const qualityEvidence = qualityMismatch.comparisons[0].qualityDeltaEvidence;
  assert.equal(qualityMismatch.comparisons[0].metrics.processElapsedMs.pairedN, 1,
    'time metrics remain eligible when only the quality recipe fingerprint differs');
  assert.equal(qualityMismatch.comparisons[0].qualityDelta, null);
  assert.equal(qualityEvidence.eligibleN, 0);
  assert.equal(qualityEvidence.excludedN, 1);
  assert.equal(qualityEvidence.eligibilityReasons['quality-definition-fingerprint-mismatch'], 1);

  const directory = await mkdtemp(join(tmpdir(), 'xfx-quality-definition-binding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await exportAuditReport(qualityMismatch, { output: join(directory, 'series.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened.comparisons[0].qualityDeltaEvidence, qualityEvidence,
    'frozen reopen retains the same quality-definition exclusions and denominator');
});

test('an empty or interrupted slot is partial, never a zero-valued run', () => {
  const report = summarizeAuditSeries({ id: 's', profiles, plan: plan.slice(0, 1), spec, trials: [] });
  assert.equal(report.profiles[0].quality.denominator, 1);
  assert.equal(report.profiles[0].quality.passRate, 0);
  assert.equal(report.profiles[0].metrics.processElapsedMs.median, null);
  assert.equal(report.profiles[0].metrics.processElapsedMs.missingN, 1);
  assert.equal(report.exitCode, 2);
});

test('exact profile joins preserve a missing arm and partial capture keeps exit code 2', () => {
  const report = summarizeAuditSeries({ id: 's', profiles, plan: plan.slice(0, 1), spec,
    trials: [{ index: 1, status: 'complete', runs: [{ ...run('only-a', 'A', 0), status: 'partial', capture: { status: 'partial' } }] }] });
  assert.ok(report.trials[0].profiles.find(p => p.profileName === 'A').run);
  assert.equal(report.trials[0].profiles.find(p => p.profileName === 'B').run, null);
  assert.equal(report.exitCode, 2);
  assert.equal(report.profiles[0].quality.passed, 1);
});

test('human review validation uses the frozen recipe fingerprint', () => {
  const reviewQuality = { schemaVersion: 1, id: 'review-q', version: '7', checks: [], rubric: {
    id: 'rubric', version: '3', criteria: [{ id: 'correct', label: 'Correctness', maxScore: 5 }] } };
  const subject = { ...run('review-run', 'A', 5), checks: [], profileSettings: { status: 'unchanged' }, runningClients: { status: 'unchanged' } };
  const fingerprint = auditQualityFingerprint(reviewQuality, []);
  const sourceReview = { schemaVersion: 1, runId: subject.id, fingerprint, reviewer: 'reviewer', reviewedAt: '2026-10-16T00:00:00Z',
    ratings: [{ criterionId: 'correct', score: 4, rationale: 'Evidence supports the result.', evidenceRefs: [`run:${subject.id}`] }] };
  const validatedReview = validateAuditReview(sourceReview, { run: subject, quality: reviewQuality, checks: [] });
  const report = summarizeAuditSeries({ id: 's', profiles: [profiles[0]], plan: [{ index: 1, experimentId: 'e', profileOrder: ['A'] }],
    spec: { checks: [], quality: reviewQuality }, trials: [{ index: 1, status: 'complete', runs: [subject] }],
    reviews: [validatedReview] });
  assert.equal(report.trials[0].profiles[0].quality.rubric.status, 'reviewed');
  assert.equal(report.trials[0].profiles[0].quality.definitionVersion, '7');
  assert.deepEqual(report.trials[0].profiles[0].quality.review, validatedReview);
});

test('metric comparisons expose per-metric paired denominators despite unequal missingness', () => {
  const slots = [1, 2, 3, 4].map(index => ({ index, experimentId: `m${index}`, profileOrder: ['A', 'B'] }));
  const trials = slots.map((slot, offset) => ({ index: slot.index, status: 'complete', runs: [
    run(`ma${offset}`, 'A', 100 + offset * 10),
    ...(offset === 1 ? [] : [(() => { const sample = run(`mb${offset}`, 'B', 80 + offset * 10);
      if (offset === 2) sample.usage = {};
      return sample; })()]),
  ] }));
  const report = summarizeAuditSeries({ id: 'm', profiles, plan: slots, spec, trials });
  const elapsed = report.comparisons[0].metrics.processElapsedMs;
  assert.equal(elapsed.plannedN, 4);
  assert.equal(elapsed.leftObservedN, 4);
  assert.equal(elapsed.rightObservedN, 3);
  assert.equal(elapsed.pairedN, 3);
  assert.equal(elapsed.missingPairN, 1);
  assert.equal(elapsed.eligibleN, 3);
  assert.equal(elapsed.excludedN, 1);
  assert.equal(elapsed.delta, -20);
  assert.equal(elapsed.reason, 'ineligible-comparison-conditions');
  const tokens = report.comparisons[0].metrics['root.inputTokens'];
  assert.equal(tokens.leftObservedN, 4);
  assert.equal(tokens.rightObservedN, 2);
  assert.equal(tokens.pairedN, 2);
  assert.equal(tokens.excludedN, 1);
  assert.equal(tokens.reason, 'ineligible-comparison-conditions');
});

test('optional human rubric scores aggregate without changing machine quality and compare only paired reviews', () => {
  const rubricQuality = { schemaVersion: 1, id: 'optional-review', version: '1', checks: [{ name: 'build', required: true }],
    rubric: { id: 'manual', version: '2', required: false, criteria: [{ id: 'correct', label: 'Correctness', maxScore: 5 }] } };
  const slots = [1, 2].map(index => ({ index, experimentId: `r${index}`, profileOrder: ['A', 'B'] }));
  const subjects = [run('ra1', 'A', 10), run('rb1', 'B', 12), run('ra2', 'A', 11), run('rb2', 'B', 13)];
  const fingerprint = auditQualityFingerprint(rubricQuality, [{ name: 'build' }]);
  for (const subject of subjects) subject.comparisonConditions.qualityFingerprint = fingerprint;
  const review = (subject, score) => ({ schemaVersion: 1, runId: subject.id, fingerprint, reviewer: 'reviewer', reviewedAt: '2026-10-16T00:00:00Z',
    ratings: [{ criterionId: 'correct', score, rationale: 'Scored from recorded evidence.', evidenceRefs: [`run:${subject.id}`] }] });
  const report = summarizeAuditSeries({ id: 'r', profiles, plan: slots, spec: { checks: [{ name: 'build' }], quality: rubricQuality },
    trials: [{ index: 1, status: 'complete', runs: subjects.slice(0, 2) }, { index: 2, status: 'complete', runs: subjects.slice(2) }],
    reviews: [review(subjects[0], 4), review(subjects[1], 3)] });
  const alpha = report.profiles[0], beta = report.profiles[1];
  assert.equal(alpha.quality.passed, 2);
  assert.equal(beta.quality.passed, 2);
  assert.deepEqual({ plannedN: alpha.review.plannedN, reviewedN: alpha.review.reviewedN, scoredN: alpha.review.scoredN,
    missingN: alpha.review.missingN, median: alpha.review.median, iqr: alpha.review.iqr },
  { plannedN: 2, reviewedN: 1, scoredN: 1, missingN: 1, median: 80, iqr: 0 });
  assert.equal(report.comparisons[0].reviewDelta.pairedN, 1);
  assert.equal(report.comparisons[0].reviewDelta.delta, null,
    'review delta requires a score in every eligible paired trial');
  assert.equal(report.comparisons[0].reviewDelta.missingEligiblePairN, 1);
  assert.equal(report.comparisons[0].reviewDelta.reason, 'incomplete-paired-reviews');
  assert.equal(report.trials[1].profiles[0].quality.rubric.status, 'pending-review');
  assert.equal(report.trials[0].comparisons[0].explanation.verification.left.human.status, 'reviewed');
  assert.equal(report.trials[0].comparisons[0].explanation.verification.right.human.status, 'reviewed');
  assert.equal(report.trials[1].comparisons[0].explanation.verification.left.human.status, 'pending-review');
  assert.equal(report.trials[1].comparisons[0].explanation.verification.right.human.status, 'pending-review');
  assert.equal(report.trials[1].comparisons[0].explanation.verification.left.human.scorePercent, null);
  assert.equal(report.trials[1].comparisons[0].explanation.verification.right.human.scorePercent, null);
});

test('frozen series retains bounded attributed usage, skill, tool and MCP evidence without payloads', async t => {
  const subject = run('detail', 'A', 25);
  subject.usage.observations = [{ agentId: 'child-1', turnId: 'turn-2', source: 'rollout-jsonl', sourceLine: 41,
    recordedAt: '2026-10-16T00:00:00Z', mode: 'snapshot', last: { inputTokens: 5, outputTokens: 2 },
    total: { inputTokens: 15, outputTokens: 7 }, modelContextWindow: 32000,
    present: { last: true, total: true, modelContextWindow: true }, disposition: 'accepted', prompt: 'PRIVATE_USAGE_PROMPT' },
  { agentId: 'root-detail', turnId: 'turn-1', source: 'rollout-jsonl', sourceLine: 40, total: { inputTokens: 25 },
    present: { total: true }, disposition: 'accepted' }];
  subject.turns = [{ agentId: 'root-detail', turnId: 'turn-1', status: 'completed', source: 'native-turn', sourceLine: 40,
    observedStartedAt: '2026-10-16T10:00:00.000Z', observedCompletedAt: '2026-10-16T10:00:02.000Z' },
    { agentId: 'child-1', turnId: 'turn-2', status: 'completed', model: 'child-model', reasoningEffort: 'medium', sourceLine: 42,
      source: 'hydrated-turn', observedStartedAt: '2026-10-16T10:00:03.000Z', observedCompletedAt: '2026-10-16T10:00:04.000Z' }];
  subject.agents = [{ id: 'root-detail', depth: 0, sourceLine: 39 }, { id: 'child-1', parentId: 'root-detail', depth: 1, sourceLine: 43 }];
  subject.usage.coverage = { byAgent: [{ agentId: 'child-1' }] };
  subject.usage.assessment = { status: 'partial', result: 'PRIVATE_USAGE_ASSESSMENT' };
  subject.skills = [{ id: 'plugin:review', name: 'review', origin: 'plugin', scope: 'plugin', provider: 'vendor.review',
    path: '/private/plugins/review/SKILL.md', observations: [{ kind: 'definition-read-observed', agentId: 'child-1', turnId: 'turn-2', itemId: 'child-read', sourceLine: 51,
      evidence: { source: 'app-server-command', confidence: 'single-literal-cat-completed', pathAuthority: 'literal-command-target', commandWrapper: 'login-shell-command' }, content: 'PRIVATE_SKILL_BODY' }] }];
  subject.skillInvocations = [{ agentId: 'child-1', turnId: 'turn-2', sourceLine: 52, source: 'native-event', skillName: 'review',
    skillId: 'plugin:review', scope: 'plugin', pluginId: 'vendor.review', invocationType: 'implicit', resolution: 'catalogued',
    timestampNs: '1792100000123456789', reason: 'native event', payload: 'PRIVATE_INVOCATION_PAYLOAD' }];
  subject.skillTelemetry = { status: 'partial', delivery: 'best-effort', capability: 'enabled-unverified', enabled: true,
    diagnostics: { transport: { status: 'received', receivedBytes: 240, rejectedRequests: 1, warnings: ['bad-request'] },
      journal: { status: 'partial', bytes: 1000, eventCount: 2 },
      missingness: { byAgent: { 'child-1': { plugin: { catalogCount: 2, invocationCount: 1, status: 'partial', reason: 'event-gap' } } } } } };
  subject.capture = {
    coverageDetails: { usage: { observations: 2, attributed: 2, continuity: 'observed', byAgent: { 'child-1': {
      observations: 2, accepted: 2, duplicates: 0, regressed: 0, resets: 0, inconsistent: 0, invalid: 0,
      fields: { last: { inputTokens: { present: 2, missing: 0, invalid: 0 } }, total: { totalTokens: { present: 2, missing: 0, invalid: 0 } },
        modelContextWindow: { present: 2, missing: 0, invalid: 0 } } } } } },
    observer: { transport: 'loopback-otlp-http-json', savedSettingsChanged: false,
      nativeSessionStorage: 'profile-owned-new-rollouts', profileHomeUsedForReadOnlySettingsAndSkills: true,
      runtime: { sqlite: 'private-per-process', logs: 'private-per-process', temporaryFiles: 'private-per-process', threadPersistence: 'native-owned-session', workspace: 'verified-process-cwd' },
      effects: ['PRIVATE_EFFECT_DETAIL'] },
  };
  subject.source.persistence = 'native-owned-session';
  subject.toolInvocations = [{ agentId: 'child-1', turnId: 'turn-2', sourceLine: 60, source: 'app-server', kind: 'mcp',
    serverName: 'docs', pluginId: 'vendor.docs', namespace: 'search', toolName: 'find', status: 'completed', durationMs: 17,
    success: false, exitCode: 2, failureReason: 'command-failed', startedAtMs: 100, completedAtMs: 117,
    observedStartedAtMs: 101, observedCompletedAtMs: 120, observedElapsedMs: 19,
    arguments: 'PRIVATE_TOOL_ARGUMENTS' },
  { agentId: 'root-detail', turnId: 'turn-1', itemId: 'command-root', kind: 'command', toolName: 'plugin-script', pluginId: 'vendor.command', scriptPath: 'scripts/root.py', status: 'completed' },
  { agentId: 'root-detail', turnId: 'turn-1', itemId: 'command-root', kind: 'command', toolName: 'plugin-script', pluginId: 'vendor.command', scriptPath: 'scripts/root.py', status: 'completed' },
  { agentId: 'child-1', turnId: 'turn-2', itemId: 'command-child', kind: 'command', toolName: 'plugin-script', pluginId: 'vendor.command', scriptPath: 'skills/review/scripts/child.py', status: 'completed' }];
  const requirements = { minAgents: 2, usage: { agents: 'root', fields: ['inputTokens'], minTurns: 1 },
    skills: [{ agent: 'descendant', name: 'review', origin: 'plugin', invocationType: 'implicit', min: 1 }],
    tools: [{ agent: 'descendant', kind: 'mcp', server: 'docs', tool: 'find', pluginId: 'vendor.docs', min: 1 },
      { agent: 'root', kind: 'command', pluginId: 'vendor.command', scriptPath: 'scripts/root.py', min: 1 }] };
  subject.coverage = { ...subject.coverage, agents: 'complete' };
  subject.captureAcceptance = evaluateCaptureRequirements(subject, requirements);
  assert.equal(subject.captureAcceptance.status, 'passed');
  subject.mcp = { servers: [{ name: 'docs', pluginId: 'vendor.docs', status: 'failed', failureReason: 'startup-error', source: 'app-server', sourceLine: 59, secrets: 'PRIVATE_MCP_SECRET' }] };
  const compact = compactAuditTrial({ runs: [subject] }, { index: 1, experimentId: 'e1' });
  assert.deepEqual(compactAuditTrial(compact).runs[0].skillTelemetry.diagnostics, compact.runs[0].skillTelemetry.diagnostics);
  assert.deepEqual(compactAuditTrial(compact).runs[0].usageCoverage, compact.runs[0].usageCoverage);
  assert.deepEqual(compactAuditTrial(compact).runs[0].capture, compact.runs[0].capture);
  assert.deepEqual(compactAuditTrial(compact).runs[0].toolInvocations[0], compact.runs[0].toolInvocations[0]);
  assert.equal(compact.runs[0].toolInvocations[0].exitCode, 2);
  assert.equal(compact.runs[0].toolInvocations[0].failureReason, 'command-failed');
  assert.equal(compact.runs[0].toolInvocations[0].observedElapsedMs, 19);
  assert.equal(compact.runs[0].skillInvocations[0].timestampNs, '1792100000123456789');
  assert.equal(compact.runs[0].mcpServers[0].failureReason, 'startup-error');
  const report = summarizeAuditSeries({ id: 'frozen-detail', profiles: [profiles[0]], plan: [{ index: 1, experimentId: 'e1', profileOrder: ['A'] }],
    spec: { checks: [{ name: 'build' }], quality: { schemaVersion: 1, id: 'q', version: '1', checks: [{ name: 'build' }] } }, trials: [compact] });
  const frozen = structuredClone(JSON.parse(JSON.stringify(report)));
  const serialized = JSON.stringify(frozen);
  for (const secret of ['PRIVATE_USAGE_PROMPT', 'PRIVATE_USAGE_ASSESSMENT', 'PRIVATE_SKILL_BODY', 'PRIVATE_INVOCATION_PAYLOAD', 'PRIVATE_TOOL_ARGUMENTS', 'PRIVATE_MCP_SECRET']) assert.equal(serialized.includes(secret), false);
  const retained = frozen.trials[0].profiles[0].run;
  assert.equal(retained.usage.observations[0].sourceLine, 41);
  assert.equal(retained.usage.observations[0].total.inputTokens, 15);
  assert.equal(retained.usage.observations[0].modelContextWindow, 32000);
  assert.equal(retained.usage.byAgent.find(item => item.agentId === 'child').total.inputTokens, 999);
  assert.equal(retained.usage.byAgent.some(item => item.agentId === 'coverage' || item.agentId === 'assessment'), false);
  assert.equal(retained.skillInvocations[0].agentId, 'child-1');
  assert.equal(retained.skills[0].observations[0].sourceLine, 51);
  assert.equal(retained.skills[0].observations[0].source, 'app-server-command');
  assert.equal(retained.skills[0].observations[0].itemId, 'child-read');
  assert.equal(retained.skills[0].observations[0].pathAuthority, 'literal-command-target');
  assert.equal(retained.skills[0].observations[0].commandWrapper, 'login-shell-command');
  assert.deepEqual(compactAuditTrial(compact).runs[0].skills[0].observations, compact.runs[0].skills[0].observations);
  assert.match(renderAudit(frozen), /wrapper login-shell-command/);
  const frozenComparison = compareAuditRuns(retained, retained);
  assert.equal(frozenComparison.comparison.skills[0].left.observations[0].pathAuthority, 'literal-command-target');
  assert.match(renderAudit(frozenComparison), /wrapper login-shell-command/);
  assert.equal(retained.toolInvocations[0].sourceLine, 60);
  assert.equal(retained.toolInvocations[1].pluginId, 'vendor.command');
  assert.equal(retained.toolInvocations[1].scriptPath, 'scripts/root.py');
  assert.equal(compactAuditTrial(compact).runs[0].toolInvocations[1].scriptPath, 'scripts/root.py');
  assert.match(renderAudit(frozen), /script skills\/review\/scripts\/child\.py/);
  assert.equal(retained.mcpServers[0].sourceLine, 59);
  assert.equal(retained.skillTelemetry.diagnostics.transport.receivedBytes, 240);
  assert.equal(retained.skillTelemetry.diagnostics.missingness.byAgent[0].origins.plugin.invocationCount, 1);
  assert.equal(retained.usageCoverage.byAgent['child-1'].fields.last.inputTokens.present, 2);
  assert.equal(retained.captureAcceptance.requirements.minAgents, 2);
  assert.equal(retained.captureAcceptance.requirements.skills[0].name, 'review');
  assert.equal(retained.captureAcceptance.requirements.tools[0].pluginId, 'vendor.docs');
  assert.equal(retained.captureAcceptance.requirements.tools[1].scriptPath, 'scripts/root.py');
  assert.equal(retained.captureAcceptance.checks.find(item => item.id === 'tools:1').selector.scriptPath, 'scripts/root.py');
  assert.equal(retained.source.persistence, 'native-owned-session');
  assert.equal(retained.capture.observer.nativeSessionStorage, 'profile-owned-new-rollouts');
  assert.equal(retained.capture.observer.runtime.sqlite, 'private-per-process');
  assert.equal(retained.capture.observer.runtime.workspace, 'verified-process-cwd');
  assert.equal(retained.capture.observer.savedSettingsChanged, false);
  assert.equal(serialized.includes('PRIVATE_EFFECT_DETAIL'), false);
  const rootUsageCheck = retained.captureAcceptance.checks.find(item => item.id.startsWith('usage:') && item.turnId === 'turn-1');
  assert.ok(rootUsageCheck, 'evaluation should retain its actual root turn check ID');
  assert.equal(rootUsageCheck.observations, 1);
  assert.equal(retained.agents[1].parentId, 'root-detail');
  assert.equal(retained.turns[1].sourceLine, 42);
  assert.equal(retained.turns[1].source, 'hydrated-turn');
  assert.equal(retained.turns[1].observedStartedAt, '2026-10-16T10:00:03.000Z');
  assert.equal(retained.turns[1].observedCompletedAt, '2026-10-16T10:00:04.000Z');
  assert.deepEqual(compactAuditTrial(compact).runs[0].turns[1], retained.turns[1]);
  assert.match(renderAudit(frozen), /observed start 2026-10-16T10:00:03\.000Z · observed end 2026-10-16T10:00:04\.000Z · source hydrated-turn · line 42/);
  assert.match(renderAudit(frozen), /Skill telemetry child-1 · plugin/);
  assert.match(renderAudit(frozen), /Usage field coverage observed/);
  assert.match(renderAudit(frozen), /Capture acceptance: passed · mode declared-observations/);
  assert.match(renderAudit(frozen), /Native storage: session native-owned-session · rollouts profile-owned-new-rollouts · SQLite private-per-process/);
  assert.match(renderAudit(frozen), /Usage child-1 · turn turn-2/);
  assert.match(renderAudit(frozen), /Skill use review/);
  assert.match(renderAudit(frozen), /Skill use review \[plugin:review\] · plugin vendor\.review · implicit · catalogued · agent child-1 · turn turn-2 · timestamp 1792100000123456789 ns/);
  assert.match(renderAudit(frozen), /Tool mcp/);
  assert.match(renderAudit(frozen), /exit 2/);
  assert.match(renderAudit(frozen), /native duration 17 ms/);
  assert.match(renderAudit(frozen), /observer elapsed 19 ms/);
  assert.match(renderAudit(frozen), /observer started 101/);
  assert.match(renderAudit(frozen), /failure startup-error/);
  assert.match(renderAudit(frozen), /vendor\.docs · 1 observed use/);
  assert.match(renderAudit(frozen), /vendor\.command · 2 observed uses/);
  assert.match(renderAudit(frozen), /plugin-command-call agent root-detail turn turn-1/);
  assert.match(renderAudit(frozen), /plugin-command-call agent child-1 turn turn-2/);
  const directory = await mkdtemp(join(tmpdir(), 'xfx-audit-detail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await exportAuditReport(frozen, { output: join(directory, 'series.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened.trials[0].profiles[0].run, retained);
  assert.match(renderAudit(reopened), /line 60/);

  const overflow = run('overflow', 'A', 10);
  overflow.usage.observations = Array.from({ length: 505 }, (_, i) => ({ agentId: 'root-overflow', turnId: `turn-${i}`, total: { inputTokens: i } }));
  const first = compactAuditTrial({ runs: [overflow] }, { index: 2 });
  const second = compactAuditTrial(first);
  assert.equal(first.runs[0].usage.observations.length, 500);
  assert.equal(first.runs[0].evidenceBounds.omitted.usageObservations, 5);
  assert.equal(second.runs[0].evidenceBounds.omitted.usageObservations, 5);
});

test('historical by-agent totals preserve source scope and missingness without deriving counters', () => {
  const historical = { id: 'historical', profileName: 'A', source: { threadId: 'legacy-root' }, status: 'completed',
    execution: { status: 'exited', exitCode: 0 }, agents: [{ id: 'legacy-root', parentId: null, depth: 0 }, { id: 'legacy-child', parentId: 'legacy-root', depth: 1 }],
    usage: { status: 'partial', observations: [], coverageByAgent: { 'legacy-root': { fields: {
      last: { inputTokens: { present: 0, missing: 1, invalid: 0 } },
      total: { inputTokens: { present: 1, missing: 0, invalid: 0 }, outputTokens: { present: 0, missing: 1, invalid: 0 } },
      modelContextWindow: { present: 0, missing: 1, invalid: 0 } } } },
    byAgent: [{ agentId: 'legacy-root', totals: { scope: 'rollout-root', values: { input_tokens: 19, cache_write_input_tokens: 4 } } },
      { agentId: 'legacy-child', totals: { scope: 'child-session', values: { output_tokens: 7 } } }] },
    metrics: {}, turns: [], checks: [], skills: [], skillInvocations: [], toolInvocations: [] };
  const compact = compactAuditTrial({ runs: [historical] }, { index: 1 }).runs[0];
  assert.equal(compact.metrics['root.inputTokens'], 19);
  assert.equal(compact.metrics['root.cacheWriteInputTokens'], 4);
  assert.equal(compact.metrics['root.outputTokens'], undefined);
  assert.equal(compact.metrics['root.totalTokens'], undefined);
  assert.equal(compact.usage.sourceScope, 'rollout-root');
  assert.equal(compact.usage.byAgent.find(item => item.agentId === 'legacy-child').scope, 'child-session');
  assert.equal(compact.usage.byAgent.find(item => item.agentId === 'legacy-child').total.outputTokens, 7);
  assert.equal(compact.usageCoverage.byAgent['legacy-root'].fields.total.outputTokens.missing, 1);
});

test('compact trial byte budget trims detail while preserving every run identity and core evidence', () => {
  const runs = Array.from({ length: 8 }, (_, index) => {
    const value = run(`budget-${index}`, 'A', index + 1);
    if (index === 0) {
      const accounting = nativeUsageAccounting('0.163.0-alpha.10.2');
      value.source.kind = 'native-app-server-v2'; value.source.version = accounting.version;
      value.source.historyMode = 'paginated'; value.source.freshThread = true;
      value.usage.accounting = accounting;
      value.usage.workflow = { status: 'complete', scope: 'captured-workflow-agents', derivation: { method: 'sum-final-owned-thread-counters-once', basis: 'full-capture-before-export-bounds', agents: 2, turns: 4, observations: 4 },
        values: { inputTokens: 400, outputTokens: 200, cachedInputTokens: 20, reasoningOutputTokens: 30, cacheWriteInputTokens: 10, totalTokens: 600 },
        fields: Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']
          .map(field => [field, { status: 'observed', contributingAgents: 2, agentCount: 2 }])) };
      value.usage.observations = Array.from({ length: 500 }, (_, item) => ({ agentId: 'root-budget-0', turnId: `usage-turn-${item}`,
        source: 'rollout-jsonl', recordedAt: '2026-10-16T10:00:00.000Z', mode: 'snapshot',
        last: { inputTokens: item, outputTokens: item + 1, cachedInputTokens: item + 2, reasoningOutputTokens: item + 3, cacheWriteInputTokens: item + 4, totalTokens: item + 5 },
        total: { inputTokens: item, outputTokens: item + 1, cachedInputTokens: item + 2, reasoningOutputTokens: item + 3, cacheWriteInputTokens: item + 4, totalTokens: item + 5 },
        present: { last: true, total: true }, disposition: 'accepted' }));
    }
    value.outcome = { status: 'claim-recorded', nativeTurnStatus: 'completed' };
    value.checks = [{ name: 'required-check', status: 'passed', exitCode: 0 }];
    value.coverage.tools = 'partial'; value.coverage.mcp = 'partial';
    value.toolInvocations = Array.from({ length: index === 0 ? 300 : 1 }, (_, item) => ({ agentId: `agent-${index}`, turnId: `turn-${item}`,
      kind: 'mcp', serverName: 'server'.repeat(20), toolName: 'tool'.repeat(20), status: 'completed', sourceLine: item + 1 }));
    return value;
  });
  const frozen = compactAuditTrial({ runs }, { index: 1, experimentId: 'e1', maxBytes: 320 * 1024 });
  assert.ok(new TextEncoder().encode(JSON.stringify(frozen)).byteLength <= 320 * 1024);
  assert.equal(frozen.runs.length, 8);
  assert.deepEqual(frozen.runs.map(item => item.id), runs.map(item => item.id));
  for (const item of frozen.runs) {
    assert.equal(item.metrics.processElapsedMs > 0, true);
    assert.equal(item.outcome.status, 'claim-recorded');
    assert.equal(item.checks[0].status, 'passed');
    if (item.id === 'budget-0') assert.ok(item.evidenceBounds.omitted.toolInvocations > 0);
    assert.equal(item.coverage.tools, 'partial');
    assert.equal(item.coverage.mcp, 'partial');
    assert.equal(compareAuditRuns(item, item).comparison.tools.status, 'partial-or-unknown');
  }
  const workflowRun = frozen.runs[0];
  assert.equal(workflowRun.metrics['workflow.inputTokens'], 400);
  assert.equal(workflowRun.usage.workflow.values.inputTokens, 400);
  assert.ok(workflowRun.evidenceBounds.omitted.usageObservations > 0);
  assert.equal(workflowRun.usage.workflow.revalidation, 'detail-omitted-after-precomputation');
  assert.equal(workflowRun.usage.workflow.derivation.method, 'sum-final-owned-thread-counters-once');
  const report = summarizeAuditSeries({ id: 'bounded', profiles: [profiles[0]],
    plan: [{ index: 1, experimentId: 'e1', profileOrder: ['A'] }], trials: [frozen] });
  assert.match(renderAudit(report), /revalidation detail-omitted-after-precomputation/);
});

test('byte budget trims dense coverage and acceptance evidence with explicit omissions', () => {
  const requirements = { minAgents: 1, usage: { agents: 'root', fields: ['inputTokens'], minTurns: 1 }, skills: [], tools: [] };
  const runs = Array.from({ length: 8 }, (_, index) => {
    const value = run(`dense-${index}`, 'A', index + 1);
    value.outcome = { status: 'claim-recorded', nativeTurnStatus: 'completed' };
    value.checks = [{ name: 'required-check', status: 'passed', exitCode: 0 }];
    value.usageCoverage = { observations: 160, attributed: 160, continuity: 'observed', byAgent: Object.fromEntries(
      Array.from({ length: 160 }, (_, agent) => [`agent-${agent}`, { observations: 1, accepted: 1, duplicates: 0,
        regressed: 0, resets: 0, inconsistent: 0, invalid: 0, fields: Object.fromEntries(['last', 'total'].map(group => [group,
          Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens']
            .map(field => [field, { present: 1, missing: 0, invalid: 0 }]))])) }])) };
    value.captureAcceptance = { schemaVersion: 1, mode: 'declared-observations', status: 'passed', requirements,
      checks: Array.from({ length: 200 }, (_, check) => ({ id: `usage:agent-${check}:turn-${check}`, status: 'passed', required: 1,
        observed: 1, observations: 1, agentId: `agent-${check}`, turnId: `turn-${check}`, missingFields: [],
        selector: { agent: 'root', name: `skill-${check}`, origin: 'plugin', invocationType: 'implicit', min: 1 } })),
      exhaustiveConsumption: false, boundary: 'bounded observation evidence' };
    return value;
  });
  const maxBytes = 320 * 1024;
  const frozen = compactAuditTrial({ runs }, { maxBytes });
  assert.ok(new TextEncoder().encode(JSON.stringify(frozen)).byteLength <= maxBytes);
  assert.deepEqual(frozen.runs.map(item => item.id), runs.map(item => item.id));
  for (const item of frozen.runs) {
    assert.equal(item.metrics.processElapsedMs > 0, true);
    assert.equal(item.outcome.status, 'claim-recorded');
    assert.equal(item.checks[0].status, 'passed');
    assert.equal(item.captureAcceptance.status, 'passed');
    assert.ok(item.evidenceBounds.omitted.usageCoverageAgents > 0);
    assert.ok(item.evidenceBounds.omitted.captureAcceptanceChecks > 0);
    assert.ok(item.usageCoverage.byAgentOmitted > 0);
    assert.ok(item.captureAcceptance.checksOmitted > 0);
  }
  assert.deepEqual(compactAuditTrial(frozen).runs, frozen.runs);
});

test('byte budget fails explicitly when irreducible run identity evidence exceeds the limit', () => {
  assert.throws(() => compactAuditTrial({ runs: [{ id: 'x'.repeat(400 * 1024), metrics: {}, checks: [], turns: [], agents: [] }] },
    { maxBytes: 320 * 1024 }), error => error.code === 'AUDIT_TRIAL_EVIDENCE_EXCEEDS_BYTE_BUDGET');
});

test('frozen trials preserve normalized instruction metadata, omissions, and partial coverage', () => {
  const hash = n => `sha256:${String(n).repeat(64)}`;
  const value = run('instruction-frozen', 'A', 10);
  value.agents = [{ id: 'root-instruction-frozen', role: 'root' }, { id: 'child', role: 'review', parentId: 'root-instruction-frozen' }];
  value.coverage.instructions = 'observed';
  value.instructionSources = [
    { agentId: 'root-instruction-frozen', status: 'reported-empty', source: 'thread/start', phase: 'before-task', sourceLine: 1, reportedCount: 0, sources: [], omittedCount: 0, rejectedCount: 0, reason: null },
    { agentId: 'child', status: 'reported', source: 'thread/resume-loaded', phase: 'after-task', sourceLine: 9, reportedCount: 70,
      sources: Array.from({ length: 70 }, (_, index) => ({ id: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
        origin: 'repository', name: 'AGENTS.md', ...(index === 0 ? { path: '/DO_NOT_EXPORT', body: 'SECRET_BODY' } : {}) })), omittedCount: 0, rejectedCount: 0, reason: null },
    { agentId: 'unowned', status: 'reported', source: 'thread/start', phase: 'before-task', sourceLine: 10, reportedCount: 1,
      sources: [{ id: hash('d'), origin: 'external', name: 'instruction-file' }], omittedCount: 0, rejectedCount: 0, reason: null },
  ];
  const frozen = compactAuditTrial({ runs: [value] });
  assert.equal(frozen.runs[0].instructionSources.length, 2);
  assert.equal(frozen.runs[0].instructionSources[1].phase, 'after-task');
  assert.equal(frozen.runs[0].instructionSources[1].sources[0].origin, 'repository');
  assert.equal(frozen.runs[0].instructionSources[1].omittedCount, 6);
  assert.equal(frozen.runs[0].coverage.instructions, 'partial');
  assert.ok(frozen.runs[0].evidenceBounds.omitted.instructionAgents >= 1);
  assert.doesNotMatch(JSON.stringify(frozen), /DO_NOT_EXPORT|SECRET_BODY/);
  const compactAgain = compactAuditTrial(frozen).runs[0];
  assert.deepEqual(compactAgain.instructionSources, frozen.runs[0].instructionSources);
  assert.equal(compactAgain.evidenceBounds.omitted.instructionSources, frozen.runs[0].evidenceBounds.omitted.instructionSources);
  assert.equal(compactAgain.evidenceBounds.omitted.instructionAgents, frozen.runs[0].evidenceBounds.omitted.instructionAgents);
});

test('frozen byte budget trims nested instruction references and records the loss', () => {
  const sourceId = index => `sha256:${index.toString(16).padStart(64, '0')}`;
  const value = run('instruction-byte-budget', 'A', 10);
  value.agents = Array.from({ length: 160 }, (_, index) => ({ id: index === 0 ? 'root-instruction-byte-budget' : `agent-${index}`, role: `role-${index}`,
    ...(index ? { parentId: 'root-instruction-byte-budget', depth: 1 } : { depth: 0 }) }));
  value.instructionSources = value.agents.map((agent, index) => ({ agentId: agent.id, status: 'reported', source: 'thread/resume-loaded', phase: 'after-task',
    sourceLine: index + 1, reportedCount: 64, sources: Array.from({ length: 64 }, (_, n) => ({ id: sourceId(index * 64 + n + 1), origin: 'repository', name: 'AGENTS.md' })),
    omittedCount: 0, rejectedCount: 0, reason: null }));
  value.coverage.instructions = 'observed';
  const frozen = compactAuditTrial({ runs: [value] }, { maxBytes: 300 * 1024 }).runs[0];
  assert.ok(frozen.evidenceBounds.omitted.instructionSources > 0 || frozen.evidenceBounds.omitted.instructionAgents > 0);
  assert.equal(frozen.coverage.instructions, 'partial');
  assert.ok(frozen.instructionSources.reduce((sum, row) => sum + row.omittedCount, 0) > 0 || frozen.evidenceBounds.omitted.instructionAgents > 0);
  assert.ok(frozen.instructionSources.filter(row => row.omittedCount > 0).every(row => row.status === 'partial' && row.reason === 'instruction-evidence-limit'));
  const compactAgain = compactAuditTrial(frozen).runs[0];
  assert.equal(compactAgain.evidenceBounds.omitted.instructionSources, frozen.evidenceBounds.omitted.instructionSources);
  assert.equal(compactAgain.evidenceBounds.omitted.instructionAgents, frozen.evidenceBounds.omitted.instructionAgents);
  assert.deepEqual(compactAgain.instructionSources.map(row => [row.status, row.omittedCount, row.reason]),
    frozen.instructionSources.map(row => [row.status, row.omittedCount, row.reason]));
});

test('compact MCP bounds keep counts partial and startup identity visible after repeated projection', () => {
  const subject = run('mcp-bounds', 'A', 10);
  subject.coverage = { tools: 'complete', mcp: 'complete', skillInvocationTelemetry: 'observed' };
  subject.toolInvocations = Array.from({ length: 501 }, (_, index) => ({ agentId: 'root-mcp-bounds', turnId: 'turn-mcp-bounds',
    itemId: `call-${index}`, kind: 'mcp', serverName: `server-${index}`, pluginId: 'example-plugin@local-market',
    toolName: 'lookup', status: 'completed', failed: false }));
  subject.mcp = { inventory: 'not-requested', servers: Array.from({ length: 161 }, (_, index) => ({
    name: `server-${index}`, pluginId: null, status: index === 0 ? 'failed' : 'ready',
    failureReason: index === 0 ? 'reauthenticationRequired' : null, source: 'app-server-process' })) };
  const first = compactAuditTrial({ runs: [subject] }).runs[0];
  for (const compact of [first, compactAuditTrial({ runs: [first] }).runs[0]]) {
    assert.equal(compact.evidenceBounds.omitted.toolInvocations, 1);
    assert.equal(compact.evidenceBounds.omitted.mcpServers, 1);
    assert.equal(compact.coverage.tools, 'partial');
    assert.equal(compact.coverage.mcp, 'partial');
    assert.equal(compact.mcpInventory, 'not-requested');
    // Older compact reports can carry complete coverage alongside omission
    // metadata. Readers must still avoid presenting retained counts as complete.
    const old = { ...compact, coverage: subject.coverage };
    const comparison = compareAuditRuns(old, old);
    assert.equal(comparison.comparison.tools.left.count, null);
    assert.equal(comparison.comparison.tools.status, 'partial-or-unknown');
    assert.equal(comparison.comparison.mcp.left.observedCount, 160);
    assert.equal(comparison.comparison.mcp.left.count, null);
    assert.equal(comparison.comparison.mcp.status, 'partial-or-unknown');
    assert.equal(comparison.comparison.mcp.left.inventory, 'not-requested');
    assert.equal(comparison.comparison.mcp.left.servers[0].failureReason, 'reauthenticationRequired');
    assert.equal(comparison.comparison.plugins.left.status, 'partial-or-unknown');
    assert.ok(comparison.comparison.tools.counts.every(row => row.delta === null));
    assert.ok(comparison.comparison.mcp.counts.every(row => row.delta === null));
  }
  const serverOnly = compactAuditTrial({ runs: [{ ...subject, toolInvocations: subject.toolInvocations.slice(0, 1) }] }).runs[0];
  assert.equal(serverOnly.coverage.tools, 'complete');
  assert.equal(serverOnly.coverage.mcp, 'partial');
  const compared = compareAuditRuns(serverOnly, serverOnly);
  assert.equal(compared.comparison.tools.status, 'known');
  assert.equal(compared.comparison.mcp.left.observedCount, 160);
  assert.equal(compared.comparison.mcp.left.count, null);
  assert.equal(compared.comparison.mcp.status, 'partial-or-unknown');
});
