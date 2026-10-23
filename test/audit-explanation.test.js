import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';
import { buildAuditExplanation, freezeAuditComparisonEvidence, canonicalAuditChecks } from '../src/audit-explanation.js';
import { compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const headings = ['Comparison conditions', 'Behavioral findings', 'Paired action evidence', 'Verification', 'Time and tokens', 'Outcome and code changes'];
const scope = explanation => explanation.findings.find(row => row.rule === 'editable-file-boundary');

test('missing selected arms retain pair accounting through rendering and source-free reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-m1-missing-pair-'));
  try {
    for (const missingSide of [0, 1]) {
      const pair = bookingLedgerPair(); pair[missingSide] = null;
      const expected = buildAuditExplanation(...pair), report = compareAuditRuns(...pair);
      assert.deepEqual(report.comparison.explanation, expected);
      assert.equal(expected.consistency.observedPairs, 0);
      assert.equal(expected.consistency.missingPairs, 1);
      assert.equal(expected.conditions.evidenceKinds[missingSide ? 'right' : 'left'], 'unavailable');
      for (const finding of expected.findings) {
        assert.equal(finding.pairs.observed, 0); assert.equal(finding.pairs.missing, 1);
      }
      const compact = compactAuditTrial({ runs: [report.left, report.right] });
      assert.deepEqual(compareAuditRuns(...compact.runs).comparison.explanation, expected);
      const exported = await exportAuditReport(report, { output: join(directory, `${missingSide}.md`), format: 'markdown' });
      const reopened = await readAuditReport(exported.evidencePath);
      assert.deepEqual(reopened.comparison.explanation, expected);
      assert.equal(renderAudit(reopened), renderAudit(report));
    }
    const pair = bookingLedgerPair(); pair[0].status = 'not-started';
    assert.equal(buildAuditExplanation(...pair).conditions.eligible, false);
    assert.equal(buildAuditExplanation(...pair).consistency.missingPairs, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('booking-ledger scope difference has paired owned references and distinct outcome classes', () => {
  const [left, right] = bookingLedgerPair(), report = compareAuditRuns(left, right), explanation = report.comparison.explanation;
  assert.equal(explanation.conditions.eligible, true);
  assert.equal(scope(explanation).classification, 'different');
  for (const side of ['left', 'right']) {
    assert.equal(scope(explanation)[side].evidenceRefs.length, 1);
    for (const ref of scope(explanation)[side].evidenceRefs) {
      const action = explanation.evidence[side].find(row => row.id === ref);
      assert.ok(action); assert.equal(action.actorState, 'owned'); assert.ok(action.agentId); assert.ok(action.sourceLine);
    }
    assert.equal(explanation.verification[side].agentClaim.success, true);
    assert.equal(explanation.verification[side].nativeCompletion, 'completed');
    assert.equal(explanation.verification[side].human.status, 'not-recorded');
  }
  assert.equal(explanation.outcomes.criteria[0].advantage, 'left');
  assert.equal(explanation.consistency.status, 'unmeasured');
  assert.equal(explanation.findings.find(row => row.rule === 'agent-verification').classification, 'inconclusive');
  for (const format of ['terminal', 'markdown']) {
    const text = renderAudit(report, { format });
    const positions = headings.map(title => text.indexOf(format === 'markdown' ? `## ${title}\n` : `${title}\n`));
    assert.ok(positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])));
    assert.match(text, /synthetic/); assert.match(text, /Recorded an edit outside the declared file boundary/);
  }
});

