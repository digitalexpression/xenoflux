import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildAuditCheckEvidence, normalizeAuditCheckEvidence, readAuditCheckOutput } from '../src/audit-check-evidence.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const recipe = { name: 'unit tests', argv: ['npm', 'test', '--', '--runInBand'], timeoutMs: 30_000 };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function report(evidence = buildAuditCheckEvidence({ checks: [recipe],
  results: [{ name: recipe.name, status: 'passed', exitCode: 0, startedAt: '2026-10-31T12:00:00.000Z', elapsedMs: 1250 }],
  workspaceFingerprint: 'a'.repeat(64), outputs: [{ stdout: 'All tests passed\n', stderr: '', status: 'retained', truncated: false }] })) {
  const execution = evidence?.records?.[0]?.execution ?? { status: 'passed', exitCode: 0 };
  return { schemaVersion: 1, kind: 'audit-run', id: 'check-run', status: 'complete',
    comparisonConditions: { schemaVersion: 1, checkRecipes: [{ name: recipe.name, fingerprint: hash(recipe) }] },
    checks: [{ name: recipe.name, status: execution.status, exitCode: execution.exitCode, origin: 'runner-check' }], checkEvidence: evidence };
}

test('builds stable check records with runner result and task-end baseline', () => {
  const first = buildAuditCheckEvidence({ checks: [recipe],
    results: [{ status: 'failed', exitCode: 2, startedAt: '2026-10-31T12:00:00.000Z', elapsedMs: 17 }],
    workspaceFingerprint: 'b'.repeat(64), outputs: [{ stdout: 'failure', stderr: '', status: 'retained', truncated: true }] });
  const again = buildAuditCheckEvidence({ checks: [recipe] });
  assert.equal(first.records[0].id, again.records[0].id);
  assert.equal(first.records[0].definitionFingerprint, hash(recipe));
  assert.equal(first.records[0].definition.command, JSON.stringify(recipe.argv));
  assert.equal(first.records[0].execution.status, 'failed');
  assert.equal(first.records[0].execution.exitCode, 2);
  assert.equal(first.records[0].execution.workspaceFingerprint, 'b'.repeat(64));
  assert.equal(first.records[0].output.truncated, true);
});

test('normalization omits content by default and redacts command/output only when selected', () => {
  const source = report(buildAuditCheckEvidence({ checks: [recipe],
    results: [{ name: recipe.name, status: 'passed', exitCode: 0, startedAt: '2026-10-31T12:00:00.000Z', elapsedMs: 50 }],
    workspaceFingerprint: 'c'.repeat(64), outputs: [{ stdout: 'token=ghp_12345678901234567890', stderr: '', status: 'retained', truncated: false }] }));
  source.checkEvidence.records[0].definition.command = 'echo sk-abcdefghijklmnopqrstuv';
  const omitted = normalizeAuditCheckEvidence(source);
  assert.equal(omitted.records[0].definition.command, null);
  assert.deepEqual(omitted.records[0].output, { stdout: null, stderr: null, status: 'omitted', truncated: false });
  const selected = normalizeAuditCheckEvidence(source, { includeContent: true });
  assert.doesNotMatch(JSON.stringify(selected), /sk-abcdefghijklmnopqrstuv|ghp_12345678901234567890/);
  assert.match(selected.records[0].definition.command, /\[REDACTED\]/);
  assert.match(selected.records[0].output.stdout, /\[REDACTED\]/);
  assert.equal(selected.records[0].output.status, 'retained');
});

test('drops evidence whose recipe fingerprint or canonical runner outcome contradicts it', () => {
  const forged = report();
  forged.checkEvidence.records[0].definitionFingerprint = 'f'.repeat(64);
  assert.equal(normalizeAuditCheckEvidence(forged), null);
  const contradictory = report();
  contradictory.checks[0].exitCode = 1;
  assert.equal(normalizeAuditCheckEvidence(contradictory).records.length, 0);
});

test('reads only bounded regular runner output files and reports unavailable after source removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-check-evidence-'));
  try {
    await writeFile(join(directory, 'check-0.stdout'), 'stdout token=ghp_12345678901234567890\n', { mode: 0o600 });
    await writeFile(join(directory, 'check-0.stderr'), '', { mode: 0o600 });
    const retained = await readAuditCheckOutput(directory, 0);
    assert.equal(retained.status, 'retained');
    assert.doesNotMatch(retained.stdout, /ghp_12345678901234567890/);
    const capped = await readAuditCheckOutput(directory, 0, { outputLimitBytes: 5 });
    assert.equal(capped.truncated, true);
    assert.equal(capped.status, 'retained');
    await writeFile(join(directory, 'check-0.stdout'), 'aaaa😀tail', { mode: 0o600 });
    const splitCharacter = await readAuditCheckOutput(directory, 0, { outputLimitBytes: 7 });
    assert.equal(splitCharacter.status, 'retained');
    assert.equal(splitCharacter.stdout, 'aaaa', 'the incomplete emoji at the bounded byte edge is dropped safely');
    assert.equal(splitCharacter.truncated, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const missing = await readAuditCheckOutput(join(tmpdir(), 'removed-check-source'), 0);
  assert.equal(missing.status, 'unavailable');
});

test('frozen export defaults to omitted content and opted-in report reopens without private source files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-check-export-'));
  try {
    const defaultPath = join(directory, 'default.json');
    await exportAuditReport(report(), { output: defaultPath });
    const omitted = await readAuditReport(defaultPath);
    assert.equal(omitted.checkEvidence.records[0].definition.command, null);
    assert.equal(omitted.checkEvidence.records[0].output.status, 'omitted');
    assert.equal(omitted.checkEvidence.contentBoundary, 'check-command-and-output-omitted');
    const optedAfterOmission = normalizeAuditCheckEvidence(omitted, { includeContent: true });
    assert.deepEqual(optedAfterOmission, omitted.checkEvidence, 'reopening or opting in cannot recover omitted content');

    const includedPath = join(directory, 'included.json');
    await exportAuditReport(report(), { output: includedPath, includeReplayContent: true });
    const included = await readAuditReport(includedPath);
    assert.equal(included.checkEvidence.records[0].output.status, 'retained');
    assert.equal(included.checkEvidence.records[0].output.stdout, 'All tests passed\n');
    assert.equal(included.checkEvidence.records[0].execution.workspaceFingerprint, 'a'.repeat(64));
    assert.equal(included.checkEvidence.records[0].definition.command, JSON.stringify(recipe.argv));
    assert.equal(Object.hasOwn(included.checkEvidence.records[0], 'outputPath'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
