import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';
import { compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport, projectReportResourceProvenance } from '../src/audit-store.js';
import { auditCommand } from '../src/audit.js';
import { summarizeAuditSeries } from '../src/audit-statistics.js';

const exec = promisify(execFile);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-consistency-flow-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  return { root, store };
}
async function json(path, value) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); }
function pairAt(index) {
  const pair = bookingLedgerPair();
  for (const [side, run] of pair.entries()) {
    run.id = `run-${index}-${side}`;
    const actor = `session-${index}-${side}`, turn = `turn-${index}-${side}`;
    run.source.nativeSessionId = actor;
    run.agents[0].id = actor;
    run.turns[0].agentId = actor; run.turns[0].turnId = turn;
    run.artifacts[0].agentId = actor; run.artifacts[0].turnId = turn;
    run.outcome.claim.agentId = actor; run.outcome.claim.turnId = turn;
  }
  return pair;
}

test('CLI cohort retains contradictions, source reviews and missing samples through export and source-free reopen', async t => {
  const f = await fixture(t), pairs = [];
  for (let index = 0; index < 3; index++) {
    const [left, right] = pairAt(index);
    if (index === 1) {
      [left.artifacts[0].path, right.artifacts[0].path] = [right.artifacts[0].path, left.artifacts[0].path];
      [left.checks, right.checks] = [right.checks, left.checks];
    }
    const file = join(f.root, `pair-${index}.json`);
    await exportAuditReport(compareAuditRuns(left, right), { output: file });
    if (index === 0) {
      const packet = (await auditCommand(f.store, ['evaluate', file], {})).value;
      const submission = join(f.root, 'review.json');
      await json(submission, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
        evidenceFingerprint: packet.reviewPacket.evidenceFingerprint, supplementalChecks: [], reviews: [{
          id: 'external-review', reviewer: { type: 'human', name: 'Fixture reviewer' },
          reviewedAt: '2026-10-22T12:00:00Z', method: 'fixture-packet-review', scope: packet.reviewPacket.claimScopes[0],
          conclusion: 'positive', preferredRunId: left.id, summary: 'The left outcome satisfies the named check.', evidenceRefs: [`run:${left.id}`],
        }] });
      const reviewed = (await auditCommand(f.store, ['evaluate', packet.id], { '--spec': submission })).value;
      const reviewedFile = join(f.root, 'reviewed-pair.json');
      await exportAuditReport(reviewed, { output: reviewedFile }); pairs.push({ comparison: 'reviewed-pair.json' });
    } else pairs.push({ comparison: `pair-${index}.json` });
  }
  const [lastLeft] = pairAt(3);
  await exportAuditReport(lastLeft, { output: join(f.root, 'last-left.json') });
  pairs.push({ left: { report: 'last-left.json' }, right: { report: 'missing-right.json' } });
  const spec = join(f.root, 'cohort.json');
  await json(spec, { schemaVersion: 1, kind: 'audit-cohort', pairs });
  const cli = spawnSync(process.execPath, ['bin/xfx.js', 'audit', 'cohort', '--spec', spec, '--store', f.store.directory, '--json'], { encoding: 'utf8' });
  assert.ok([0, 2, 4].includes(cli.status), cli.stderr);
  const report = JSON.parse(cli.stdout), comparison = report.consistency.comparisons[0];
  assert.equal(report.cohort.plannedPairCount, null);
  assert.equal(comparison.coverage.selectedPairs, 4);
  assert.equal(comparison.coverage.missingPairs, 1);
  assert.equal(comparison.findings.find(row => row.rule === 'editable-file-boundary').consistency, 'contradictory');
  assert.equal(comparison.outcomes.find(row => row.name === 'scope').comparison, 'contradictory-outcomes');
  assert.equal(report.trials[0].reviewEvaluations[0].report.reviewState.reviewModes.human, true);
  assert.ok(comparison.reviewers.some(row => row.reviewer.name === 'Fixture reviewer'));
  const rendered = renderAudit(report);
  const headings = ['Comparison conditions', 'Behavioral findings', 'Paired action evidence', 'Verification', 'Time and tokens', 'Outcome and code changes'];
  assert.deepEqual(headings.map(text => rendered.indexOf(text)), headings.map(text => rendered.indexOf(text)).sort((a, b) => a - b));
  assert.match(rendered, /planned pairs unknown/);
  assert.match(rendered, /contradictory/);
  assert.match(rendered, /The left outcome satisfies the named check/);
  for (const operation of ['resume', 'recover', 'clean']) await assert.rejects(auditCommand(f.store, [operation, report.id], {}), /no tasks|owns no/);
  const out = join(f.root, 'cohort.md');
  await auditCommand(f.store, ['export', report.id], { '--output': out, '--format': 'markdown' });
  await rm(f.store.directory, { recursive: true, force: true });
  for (const file of ['pair-0.json', 'pair-1.json', 'pair-2.json', 'reviewed-pair.json', 'last-left.json']) await rm(join(f.root, file));
  const reopened = await readAuditReport(`${out}.audit.json`);
  assert.deepEqual(reopened.consistency, report.consistency);
  assert.equal(renderAudit(reopened), rendered);
  const forged = structuredClone(reopened);
  forged.consistency.comparisons[0].findings[0].consistency = 'invented-winner';
  assert.deepEqual(projectReportResourceProvenance(forged).consistency, reopened.consistency);
  const fresh = await fixture(t);
  const evaluated = (await auditCommand(fresh.store, ['evaluate', `${out}.audit.json`], {})).value;
  assert.equal(evaluated.subject.cohort.selectedPairCount, 4);
  assert.deepEqual(evaluated.consistency, reopened.consistency);
});

