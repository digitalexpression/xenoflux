import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { auditCommand } from '../src/audit.js';
import { exportAuditReport } from '../src/audit-store.js';
import { createEngineProvider } from '../src/ui-engine.js';

const exec = promisify(execFile);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('retained human and AI reviews, disagreement and earlier revisions survive export and app reopen', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ui-reviews-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'store'));
  await store.update(data => { create(data, 'A'); create(data, 'B'); });
  const executable = join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  for (const [index, name] of ['A', 'B'].entries()) {
    const native = await prepareNativeHome({ directory: join(root, name), executable, codexVersion: '0.153.4' });
    await registerHome(store, name, native.root, { executable, version: '0.153.4' });
    const rollout = join(native.home, 'sessions', `${id(index + 1)}.jsonl`);
    await mkdir(join(native.home, 'sessions'), { recursive: true });
    const rec = (type, payload, second) => ({ timestamp: `2026-10-22T10:00:0${second}.000Z`, type, payload });
    await writeFile(rollout, [
      rec('session_meta', { id: id(index + 1), cli_version: '0.153.4', originator: index ? 'codex_desktop' : 'codex_cli_rs' }, 0),
      rec('turn_context', { turn_id: id(index + 10), cwd: '/fixture/repo', model: 'fixture-model', effort: 'medium' }, 1),
      rec('event_msg', { type: 'task_complete', turn_id: id(index + 10), success: true, status: 'completed' }, 3),
    ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await exec('/usr/bin/sqlite3', [join(native.home, 'state_5.sqlite'),
      `CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,rollout_path TEXT,source TEXT); INSERT INTO threads VALUES ('${id(index + 1)}','/fixture/repo','fixture',1,1,0,'${rollout.replaceAll("'", "''")}','${index ? 'vscode' : 'cli'}');`]);
  }
  const source = join(root, 'pair.json');
  await auditCommand(store, ['export'], { '--left-profile': 'A', '--left-id': id(1), '--right-profile': 'B', '--right-id': id(2), '--output': source },
    { defaultUserHome: root, adminRoots: [] });
  const submit = async (evaluation, reviews) => {
    const file = join(root, `submission-${evaluation.id}.json`);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, kind: 'xfx-audit-review-submission', evidenceFingerprint: evaluation.reviewPacket.evidenceFingerprint, reviews, supplementalChecks: [] }), { mode: 0o600 });
    return (await auditCommand(store, ['evaluate', evaluation.id], { '--spec': file })).value;
  };
  const review = (packet, type, name, conclusion, extra = {}) => ({ id: name, reviewer: { type, name, ...(type === 'ai' ? { model: 'external-review-model' } : {}) },
    reviewedAt: '2026-10-22T12:00:00Z', method: 'retained-evidence-review', scope: packet.claimScopes[0], conclusion, summary: `${name} judgment.`, evidenceRefs: [`run:${packet.subject.runIds[0]}`], ...extra });
  const unreviewed = (await auditCommand(store, ['evaluate', source], {})).value;
  const human = await submit(unreviewed, [review(unreviewed.reviewPacket, 'human', 'human-one', 'positive')]);
  const combined = await submit(human, [review(human.reviewPacket, 'ai', 'ai-one', 'negative')]);
  const revision = await submit(combined, [review(combined.reviewPacket, 'human', 'human-two', 'inconclusive', { reviewer: { type: 'human', name: 'human-one' }, supersedes: 'human-one' })]);
  const output = join(root, 'reviewed.md');
  await exportAuditReport(revision, { output, format: 'markdown' });
  // Remove the original histories: the saved pair alone must reopen.
  await rm(join(root, 'A'), { recursive: true }); await rm(join(root, 'B'), { recursive: true });

  const provider = createEngineProvider({ store, defaultUserHome: root, reportsRoot: join(root, 'reports') });
  const opened = await provider.openReport({ fileName: 'reviewed.md.audit.json', text: await readFile(`${output}.audit.json`, 'utf8') });
  assert.equal(opened.kept.find(row => row.label === 'Reviews attached earlier').value, 'Kept, with reviewers and earlier revisions');
  const report = await provider.report({ ref: opened.ref });
  assert.match(report.verification.reviews.text, /3 reviews attached/);
  assert.equal(report.verification.reviews.href, `/reports/${opened.ref}/reviews`);
  assert.equal(report.a.client, 'Codex CLI');
  assert.equal(report.b.client, 'Codex Desktop');
  const reviews = await provider.reviews({ ref: opened.ref });
  const cards = reviews.topics.flatMap(topic => topic.reviews);
  assert.deepEqual(cards.map(card => [card.kind, card.verdict]).sort(), [['ai', 'negative'], ['human', 'inconclusive']]);
  assert.ok(reviews.topics.some(topic => topic.disagreement), 'disagreement is shown, not averaged');
  const revised = cards.find(card => card.kind === 'human');
  assert.equal(revised.earlier.verdict, 'positive', 'the superseded revision is kept for the record');
  assert.match(cards.find(card => card.kind === 'ai').reviewer, /external-review-model/);

  const submission = { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: revision.reviewPacket.evidenceFingerprint,
    reviews: [review(revision.reviewPacket, 'ai', 'ui-import', 'mixed')], supplementalChecks: [] };
  const auditDirectory = join(root, 'store', 'audits');
  const beforePreview = await import('node:fs/promises').then(fs => fs.readdir(auditDirectory));
  const draft = await provider.previewReview({ ref: opened.ref, submission });
  assert.equal(draft.evidenceFingerprint, revision.reviewPacket.evidenceFingerprint);
  assert.ok(draft.topics.some(topic => topic.reviews.some(card => card.reviewer.includes('ui-import'))));
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(auditDirectory)), beforePreview,
    'preview validates and presents the submission without writing an evaluation');
  const saved = await provider.saveReview({ ref: opened.ref, token: draft.token });
  assert.match(saved.ref, /^f\./);
  const afterSave = await provider.reviews({ ref: saved.ref });
  assert.ok(afterSave.topics.flatMap(topic => topic.reviews).some(card => card.reviewer.includes('ui-import')));
  assert.equal((await import('node:fs/promises').then(fs => fs.readdir(auditDirectory))).length, beforePreview.length + 1);

  const beforePacketExport = await import('node:fs/promises').then(fs => fs.readdir(auditDirectory));
  const packetExport = await provider.exportReport({ ref: saved.ref, prepareReview: true, includeReplayContent: false });
  assert.ok(packetExport.reviewPacketFingerprint);
  assert.ok(packetExport.reviewPacketRef);
  const exportedPacket = JSON.parse(await readFile(join(packetExport.folder, packetExport.files[1]), 'utf8'));
  assert.equal(exportedPacket.reviewPacket.evidenceFingerprint, packetExport.reviewPacketFingerprint,
    'the packet fingerprint binds the exported projection');
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(auditDirectory)), beforePacketExport,
    'preparing an export-bound review packet creates no persisted evaluation');
  const followup = { ...submission, evidenceFingerprint: exportedPacket.reviewPacket.evidenceFingerprint,
    reviews: [review(exportedPacket.reviewPacket, 'human', 'after-export', 'positive')] };
  const reopenedPacket = await provider.openReport({ fileName: packetExport.files[1], text: await readFile(join(packetExport.folder, packetExport.files[1]), 'utf8') });
  const projectedPreview = await provider.previewReview({ ref: reopenedPacket.ref, submission: followup });
  assert.equal(projectedPreview.evidenceFingerprint, packetExport.reviewPacketFingerprint,
    'the same projected packet is reopened for import without rebinding its fingerprint');
});
