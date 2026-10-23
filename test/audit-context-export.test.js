import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { instructionReferenceId, projectInstructionSources } from '../src/audit-instructions.js';
import { evaluateCaptureRequirements } from '../src/audit-evidence.js';

const requirement = { agents: 'all', origin: 'repository', path: 'docs/AGENTS.md' };
const ref = instructionReferenceId(requirement.origin, requirement.path);
function run(status = 'passed') {
  const actor = (agentId, phase, source, reason = null) => ({ agentId, phase, source, referenceId: ref, reason,
    // These fields must never enter the bounded/offline report.
    content: 'PRIVATE_SOURCE_BYTES', absolutePath: '/private/secret/AGENTS.md' });
  const check = { id: 'context:0', status, reason: status === 'passed' ? null : 'required-context-not-observed', selector: requirement,
    checks: [actor('root', 'before-task', 'thread/start'), actor('child', 'after-task', 'thread/resume-loaded', status === 'passed' ? null : 'required-context-not-observed')] };
  return { id: `context-${status}`, profileName: 'A', source: { threadId: 'root', version: '0.163.0-alpha.10.2', kind: 'native-app-server-v2' },
    agents: [{ id: 'root', parentId: null }, { id: 'child', parentId: 'root' }],
    captureAcceptance: { schemaVersion: 1, mode: 'declared-observations', status, requirements: { minAgents: 1, context: [requirement] },
      checks: [check], exhaustiveConsumption: false } };
}

