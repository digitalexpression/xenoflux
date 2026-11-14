import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareAuditRuns } from '../src/audit-report.js';
import { presentComparison, presentEvidence, presentRunExecution, presentSetupComparison, presentSkillPackage, presentTaskEndPatch } from '../src/audit-presentation.js';
import { captureAuditWorkspacePatch } from '../src/audit-workspace-patch.js';
import { compareAuditResourceDetails } from '../src/audit-profile-diff.js';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';

test('comparison limits distinguish observed skill receipts from exhaustive skill use', () => {
  const pair = bookingLedgerPair();
  for (const run of pair) run.coverage = { ...run.coverage, skills: 'partial',
    skillInventory: 'complete', skillUsage: 'partial', skillInvocationTelemetry: 'observed', captureRequirements: 'passed' };
  const original = structuredClone(pair);
  const limits = presentComparison(compareAuditRuns(...pair)).limits.join('\n');
  assert.doesNotMatch(limits, /Skill use: partly recorded/);
  assert.match(limits, /Native skill invocation receipts are recorded/);
  assert.match(limits, /exhaustive skill use remains unverified/);
  assert.deepEqual(pair, original);
  pair[1].coverage.skillInvocationTelemetry = 'partial';
  assert.match(presentComparison(compareAuditRuns(...pair)).limits.join('\n'), /Skill invocation telemetry: partly recorded/);
  pair[1].coverage.skillInventory = 'partial';
  assert.match(presentComparison(compareAuditRuns(...pair)).limits.join('\n'), /Skill catalog: partly recorded/);
});

test('an explicitly empty captured patch is unchanged rather than missing content', () => {
  const run = bookingLedgerPair()[0];
  const fingerprint = 'a'.repeat(64), patchSha256 = createHash('sha256').update('').digest('hex');
  run.workspace.taskEnd = { fingerprint, baselineFingerprint: fingerprint, patchSha256, timing: 'task-end', captureComplete: true,
    patchContent: captureAuditWorkspacePatch(Buffer.alloc(0), { fingerprint, patchSha256 }, {
      baselineFingerprint: fingerprint, sourceBaselineCommit: run.sourceWorkspace.sourceCommit, sourceBaselineTree: run.sourceWorkspace.sourceTree,
    }) };
  const before = structuredClone(run);
  assert.equal(presentTaskEndPatch(run).status, 'unchanged');
  assert.match(presentTaskEndPatch(run).note, /no changes/);
  assert.deepEqual(run, before);
  run.workspace.taskEnd.patchContent.reason = 'recorded-content-not-included';
  assert.equal(presentTaskEndPatch(run).status, 'omitted');
});

test('patch presentation distinguishes verified task end, unverified boundary and post-process fallback', () => {
  const run = bookingLedgerPair()[0];
  const patch = Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n');
  const fingerprint = 'a'.repeat(64), baselineFingerprint = 'b'.repeat(64);
  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  run.workspace.taskEnd = { fingerprint, baselineFingerprint, patchSha256, timing: 'task-end', captureComplete: true,
    patchContent: captureAuditWorkspacePatch(patch, { fingerprint, patchSha256 }, {
      baselineFingerprint, sourceBaselineCommit: run.sourceWorkspace.sourceCommit, sourceBaselineTree: run.sourceWorkspace.sourceTree,
    }) };
  assert.doesNotMatch(presentTaskEndPatch(run).note, /unverified|after the process/);
  run.workspace.taskEnd.captureComplete = false;
  run.workspace.taskEnd.timing = 'unverified-task-end';
  assert.match(presentTaskEndPatch(run).note, /boundary is unverified/);
  assert.doesNotMatch(presentTaskEndPatch(run).note, /after the process/);
  run.workspace.taskEnd.timing = 'after-process-fallback';
  assert.match(presentTaskEndPatch(run).note, /after the process ended/);
  run.workspace.taskEnd.patchContent.captureProvenance = 'verified-retained-artifact';
  assert.match(presentTaskEndPatch(run).note, /verified retained snapshot to this new report/);
});

