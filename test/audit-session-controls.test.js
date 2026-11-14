import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSessionControls, presentSessionControls } from '../src/audit-session-controls.js';
import { compareAuditConditions, freezeAuditComparisonEvidence } from '../src/audit-explanation.js';
import { buildAuditComparisonConditions } from '../src/audit-conditions.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

function run(model = 'model-a') {
  const execution = { model, reasoningEffort: 'high', permissionMode: 'default' };
  return { schemaVersion: 1, kind: 'audit-run', id: `run-${model}`, status: 'ready',
    clientIdentity: { client: 'codex', surface: 'cli' },
    source: { kind: 'native-app-server-v2', threadId: 'root', clientVersion: '1.2.3' },
    profile: { execution }, settingsEvidence: { requested: execution },
    comparisonConditions: buildAuditComparisonConditions({ spec: { task: 'same task' },
      baseline: { commit: 'commit-a', tree: 'tree-a' }, profile: { execution, skills: [] } }),
    agents: [{ id: 'root', parentId: null }],
    turns: [{ agentId: 'root', turnId: 'turn-1', model, reasoningEffort: 'high' }],
  };
}
const compare = (a, b) => compareSessionControls(a, b, { conditions: compareAuditConditions(a, b) });
const row = (view, id) => view.rows.find(value => value.id === id);

test('owned turn observations display the exact retained native context reference', () => {
  const value = run();
  delete value.turns[0].sourceLine;
  const proof = { agentId: 'root', turnId: 'turn-1', model: 'model-a', reasoningEffort: 'high',
    source: 'turn_context', sourceLine: 10, sourceFingerprint: 'a'.repeat(64), workspaceMatched: true };
  value.nativeControls = { turns: [proof] };
  const before = structuredClone(value);
  const observation = presentSessionControls(value).turns[0];
  assert.equal(observation.sourceLine, 10);
  assert.equal(observation.source, 'Retained native turn context');
  assert.deepEqual(value, before);
  for (const changed of [{ ...proof, model: 'foreign-model' }, { ...proof, workspaceMatched: false },
    { ...proof, sourceFingerprint: null }, { ...proof, turnId: 'foreign-turn' }]) {
    value.nativeControls.turns = [changed];
    assert.equal(presentSessionControls(value).turns[0].sourceLine, null);
  }
  value.nativeControls.turns = [proof, proof];
  assert.equal(presentSessionControls(value).turns[0].sourceLine, null);
});

test('model-only request is explicitly limited to known listed requests, never historical equivalence', () => {
  const a = run(), b = run('model-b');
  const view = compare(a, b);
  assert.equal(view.requested.label, 'Model-only request');
  assert.match(view.requested.text, /listed recorded requested controls/);
  assert.match(view.requested.text, /historical harness equivalence is unknown/);
  assert.equal(row(view, 'model-sent').status, 'unknown');
  assert.equal(row(view, 'model-confirmed').status, 'unknown');
  assert.equal(row(view, 'model-observed').status, 'unknown');
  assert.equal(row(view, 'observed-model-set').status, 'different');
  assert.equal(view.recorded.label, 'Observed models differ');
  assert.equal(row(view, 'historical-harness').status, 'unknown');
  assert.deepEqual(presentSessionControls(a).settings[0], { name: 'Model', requested: 'model-a', sent: null, confirmed: null, observed: null });
  delete b.settingsEvidence.requested.permissionMode;
  assert.equal(compare(a, b).requested.label, 'Model change requested');
  delete b.comparisonConditions.selectedSkills;
  assert.equal(compare(a, b).requested.label, 'Model change requested');
});

test('permission, effort, native version, selected skill and client changes expose concrete harness evidence', () => {
  for (const key of ['permissionMode', 'reasoningEffort']) {
    const a = run(), b = run('model-b');
    b.settingsEvidence.requested[key] = 'other';
    const view = compare(a, b);
    assert.equal(row(view, `${key}-requested`).status, 'different');
    assert.equal(view.recorded.label, 'Harness controls differ');
    assert.notEqual(view.requested.label, 'Model-only request');
  }
  for (const variation of ['version', 'skills', 'client']) {
    const a = run(), b = run('model-b');
    if (variation === 'version') b.source.clientVersion = '2.0.0';
    if (variation === 'skills') b.comparisonConditions.selectedSkills = ['review'];
    if (variation === 'client') b.clientIdentity.client = 'claude-code';
    const view = compare(a, b);
    assert.equal(view.recorded.label, 'Harness controls differ');
    if (variation === 'client') {
      assert.equal(row(view, 'client').status, 'different');
      assert.equal(row(view, 'reasoningEffort-requested').status, 'not-comparable');
      assert.equal(row(view, 'permissionMode-requested').status, 'not-comparable');
    }
  }
});

