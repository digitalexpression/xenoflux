import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateAuditEvidence } from '../src/audit-review-command.js';
import { buildAuditReviewPacket } from '../src/audit-review.js';
import { projectReportResourceProvenance } from '../src/audit-store.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { attachAuditSessionEvidence, projectAuditSessionEvidence } from '../src/audit-session-evidence.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const run = (id, profileId, nativeSessionId, fingerprint) => ({ kind: 'audit-run', id, status: 'partial',
  profile: { profileId, profileName: profileId }, source: { kind: 'native-rollout', nativeSessionId, fingerprint },
  checks: [{ name: 'original-native-check', status: 'unknown' }] });
function submission(subject, attachments) { return { schemaVersion: 1, kind: 'xfx-audit-session-evidence',
  evidenceFingerprint: buildAuditReviewPacket(subject).evidenceFingerprint, attachments }; }
function attachment(row) { return { ...row, attributed: { type: 'human', name: 'operator' }, recordedAt: '2026-10-23T14:00:00.000Z',
  taskContract: { id: 'task-one', editableFiles: ['src/main.js'] },
  taskEnd: { capturedAt: '2026-10-23T13:59:00.000Z', files: [
    { path: 'src/main.js', sha256: digest('end') }, { path: 'README.md', sha256: digest('readme') },
  ] },
  checkRecipes: [{ name: 'acceptance', argv: ['node', '/private/path/check.js', 'task-one'],
    inputs: [{ path: 'test/oracle.js', sha256: digest('oracle') }] }] }; }

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-session-evidence-')));
  await chmod(root, 0o700);
  const store = { directory: join(root, '.xfx') };
  await mkdir(store.directory, { mode: 0o700 }); await chmod(store.directory, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store };
}

test('attaches task-end and recipe identities to exact native sessions without changing original checks', () => {
  const a = run('run-a', 'profile-a', 'native-a', digest('rollout-a'));
  const b = run('run-b', 'profile-b', 'native-b', digest('rollout-b'));
  const source = { schemaVersion: 1, kind: 'audit-comparison', id: 'comparison-a', status: 'partial', left: a, right: b };
  const before = structuredClone(source);
  const attached = attachAuditSessionEvidence(source, submission(source, [attachment({ runId: a.id, profileId: 'profile-a',
    nativeSessionId: 'native-a', sourceFingerprint: a.source.fingerprint })]));
  assert.deepEqual(source, before);
  const projected = projectAuditSessionEvidence(attached.left);
  assert.equal(projected.taskEnd.fingerprint, digest(JSON.stringify([
    { path: 'README.md', sha256: digest('readme') }, { path: 'src/main.js', sha256: digest('end') },
  ])));
  assert.equal(projected.taskEnd.files.length, 2, 'full task-end snapshots may include files outside the editable boundary');
  assert.equal(projected.checkRecipes[0].fingerprint.length, 64);
  assert.equal(JSON.stringify(projected).includes('/private/path'), false, 'private argv is not persisted');
  assert.deepEqual(attached.left.checks, a.checks, 'native original checks remain unchanged');
  assert.equal(projectAuditSessionEvidence(attached.right), null);
  assert.throws(() => projectAuditSessionEvidence({ ...attached.left, source: { ...a.source, fingerprint: digest('changed') } }), /no longer matches/);
});

test('rejects mismatched bindings, duplicate attachments, and unsafe manifests', () => {
  const a = run('run-a', 'profile-a', 'native-a', digest('rollout-a'));
  const b = run('run-b', 'profile-b', 'native-b', digest('rollout-b'));
  const source = { schemaVersion: 1, kind: 'audit-comparison', id: 'comparison-a', status: 'complete', left: a, right: b };
  const good = attachment({ runId: a.id, profileId: 'profile-a', nativeSessionId: 'native-a', sourceFingerprint: a.source.fingerprint });
  assert.throws(() => attachAuditSessionEvidence(source, submission(source, [{ ...good, profileId: 'profile-b' }])), /does not match/);
  assert.throws(() => attachAuditSessionEvidence(source, submission(source, [good, good])), /Duplicate/);
  assert.throws(() => attachAuditSessionEvidence(source, submission(source, [{ ...good, taskEnd: {
    capturedAt: good.taskEnd.capturedAt, files: [{ path: '../outside', sha256: digest('x') }],
  } }])), /safe relative/);
  assert.throws(() => attachAuditSessionEvidence(source, { ...submission(source, [good]), extra: true }), /Invalid session evidence submission fields/);
  assert.throws(() => attachAuditSessionEvidence(source, submission(source, [{
    runId: a.id, profileId: 'profile-a', nativeSessionId: 'native-a', sourceFingerprint: a.source.fingerprint,
    attributed: { type: 'human', name: 'operator' }, recordedAt: '2026-10-23T14:00:00.000Z',
  }])), /must contain a task contract/);
  const existing = attachAuditSessionEvidence(source, submission(source, [good]));
  assert.throws(() => attachAuditSessionEvidence(existing, submission(existing, [good])), /already attached/);
  assert.throws(() => attachAuditSessionEvidence({ ...source, left: { ...a, status: 'unavailable' } },
    submission({ ...source, left: { ...a, status: 'unavailable' } }, [good])), /native-rollout comparison/);
});