test('similar, missing, unknown and incompatible findings preserve observed sides without false absence', () => {
  const [left, right] = bookingLedgerPair();
  right.artifacts[0].path = left.artifacts[0].path;
  assert.equal(scope(buildAuditExplanation(left, right)).classification, 'similar');
  right.artifacts = []; right.coverage.workspaceDiff = 'partial';
  let finding = scope(buildAuditExplanation(left, right));
  assert.equal(finding.classification, 'inconclusive'); assert.equal(finding.right.assertion, 'edit-scope-unknown');
  assert.equal(finding.right.state, 'partial'); assert.equal(finding.left.evidenceRefs.length, 1);
  for (const coverage of ['unknown', 'unavailable', 'not-found', 'none-recorded']) {
    right.coverage.workspaceDiff = coverage;
    finding = scope(buildAuditExplanation(left, right));
    assert.equal(finding.right.state, coverage); assert.equal(finding.classification, coverage === 'none-recorded' ? 'different' : 'inconclusive');
  }
  const conflictingTask = bookingLedgerPair(); conflictingTask[1].comparisonConditions.taskFingerprint = 'f'.repeat(64);
  let report = compareAuditRuns(...conflictingTask);
  assert.equal(report.comparison.explanation.conditions.sameTaskEligible, false);
  assert.equal(report.comparison.metrics.taskMs.delta, null); assert.equal(scope(report.comparison.explanation).classification, 'different');
  const changedBaseline = bookingLedgerPair(); changedBaseline[1].sourceWorkspace.sourceTree = 'different-tree';
  report = compareAuditRuns(...changedBaseline);
  assert.equal(report.comparison.explanation.conditions.sameTaskEligible, true);
  assert.equal(report.comparison.explanation.conditions.codeComparable, false);
  assert.equal(report.comparison.metrics.taskMs.delta, 25); assert.equal(scope(report.comparison.explanation).classification, 'different');
  assert.equal(report.comparison.metrics.taskMs.left, 100); assert.equal(report.comparison.metrics.taskMs.right, 125);
  for (const change of [r => { r.turns[0].model = 'other-model'; }, r => { r.source.clientVersion = 'different-native'; }, r => { r.turns[0].reasoningEffort = null; }]) {
    const pair = bookingLedgerPair(); change(pair[1]); const report = compareAuditRuns(...pair);
    assert.equal(report.comparison.explanation.conditions.behaviorEligible, true);
    assert.equal(report.comparison.explanation.conditions.sameTaskEligible, true);
    assert.equal(report.comparison.metrics.taskMs.delta, 25);
    assert.equal(scope(report.comparison.explanation).eligibility.sameTaskEligible, true);
  }
});

test('same-source read/edit order is scoped and never aligned across unrelated actors or clocks', () => {
  const pair = bookingLedgerPair();
  for (const [index, run] of pair.entries()) run.events = [{ kind: 'command-execution', agentId: run.agents[0].id,
    turnId: run.turns[0].turnId, sourceLine: index ? 18 : 4, recordedAt: index ? 0 : 9999999, metadata: { operation: 'read', status: 'completed' } }];
  const find = () => buildAuditExplanation(...pair).findings.find(row => row.rule === 'read-edit-sequence');
  assert.equal(find().classification, 'different'); assert.equal(find().left.assertion, 'read-before-recorded-edit');
  assert.equal(find().right.assertion, 'read-after-recorded-edit'); assert.equal(find().left.target, 'unknown');
  pair[1].events[0].agentId = 'unowned-actor';
  assert.equal(find().classification, 'inconclusive');
  assert.equal(find().right.assertion, 'read-edit-order-unknown');
});

test('canonical checks preserve conflicts idempotently and do not replace agent behavior with checker outcomes', () => {
  const [left, right] = bookingLedgerPair();
  left.outcome.checks = left.checks; delete left.checks;
  const compact = compactAuditTrial({ runs: [left, right] });
  assert.equal(compact.runs[0].checks[0].status, 'passed');
  right.outcome.checks = [{ name: 'scope', status: 'passed', exitCode: 0 }];
  const checks = canonicalAuditChecks(right);
  assert.equal(checks[0].status, 'unknown'); assert.equal(checks[0].exitCode, null);
  assert.deepEqual(canonicalAuditChecks({ checks }), checks);
  assert.equal(buildAuditExplanation(left, right).outcomes.criteria[0].advantage, null);
});

