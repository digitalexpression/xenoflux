import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { prepareEvaluation } from '../test-support/substantive-evaluation/prepare.mjs';
import { prepareExecutionEnvelope, validateExecutionEnvelope } from '../test-support/evaluation-isolation/prepare-envelope.mjs';
import { auditQualityFingerprint } from '../src/audit-quality.js';

test('execution envelope binds frozen inputs and remains pending without touching campaign', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-envelope-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, 'campaign'), campaign = await prepareEvaluation(campaignDir);
  const campaignPath = join(campaignDir, 'campaign.json'), original = await readFile(campaignPath);
  const envelopePath = join(root, 'envelope/envelope.json');
  const envelope = await prepareExecutionEnvelope(campaignPath, join(root, 'envelope'));
  assert.equal(await readFile(campaignPath, 'utf8'), original.toString());
  assert.equal(envelope.executionAuthorized, false);
  assert.equal(envelope.paidExecutionAuthorized, false);
  assert.equal(envelope.approval.approved, false);
  assert.equal(envelope.approval.model, null);
  assert.equal(envelope.approval.effort, null);
  assert.equal(envelope.approval.accountRoute, null);
  assert.equal(envelope.approval.monetaryBudget, null);
  assert.equal(envelope.approval.providerEnforcement, null);
  assert.equal(envelope.approval.humanReviewer, null);
  assert.equal(envelope.gates.nativeIsolation, 'pending');
  assert.equal(envelope.executionPaths.status, 'proposed-only-not-registered-or-authenticated');
  assert.deepEqual(envelope.executionPaths.profiles.map(profile => profile.skills), [[], ['evaluation-workflow']]);
  await assert.rejects(readFile(envelope.executionPaths.store), { code: 'ENOENT' });
  assert.equal(envelope.slots.length, 12);
  assert.deepEqual(envelope.slots.map(slot => [slot.taskId, slot.repetition, slot.profile]), [
    ['booking-ledger', 1, 'EvalBaseline'], ['booking-ledger', 1, 'EvalWorkflow'],
    ['booking-ledger', 2, 'EvalWorkflow'], ['booking-ledger', 2, 'EvalBaseline'],
    ['retry-queue', 1, 'EvalWorkflow'], ['retry-queue', 1, 'EvalBaseline'],
    ['retry-queue', 2, 'EvalBaseline'], ['retry-queue', 2, 'EvalWorkflow'],
    ['config-overlay', 1, 'EvalBaseline'], ['config-overlay', 1, 'EvalWorkflow'],
    ['config-overlay', 2, 'EvalWorkflow'], ['config-overlay', 2, 'EvalBaseline'],
  ]);
  assert.deepEqual(envelope.tasks.map(task => task.id), ['booking-ledger', 'retry-queue', 'config-overlay']);
  assert.deepEqual(envelope.slots.map(slot => slot.slot), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.deepEqual(envelope.slots[0].profileOrder, ['EvalBaseline', 'EvalWorkflow']);
  assert.deepEqual(envelope.slots[2].profileOrder, ['EvalWorkflow', 'EvalBaseline']);
  for (const task of envelope.tasks) {
    assert.equal(task.trialBounds.runMs, 900000);
    assert.equal(task.isolatedCheck.timeoutMs, 600000);
    assert.equal(task.isolatedCheck.argv[0], process.execPath);
    assert.match(task.isolatedCheck.argv[1], /check-isolated\.mjs$/);
    assert.equal(task.isolatedCheck.argv[2], join(root, 'envelope/envelope.json'));
    assert.notEqual(task.qualityFingerprint, task.originalQualityFingerprint);
  }
  assert.equal((await validateExecutionEnvelope(envelopePath)).executionAuthorized, false);
  const approvalTamper = JSON.parse(await readFile(envelopePath, 'utf8'));
  approvalTamper.approval.approved = true;
  const tamperedPath = join(root, 'tampered-envelope.json');
  await writeFile(tamperedPath, JSON.stringify(approvalTamper));
  await assert.rejects(validateExecutionEnvelope(tamperedPath), /approval-gate/);

  const pristineEnvelope = await readFile(envelopePath);
  const rejectsTamper = async (edit, pattern) => {
    const value = JSON.parse(pristineEnvelope);
    edit(value);
    await chmod(envelopePath, 0o600);
    await writeFile(envelopePath, JSON.stringify(value));
    try { await assert.rejects(validateExecutionEnvelope(envelopePath), pattern); }
    finally { await writeFile(envelopePath, pristineEnvelope); await chmod(envelopePath, 0o400); }
  };
  await rejectsTamper(value => {
    value.tasks[0].quality.rubric.criteria[0].label = 'Changed after freeze';
    value.tasks[0].qualityFingerprint = auditQualityFingerprint(value.tasks[0].quality, [value.tasks[0].isolatedCheck]);
  }, /frozen-quality-mismatch/);
  await rejectsTamper(value => { value.slots[0].profile = 'EvalWorkflow'; }, /slot-sequence-mismatch/);
  await rejectsTamper(value => { value.slots[0].slot = 2; }, /slot-sequence-mismatch/);
  await rejectsTamper(value => { value.slots[0].profileOrder.reverse(); }, /slot-sequence-mismatch/);
  await rejectsTamper(value => {
    value.nativeBinary = { version: '0.163.0-alpha.10.2', sha256: '0'.repeat(64),
      status: 'blocked-managed-preferences', executionAuthorized: false };
  }, /native-binary-descriptor-mismatch/);
  await rejectsTamper(value => { value.checker.sha256 = '0'.repeat(64); }, /design-or-observer-head-mismatch/);
  await rejectsTamper(value => { value.tasks[0].isolatedCheck.name = 'changed-check'; }, /frozen-quality-mismatch/);
  await rejectsTamper(value => { value.executionPaths.store = join(root, 'live-store'); }, /bounds-mismatch/);
  await assert.rejects(prepareExecutionEnvelope(campaignPath, join(root, 'envelope')), { code: 'EEXIST' });
});