test('package evidence reports changed safe-text tails beyond identical previews and retains unverified preview limits', () => {
  const source = (fingerprint, content, comparison = 'available') => ({ category: 'skill', name: 'package', scope: 'profile', path: `/profiles/${fingerprint}/skills/package`, status: 'present',
    comparison: comparison === 'available' ? 'available' : 'partial', detail: { status: 'partial', coverage: { comparison: comparison === 'available' ? 'complete' : 'partial', content: 'partial' },
      files: [{ path: 'large.txt', comparison, comparisonBasis: comparison === 'available' ? 'public-safe-text' : undefined,
        comparisonReason: comparison === 'available' ? undefined : 'report-budget-exceeded', fingerprint, status: 'partial', content, truncated: true, bytes: 70000, mode: 0o600 }] } });
  const left = source('left', 'same preview'), right = source('right', 'same preview');
  const changed = { ...right, left, right, detailDiff: compareAuditResourceDetails(left, right) };
  assert.ok(changed.detailDiff.hunks.some(hunk => hunk.kind === 'content-changed'));
  const value = { left: { profile: { profileName: 'A' } }, right: { profile: { profileName: 'B' } }, comparison: { resources: { changed: [changed] } } };
  const file = presentSkillPackage(value, 'package').files[0];
  assert.equal(file.label, 'different');
  assert.match(file.statement, /file contents differ/i);
  assert.doesNotMatch(file.statement, /permissions differ/);
  const unknownLeft = source('left', 'same preview', 'unknown'), unknownRight = source('right', 'same preview and extra', 'unknown');
  value.comparison.resources = { unavailable: [{ ...unknownRight, left: unknownLeft, right: unknownRight,
    detailDiff: compareAuditResourceDetails(unknownLeft, unknownRight) }] };
  const unknown = presentSkillPackage(value, 'package').files[0];
  assert.equal(unknown.label, 'cannot-compare');
  assert.match(unknown.statement, /Limited preview differences/);
});

test('matching previews do not override an explicit unknown full-file comparison', () => {
  const source = { category: 'skill', scope: 'profile', name: 'package', path: '/fixture', status: 'present', comparison: 'partial',
    detail: { status: 'partial', coverage: { comparison: 'partial', content: 'complete' }, files: [
      { path: 'SKILL.md', status: 'available', comparison: 'unknown', comparisonReason: 'report-budget-exceeded', content: 'same preview', mode: 0o600 },
    ] } };
  const value = { left: { profile: { profileName: 'A' } }, right: { profile: { profileName: 'B' } },
    comparison: { resources: { unavailable: [{ ...source, left: source, right: source }] } } };
  const file = presentSkillPackage(value, 'package').files[0];
  assert.equal(file.label, 'cannot-compare');
  assert.match(file.statement, /report-budget-exceeded/);
});

test('local source reading and displayed-value limits stay separate', () => {
  const omitted = { category: 'config', name: 'large_table', scope: 'profile', path: '/profile/config.toml', status: 'present', valueStatus: 'omitted',
    comparison: 'unverified-on-right', note: 'Source value exceeds the local comparison detail limit.' };
  const left = { profile: { profileName: 'Left' }, context: { includeSourceValues: true }, coverage: { config: 'complete', sourceValues: 'partial' } };
  const right = { profile: { profileName: 'Right' }, context: { includeSourceValues: true }, coverage: { config: 'complete', sourceValues: 'complete' } };
  const view = presentSetupComparison({ left, right, comparison: { resources: { unavailable: [omitted] } } });
  assert.match(view.items[0].detail.values[0].value, /local comparison detail limit/);
  assert.equal(view.limits.coverage.find(row => row.area === 'Profile config').a, 'Read in full');
  assert.deepEqual(view.limits.coverage.find(row => row.area === 'Displayed source values'),
    { area: 'Displayed source values', a: 'Some read values omitted (detail limit)', b: 'Included in full' });
});

