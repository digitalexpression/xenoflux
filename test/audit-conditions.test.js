import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateAuditSpec } from '../src/audit-spec.js';
import { buildAuditComparisonConditions } from '../src/audit-conditions.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { bookingLedgerPair } from '../test-support/audit-explanation/booking-ledger.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const basic = { schemaVersion: 1, repository: '/tmp/repo', revision: 'HEAD', task: 'PRIVATE task text',
  profiles: [{ name: 'Alpha', skills: ['workflow'] }, 'Beta'], setup: [],
  checks: [{ name: 'verify', argv: ['node', 'test.js'], timeoutMs: 60000 }] };

test('conditions include frozen fingerprints and only an explicit task contract', () => {
  const oldSpec = validateAuditSpec(basic);
  assert.equal(oldSpec.taskContract, undefined);
  const spec = validateAuditSpec({ ...basic, taskContract: { id: 'booking-ledger', editableFiles: ['src/booking-ledger.js'] } });
  const result = buildAuditComparisonConditions({ spec, baseline: { commit: 'abc123', tree: 'tree456' },
    profile: spec.profiles[0], profileOrder: ['Alpha', 'Beta'], trialIndex: 0,
    environment: { platform: 'darwin', epoch: '2026-10-21T00:00:00.000Z', SECRET: 'do-not-copy' } });
  assert.equal(result.taskFingerprint, digest(spec.task));
  assert.equal(result.taskId, 'booking-ledger');
  assert.deepEqual(result.editableFiles, ['src/booking-ledger.js']);
  assert.equal(result.checkRecipes[0].fingerprint, digest(spec.checks[0]));
  assert.deepEqual(result.selectedSkills, ['workflow']);
  assert.deepEqual(result.profileOrder, ['Alpha', 'Beta']);
  assert.equal(result.environment.SECRET, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE task text|do-not-copy/);
});

test('task contracts reject absolute, traversal, and ambiguous paths', () => {
  for (const path of ['/private/file', '../secret', 'src/../secret', 'src//file', 'src\\file'])
    assert.throws(() => validateAuditSpec({ ...basic, taskContract: { id: 'task', editableFiles: [path] } }), /safe ID and distinct relative/);
  assert.throws(() => validateAuditSpec({ ...basic, taskContract: { id: '../task', editableFiles: [] } }), /safe ID and distinct relative/);
});

test('trial compaction freezes the same conditions it exports on the run', () => {
  const [sourceRun] = bookingLedgerPair();
  const compact = compactAuditTrial({ runs: [sourceRun] }).runs[0];
  assert.equal(compact.comparisonEvidence.status, 'recorded');
  const frozen = compact.comparisonEvidence.conditions, exported = compact.comparisonConditions;
  for (const key of ['taskFingerprint', 'taskId', 'editableFiles', 'checkRecipes', 'qualityFingerprint',
    'setupFingerprint', 'variables', 'selectedSkills', 'profileOrder', 'trialIndex', 'baseline'])
    assert.deepEqual(frozen[key] ?? null, exported[key] ?? null, key);
  for (const key of ['platform', 'architecture', 'nodeVersion', 'settings', 'cache', 'integrations', 'epoch'])
    assert.equal(frozen.environment[key] ?? null, exported.environment[key] ?? null, `environment.${key}`);
});

test('invocation overrides bind comparison setup and survive repeated compaction', () => {
  const spec = validateAuditSpec(basic);
  const profile = { ...spec.profiles[0], nativeConfig: { model_reasoning_effort: 'low', forced_login_method: 'chatgpt' } };
  const controlled = buildAuditComparisonConditions({ spec, profile });
  const changed = buildAuditComparisonConditions({ spec, profile: { ...profile,
    nativeConfig: { ...profile.nativeConfig, model_reasoning_effort: 'high' } } });
  assert.notEqual(controlled.setupFingerprint, changed.setupFingerprint);
  const [run] = bookingLedgerPair();
  run.profile.nativeConfig = profile.nativeConfig;
  const compact = compactAuditTrial({ runs: [run] }).runs[0];
  assert.deepEqual(compact.nativeConfig, profile.nativeConfig);
  assert.deepEqual(compactAuditTrial({ runs: [compact] }).runs[0].nativeConfig, profile.nativeConfig);
});
