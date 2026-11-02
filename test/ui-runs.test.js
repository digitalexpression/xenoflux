import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';
import { createExperiment, createExperimentRun, readAuditRecord, writeAuditState, reserveAuditProfile, inspectAuditReservation } from '../src/audit-experiment-store.js';
import { validateAuditSpec } from '../src/audit-spec.js';
import { createUiRuns } from '../src/ui-runs.js';
import { inspectAuditRepository } from '../src/audit-workspace.js';

async function fixture(t, mode) {
  const app = await createUiRunsFixture({ mode });
  t.after(() => app.close());
  return app;
}
const request = app => ({ task: 'PRIVATE U3 TASK TEXT', files: '', a: 'baseline', b: 'strict-review', repository: app.repository, commit: 'HEAD', checks: [] });
async function waitFor(read, predicate, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

test('run preview is read-only and binds exactly two profiles, commands and limits', async t => {
  const app = await fixture(t);
  const input = { ...request(app), files: 'README.md', checks: [{ name: 'smoke', command: 'true' }],
    advanced: { timeMinutes: 2, outputMiB: 4, sandbox: 'read-only', program: '', reasoningEffort: 'high', setup: [{ name: 'prepare', command: 'true' }] } };
  const preview = await app.provider.runPreview(input);
  assert.equal(preview.ready, true);
  assert.match(preview.previewToken, /^[0-9a-f-]{36}$/);
  assert.match(preview.where.join('\n'), /Pinned commit: [0-9a-f]{40}/);
  assert.match(preview.limits.join('\n'), /read-only.*network disabled/);
  assert.match(preview.limits.join('\n'), /prepare: true/);
  assert.match(preview.checks[0], /smoke: true/);
  assert.equal(app.calls.captures.length, 0);
  await assert.rejects(access(join(app.store.directory, 'audits')), { code: 'ENOENT' });
  await assert.rejects(access(join(app.store.directory, 'ui-runs')), { code: 'ENOENT' });
  await assert.rejects(app.provider.runPreview({ ...request(app), b: 'baseline' }), { code: 'invalid-run' });
  await assert.rejects(app.provider.startRun({ ...request(app) }), { code: 'invalid-run' });
});

test('uncapped run preview and progress keep the overall limit explicitly null', async t => {
  const app = await fixture(t, { capture: 'delayed' });
  const preview = await app.provider.runPreview({ ...request(app), advanced: { timeMinutes: null } });
  assert.equal(preview.ready, true);
  assert.equal(preview.limit, 'No time cap');
  assert.match(preview.summary, /No time cap/);
  assert.ok(preview.limits.some(row => /No time cap per profile; No time cap overall/.test(row)));

  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  await waitFor(() => app.calls.captures.length, count => count === 1, 'Uncapped capture did not start');
  const progress = await app.provider.run(started);
  assert.equal(progress.state, 'running');
  assert.equal(progress.timeUsed, null);
  assert.match(progress.elapsed, /overall limit No time cap/);
  const current = await readAuditRecord(app.store, started.id);
  assert.equal(current.record.spec.limits.runMs, null);
  assert.equal(current.record.spec.limits.experimentMs, null);
  await app.provider.cancelRun(started);
});

test('a reviewed run starts once across concurrent retries and provider restart', async t => {
  const app = await fixture(t);
  const preview = await app.provider.runPreview(request(app));
  const [first, second] = await Promise.all([app.provider.startRun({ previewToken: preview.previewToken }), app.provider.startRun({ previewToken: preview.previewToken })]);
  assert.deepEqual(first, second);
  const view = await waitFor(() => app.provider.run(first), value => value.state !== 'running', 'Run did not settle');
  assert.equal(view.state, 'finished');
  assert.deepEqual(app.calls.captures, ['baseline', 'strict-review']);
  const report = await app.provider.report({ ref: `e.${first.id}` });
  assert.equal(report.title, 'Task comparison');
  assert.equal(report.progressHref, `/runs/${first.id}`);
  assert.match(report.outcome.summary, /baseline: 0 tracked files · 0 ignored files or artifacts/);
  assert.deepEqual(report.outcome.files, []);
  const current = await readAuditRecord(app.store, first.id);
  assert.equal(current.record.spec.revision.length, 40);
  assert.equal(current.report.runs.length, 2);
  await app.restartServer();
  assert.deepEqual(await app.provider.startRun({ previewToken: preview.previewToken }), first);
  assert.deepEqual(app.calls.captures, ['baseline', 'strict-review']);
  const exported = await app.provider.exportReport({ ref: `e.${first.id}` });
  const evidence = await readFile(join(exported.folder, exported.files.find(name => name.endsWith('.audit.json'))), 'utf8');
  assert.equal(evidence.includes(request(app).task), false, 'the private task text is not an exported title or payload');
});

test('native sandbox preflight failure stays failed, marks unreached checks skipped, and survives report reopen safely', async t => {
  const app = await fixture(t, { capture: 'sandbox-unavailable' });
  const preview = await app.provider.runPreview({ ...request(app), checks: [{ name: 'smoke', command: 'true' }] });
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const progress = await waitFor(() => app.provider.run(started).catch(() => null), value => value && value.state !== 'running', 'Run did not settle');
  expectFailureProgress(progress);
  assert.deepEqual(app.calls.checks, []);
  const original = await app.provider.report({ ref: `e.${started.id}` });
  expectFailureReport(original);
  const exported = await app.provider.exportReport({ ref: `e.${started.id}` });
  const markdownPath = join(exported.folder, exported.files.find(name => name.endsWith('.md')));
  const markdown = await readFile(markdownPath, 'utf8');
  assert.match(markdown, /native command sandbox could not be verified, so the model task did not start/);
  assert.equal(markdown.includes('PRIVATE RAW STARTUP DETAIL'), false);
  const evidencePath = join(exported.folder, exported.files.find(name => name.endsWith('.audit.json')));
  const text = await readFile(evidencePath, 'utf8');
  assert.ok(text.includes('startup-command-sandbox-unavailable'), 'the recorded failure code survives freezing');
  const reopened = await app.provider.openReport({ fileName: 'sandbox-failure.audit.json', text });
  expectFailureReport(await app.provider.report({ ref: reopened.ref }));
});

test('sandbox preflight code does not override recorded native completion and check results', async t => {
  const app = await fixture(t, { capture: 'sandbox-error-with-turn' });
  const preview = await app.provider.runPreview({ ...request(app), checks: [{ name: 'smoke', command: 'true' }] });
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const progress = await waitFor(() => app.provider.run(started).catch(() => null), value => value && value.state !== 'running', 'Run did not settle');
  assert.equal(progress.state, 'finished');
  assert.ok(progress.columns.every(column => column.steps.some(step => step.text === 'Model task' && step.state === 'done')));
  assert.ok(progress.columns.every(column => column.steps.some(step => step.text === 'Verification checks' && step.state === 'done')));
  const report = await app.provider.report({ ref: `e.${started.id}` });
  for (const cell of report.verification.cells) {
    assert.deepEqual(cell.executionFailures, ['Native command sandbox preflight reported an unavailable check.']);
    assert.ok(cell.checks.some(check => /smoke.*passed/.test(check.text)));
    assert.ok(!cell.checks.some(check => /skipped because the model task did not start/.test(check.text)));
  }
});

test('completed tasks with partial capture retain their checks and paired files through export', async t => {
  const app = await fixture(t, { capture: 'partial' });
  const preview = await app.provider.runPreview({ ...request(app), files: 'README.md', checks: [{ name: 'smoke', command: 'true' }],
    advanced: { program: app.executable } });
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const progress = await waitFor(() => app.provider.run(started), value => value.state !== 'running', 'Run did not settle');
  assert.equal(progress.state, 'finished-partial');
  assert.equal(progress.stateText, 'Tasks completed · evidence partial');
  assert.ok(progress.columns.every(column => column.steps.every(step => step.state === 'done' || step.state === 'skipped')));
  assert.equal(app.calls.checks.length, 2);
  const ref = `e.${started.id}`;
  const report = await app.provider.report({ ref });
  assert.deepEqual(report.outcome.files, [{ path: 'README.md', a: 'Changed', b: 'Changed', category: 'tracked' }]);
  assert.ok(report.limits.some(limit => /Skill use: partly recorded/.test(limit)));
  const exported = await app.provider.exportReport({ ref });
  const text = await readFile(join(exported.folder, exported.files.find(name => name.endsWith('.audit.json'))), 'utf8');
  const reopened = await app.provider.openReport({ fileName: 'partial.audit.json', text });
  assert.deepEqual((await app.provider.report({ ref: reopened.ref })).outcome.files, report.outcome.files);
  await app.restartServer();
  assert.equal((await app.provider.run(started)).state, 'finished-partial');
  assert.deepEqual(app.calls.captures, ['baseline', 'strict-review']);
});

test('a failed check takes precedence over completed tasks with partial evidence', async t => {
  const app = await fixture(t, { capture: 'partial', check: 'fail' });
  const preview = await app.provider.runPreview({ ...request(app), checks: [{ name: 'smoke', command: 'true' }] });
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const progress = await waitFor(() => app.provider.run(started), value => value.state !== 'running', 'Run did not settle');
  assert.equal(progress.state, 'check-failed');
});

function expectFailureProgress(progress) {
  assert.equal(progress.state, 'failed');
  for (const column of progress.columns) {
    assert.equal(column.steps.find(step => step.text === 'Model task did not start')?.state, 'failed');
    assert.equal(column.steps.find(step => step.text === 'Verification checks skipped')?.state, 'skipped');
    assert.match(column.failure, /native command sandbox could not be verified/);
    assert.equal(JSON.stringify(column).includes('PRIVATE RAW STARTUP DETAIL'), false);
  }
}

function expectFailureReport(report) {
  assert.equal(report.verification.cells.length, 2);
  for (const cell of report.verification.cells) {
    assert.deepEqual(cell.executionFailures, ['The native command sandbox could not be verified, so the model task did not start.']);
    assert.ok(cell.checks.some(check => /smoke.*skipped because the model task did not start/.test(check.text)));
  }
  assert.equal(JSON.stringify(report).includes('PRIVATE RAW STARTUP DETAIL'), false);
}

test('a setup change after preview prevents any experiment or model task from starting', async t => {
  const app = await fixture(t);
  const preview = await app.provider.runPreview(request(app));
  assert.equal(preview.ready, true);
  await writeFile(join(app.homes.baseline.home, 'AGENTS.md'), 'Changed after review.\n', { mode: 0o600 });
  await assert.rejects(app.provider.startRun({ previewToken: preview.previewToken }), { code: 'preview-stale' });
  assert.equal(app.calls.captures.length, 0);
  await assert.rejects(access(join(app.store.directory, 'audits')), { code: 'ENOENT' });
});

test('completed first-profile steps remain complete while the second profile is running', async t => {
  const app = await fixture(t, { capture: 'delayed' });
  const preview = await app.provider.runPreview({ ...request(app), checks: [{ name: 'smoke', command: 'true' }],
    advanced: { setup: [{ name: 'prepare', command: 'true' }] } });
  const run = await app.provider.startRun({ previewToken: preview.previewToken });
  await waitFor(async () => app.calls.captures.length, count => count === 1, 'First capture did not start');
  app.releaseCapture();
  await waitFor(async () => app.calls.captures.length, count => count === 2, 'Second capture did not start');
  const view = await app.provider.run(run);
  assert.equal(view.state, 'running');
  const first = view.columns[0].steps;
  for (const label of ['Prepared copy', 'Setup commands', 'Model task', 'Verification checks'])
    assert.equal(first.find(step => step.text === label)?.state, 'done', `${label} remains complete`);
  assert.equal(view.columns[1].steps.find(step => step.text === 'Model task').state, 'active');
  await app.provider.cancelRun(run);
});

test('server shutdown during start revalidation never launches the experiment afterward', async t => {
  const app = await fixture(t);
  let hold = false, release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const manager = createUiRuns({ store: app.store, defaultUserHome: join(app.root, 'default-user-home'),
    context: { ...app.runContext, inspectRepository: async (...args) => {
      if (hold) { entered(); await gate; }
      return inspectAuditRepository(...args);
    } } });
  const preview = await manager.runPreview(request(app));
  hold = true;
  const start = manager.startRun({ previewToken: preview.previewToken });
  await reached;
  const stopped = manager.close();
  release();
  await assert.rejects(start, { code: 'stopping' });
  await stopped;
  assert.equal(app.calls.captures.length, 0);
  await assert.rejects(access(join(app.store.directory, 'audits')), { code: 'ENOENT' });
});

test('cancelling only the owned task retains partial evidence and does not start the second profile', async t => {
  const app = await fixture(t, { capture: 'delayed' });
  const preview = await app.provider.runPreview({ ...request(app), checks: [{ name: 'smoke', command: 'true' }] });
  const run = await app.provider.startRun({ previewToken: preview.previewToken });
  await waitFor(async () => app.calls.captures.length, count => count === 1, 'Capture did not start');
  const result = await app.provider.cancelRun(run);
  assert.equal(result.state, 'cancelled');
  assert.ok(result.reportHref);
  assert.deepEqual(app.calls.captures, ['baseline']);
  const current = await readAuditRecord(app.store, run.id);
  assert.equal(current.finalized, true);
  assert.equal(current.report.status, 'cancelled');
  assert.ok(result.columns[1].steps.find(step => step.text === 'Model task not started' && step.state === 'skipped'));
  assert.ok(!result.columns[1].steps.some(step => step.text === 'Prepared copy' && step.state === 'done'));
  const comparison = await app.provider.report({ ref: `e.${run.id}` });
  assert.equal(comparison.verification.none, false, 'selected checks without results are not no-checks-selected');
  assert.ok(comparison.verification.cells.every(cell => cell.checks.some(check => /selected; no result was recorded/.test(check.text))));
});

test('stopping and reopening the server reports interruption without repeating a task', async t => {
  const app = await fixture(t, { capture: 'delayed' });
  const preview = await app.provider.runPreview(request(app));
  const run = await app.provider.startRun({ previewToken: preview.previewToken });
  await waitFor(async () => app.calls.captures.length, count => count === 1, 'Capture did not start');
  await app.restartServer();
  const result = await app.provider.run(run);
  assert.equal(result.state, 'interrupted');
  assert.ok(result.reportHref);
  assert.equal((await app.provider.info()).activeRun, null);
  assert.ok((await app.provider.overview()).recent.some(item => item.href === `/runs/${run.id}`));
  await app.provider.startRun({ previewToken: preview.previewToken });
  assert.deepEqual(app.calls.captures, ['baseline']);
});

test('recovery previews stopped owned records, rejects an unreviewed apply, and retains both partial sides', async t => {
  const app = await fixture(t);
  const input = { ...request(app), a: 'Default' }, spec = validateAuditSpec({ schemaVersion: 1, repository: app.repository, revision: 'HEAD',
    task: input.task, profiles: [input.a, input.b], allowIncompleteCapture: true });
  const strict = (await app.store.read()).profiles.find(profile => profile.name === 'strict-review');
  const profiles = [{ profileId: 'default', profileName: 'Default', home: join(app.root, 'default-user-home', '.codex') },
    { profileId: strict.id, profileName: strict.name, home: app.homes.strict.home }];
  const parent = await createExperiment(app.store, { spec, task: spec.task, profiles });
  let defaultLease;
  for (const profile of profiles) {
    const child = await createExperimentRun(app.store, { experimentId: parent.id, profile });
    if (profile.profileId === 'default') {
      const owner = { kind: 'audit-experiment', host: hostname(), pid: process.pid, runId: child.id,
        experimentId: parent.id, storePath: app.store.directory, profileId: 'default', home: profile.home };
      defaultLease = { root: profile.home, owner };
      await reserveAuditProfile(defaultLease);
    }
    await writeAuditState(app.store, child.id, { coordinator: { pid: 2147483000, host: hostname(),
      processIdentity: { pid: 2147483000, started: 'fixture-stopped', host: hostname() } }, process: null,
      reservation: profile.profileId === 'default' ? defaultLease : null });
  }
  await mkdir(join(app.store.directory, 'ui-runs'), { mode: 0o700 });
  await writeFile(join(app.store.directory, 'ui-runs', `${parent.id}.json`), JSON.stringify({ id: parent.id,
    createdAt: new Date().toISOString(), profiles: [input.a, input.b] }), { mode: 0o600 });
  const before = await readFile(join(parent.directory, 'state.json'), 'utf8');
  const view = await app.provider.run({ id: parent.id });
  assert.equal(view.state, 'interrupted');
  assert.equal(view.recovery.facts.length, 2);
  assert.equal(await readFile(join(parent.directory, 'state.json'), 'utf8'), before);
  await assert.rejects(app.provider.recoverRun({ id: parent.id, previewToken: 'unreviewed' }), { code: 'preview-stale' });
  const recovered = await app.provider.recoverRun({ id: parent.id, previewToken: view.recovery.previewToken });
  assert.equal(recovered.recovery, null);
  const current = await readAuditRecord(app.store, parent.id);
  assert.equal(current.finalized, true);
  assert.equal(current.report.runs.length, 2);
  assert.equal(await inspectAuditReservation(defaultLease), null, 'Default recovery releases only its exact owned lease');
  assert.equal(app.calls.captures.length, 0);
  assert.ok(recovered.reportHref);
});