test('unverified cache evidence neither claims absence nor a verified package and stays distinct without identity', () => {
  const entries = [
    { status: 'unsafe', name: 'review', path: '/a/cache/review', comparison: 'unverified-on-right' },
    { status: 'unsupported', name: 'review', path: '/b/cache/review', comparison: 'unverified-on-left' },
  ].map(item => ({ ...item, category: 'plugin', scope: 'plugin', sourceRole: 'plugin-cache' }));
  const value = { left: { profile: { profileName: 'Left' } }, right: { profile: { profileName: 'Right' } }, comparison: { resources: { unavailable: entries } } };
  const view = presentSetupComparison(value);
  assert.equal(view.items.length, 2, 'ambiguous cache names do not merge');
  assert.equal(new Set(view.items.map(item => item.id)).size, 2, 'each ambiguous location can be selected independently');
  for (const item of view.items) {
    assert.doesNotMatch(item.detail.values.map(box => box.value).join(' '), /cached package/);
    assert.match(item.detail.values.map(box => box.value).join(' '), /source location not verified/);
    const evidence = item.detail.evidence[0];
    assert.equal(evidence.name, 'Cache location (not verified)');
    assert.doesNotMatch(JSON.stringify(evidence.detail.values), /Not present/);
    assert.ok(evidence.detail.values.some(box => box.value === 'Not established from the sources read'));
  }
});

test('pairs files within each recorded workspace while retaining external paths and unknown sides', () => {
  const pair = bookingLedgerPair();
  for (const [index, run] of pair.entries()) {
    run.sourceWorkspace.directory = `/workspaces/${index}`;
    run.artifacts = [{ ...run.artifacts[0], path: `/workspaces/${index}/src/booking-ledger.js` },
      { ...run.artifacts[0], path: `/workspaces/${index}-other/src/booking-ledger.js` }];
  }
  const files = presentComparison(compareAuditRuns(...pair)).outcome.files;
  assert.deepEqual(files, [
    { path: '/workspaces/0-other/src/booking-ledger.js', a: 'Changed', b: 'Not recorded', category: 'observed' },
    { path: '/workspaces/1-other/src/booking-ledger.js', a: 'Not recorded', b: 'Changed', category: 'observed' },
    { path: 'src/booking-ledger.js', a: 'Changed', b: 'Changed', category: 'observed' },
  ]);
  assert.equal(pair[0].artifacts[0].path, '/workspaces/0/src/booking-ledger.js', 'presentation leaves retained evidence unchanged');
});

test('shows runner task wall time without substituting it for native recorded time', () => {
  const pair = bookingLedgerPair();
  pair[0].metrics.taskMs = 135160;
  pair[1].metrics.taskMs = 68328;
  const report = presentComparison(compareAuditRuns(...pair));
  assert.equal(report.timeTokens.rows.find(row => row.name === 'Recorded time span').a, 'Not recorded');
  assert.equal(report.timeTokens.rows.find(row => row.name === 'Runner task phase').scope.a, 'Runner task and capture phase');
  assert.deepEqual(report.timeTokens.rows.find(row => row.name === 'Runner task phase'), {
    name: 'Runner task phase', a: '2 min 15 s', b: '1 min 8 s',
    scope: { a: 'Runner task and capture phase', b: 'Runner task and capture phase' },
    caveat: 'Local wall time for the task and capture, including startup and shutdown. Excludes setup and verification checks; not active working time.',
  });
  delete pair[1].metrics.taskMs;
  assert.equal(presentComparison(compareAuditRuns(...pair)).timeTokens.rows.find(row => row.name === 'Runner task phase').b, 'Not recorded');
});

test('derives recorded time from exactly one replay root without summing children', () => {
  const pair = bookingLedgerPair();
  for (const run of pair) run.sessionReplay = { sessions: [
    { id: 'root', parentId: null, events: [{ timestamp: '2026-01-01T00:00:00Z' }, { timestamp: '2026-01-01T00:00:06Z' }] },
    { id: 'child', parentId: 'root', events: [{ timestamp: '2026-01-01T00:00:01Z' }, { timestamp: '2026-01-01T00:03:01Z' }] },
  ] };
  const row = presentComparison(compareAuditRuns(...pair)).timeTokens.rows.find(item => item.name === 'Recorded time span');
  assert.equal(row.a, '6 s');
  assert.equal(row.b, '6 s');
  assert.deepEqual(row.scope, { a: 'Root replay event timestamps', b: 'Root replay event timestamps' });
  assert.match(row.caveat, /root event; not active working time/i);

  pair[0].sessionReplay.sessions[0].events.push({ timestamp: null });
  pair[1].sessionReplay.sessions.push({ id: 'extra-root', parentId: null, events: [{ timestamp: '2026-01-01T00:00:00Z' }, { timestamp: '2026-01-01T00:00:06Z' }] });
  const rows = presentComparison(compareAuditRuns(...pair)).timeTokens.rows;
  const partial = rows.find(item => item.name === 'Recorded time span');
  assert.equal(partial.a, '6 s');
  assert.match(partial.caveat, /1 without timestamps/);
  assert.equal(partial.b, 'Not recorded');
  assert.match(partial.caveat, /root replay is ambiguous/);
});