test('projects compacted evidence through legacy profile and source thread ID fields', () => {
  const base = { kind: 'audit-run', id: 'run-legacy', status: 'partial', profileId: 'profile-legacy',
    source: { kind: 'native-rollout', threadId: 'thread-legacy', fingerprint: digest('legacy-source') } };
  const source = { schemaVersion: 1, ...base };
  const attached = attachAuditSessionEvidence(source, submission(source, [attachment({ runId: base.id,
    profileId: base.profileId, nativeSessionId: base.source.threadId, sourceFingerprint: base.source.fingerprint })]));
  const compact = compactAuditTrial({ runs: [attached] });
  assert.equal(compact.runs.length, 1);
  assert.equal(projectAuditSessionEvidence(compact.runs[0]).nativeSessionId, 'thread-legacy');
  const unsafe = { ...compact.runs[0], sessionEvidence: { ...compact.runs[0].sessionEvidence, extra: true } };
  assert.throws(() => projectAuditSessionEvidence(unsafe), /Invalid stored session evidence fields/);
  const unsafePath = { ...compact.runs[0], sessionEvidence: { ...compact.runs[0].sessionEvidence,
    taskContract: { id: 'task-one', editableFiles: ['../secret'] } } };
  assert.throws(() => projectAuditSessionEvidence(unsafePath), /safe relative/);
  const tooMany = { ...compact.runs[0], sessionEvidence: { ...compact.runs[0].sessionEvidence,
    taskEnd: { ...compact.runs[0].sessionEvidence.taskEnd,
      files: Array.from({ length: 501 }, (_, index) => ({ path: `f${index}`, sha256: digest(String(index)) })) } } };
  assert.throws(() => projectAuditSessionEvidence(tooMany), /bounded timestamp and file manifest/);
  const badTime = { ...compact.runs[0], sessionEvidence: { ...compact.runs[0].sessionEvidence, recordedAt: 'bad\nvalue' } };
  assert.throws(() => projectAuditSessionEvidence(badTime), /attribution or timestamp/);
});

test('allows independent optional task context and rejects an attachment with no meaningful evidence', () => {
  const source = { schemaVersion: 1, ...run('run-context', 'profile-context', 'native-context', digest('context-source')) };
  const bind = { runId: source.id, profileId: source.profile.profileId, nativeSessionId: source.source.nativeSessionId,
    sourceFingerprint: source.source.fingerprint, attributed: { type: 'human', name: 'operator' },
    recordedAt: '2026-10-23T14:00:00.000Z' };
  const contractOnly = attachAuditSessionEvidence(source, submission(source, [{ ...bind,
    taskContract: { id: 'behavior-only', editableFiles: ['src/main.js'] }, checkRecipes: [] }]));
  assert.equal(projectAuditSessionEvidence(contractOnly).taskContract.id, 'behavior-only');
  assert.equal(projectAuditSessionEvidence(contractOnly).taskEnd, undefined);
  assert.throws(() => attachAuditSessionEvidence(source, submission(source, [{ ...bind, checkRecipes: [] }])), /must contain/);
});

test('audit evaluate stores an immutable session-evidence evaluation from the original report', async t => {
  const { root, store } = await fixture(t), source = { schemaVersion: 1, ...run('run-a', 'profile-a', 'native-a', digest('rollout-a')) };
  const sourcePath = join(root, 'source.json');
  await writeFile(sourcePath, JSON.stringify(source), { flag: 'wx', mode: 0o600 });
  const specPath = join(root, 'session-evidence.json');
  await writeFile(specPath, JSON.stringify(submission(projectReportResourceProvenance(source), [attachment({ runId: source.id, profileId: 'profile-a',
    nativeSessionId: 'native-a', sourceFingerprint: source.source.fingerprint })])), { flag: 'wx', mode: 0o600 });
  const evaluated = await evaluateAuditEvidence(store, sourcePath, specPath);
  assert.equal(evaluated.subject.sessionEvidence.runId, source.id);
  assert.deepEqual(JSON.parse(await (await import('node:fs/promises')).readFile(sourcePath, 'utf8')), source, 'source audit report stays immutable');
  assert.ok(projectAuditSessionEvidence(evaluated.subject));
  assert.equal(evaluated.reviewPacket.evidenceFingerprint, buildAuditReviewPacket(evaluated.subject).evidenceFingerprint);
});