test('comparison support is private-payload-free, capped, owned, bound and stable under ordinary compaction', () => {
  const [left, right] = bookingLedgerPair();
  left.prompt = 'PRIVATE_PROMPT'; left.events = [{ kind: 'tool-call', arguments: 'PRIVATE_ARGS', result: 'PRIVATE_RESULT' }];
  left.review = { rationale: 'PRIVATE_REVIEW', reviewer: 'private@example.test' };
  left.sourceWorkspace.directory = '/private/PRIVATE_WORKSPACE'; left.account = 'PRIVATE_ACCOUNT';
  const core = freezeAuditComparisonEvidence(left);
  assert.doesNotMatch(JSON.stringify(core), /PRIVATE_|private@example/);
  const original = buildAuditExplanation(left, right);
  const compact = compactAuditTrial({ runs: [left, right] });
  assert.deepEqual(buildAuditExplanation(...compact.runs), original);
  for (const change of [r => { r.id = 'other-run'; }, r => { r.source.fingerprint = 'f'.repeat(64); }, r => { r.profile.profileId = 'other-profile'; },
    r => { r.comparisonConditions.taskFingerprint = 'f'.repeat(64); }]) {
    const run = structuredClone(left); run.comparisonEvidence = core; change(run);
    assert.equal(freezeAuditComparisonEvidence(run).status, 'unavailable');
  }
  const capped = structuredClone(left);
  capped.artifacts = Array.from({ length: 300 }, (_, i) => ({ ...left.artifacts[0], sourceLine: i + 1 }));
  const report = buildAuditExplanation(capped, right);
  assert.equal(report.evidence.left.length, 256); assert.equal(scope(report).left.omissions.actions, 44);
  assert.ok(scope(report).left.evidenceRefs.every(ref => report.evidence.left.some(row => row.id === ref)));
});