test('keeps workflow token validation and observed turn controls scoped per side', () => {
  const pair = bookingLedgerPair();
  pair[0].usage.workflow = { status: 'unavailable', reason: 'accounting-contract-unverified' };
  pair[0].turns[0].model = 'model-a';
  pair[1].turns[0].model = 'model-b';
  pair[1].turns[0].reasoningEffort = 'low';
  const comparison = compareAuditRuns(...pair);
  comparison.comparison.explanation.conditions.userDeclaredVariables = ['Model'];
  const report = presentComparison(comparison);
  const workflow = report.timeTokens.rows.find(item => item.name === 'Total for the whole workflow');
  assert.equal(workflow.a, 'Not validated');
  assert.equal(workflow.scope.a, 'Whole workflow');
  assert.equal(workflow.b, 'Not validated');
  assert.equal(workflow.scope.b, 'Whole workflow');
  assert.match(workflow.caveat, /has not been validated/i);
  assert.match(workflow.caveat, /counters are not added/i);
  assert.equal(report.conditions.allRows.find(row => row.key === 'models').name, 'Model');
  assert.equal(report.conditions.allRows.find(row => row.key === 'reasoningEffort').name, 'Reasoning effort');
  assert.match(report.conditions.scopeNote, /Model and reasoning effort summarize recorded turns/i);
  assert.match(report.conditions.scopeNote, /root values are shown separately/i);
  assert.equal(report.conditions.rows.find(row => row.key === 'models').intent, 'intended');
  assert.equal(report.conditions.rows.find(row => row.key === 'reasoningEffort').intent, 'not-marked');
  assert.match(report.outcome.scopeNote, /only observed edit paths are listed/i);

  comparison.comparison.artifacts.snapshots.taskEnd.changes.status = 'known';
  assert.match(presentComparison(comparison).outcome.scopeNote, /only observed edit paths are listed/i);
});

test('task completion does not appear as an additional verification check', () => {
  const pair = bookingLedgerPair();
  for (const run of pair) run.task = { nativeTurnStatus: 'completed' };
  const checks = presentComparison(compareAuditRuns(...pair)).verification.cells[0].checks;
  assert.ok(checks.every(check => !/task as completed/i.test(check.text)));
});

test('replay root labels use saved actual root metadata and keep recorded requests separate', () => {
  const pair = bookingLedgerPair();
  pair[0].source = { threadId: pair[0].agents[0].id, model: 'gpt-6.1-sol', reasoningEffort: 'high' };
  pair[1].source = { threadId: pair[1].agents[0].id };
  pair[1].nativeControls = { schemaVersion: 1, configured: { model: 'gpt-6.1-sol', modelReasoningEffort: 'high' } };
  const context = presentComparison(compareAuditRuns(...pair)).replayRootContext;
  assert.deepEqual(context.a, { model: 'gpt-6.1-sol', effort: 'high', requestedModel: null, requestedEffort: null });
  assert.deepEqual(context.b, { model: 'Not recorded', effort: 'Not recorded', requestedModel: 'gpt-6.1-sol', requestedEffort: 'high' });

  const absent = bookingLedgerPair();
  absent[0].source = { threadId: absent[0].agents[0].id };
  absent[1].source = { threadId: absent[1].agents[0].id };
  const absentRequests = presentComparison(compareAuditRuns(...absent)).replayRootContext;
  assert.deepEqual(absentRequests.a, { model: 'Not recorded', effort: 'Not recorded', requestedModel: null, requestedEffort: null });
  assert.deepEqual(absentRequests.b, { model: 'Not recorded', effort: 'Not recorded', requestedModel: null, requestedEffort: null });
});

