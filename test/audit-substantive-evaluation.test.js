import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareEvaluation } from '../test-support/substantive-evaluation/prepare.mjs';
import { checkCandidate, workspaceFiles } from '../test-support/substantive-evaluation/check-candidate.mjs';
import { authorizeAuditWorkspaceParent, createAuditWorkspace } from '../src/audit-workspace.js';
import { auditQualityFingerprint, evaluateAuditQuality } from '../src/audit-quality.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test('substantive evaluation prepares twelve blocked slots and verifies starter/reference, scope and review boundaries offline', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-substantive-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'prepared'), manifest = await prepareEvaluation(output), manifestPath = join(output, 'campaign.json');
  assert.equal(manifest.paidExecutionAuthorized, false);
  assert.equal(manifest.executionApprovalRequired.model, null);
  assert.equal(manifest.design.plannedRuns, 12);
  const prepared = JSON.parse(await readFile(join(output, 'preparation.json')));
  assert.equal(prepared.paidCalls, 0); assert.equal(prepared.nativeCalls, 0);
  assert.deepEqual(prepared.previews.map(row => row.schedule), [
    [['EvalBaseline', 'EvalWorkflow'], ['EvalWorkflow', 'EvalBaseline']],
    [['EvalWorkflow', 'EvalBaseline'], ['EvalBaseline', 'EvalWorkflow']],
    [['EvalBaseline', 'EvalWorkflow'], ['EvalWorkflow', 'EvalBaseline']],
  ]);
  assert.equal(await readFile(join(manifest.profileHomes[0], 'config.toml'), 'utf8'), await readFile(join(manifest.profileHomes[1], 'config.toml'), 'utf8'));
  await assert.rejects(readFile(join(manifest.profileHomes[0], 'skills/evaluation-workflow/SKILL.md')), { code: 'ENOENT' });
  assert.match(await readFile(join(manifest.profileHomes[1], 'skills/evaluation-workflow/SKILL.md'), 'utf8'), /name: evaluation-workflow/);
  for (const home of manifest.profileHomes) await assert.rejects(readFile(join(home, 'auth.json')), { code: 'ENOENT' });
  const launcher = spawnSync(manifest.fixtureLauncher, ['app-server'], { env: { HOME: root }, encoding: 'utf8', timeout: 3000 });
  assert.equal(launcher.status, 78); assert.match(launcher.stderr, /not authorized/);
  await assert.rejects(prepareEvaluation(output), { code: 'EEXIST' });

  const base = join(root, 'audits'); await mkdir(base, { mode: 0o700 });
  const exported = [];
  for (const task of manifest.tasks) await t.test(task.id, async () => {
    const spec = JSON.parse(await readFile(task.specPath));
    assert.equal(auditQualityFingerprint(spec.quality, spec.checks), task.qualityFingerprint);
    assert.equal(spec.quality.rubric.required, true);
    assert.deepEqual(spec.captureRequirements.context, [{ agents: 'root', origin: 'repository', path: 'AGENTS.md', phase: 'before-task' }]);
    const cli = spawnSync(process.execPath, [join(repo, 'bin/xfx.js'), '--store', manifest.store, '--json', 'audit', 'run', '--spec', task.specPath, '--dry-run'],
      { cwd: repo, env: { PATH: process.env.PATH, HOME: join(output, 'preparation-home') }, encoding: 'utf8', timeout: 15000 });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).kind, 'audit-series-preview');
    assert.equal(JSON.parse(cli.stdout).plannedRuns, 4);
    assert.deepEqual(await workspaceFiles(task.repository), task.workspaceFiles);
    const files = Object.keys(task.workspaceFiles);
    assert.ok(files.every(name => !/oracle|reference/.test(name)));
    assert.ok(files.includes('AGENTS.md') && files.includes('test/visible.test.js'));
    const parent = join(base, task.id), owner = { experimentId: 'fixture-experiment', runId: task.id };
    await mkdir(parent, { mode: 0o700 });
    await authorizeAuditWorkspaceParent({ parentDirectory: parent, baseDirectory: base, owner });
    const workspace = join(parent, 'workspace');
    await createAuditWorkspace({ repository: task.repository, commit: task.revision, directory: workspace, owner });
    const starter = await checkCandidate(manifestPath, task.id, workspace);
    assert.equal(starter.passed, false);
    assert.deepEqual(starter.suites.map(suite => suite.passed), [false, false], 'both suites execute despite starter failure');
    const definition = JSON.parse(await readFile(join(repo, 'test-support/substantive-evaluation/tasks', task.id, 'task.json')));
    for (const [target, reference] of Object.entries(definition.referenceFiles))
      await cp(join(repo, 'test-support/substantive-evaluation/tasks', task.id, reference), join(workspace, target));
    const reference = await checkCandidate(manifestPath, task.id, workspace);
    assert.equal(reference.passed, true, reference.stdout + reference.stderr);
    assert.deepEqual(reference.suites.map(suite => suite.passed), [true, true]);
    await writeFile(join(workspace, 'test/visible.test.js'), 'import test from "node:test"; test("tampered",()=>{});\n');
    await assert.rejects(checkCandidate(manifestPath, task.id, workspace), /fixture-scope-changed/);
    await writeFile(join(workspace, 'test/visible.test.js'), await readFile(join(task.repository, 'test/visible.test.js')));
    const sourcePath = join(workspace, task.editableFiles[0]), referenceSource = await readFile(sourcePath, 'utf8');
    await writeFile(sourcePath, `import {writeFileSync as fixtureWrite} from 'node:fs';\nfixtureWrite('unexpected-runtime-file.txt','side effect');\n${referenceSource}`);
    await assert.rejects(checkCandidate(manifestPath, task.id, workspace), /fixture-check-mutated-input/);
    await rm(join(workspace, 'unexpected-runtime-file.txt')); await writeFile(sourcePath, referenceSource);
    assert.deepEqual(await workspaceFiles(task.repository), task.workspaceFiles, 'controls never mutate committed starter source');

    // Explicit synthetic record tests required-review/export behavior. It is not
    // model performance, native capture, or a human rating.
    const value = { schemaVersion: 1, kind: 'audit-run', id: `fixture-only-${task.id}`, status: 'partial',
      source: { kind: 'fixture-only-no-model' }, execution: { status: 'exited', exitCode: 0 },
      task: { nativeTurnStatus: 'completed' }, checks: [{ name: 'acceptance-suite', status: 'passed', exitCode: 0 }],
      coverage: { agents: 'partial', skills: 'partial' }, workspace: { taskEnd: { captureComplete: true, timing: 'task-end',
        changeCountStatus: 'known', changedFileCount: 1, changeCountBasis: 'post-setup-snapshot-delta-v1', fingerprint: 'synthetic-control-only' } } };
    value.quality = evaluateAuditQuality(value, spec.quality, { checks: spec.checks });
    assert.equal(value.quality.rubric.status, 'pending-review');
    assert.equal(value.quality.status, 'incomplete');
    for (const format of ['json', 'markdown']) {
      const receipt = await exportAuditReport(value, { output: join(root, `${task.id}.${format}`), format }); exported.push(receipt);
      assert.doesNotMatch(await readFile(receipt.output, 'utf8'), /REQUIRES_HUMAN_REVIEWER/);
    }
  });
  await rm(output, { recursive: true, force: true }); await rm(base, { recursive: true, force: true });
  for (const receipt of exported) {
    const reopened = await readAuditReport(receipt.evidencePath);
    assert.equal(reopened.source.kind, 'fixture-only-no-model');
    assert.equal(reopened.quality.status, 'incomplete'); assert.equal(reopened.quality.rubric.status, 'pending-review');
  }
});