test('complete synthetic report path preserves claims through compact export, sidecars and source-free CLI', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-m1-offline-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = bookingLedgerPair(), expected = compareAuditRuns(...pair).comparison.explanation;
  const sourceHome = join(directory, 'source-home'); await mkdir(sourceHome); await writeFile(join(sourceHome, 'not-read'), 'PRIVATE_SOURCE');
  const compact = compactAuditTrial({ runs: pair });
  const paths = [];
  for (const [i, run] of compact.runs.entries()) {
    const output = join(directory, `run-${i}.json`); paths.push(output);
    await exportAuditReport({ ...run, schemaVersion: 1, kind: 'audit-run' }, { output });
  }
  await rm(sourceHome, { recursive: true });
  const cli = fileURLToPath(new URL('../bin/xfx.js', import.meta.url));
  const invoke = args => {
    const result = spawnSync(process.execPath, [cli, '--store', join(directory, 'empty-store'), '--json', 'audit', ...args], {
      env: { ...process.env, HOME: directory, CODEX_HOME: sourceHome, XFX_NATIVE_PROFILE_OPEN: '0' }, encoding: 'utf8' });
    assert.ifError(result.error); assert.ok([0, 2].includes(result.status), result.stderr); return JSON.parse(result.stdout);
  };
  const diff = invoke(['diff', ...paths]); assert.deepEqual(diff.comparison.explanation, expected);
  const comparisonPath = join(directory, 'comparison.json');
  await exportAuditReport(diff, { output: comparisonPath });
  assert.deepEqual(invoke(['show', comparisonPath]).comparison.explanation, expected);
  const markdownPath = join(directory, 'comparison.md');
  const receipt = invoke(['export', comparisonPath, '--format', 'markdown', '--output', markdownPath]);
  assert.deepEqual((await readAuditReport(receipt.evidencePath)).comparison.explanation, expected);
  const markdown = await readFile(markdownPath, 'utf8');
  assert.ok(headings.every(title => markdown.includes(`## ${title}\n`)));
  assert.ok(scope(expected).left.evidenceRefs.every(ref => markdown.replace(/\\([\\`*_{}\[\]()#+.!|>~-])/g, '$1').includes(ref)));
});


test('counterexample controls reject capped similarity, unbound outcomes and self-consistent private core payloads', () => {
  const pair = bookingLedgerPair(); pair[1].artifacts[0].path = pair[0].artifacts[0].path;
  for (const run of pair) run.artifacts = Array.from({ length: 256 }, (_, i) => ({ ...run.artifacts[0], sourceLine: i + 1 }));
  pair[1].artifacts.push({ ...pair[1].artifacts[0], sourceLine: 257, path: 'test/visible.test.js' });
  assert.equal(scope(buildAuditExplanation(...pair)).classification, 'inconclusive');
  const [left, right] = bookingLedgerPair();
  left.checks.push({ name: 'undeclared', status: 'passed', exitCode: 0 }); right.checks.push({ name: 'undeclared', status: 'failed', exitCode: 1 });
  assert.equal(buildAuditExplanation(left, right).outcomes.criteria.find(row => row.criterion === 'undeclared').advantage, null);
  left.checks[0].exitCode = 1;
  assert.equal(canonicalAuditChecks(left)[0].status, 'unknown');
  assert.equal(buildAuditExplanation(left, right).outcomes.criteria[0].advantage, null);
  const core = freezeAuditComparisonEvidence(right);
  const forged = structuredClone(core); forged.privatePayload = 'PRIVATE_PAYLOAD';
  const seal = payload => { delete payload.fingerprint; payload.fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex'); };
  seal(forged); assert.equal(freezeAuditComparisonEvidence({ ...right, comparisonEvidence: forged }).status, 'unavailable');
  const badTurn = structuredClone(core); badTurn.actions[0].turnId = 'nonexistent-turn';
  const { id, ...action } = badTurn.actions[0];
  badTurn.actions[0].id = 'action-' + createHash('sha256').update(JSON.stringify([badTurn.binding.runId, action])).digest('hex').slice(0, 24);
  seal(badTurn); assert.equal(freezeAuditComparisonEvidence({ ...right, comparisonEvidence: badTurn }).status, 'unavailable');
  const changed = { ...right, comparisonEvidence: core, turns: [{ ...right.turns[0], model: 'changed-model' }] };
  assert.equal(freezeAuditComparisonEvidence(changed).reason, 'observed-control-binding-mismatch');
});

test('complete-empty capture is scoped none-recorded; incompatible token domains never yield a generic delta', () => {
  const pair = bookingLedgerPair();
  for (const run of pair) { run.artifacts = []; run.coverage.workspaceDiff = 'complete'; }
  const finding = scope(buildAuditExplanation(...pair));
  assert.equal(finding.left.state, 'none-recorded'); assert.equal(finding.left.assertion, 'no-file-change-records');
  assert.equal(finding.classification, 'similar');
  pair[0].usage = { totals: { scope: 'root-agent-source-reported', values: { inputTokens: 100 } } };
  pair[1].usage = { totals: { scope: 'captured-workflow-agents', values: { inputTokens: 80 } } };
  const comparison = compareAuditRuns(...pair).comparison;
  assert.equal(comparison.metrics.inputTokens.delta, null);
  assert.equal(comparison.metrics.inputTokens.reason, 'token-accounting-domain-unverified');
  assert.equal(comparison.usage.deltas.inputTokens.delta, null);
});


test('nested payloads, actor roles and changed retained completion evidence cannot survive a sealed core', () => {
  const [run] = bookingLedgerPair();
  const frozen = freezeAuditComparisonEvidence(run);
  const seal = core => { delete core.fingerprint; core.fingerprint = createHash('sha256').update(JSON.stringify(core)).digest('hex'); };
  const nested = structuredClone(frozen); nested.verification.checks[0].evidenceRefs.push({ rawPrompt: 'PRIVATE_PROMPT_SENTINEL' }); seal(nested);
  assert.equal(freezeAuditComparisonEvidence({ ...run, comparisonEvidence: nested }).status, 'unavailable');
  const role = structuredClone(frozen); role.actions[0].role = 'owned-child';
  const { id, ...content } = role.actions[0];
  role.actions[0].id = 'action-' + createHash('sha256').update(JSON.stringify([role.binding.runId, content])).digest('hex').slice(0, 24); seal(role);
  assert.equal(freezeAuditComparisonEvidence({ ...run, comparisonEvidence: role }).status, 'unavailable');
  for (const change of [value => { value.turns[0].status = 'failed'; }, value => { value.outcome.claim.turnId = 'other-turn'; },
    value => { value.execution.exitCode = 1; }, value => { value.checks[0].status = 'failed'; value.checks[0].exitCode = 1; }]) {
    const altered = structuredClone(run); altered.comparisonEvidence = frozen; change(altered);
    assert.equal(freezeAuditComparisonEvidence(altered).status, 'unavailable');
  }
});


test('task association, check recipe, and code baseline qualify only the claims that depend on them', () => {
  const pair = bookingLedgerPair(); pair[1].comparisonConditions.editableFiles = ['src/other.js'];
  assert.equal(compareAuditRuns(...pair).comparison.metrics.taskMs.delta, 25);
  pair[1].comparisonConditions.checkRecipes[0].fingerprint = 'f'.repeat(64);
  const changedCheck = compareAuditRuns(...pair).comparison.explanation.conditions;
  assert.equal(changedCheck.sameTaskEligible, true);
  assert.equal(changedCheck.checksEligible, false);
  assert.equal(changedCheck.metricEligibility.checksMs.eligible, false);
  const unknown = bookingLedgerPair(); unknown[1].comparisonConditions.selectedSkills = null;
  const explanation = buildAuditExplanation(...unknown);
  assert.equal(explanation.conditions.behaviorEligible, true);
  assert.equal(explanation.conditions.sameTaskEligible, true);
  assert.deepEqual(buildAuditExplanation(...compactAuditTrial({ runs: unknown }).runs), explanation);
});

test('direct-session association is explicit, task conflicts cannot be overridden, and unknown identity limits only dependent claims', () => {
  const pair = bookingLedgerPair();
  delete pair[0].comparisonConditions.taskFingerprint; delete pair[1].comparisonConditions.taskFingerprint;
  let explanation = buildAuditExplanation(...pair);
  assert.equal(explanation.conditions.behaviorEligible, true);
  assert.equal(explanation.conditions.sameTaskEligible, false);
  assert.equal(explanation.conditions.taskAssociation.status, 'unknown');
  assert.notEqual(scope(explanation).classification, 'inconclusive');
  assert.equal(explanation.consistency.eligiblePairs, 0);
  explanation = buildAuditExplanation(...pair, { taskAssociation: { status: 'user-declared', taskId: 'booking-task' },
    declaredVariables: ['different reasoning', 'PRIVATE/invalid'] });
  assert.equal(explanation.conditions.sameTaskEligible, true);
  assert.equal(explanation.conditions.taskAssociation.source, 'user-declaration');
  assert.deepEqual(explanation.conditions.userDeclaredVariables, ['different reasoning']);
  assert.equal(explanation.consistency.eligiblePairs, 1);

  const conflict = bookingLedgerPair(); conflict[1].comparisonConditions.taskFingerprint = 'f'.repeat(64);
  explanation = buildAuditExplanation(...conflict, { taskAssociation: { status: 'user-declared', taskId: 'booking-task' } });
  assert.equal(explanation.conditions.taskAssociation.status, 'contradictory');
  assert.equal(explanation.conditions.sameTaskEligible, false);
  assert.ok(explanation.conditions.reasons.includes('recorded-task-fingerprints-differ'));
  assert.notEqual(scope(explanation).classification, 'inconclusive');
});

test('setup failures and unavailable history selections cannot become task evidence through IDs or declarations', () => {
  const setupFailure = bookingLedgerPair();
  for (const run of setupFailure) {
    run.status = 'failed'; run.phase = 'setup'; run.turns = []; run.agents = []; run.events = [];
    run.actions = []; run.namedActions = []; run.artifacts = []; run.toolInvocations = [];
  }
  let explanation = buildAuditExplanation(...setupFailure);
  assert.equal(explanation.conditions.behaviorEligible, false);
  assert.equal(explanation.conditions.sameTaskEligible, false);
  assert.equal(explanation.conditions.checksEligible, false);
  assert.equal(explanation.consistency.observedPairs, 0);
  assert.ok(explanation.conditions.reasons.includes('left-task-not-started'));
  assert.ok(explanation.findings.every(row => row.classification === 'inconclusive'));
  assert.deepEqual(buildAuditExplanation(...compactAuditTrial({ runs: setupFailure }).runs), explanation);

  const unavailable = bookingLedgerPair();
  for (const run of unavailable) {
    run.status = 'unavailable'; run.turns = []; run.agents = []; run.events = []; run.actions = [];
    run.namedActions = []; run.artifacts = []; run.toolInvocations = [];
    run.source = { kind: 'native-rollout', nativeSessionId: run.source.nativeSessionId, recordCount: 0 };
  }
  explanation = buildAuditExplanation(...unavailable, { taskAssociation: { status: 'user-declared', taskId: 'booking-task' } });
  assert.equal(explanation.conditions.behaviorEligible, false);
  assert.equal(explanation.conditions.sameTaskEligible, false);
  assert.deepEqual(explanation.conditions.evidenceKinds, { left: 'unavailable', right: 'unavailable' });

  const minimalSession = bookingLedgerPair();
  for (const run of minimalSession) {
    run.status = 'partial'; run.turns = []; run.agents = []; run.events = []; run.actions = [];
    run.namedActions = []; run.artifacts = []; run.toolInvocations = [];
    run.source = { kind: 'native-rollout', nativeSessionId: run.source.nativeSessionId, recordCount: 2, fingerprint: 'a'.repeat(64) };
  }
  minimalSession[0].source.recordCount = 1; // A parseable header alone does not show that a turn began.
  explanation = buildAuditExplanation(...minimalSession);
  assert.equal(explanation.conditions.behaviorEligible, false);
  assert.equal(explanation.conditions.taskAssociation.status, 'recorded');

  for (const [index, run] of minimalSession.entries()) {
    const agentId = `direct-root-${index}`;
    run.agents = [{ id: agentId, parentId: null }];
    run.turns = [{ agentId, turnId: `direct-turn-${index}`, status: 'in-progress' }];
  }
  explanation = buildAuditExplanation(...minimalSession);
  assert.equal(explanation.conditions.behaviorEligible, true);
  assert.equal(explanation.conditions.sameTaskEligible, true);
});

test('source-free frozen evidence retains task-start proof after raw turn and action rows are removed', () => {
  const pair = bookingLedgerPair();
  const expected = buildAuditExplanation(...pair);
  const compacted = pair.map(run => {
    const frozen = freezeAuditComparisonEvidence(run);
    return { ...run, comparisonEvidence: frozen, turns: [], agents: [], actions: [], namedActions: [],
      events: [], artifacts: [], toolInvocations: [], task: undefined, outcome: undefined };
  });
  const reopened = buildAuditExplanation(...compacted);
  assert.equal(reopened.conditions.behaviorEligible, true);
  assert.equal(reopened.conditions.sameTaskEligible, true);
  assert.deepEqual(reopened, expected);
});


test('compacted primary report retains the same completion claims and supported elapsed measurements', () => {
  const pair = bookingLedgerPair(); pair[0].metrics.elapsedMs = 1000; pair[1].metrics.elapsedMs = 1100;
  const full = compareAuditRuns(...pair);
  const compact = compareAuditRuns(...compactAuditTrial({ runs: [full.left, full.right] }).runs);
  assert.deepEqual(compact.comparison.outcomes, full.comparison.outcomes);
  assert.deepEqual(compact.comparison.metrics.elapsedMs, full.comparison.metrics.elapsedMs);
  assert.deepEqual(compact.comparison.explanation, full.comparison.explanation);
});