test('native root labels use the owned recorded setup without borrowing child settings or changing evidence', () => {
  const pair = bookingLedgerPair();
  const setup = { status: 'partial', source: 'native-turn-context', model: ['gpt-6.1-sol'], effort: ['low'], fullHistoricalSetup: 'unavailable' };
  for (const run of pair) {
    run.agents[0].role = 'primary';
    run.agents.push({ id: 'reviewer', parentId: run.agents[0].id, role: 'subagent', depth: 1,
      model: 'gpt-6-sol', reasoningEffort: 'high', source: { recordedSetup: { ...setup, model: ['gpt-6-sol'], effort: ['high'] } } });
    run.nativeControls = { configured: { model: 'requested-model', modelReasoningEffort: 'medium' } };
  }
  pair[0].agents[0].source.recordedSetup = setup;
  pair[1].source.recordedSetup = setup;
  const comparison = compareAuditRuns(...pair), before = structuredClone(comparison);
  const context = presentComparison(comparison).replayRootContext;
  for (const side of ['a', 'b']) assert.deepEqual(context[side], {
    model: 'gpt-6.1-sol', effort: 'low', requestedModel: null, requestedEffort: null,
  });
  assert.deepEqual(comparison, before, 'display leaves the frozen evidence unchanged');
});

test('native root labels retain multiple values and unknown ownership or unavailable settings', () => {
  const setup = { status: 'partial', source: 'native-turn-context', model: ['root-one', 'root-two'], effort: ['low', 'high'] };
  const cases = [
    { name: 'multiple recorded values', mutate() {}, model: 'Multiple recorded: root-one, root-two', effort: 'Multiple recorded: low, high' },
    { name: 'missing effort', mutate(run) { run.agents[0].source.recordedSetup.effort = []; }, model: 'Multiple recorded: root-one, root-two', effort: 'Not recorded' },
    { name: 'unavailable setup', mutate(run) { run.agents[0].source.recordedSetup.status = 'unavailable'; } },
    { name: 'unknown setup source', mutate(run) { run.agents[0].source.recordedSetup.source = 'unknown'; } },
    { name: 'mismatched root', mutate(run) { run.source.nativeSessionId = 'missing-root'; run.agents[0].role = 'root'; } },
    { name: 'duplicate root identity', mutate(run) { run.agents.push(structuredClone(run.agents[0])); } },
    { name: 'child cannot supply root settings', mutate(run) { run.agents[0].parentId = 'another-root'; } },
    { name: 'explicit actual metadata stays authoritative', mutate(run) { run.agents[0].model = 'explicit-root'; run.agents[0].reasoningEffort = 'medium'; }, model: 'explicit-root', effort: 'medium' },
  ];
  for (const entry of cases) {
    const pair = bookingLedgerPair();
    pair[0].agents[0].source.recordedSetup = structuredClone(setup);
    pair[0].nativeControls = { configured: { model: 'requested-model', modelReasoningEffort: 'high' } };
    entry.mutate(pair[0]);
    const context = presentComparison(compareAuditRuns(...pair)).replayRootContext.a;
    const model = entry.model ?? 'Not recorded', effort = entry.effort ?? 'Not recorded';
    assert.deepEqual(context, { model, effort, requestedModel: model === 'Not recorded' ? 'requested-model' : null,
      requestedEffort: effort === 'Not recorded' ? 'high' : null }, entry.name);
  }
});

test('a completed pathless file-change event does not claim a file changed', () => {
  const pair = bookingLedgerPair();
  for (const run of pair) {
    run.artifacts = [];
    run.toolInvocations = [{ agentId: run.agents[0].id, turnId: run.turns[0].turnId,
      kind: 'file-change', status: 'completed', sourceLine: 10, itemId: `edit-${run.id}` }];
  }
  const view = presentEvidence(compareAuditRuns(...pair));
  const steps = view.findings.flatMap(finding => finding.columns.flatMap(column => column.steps));
  assert.ok(steps.some(step => step.text === 'File-change event (file path not recorded)'));
  assert.ok(!steps.some(step => step.text === 'Changed a file (path not recorded)'));
});

