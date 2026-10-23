import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { auditCommand } from '../src/audit.js';
import { renderAudit } from '../src/audit-report.js';
import { readAuditReport, exportAuditReport } from '../src/audit-store.js';
import { createExperiment, createExperimentRun, finalizeAuditRecord } from '../src/audit-experiment-store.js';

const exec = promisify(execFile);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-review-integration-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  return { root, store };
}
async function submit(f, evaluation, reviews, supplementalChecks = []) {
  const file = join(f.root, `submission-${evaluation.id}.json`);
  await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: evaluation.reviewPacket.evidenceFingerprint, reviews, supplementalChecks }), { mode: 0o600 });
  return (await auditCommand(f.store, ['evaluate', evaluation.id], { '--spec': file })).value;
}
function review(packet, type, name, conclusion, extra = {}) {
  return { id: name, reviewer: { type, name, ...(type === 'ai' ? { model: 'external-review-model' } : {}) },
    reviewedAt: '2026-10-22T12:00:00Z', method: 'retained-evidence-review', scope: packet.claimScopes[0],
    conclusion, summary: `${name} judgment from retained evidence.`, evidenceRefs: [`run:${packet.subject.runIds[0]}`], ...extra };
}

test('direct CLI and Desktop session selection flows through combined review, revision, export and source-free reopen', async t => {
  const f = await fixture(t), homes = [];
  const executable = join(f.root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  for (const [index, name] of ['A', 'B'].entries()) {
    const native = await prepareNativeHome({ directory: join(f.root, name), executable, codexVersion: '0.153.4' });
    await registerHome(f.store, name, native.root, { executable, version: '0.153.4' }); homes.push(native);
    const rollout = join(native.home, 'sessions', `${id(index + 1)}.jsonl`);
    await mkdir(join(native.home, 'sessions'), { recursive: true });
    const rec = (type, payload, second) => ({ timestamp: `2026-10-22T10:00:0${second}.000Z`, type, payload });
    await writeFile(rollout, [
      rec('session_meta', { id: id(index + 1), cli_version: '0.153.4', originator: index ? 'codex_desktop' : 'codex_cli_rs' }, 0),
      rec('turn_context', { turn_id: id(index + 10), cwd: '/fixture/repo', model: 'fixture-model', effort: 'medium' }, 1),
      rec('event_msg', { type: 'task_started', turn_id: id(index + 10) }, 2),
      rec('event_msg', { type: 'task_complete', turn_id: id(index + 10), success: true, status: 'completed' }, 3),
    ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    const quote = text => text.replaceAll("'", "''");
    await exec('/usr/bin/sqlite3', [join(native.home, 'state_5.sqlite'),
      `CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,rollout_path TEXT,source TEXT); INSERT INTO threads VALUES ('${id(index + 1)}','/fixture/repo','fixture',1,1,0,'${quote(rollout)}','${index ? 'vscode' : 'cli'}');`]);
  }
  const source = join(f.root, 'pair.json');
  await auditCommand(f.store, ['export'], { '--left-profile': 'A', '--left-id': id(1), '--right-profile': 'B', '--right-id': id(2),
    '--same-task': 'fixture-task', '--output': source }, { defaultUserHome: f.root, adminRoots: [] });
  const unreviewed = (await auditCommand(f.store, ['evaluate', source], {})).value;
  assert.equal(unreviewed.subject.kind, 'audit-comparison');
  assert.equal(unreviewed.subject.left.source.client, 'cli');
  assert.equal(unreviewed.subject.right.source.client, 'desktop');
  assert.equal(unreviewed.reviewState.status, 'not-reviewed');
  assert.equal(unreviewed.reviewPacket.subject.runIds.length, 2);
  const human = await submit(f, unreviewed, [review(unreviewed.reviewPacket, 'human', 'human-one', 'positive')]);
  const combined = await submit(f, human, [review(human.reviewPacket, 'ai', 'ai-one', 'negative')]);
  assert.equal(combined.reviewMethod, 'human-and-ai');
  assert.equal(combined.reviewState.disagreement, true);
  const revision = await submit(f, combined, [review(combined.reviewPacket, 'human', 'human-two', 'inconclusive', {
    reviewer: { type: 'human', name: 'human-one' }, supersedes: 'human-one', summary: 'Revised after considering the AI review.' })]);
  assert.equal(revision.reviewHistory.entries.length, 3);
  assert.deepEqual(revision.reviewState.currentReviewIds, ['ai-one', 'human-two']);
  const rendered = renderAudit(revision);
  assert.match(rendered, /superseded/); assert.match(rendered, /Reviewers disagree/);
  assert.ok(rendered.indexOf('Optional review:') > rendered.indexOf('Verification'));
  assert.ok(rendered.indexOf('Optional review:') < rendered.indexOf('Time and tokens'));
  const output = join(f.root, 'reviewed.md');
  await auditCommand(f.store, ['export', revision.id], { '--output': output, '--format': 'markdown' });
  const shown = await auditCommand(f.store, ['show', revision.id], {});
  assert.deepEqual(shown.value.reviewHistory, revision.reviewHistory);
  for (const home of homes) await rm(home.root, { recursive: true, force: true });
  await rm(f.store.directory, { recursive: true, force: true });
  await rm(source);
  const reopened = await readAuditReport(`${output}.audit.json`);
  assert.equal(renderAudit(reopened), rendered);
  assert.match(await readFile(output, 'utf8'), /Revised after considering the AI review/);
  const fresh = await fixture(t);
  const imported = (await auditCommand(fresh.store, ['evaluate', `${output}.audit.json`], {})).value;
  assert.deepEqual(imported.reviewHistory, revision.reviewHistory);
  assert.equal(imported.parentEvaluationId, revision.id);
});

test('saved xfx run accepts AI-only review and separately attributed supplemental check without erasing failure', async t => {
  const f = await fixture(t);
  const experiment = await createExperiment(f.store, { spec: {}, task: 'fixture', profiles: [] });
  const run = await createExperimentRun(f.store, { experimentId: experiment.id, profile: { profileName: 'A' } });
  await finalizeAuditRecord(f.store, run.id, { status: 'complete', profile: { profileName: 'A' },
    source: { kind: 'app-server', provider: 'codex', client: 'cli' }, execution: { status: 'exited', exitCode: 0 },
    outcome: { status: 'failed', checks: [{ name: 'test', status: 'failed', exitCode: 1 }] },
    workspace: { taskEnd: { fingerprint: 'candidate', timing: 'task-end' } },
    comparisonConditions: { checkRecipes: [{ name: 'test', fingerprint: 'recipe' }] } });
  const first = (await auditCommand(f.store, ['evaluate', run.id], {})).value;
  const reviewed = await submit(f, first, [review(first.reviewPacket, 'ai', 'agent-review', 'mixed')], [{
    id: 'supplement-1', runId: run.id, name: 'test', candidateFingerprint: 'candidate', recipeFingerprint: 'recipe',
    checkedAt: '2026-10-22T12:00:00Z', method: 'external-check', status: 'passed', exitCode: 0,
    evidenceRefs: [`run:${run.id}`, `check:${run.id}:test`], attribution: { type: 'human', name: 'fixture-reviewer' },
  }]);
  assert.equal(reviewed.reviewMethod, 'ai');
  assert.equal(reviewed.subject.outcome.checks[0].status, 'failed');
  assert.equal(reviewed.reviewState.supplementalChecks[0].status, 'passed');
  const rendered = renderAudit(reviewed);
  assert.match(rendered, /test: failed/); assert.match(rendered, /test: passed/);
  assert.match(rendered, /externally supplied/);
  const frozen = join(f.root, 'reviewed.json');
  await exportAuditReport(reviewed, { output: frozen });
  const tampered = JSON.parse(await readFile(frozen, 'utf8'));
  tampered.reviewHistory.entries[0].evidenceRefs = ['run:invented'];
  const invalid = join(f.root, 'invalid.json');
  await writeFile(invalid, JSON.stringify(tampered), { mode: 0o600 });
  await assert.rejects(readAuditReport(invalid), /invalid/);
});
