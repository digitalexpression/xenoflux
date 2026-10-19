import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { createResourceProvenance } from '../src/audit-provenance.js';
import { createExperiment, createExperimentRun, writeAuditState, writeAuditCaptureCheckpoint, readAuditRecord } from '../src/audit-experiment-store.js';
import { recoverAuditExperiment } from '../src/audit-experiment.js';
import { readAuditReport, exportAuditReport } from '../src/audit-store.js';

test('private checkpoint recovery and exports retain captured provenance after definitions are removed', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-provenance-checkpoint-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), directory = join(workspace, '.agents/skills/checkpoint');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const definition = join(directory, 'SKILL.md'); await writeFile(definition, 'PRIVATE_CHECKPOINT_DEFINITION', { mode: 0o600 });
  const provenance = createResourceProvenance({ workspace });
  const threadId = '11111111-1111-4111-8111-111111111111';
  await provenance.observeCatalog([{ id: 'checkpoint-skill', name: 'checkpoint', path: definition, origin: 'repository', scope: 'project' }], { agentId: threadId, phase: 'before-task' });
  const block = provenance.snapshot(); assert.ok(block.resources[0]?.snapshots[0]?.definition.fingerprint);
  const controller = join(root, 'controller'); await mkdir(controller, { mode: 0o700 });
  const store = new Store(controller), profile = { id: 'fixture', profileId: 'fixture', profileName: 'fixture', home: workspace };
  const parent = await createExperiment(store, { spec: {}, task: 'fixture', profiles: [profile] });
  const run = await createExperimentRun(store, { experimentId: parent.id, profile });
  const report = { schemaVersion: 1, kind: 'audit-run', id: run.id, status: 'partial', profile,
    source: { threadId, kind: 'native-app-server-v2' }, resourceProvenance: { ...block, rawBody: 'PRIVATE_INJECTED_BODY', absolutePath: '/private/secret' },
    agents: [], turns: [], skills: [], events: [], warnings: [], coverage: { skills: 'partial' }, metrics: {} };
  await writeAuditCaptureCheckpoint(store, run.id, { run: report, capture: { status: 'partial' } });
  await writeAuditState(store, run.id, { status: 'running', phase: 'capture', nativeSessionId: threadId, process: null, coordinator: { pid: 999999, started: 'fixture-start' } });
  const disk = await readFile(join(run.directory, 'capture-checkpoint.json'), 'utf8');
  assert.doesNotMatch(disk, /PRIVATE_INJECTED_BODY|PRIVATE_CHECKPOINT_DEFINITION|absolutePath/);
  assert.deepEqual((await readAuditRecord(store, run.id)).captureCheckpoint.run.resourceProvenance, block);
  await rm(join(workspace, '.agents'), { recursive: true });
  let nativeReads = 0;
  const recovered = await recoverAuditExperiment(store, run.id, { apply: true, observeProcess: async () => ({ status: 'stopped' }), readNative: async () => { nativeReads++; throw new Error('Forbidden fresh native read'); } });
  assert.equal(nativeReads, 0); assert.equal(recovered.status, 'recovered');
  const final = (await readAuditRecord(store, run.id)).report;
  assert.deepEqual(final.resourceProvenance, block);
  assert.equal(final.status, 'partial');
  const json = join(root, 'frozen.json'), markdown = join(root, 'frozen.md');
  await exportAuditReport(final, { output: json }); await exportAuditReport(final, { output: markdown, format: 'markdown' });
  assert.deepEqual((await readAuditReport(json)).resourceProvenance, block);
  assert.deepEqual((await readAuditReport(markdown + '.audit.json')).resourceProvenance, block);
  assert.equal(nativeReads, 0);
});