test('execution envelope rejects changed frozen task baselines before creating output', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-envelope-hash-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, 'campaign'), campaign = await prepareEvaluation(campaignDir);
  const task = campaign.tasks[0];
  await writeFile(task.specPath, `${await readFile(task.specPath, 'utf8')} `);
  await assert.rejects(prepareExecutionEnvelope(join(campaignDir, 'campaign.json'), join(root, 'rejected')),
    /envelope-spec-hash-mismatch/);
});

test('execution envelope preparation rejects a reordered frozen profile schedule', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-envelope-order-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, 'campaign'), campaign = await prepareEvaluation(campaignDir);
  const task = campaign.tasks[0], spec = JSON.parse(await readFile(task.specPath, 'utf8'));
  spec.profiles.reverse();
  const specBytes = `${JSON.stringify(spec, null, 2)}\n`;
  await writeFile(task.specPath, specBytes);
  const manifestPath = join(campaignDir, 'campaign.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.tasks[0].specSha256 = (await import('node:crypto')).createHash('sha256').update(specBytes).digest('hex');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(prepareExecutionEnvelope(manifestPath, join(root, 'rejected')),
    /envelope-spec-quality-or-trials-mismatch/);
});

test('execution envelope CLI binds an optional retained runtime and rejects unknown flags', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-envelope-cli-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = join(root, 'campaign'), campaign = await prepareEvaluation(campaignDir);
  const runtimePath = join(root, 'runtime.json'), runtimeBytes = Buffer.from('{"offlineFixture":true}\n');
  await writeFile(runtimePath, runtimeBytes);
  const helper = fileURLToPath(new URL('../test-support/evaluation-isolation/prepare-envelope.mjs', import.meta.url));
  const output = join(root, 'cli-envelope');
  const run = spawnSync(process.execPath, [helper, '--campaign', join(campaignDir, 'campaign.json'),
    '--output', output, '--runtime', runtimePath], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const envelope = JSON.parse(await readFile(join(output, 'envelope.json'), 'utf8'));
  assert.deepEqual(envelope.workerRuntime, { path: runtimePath, sha256: createHash('sha256').update(runtimeBytes).digest('hex') });
  assert.equal(envelope.executionAuthorized, false);
  assert.equal(JSON.parse(await readFile(join(output, 'validation.json'), 'utf8')).nativeCalls, 0);

  const rejectedOutput = join(root, 'unknown-flag-output');
  const rejected = spawnSync(process.execPath, [helper, '--campaign', join(campaignDir, 'campaign.json'),
    '--output', rejectedOutput, '--execute'], { encoding: 'utf8', timeout: 15000 });
  assert.notEqual(rejected.status, 0);
  await assert.rejects(readFile(join(rejectedOutput, 'envelope.json')), { code: 'ENOENT' });
});
