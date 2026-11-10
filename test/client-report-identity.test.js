import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvironmentBinding, createNativeReference } from '../src/client-contracts.js';
import { exportAuditReport, readAuditReport, projectReportResourceProvenance } from '../src/audit-store.js';

function qualified({ client = 'claude-code', jobId = 'job:one', profileId = 'profile:opaque' } = {}) {
  return { schemaVersion: 1, kind: 'audit-run', id: jobId, status: 'partial',
    profile: { id: 'Display name, not a profile identifier', profileId, client, surface: 'cli', executionLocation: 'local' },
    source: { threadId: 'native:shared' },
    clientIdentity: { client, surface: 'cli', executionLocation: 'local' },
    nativeReference: createNativeReference({ client, jobId, profileId, sessionId: 'native:shared', turnId: null }),
    environmentBinding: createEnvironmentBinding({ client, profileId, surface: 'cli', executionLocation: 'local', rootMode: 'explicit',
      roots: { config: '/fixture/config', runtime: null, user: '/fixture/user', reservation: '/fixture/reservation' },
      workspace: '/fixture/workspace', executable: { path: '/fixture/client', identity: 'fixture-build', version: null }, settingsIdentity: null }) };
}
async function directory(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-client-report-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('qualified non-Codex attribution and opaque native IDs survive export and reopen', async t => {
  const root = await directory(t);
  for (const client of ['claude-code', 'copilot', 'codex']) {
    const value = qualified({ client }), output = join(root, `${client}.json`);
    await exportAuditReport(value, { output });
    const reopened = await readAuditReport(output);
    for (const key of ['clientIdentity', 'nativeReference', 'environmentBinding']) assert.deepEqual(reopened[key], value[key]);
    assert.equal(reopened.nativeReference.turnId, null);
    assert.equal(reopened.nativeReference.itemId, null);
    assert.equal(reopened.nativeReference.requestId, null);
  }
});

test('shared native session strings stay qualified by each actual job and profile', async t => {
  const root = await directory(t);
  const value = { schemaVersion: 1, kind: 'audit-comparison', id: 'comparison',
    left: qualified(), right: qualified({ jobId: 'job:two', profileId: 'profile:second' }) };
  const output = join(root, 'comparison.json'); await exportAuditReport(value, { output });
  const reopened = await readAuditReport(output);
  assert.equal(reopened.left.nativeReference.sessionId, reopened.right.nativeReference.sessionId);
  assert.notEqual(reopened.left.nativeReference.jobId, reopened.right.nativeReference.jobId);
  assert.notEqual(reopened.left.nativeReference.profileId, reopened.right.nativeReference.profileId);
});

test('legacy fieldless and sparse unknown attribution remains sparse without inspecting arbitrary user payloads', async t => {
  const root = await directory(t);
  const legacy = { schemaVersion: 1, kind: 'audit-run', id: 'legacy', status: 'partial', profile: { id: 'Display name' },
    notes: { copiedRun: { kind: 'audit-run', nativeReference: { client: 'unsupported-user-text' } } } };
  const sparse = { ...legacy, id: 'sparse', clientIdentity: { client: 'claude-code', surface: null },
    nativeReference: { client: 'claude-code', jobId: 'sparse', profileId: 'profile:opaque', sessionId: null } };
  for (const value of [legacy, sparse]) {
    const output = join(root, `${value.id}.json`); await exportAuditReport(value, { output });
    const reopened = await readAuditReport(output);
    assert.deepEqual(reopened.notes, legacy.notes);
    for (const key of ['clientIdentity', 'nativeReference', 'environmentBinding']) {
      assert.equal(Object.hasOwn(reopened, key), Object.hasOwn(value, key));
      if (Object.hasOwn(value, key)) assert.deepEqual(reopened[key], value[key]);
    }
  }
});

const contradictions = {
  'client': run => { run.clientIdentity.client = 'codex'; },
  'surface': run => { run.clientIdentity.surface = 'desktop'; },
  'location': run => { run.environmentBinding.executionLocation = 'ssh'; },
  'job': run => { run.nativeReference.jobId = 'foreign-job'; },
  'profile': run => { run.nativeReference.profileId = 'foreign-profile'; },
  'UUID profile id': run => { run.profile.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
  'native session': run => { run.nativeReference.sessionId = 'foreign-session'; },
  'binding profile': run => { run.environmentBinding.profileId = 'foreign-profile'; },
  'binding client': run => { run.environmentBinding.client = 'copilot'; },
  'malformed explicit identity': run => { run.clientIdentity = []; },
  'unsupported explicit client': run => { run.clientIdentity.client = 'unsupported'; },
  'malformed native reference': run => { run.nativeReference.jobId = ''; },
  'malformed binding': run => { run.environmentBinding.roots.config = 'relative'; },
  'explicit null binding': run => { run.environmentBinding = null; },
};

test('contradictory or malformed attribution is rejected on projection, export and external reopen', async t => {
  const root = await directory(t);
  for (const [name, change] of Object.entries(contradictions)) await t.test(name, async () => {
    const value = qualified(); change(value);
    assert.throws(() => projectReportResourceProvenance(value), /identity|attribution|reference|binding|root|job ID/i);
    const output = join(root, `${name.replaceAll(' ', '-')}.json`);
    await assert.rejects(exportAuditReport(value, { output }));
    await writeFile(output, JSON.stringify(value));
    await assert.rejects(readAuditReport(output), /invalid/);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), value);
  });
});

test('validation reaches documented nested run locations and leaves unknown native sessions unknown', () => {
  const invalid = qualified(); invalid.nativeReference.jobId = 'foreign';
  for (const value of [
    { schemaVersion: 1, kind: 'audit-comparison', left: invalid },
    { schemaVersion: 1, kind: 'audit-experiment-report', runs: [invalid] },
    { kind: 'audit-capture-checkpoint', run: invalid },
    { record: {}, report: { schemaVersion: 1, kind: 'audit-run', ...invalid } },
  ]) assert.throws(() => projectReportResourceProvenance(value), /job identity/);
  const missing = qualified(); missing.source.threadId = null; missing.nativeReference.sessionId = null;
  assert.equal(projectReportResourceProvenance(missing).nativeReference.sessionId, null);
  delete missing.source.threadId; missing.nativeReference.sessionId = 'native-known-only-in-reference';
  assert.equal(projectReportResourceProvenance(missing).nativeReference.sessionId, 'native-known-only-in-reference');
});