test('setup fingerprints include native model and cannot alone establish a harness change', () => {
  const a = run(), b = run('model-b');
  for (const value of [a, b]) value.comparisonConditions = buildAuditComparisonConditions({
    spec: { task: 'same task', setup: [] }, baseline: { commit: 'commit-a', tree: 'tree-a' },
    profile: { execution: value.profile.execution, skills: [], nativeConfig: { model: value.profile.execution.model } },
  });
  const view = compare(a, b);
  assert.equal(row(view, 'setup-inputs').status, 'different');
  assert.equal(row(view, 'setup-inputs').group, 'inputs');
  assert.match(row(view, 'setup-inputs').note, /entire nativeConfig, including model/);
  assert.equal(view.recorded.label, 'Observed models differ');
  assert.equal(view.requested.label, 'Model-only request');
});

test('partial, Auto and invalid evidence cannot imply actual routes or harness equivalence', () => {
  const a = run('Auto'), b = run('Auto');
  a.turns[0].model = 'route-a'; b.turns[0].model = 'route-b';
  assert.equal(compare(a, b).recorded.label, 'Observed models differ');
  delete b.turns[0].reasoningEffort;
  const partial = compare(a, b);
  assert.equal(row(partial, 'observed-model-set').status, 'unknown');
  assert.equal(partial.recorded.label, 'Historical equivalence unknown');
  b.settingsEvidence.observed = { model: 'route-b' }; a.settingsEvidence.observed = { model: 'route-a' };
  assert.equal(compare(a, b).recorded.label, 'Observed models differ');
  b.comparisonEvidence = freezeAuditComparisonEvidence(b);
  b.source.clientVersion = 'changed-after-binding';
  const invalid = compare(a, b);
  assert.ok(invalid.rows.every(value => value.status === 'unknown'));
  assert.equal(invalid.recorded.label, 'Historical equivalence unknown');
  assert.notEqual(invalid.requested.label, 'Model-only request');
  assert.equal(compareSessionControls({}, {}).recorded.label, 'Historical equivalence unknown');
});

test('actual report export and reopen preserves source-free control conclusions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-controls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = run(), b = run('model-b');
  const before = compare(a, b);
  const reopened = [];
  for (const [index, value] of [a, b].entries()) {
    const receipt = await exportAuditReport(value, { output: join(directory, `run-${index}.json`), format: 'json' });
    reopened.push(await readAuditReport(receipt.evidencePath));
  }
  assert.deepEqual(compare(...reopened), before);
  const sourceFree = reopened.map(value => {
    const out = structuredClone(value);
    delete out.turns; delete out.agents; delete out.events; delete out.toolInvocations;
    return out;
  });
  assert.deepEqual(compare(...sourceFree), before);
});

test('an observed effort change or a different task prevents presenting the pair as an isolated model experiment', () => {
  const a = run(), b = run('model-b');
  b.turns[0].reasoningEffort = 'low';
  assert.equal(row(compare(a, b), 'observed-effort-set').status, 'different');
  assert.equal(compare(a, b).recorded.label, 'Harness controls differ');
  b.comparisonConditions.taskFingerprint = 'f'.repeat(64);
  assert.equal(compare(a, b).recorded.label, 'Task or baseline inputs differ');
  b.clientIdentity.client = 'claude-code';
  assert.equal(row(compare(a, b), 'native-version').status, 'not-comparable');
});

test('original client surface changes are visible while import read context remains separate', () => {
  const a = run(), b = run('model-b');
  b.clientIdentity.surface = 'desktop';
  assert.equal(row(compare(a, b), 'surface').status, 'different');
  assert.equal(compare(a, b).recorded.label, 'Harness controls differ');
  for (const value of [a, b]) {
    value.source.kind = 'claude-code-sdk-file-import';
    value.clientIdentity.client = 'claude-code';
    value.source.readContext = { surface: 'desktop', executionLocation: 'local' };
  }
  assert.equal(row(compare(a, b), 'surface').status, 'unknown');
  assert.equal(row(compare(a, b), 'execution-location').status, 'unknown');
});