test('actual native readers accept repeated CLI and Desktop fixture sessions without inventing consistency from empty actions', async t => {
  const f = await fixture(t), nativeHomes = [];
  const executable = join(f.root, 'codex'); await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  for (const [side, profile] of ['A', 'B'].entries()) {
    const native = await prepareNativeHome({ directory: join(f.root, profile), executable, codexVersion: '0.999.0' });
    await registerHome(f.store, profile, native.root, { executable, version: '0.999.0' }); nativeHomes.push(native);
    await mkdir(join(native.home, 'sessions'), { recursive: true });
    const db = join(native.home, 'state_5.sqlite');
    await exec('/usr/bin/sqlite3', [db, 'CREATE TABLE threads(id TEXT PRIMARY KEY, archived INTEGER, rollout_path TEXT, source TEXT);']);
    for (let trial = 0; trial < 2; trial++) {
      const session = id(trial * 2 + side + 1), turn = id(trial * 2 + side + 101), path = join(native.home, 'sessions', `${session}.jsonl`);
      await writeFile(path, [
        { type: 'session_meta', payload: { id: session, session_id: session, originator: side ? 'Codex Desktop' : 'codex_cli_rs' } },
        { type: 'turn_context', payload: { turn_id: turn, model: 'fixture-model', effort: 'medium', cwd: f.root } },
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, status: 'completed' } },
      ].map((row, index) => JSON.stringify({ timestamp: `2026-10-22T10:00:0${index}Z`, ...row })).join('\n') + '\n', { mode: 0o600 });
      await exec('/usr/bin/sqlite3', [db, `INSERT INTO threads VALUES ('${session}',0,'${path.replaceAll("'", "''")}','${side ? 'vscode' : 'cli'}');`]);
    }
  }
  const spec = join(f.root, 'sessions.json');
  await json(spec, { schemaVersion: 1, kind: 'audit-cohort', sameTask: 'same-request', pairs: [
    { left: { profile: 'A', id: id(1) }, right: { profile: 'B', id: id(2) } },
    { left: { profile: 'A', id: id(3) }, right: { profile: 'B', id: id(4) } },
  ] });
  const report = (await auditCommand(f.store, ['cohort'], { '--spec': spec }, { defaultUserHome: f.root, adminRoots: [] })).value;
  assert.equal(report.trials[0].profiles[0].run.source.client, 'cli');
  assert.equal(report.trials[0].profiles[1].run.source.client, 'desktop');
  assert.equal(report.trials[0].profiles[0].run.metrics.recordedSpanMs, 2000);
  assert.equal(report.comparisons[0].metrics.recordedSpanMs.pairedN, 2);
  assert.equal(report.comparisons[0].metrics.recordedSpanMs.delta, 0);
  assert.equal(report.consistency.comparisons[0].coverage.eligiblePairs, 2);
  assert.equal(report.consistency.status, 'unmeasured');
  assert.equal(report.consistency.comparisons[0].cohort.taskAssociation, 'user-declared');
  const output = join(f.root, 'native-cohort.json');
  await exportAuditReport(report, { output });
  for (const native of nativeHomes) await rm(native.root, { recursive: true, force: true });
  const reopened = await readAuditReport(output);
  assert.deepEqual(reopened.consistency, report.consistency);
  assert.equal(reopened.trials[0].profiles[0].run.metrics.recordedSpanMs, 2000);
  assert.deepEqual(reopened.comparisons[0].metrics.recordedSpanMs, report.comparisons[0].metrics.recordedSpanMs);
});

test('R3 sealed series evaluations reopen without adding fields to their fingerprint-bound subject', async t => {
  const f = await fixture(t), pairs = [pairAt(0), pairAt(1)];
  const report = summarizeAuditSeries({ profiles: pairs[0].map(run => run.profile),
    plan: pairs.map((_, index) => ({ index: index + 1, profileOrder: ['A', 'B'] })),
    trials: pairs.map((runs, index) => ({ index: index + 1, runs, status: 'complete' })) });
  delete report.consistency;
  const source = join(f.root, 'old-series.json'); await exportAuditReport(report, { output: source });
  const evaluation = (await auditCommand(f.store, ['evaluate', source], {})).value;
  assert.equal(Object.hasOwn(evaluation.subject, 'consistency'), false);
  const output = join(f.root, 'old-evaluation.json'); await exportAuditReport(evaluation, { output });
  const reopened = await readAuditReport(output);
  assert.equal(reopened.reviewPacket.evidenceFingerprint, evaluation.reviewPacket.evidenceFingerprint);
  assert.equal(Object.hasOwn(reopened.subject, 'consistency'), false);
  assert.equal(reopened.consistency.comparisons[0].coverage.selectedPairs, 2);
});