test('attempt identity separates startup refusal from completed tasks with evidence gaps', () => {
  const pair = bookingLedgerPair();
  for (const run of pair) {
    run.turns = [];
    run.artifacts = [];
    run.checks = [];
    run.outcome = {};
    run.capture = { errors: [{ code: 'startup-command-sandbox-unavailable' }] };
  }
  const failed = presentComparison(compareAuditRuns(...pair));
  assert.equal(failed.attempt.title, 'Neither model task started');
  assert.ok(failed.attempt.cells.every(cell => cell.state === 'not-started'));
  assert.match(failed.attempt.text, /no model work to compare/);
  const completed = bookingLedgerPair();
  const report = presentComparison(compareAuditRuns(...completed));
  assert.equal(report.attempt.title, 'Both model tasks completed');
  assert.equal(report.attempt.notStarted, false);
  assert.equal(report.timeTokens.rows[0].a, 'Not recorded', 'completion does not fill native time');
  assert.deepEqual(presentRunExecution({}), { state: 'unknown', text: 'Task completion not recorded' });
  const conflicting = { source: { threadId: 'root' }, agents: [{ id: 'root', parentId: null }],
    turns: [{ agentId: 'root', turnId: 'turn-1', status: 'failed' }], task: { nativeTurnStatus: 'completed' } };
  assert.deepEqual(presentRunExecution(conflicting), { state: 'failed', text: 'Model task failed or stopped' },
    'validated failure takes precedence over contradictory raw completion');
});

test('token fields line up independently and preserve zero versus missing values', () => {
  const comparison = compareAuditRuns(...bookingLedgerPair());
  comparison.comparison.usage.left.values = { inputTokens: 0, cachedInputTokens: 253440, outputTokens: 4021 };
  comparison.comparison.usage.right.values = { inputTokens: 273334, outputTokens: 2477 };
  const rows = presentComparison(comparison).timeTokens.rows;
  const input = rows.find(row => row.name === 'Main-session input tokens');
  assert.equal(input.a, '0');
  assert.equal(input.b, '273,334');
  const cached = rows.find(row => row.name === 'Main-session cached input tokens');
  assert.equal(cached.a, '253,440');
  assert.equal(cached.b, 'Not recorded');
});

test('snapshot file counts and classified rows survive a source-free export and reopen', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { exportAuditReport, readAuditReport } = await import('../src/audit-store.js');
  const dir = await mkdtemp(join(tmpdir(), 'xfx-inventory-presentation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pair = bookingLedgerPair();
  const before = 'a'.repeat(64);
  const inventories = [
    [{ path: 'src/ledger.js', change: 'modified', origin: 'tracked' }],
    [{ path: 'src/ledger.js', change: 'modified', origin: 'tracked' }, { path: 'test-results/error.txt', change: 'added', origin: 'ignored' }],
  ];
  pair.forEach((run, index) => {
    const fingerprint = String(index + 1).repeat(64);
    run.workspace.taskEnd = { fingerprint, baselineFingerprint: before, fileCount: index + 1,
      changedFileCount: index + 1, changeCountStatus: 'known', changeCountBasis: 'post-setup-snapshot-delta-v1',
      captureComplete: true, timing: 'task-end', path: '/does-not-exist/task-end.patch',
      changeInventory: { schemaVersion: 1, status: 'recorded', basis: 'post-setup-snapshot-delta-v1',
        fingerprints: { postSetup: before, taskEnd: fingerprint }, entries: inventories[index],
        counts: { tracked: 1, ignored: index, total: index + 1 }, reason: null } };
  });
  const original = compareAuditRuns(...pair);
  const beforeView = presentComparison(original);
  assert.deepEqual(beforeView.outcome.files, [
    { path: 'src/ledger.js', a: 'Changed', b: 'Changed', category: 'tracked' },
    { path: 'test-results/error.txt', a: 'Not changed', b: 'Added', category: 'ignored' },
  ]);
  assert.match(beforeView.outcome.cells[1], /1 tracked file · 1 ignored file or artifact/);
  assert.match(beforeView.outcome.scopeNote, /same post-setup to task-end snapshot inventory/);
  assert.ok(beforeView.limits.every(item => !/behaviors? that the recorded actions/.test(item)));
  const output = join(dir, 'report.json');
  await exportAuditReport(original, { output });
  const afterView = presentComparison(await readAuditReport(output));
  assert.deepEqual(afterView.outcome, beforeView.outcome);
});