test('bounded context acceptance survives offline JSON and Markdown export/reopen', async t => {
  const passing = compactAuditTrial({ runs: [run()] }).runs[0];
  const failed = compactAuditTrial({ runs: [run('failed')] }).runs[0];
  assert.equal(passing.captureAcceptance.requirements.context[0].path, requirement.path);
  assert.equal(passing.captureAcceptance.checks[0].status, 'passed');
  assert.deepEqual(passing.captureAcceptance.checks[0].checks.map(row => [row.agentId, row.phase, row.referenceId]), [
    ['root', 'before-task', ref], ['child', 'after-task', ref],
  ]);
  assert.equal(failed.captureAcceptance.checks[0].status, 'failed');
  assert.equal(failed.captureAcceptance.checks[0].checks[1].reason, 'required-context-not-observed');
  const encoded = JSON.stringify(passing);
  assert.doesNotMatch(encoded, /PRIVATE_SOURCE_BYTES|\/private\/secret/);
  const markdown = renderAudit(passing, { format: 'markdown' });
  assert.match(markdown, /Context context:0/);
  assert.ok(markdown.includes(ref));
  assert.match(markdown, /does not prove instructions were followed or activate trust/);
  assert.doesNotMatch(markdown, /PRIVATE_SOURCE_BYTES|\/private\/secret/);

  const dir = await mkdtemp(join(tmpdir(), 'xfx-context-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const format of ['json', 'markdown']) {
    const output = join(dir, `run.${format === 'json' ? 'json' : 'md'}`);
    const receipt = await exportAuditReport({ ...passing, schemaVersion: 1, kind: 'audit-run' }, { format, output });
    const reopened = await readAuditReport(receipt.evidencePath);
    assert.deepEqual(reopened.captureAcceptance.requirements.context, passing.captureAcceptance.requirements.context);
    assert.deepEqual(reopened.captureAcceptance.checks[0].checks, passing.captureAcceptance.checks[0].checks);
  }
});

test('malformed context selectors cannot be compacted into a passed acceptance check', () => {
  const value = run();
  value.captureAcceptance.requirements.context[0] = { ...requirement, path: '../outside/AGENTS.md' };
  const compact = compactAuditTrial({ runs: [value] }).runs[0].captureAcceptance;
  assert.equal(compact.contextStatus, 'failed');
  assert.equal(compact.checks[0].status, 'failed');
  assert.equal(compact.checks[0].selector, undefined);
});

test('actor evidence trimmed by its bound is marked omitted and cannot remain passed', () => {
  const value = run();
  value.captureAcceptance.checks[0].checks = Array.from({ length: 161 }, (_, index) => ({ agentId: `agent-${index}`,
    phase: 'after-task', source: 'thread/resume-loaded', referenceId: ref, reason: null }));
  const compact = compactAuditTrial({ runs: [value] }).runs[0].captureAcceptance;
  assert.equal(compact.status, 'failed');
  assert.equal(compact.contextStatus, 'failed');
  assert.equal(compact.contextOmittedChecks, 1);
  assert.equal(compact.checks[0].status, 'failed');
  assert.equal(compact.checks[0].checksOmitted, 1);
});

test('duplicate and sparse context check IDs cannot compact as passed or attach evidence to the wrong selector', () => {
  for (const ids of [['context:0', 'context:0'], ['context:1']]) {
    const value = run();
    value.captureAcceptance.requirements.context = [requirement, { ...requirement, path: 'docs/other.md' }];
    value.captureAcceptance.checks = ids.map(id => ({ ...value.captureAcceptance.checks[0], id,
      status: 'passed', reason: null, selector: requirement }));
    value.captureAcceptance.status = 'passed';
    const compact = compactAuditTrial({ runs: [value] }).runs[0].captureAcceptance;
    assert.equal(compact.status, 'failed');
    assert.equal(compact.contextStatus, 'failed');
    assert.ok(compact.checks.every(check => check.status === 'failed'));
    assert.notEqual(compact.checks[0]?.selector?.path, 'docs/other.md');
  }
});

test('context subset status is independent of unrelated acceptance failures and preserves mixed context results on export', async t => {
  const unrelated = run();
  unrelated.captureAcceptance.status = 'failed';
  unrelated.captureAcceptance.checks.push({ id: 'tools:0', status: 'failed', reason: 'required-tool-not-observed',
    selector: { kind: 'command', min: 1 } });
  const compactUnrelated = compactAuditTrial({ runs: [unrelated] }).runs[0].captureAcceptance;
  assert.equal(compactUnrelated.status, 'failed');
  assert.equal(compactUnrelated.contextStatus, 'passed');
  assert.equal(compactUnrelated.checks[0].status, 'passed');

  const mixed = run();
  const failedRequirement = { ...requirement, path: 'docs/other.md' };
  const failedRef = instructionReferenceId(failedRequirement.origin, failedRequirement.path);
  mixed.captureAcceptance.status = 'failed';
  mixed.captureAcceptance.requirements.context.push(failedRequirement);
  mixed.captureAcceptance.checks.push({ id: 'context:1', status: 'failed', reason: 'required-context-not-observed', selector: failedRequirement,
    checks: [{ agentId: 'root', referenceId: failedRef, phase: 'before-task', source: 'thread/start', reason: 'required-context-not-observed' }] });
  const compactMixed = compactAuditTrial({ runs: [mixed] }).runs[0];
  assert.equal(compactMixed.captureAcceptance.contextStatus, 'failed');
  assert.deepEqual(compactMixed.captureAcceptance.checks.filter(check => check.id.startsWith('context:')).map(check => [check.status, check.reason]), [
    ['passed', null], ['failed', 'required-context-not-observed'],
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'xfx-context-mixed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receipt = await exportAuditReport({ ...compactMixed, schemaVersion: 1, kind: 'audit-run' }, { format: 'json', output: join(dir, 'run.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened.captureAcceptance.checks.filter(check => check.id.startsWith('context:')).map(check => [check.status, check.reason]), [
    ['passed', null], ['failed', 'required-context-not-observed'],
  ]);
});


test('distinct descendant source references cannot substitute for another actor through compact export', async t => {
  // Reconstructed loaded-source fixture; this does not establish native spawn cwd support.
  const workspace = '/private/context-fixture';
  const actors = [{ id: 'root', parentId: null }, { id: 'child', parentId: 'root' }, { id: 'grandchild', parentId: 'child' }];
  const paths = ['AGENTS.md', 'child/AGENTS.md', 'child/grandchild/AGENTS.md'];
  const value = { schemaVersion: 1, kind: 'audit-run', id: 'distinct-context', status: 'partial',
    source: { kind: 'native-app-server-v2', threadId: 'root', version: '0.163.0-alpha.10.2' }, agents: actors,
    coverage: { agents: 'complete', instructions: 'observed' }, instructionSources: actors.map((actor, index) =>
      projectInstructionSources(paths.slice(0, index + 1).map(path => `${workspace}/${path}`), {
        agentId: actor.id, workspace, source: index ? 'thread/resume-loaded' : 'thread/start',
        phase: index ? 'after-task' : 'before-task', sourceLine: index + 1 })) };
  const requirements = { context: [{ agents: 'all', origin: 'repository', path: paths[0] },
    { agents: 'descendants', origin: 'repository', path: paths[2] }] };
  value.captureAcceptance = evaluateCaptureRequirements(value, requirements);
  const expected = [[null, null, null], ['required-context-not-observed', null]];
  assert.deepEqual(value.captureAcceptance.checks.filter(c => c.id.startsWith('context:')).map(c => c.checks.map(a => a.reason)), expected);
  const compact = compactAuditTrial({ runs: [value] }).runs[0];
  const dir = await mkdtemp(join(tmpdir(), 'xfx-distinct-context-export-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const format of ['json', 'markdown']) {
    const exported = await exportAuditReport({ ...compact, schemaVersion: 1, kind: 'audit-run' }, { output: join(dir, `run.${format}`), format });
    const reopened = await readAuditReport(exported.evidencePath);
    assert.equal(reopened.captureAcceptance.contextStatus, 'failed');
    assert.deepEqual(reopened.captureAcceptance.checks.filter(c => c.id.startsWith('context:')).map(c => c.checks.map(a => a.reason)), expected);
    assert.deepEqual(evaluateCaptureRequirements(reopened, requirements).checks.filter(c => c.id.startsWith('context:')).map(c => c.checks.map(a => a.reason)), expected);
    assert.deepEqual(reopened.instructionSources.map(row => row.agentId), actors.map(actor => actor.id));
    assert.doesNotMatch(JSON.stringify(reopened), /private\/context-fixture/);
  }
});
