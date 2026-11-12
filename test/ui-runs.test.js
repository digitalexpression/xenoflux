import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createUiRunsFixture } from '../test-support/ui-runs-fixture.js';
import { createExperiment, createExperimentRun, readAuditRecord, writeAuditState, reserveAuditProfile, inspectAuditReservation } from '../src/audit-experiment-store.js';
import { validateAuditSpec } from '../src/audit-spec.js';
import { createUiRuns } from '../src/ui-runs.js';
import { inspectAuditRepository } from '../src/audit-workspace.js';
import { resolveAuditExecutionProfile, snapshotAuditProfileSettings } from '../src/audit-profile.js';

async function fixture(t, mode) {
  const app = await createUiRunsFixture({ mode });
  t.after(() => app.close());
  return app;
}
const request = app => ({ task: 'PRIVATE U3 TASK TEXT', files: '', a: 'baseline', b: 'strict-review', repository: app.repository, commit: 'HEAD', checks: [] });

test('a fake second client completes a comparison through the runtime registry and retained reports', async t => {
  const app = await fixture(t);
  const dispatched = [];
  const capture = client => async input => {
    dispatched.push(client);
    assert.equal(input.profile.client, client);
    return app.runContext.capture(input);
  };
  const service = createUiRuns({ store: app.store, defaultUserHome: join(app.root, 'default-user-home'),
    context: { ...app.runContext, capture: capture('codex'),
      clientRuntimes: { 'claude-code': { capture: capture('claude-code') } },
      resolveProfile: async (...args) => {
        const profile = await resolveAuditExecutionProfile(...args);
        if (profile.profileName !== 'strict-review') return profile;
        return { ...profile, client: 'claude-code', ...(profile.environmentBinding ? { environmentBinding: { ...profile.environmentBinding, client: 'claude-code' } } : {}) };
      },
    } });
  t.after(() => service.close());
  const preview = await service.runPreview(request(app));
  assert.equal(preview.ready, true);
  const started = await service.startRun({ previewToken: preview.previewToken });
  const done = await waitFor(() => service.run(started), value => value.state !== 'running', 'Mixed fixture comparison did not finish');
  const parent = await readAuditRecord(app.store, started.id);
  assert.equal(done.state, 'finished', JSON.stringify(parent.report.failures));
  assert.deepEqual(dispatched, ['codex', 'claude-code']);
  const children = await Promise.all(parent.state.runs.map(({ id }) => readAuditRecord(app.store, id)));
  assert.deepEqual(children.map(child => child.report.clientIdentity.client), ['codex', 'claude-code']);
  assert.deepEqual(children.map(child => child.report.nativeReference.client), ['codex', 'claude-code']);
  assert.ok(done.reportHref);
});
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
    execution: { a: { reasoningEffort: 'max', permissionMode: 'read-only' }, b: { reasoningEffort: 'max' } },
    advanced: { timeMinutes: 2, outputMiB: 4, program: '', setup: [{ name: 'prepare', command: 'true' }] } };
  for (const profile of ['baseline', 'strict-review'])
    await app.provider.refreshCatalog({ requestId: randomUUID(), profile, workspace: app.repository });
  const discoveries = app.calls.catalogs.length;
  const preview = await app.provider.runPreview(input);
  assert.equal(app.calls.catalogs.length, discoveries);
  assert.equal(preview.ready, true);
  assert.match(preview.previewToken, /^[0-9a-f-]{36}$/);
  assert.match(preview.where.join('\n'), /Pinned commit: [0-9a-f]{40}/);
  assert.match(preview.limits.join('\n'), /read-only.*network disabled/);
  assert.match(preview.limits.join('\n'), /prepare: true/);
  assert.match(preview.checks[0], /smoke: true/);
  assert.equal(app.calls.captures.length, 0);
  await assert.rejects(access(join(app.store.directory, 'audits')), { code: 'ENOENT' });
  await assert.rejects(access(join(app.store.directory, 'ui-runs')), { code: 'ENOENT' });
  const same = await app.provider.runPreview({ ...request(app), b: 'baseline',
    execution: { a: { model: 'fixture-left' }, b: { model: 'fixture-right' } } });
  assert.equal(same.ready, true);
  assert.match(same.runs[0].text, /fixture-left/);
  assert.match(same.runs[1].text, /fixture-right/);
  for (const execution of [null, { a: null }, { a: { approvalPolicy: 'never' } }])
    await assert.rejects(app.provider.runPreview({ ...request(app), execution }), { code: 'invalid-run' });
  await assert.rejects(app.provider.startRun({ ...request(app) }), { code: 'invalid-run' });
});

test('preview never discovers models and explicit choices require separate refresh before preview and Start', async t => {
  const app = await fixture(t);
  assert.equal((await app.provider.runPreview(request(app))).ready, true);
  const input = { ...request(app), execution: {
    a: { model: 'fixture-left', reasoningEffort: 'max' },
    b: { model: 'fixture-right', reasoningEffort: 'high' },
  } };
  await assert.rejects(app.provider.runPreview(input), { status: 422, code: 'catalog-unavailable' });
  assert.deepEqual(app.calls.catalogs, []);
  assert.deepEqual(app.calls.captures, []);
  for (const profile of ['baseline', 'strict-review'])
    await app.provider.refreshCatalog({ requestId: randomUUID(), profile, workspace: app.repository });
  assert.equal(app.calls.catalogs.length, 2);
  const preview = await app.provider.runPreview(input);
  assert.equal(preview.ready, true);
  await assert.rejects(app.provider.runPreview({ ...input, execution: { ...input.execution,
    a: { model: 'removed-native-model', reasoningEffort: 'max' } } }), { status: 422, code: 'catalog-model-unavailable' });
  await assert.rejects(app.provider.runPreview({ ...input, execution: { ...input.execution,
    a: { model: 'fixture-left', reasoningEffort: 'high' } } }), { status: 422, code: 'catalog-effort-unavailable' });
  assert.deepEqual(app.calls.captures, []);
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const completed = await waitFor(() => app.provider.run(started), value => value.state !== 'running', 'Explicit run did not settle');
  assert.equal(completed.state, 'finished');
  assert.equal(app.calls.catalogs.length, 2, 'preview and Start do not launch another discovery probe');
  const current = await readAuditRecord(app.store, started.id);
  assert.deepEqual(current.record.spec.profiles.map(profile => profile.execution), [input.execution.a, input.execution.b]);
});

test('run history reports an unsafe receipt directory instead of presenting it as empty', async t => {
  const app = await fixture(t);
  const receiptRoot = join(app.store.directory, 'ui-runs');
  await writeFile(receiptRoot, 'not a directory', { mode: 0o600 });

  await assert.rejects(app.provider.overview(), /Expected a private directory/);
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
  await assert.rejects(app.provider.startRun({ previewToken: preview.previewToken }), error => {
    assert.equal(error.code, 'preview-stale');
    assert.deepEqual(error.details.changes, [{ reason: 'profile-settings-changed', side: 'a', profile: 'baseline',
      changedPaths: ['$CODEX_HOME/AGENTS.md'] }]);
    assert.equal(JSON.stringify(error.details).includes('Changed after review.'), false);
    return true;
  });
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

test('cancel stops owned work even after its UI receipt disappears', async t => {
  const app = await fixture(t, { capture: 'delayed' });
  const preview = await app.provider.runPreview(request(app));
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  await waitFor(() => app.calls.captures.length, count => count === 1, 'Capture did not start');
  await rm(join(app.store.directory, 'ui-runs', `${started.id}.json`));
  assert.equal((await app.provider.cancelRun(started)).state, 'cancelled');
  assert.equal((await app.provider.info()).activeJobs.length, 0);
  assert.equal((await readAuditRecord(app.store, started.id)).report.status, 'cancelled');
});

test('shutdown stops every owned job when one receipt is corrupt', async t => {
  const app = await fixture(t, { capture: 'delayed' });
  const previews = await Promise.all([app.provider.runPreview(request(app)), app.provider.runPreview(request(app))]);
  const started = await Promise.all(previews.map(preview => app.provider.startRun({ previewToken: preview.previewToken })));
  await waitFor(() => app.calls.captures.length, count => count === 2, 'Both captures did not start');
  const damaged = join(app.store.directory, 'ui-runs', `${started[0].id}.json`);
  await writeFile(damaged, 'broken JSON');
  await assert.rejects(app.provider.close(), /Owned comparisons stopped/);
  assert.equal((await app.provider.info()).activeJobs.length, 0);
  for (const run of started) assert.equal((await readAuditRecord(app.store, run.id)).report.status, 'cancelled');
  assert.equal(await readFile(damaged, 'utf8'), 'broken JSON');
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


test('a preflight refusal after Start keeps its reason through completion and restart', async t => {
  const app = await fixture(t, { blockFinalPreflight: true });
  const preview = await app.provider.runPreview(request(app));
  assert.equal(preview.ready, true);
  const started = await app.provider.startRun({ previewToken: preview.previewToken });
  const result = await waitFor(() => app.provider.run(started), value => value.state !== 'running', 'Run did not settle');
  assert.equal(result.state, 'failed');
  assert.match(result.headline, /Safe coexistence/);
  assert.deepEqual(app.calls.captures, []);
  await app.restartServer();
  assert.equal((await app.provider.run(started)).headline, result.headline);
  assert.deepEqual(await app.provider.startRun({ previewToken: preview.previewToken }), started);
  assert.deepEqual(app.calls.captures, []);
});


test('stale baseline diagnostics name metadata fields without disclosing values or dispatching', async t => {
  const app = await fixture(t, { staleCommit: true });
  const preview = await app.provider.runPreview(request(app));
  await assert.rejects(app.provider.startRun({ previewToken: preview.previewToken }), error => {
    assert.equal(error.code, 'preview-stale');
    assert.ok(error.details.changes.some(change => change.reason === 'baseline-changed' && change.fields.includes('commit')));
    assert.equal(JSON.stringify(error.details).includes('f'.repeat(40)), false);
    return true;
  });
  assert.equal(app.calls.captures.length, 0);
  await assert.rejects(access(join(app.store.directory, 'audits')), { code: 'ENOENT' });
});

test('stale readiness and resolved profile diagnostics retain distinct source reasons before any dispatch', async t => {
  const app = await fixture(t);
  let changed = false;
  const service = createUiRuns({ store: app.store, context: { ...app.runContext,
    resolveProfile: async (...args) => {
      const profile = await resolveAuditExecutionProfile(...args);
      return changed ? { ...profile, environmentId: 'replacement-environment' } : profile;
    },
    observeAccess: async () => changed
      ? { status: 'blocked', reason: 'fixture-resource-busy', clients: [], sourceReservation: null }
      : { status: 'ready', clients: [], sourceReservation: null },
  } });
  t.after(() => service.close());
  const preview = await service.runPreview(request(app));
  assert.equal(preview.ready, true);
  changed = true;
  await assert.rejects(service.startRun({ previewToken: preview.previewToken }), error => {
    assert.equal(error.code, 'preview-stale');
    const changes = error.details.changes;
    assert.deepEqual(changes.find(change => change.reason === 'readiness-changed').failures.map(failure => failure.code),
      ['profile-access-blocked', 'profile-access-blocked']);
    assert.ok(changes.find(change => change.reason === 'readiness-changed').profiles.every(profile =>
      profile.checks.some(check => check.name === 'profile-access' && check.reason === 'fixture-resource-busy')));
    assert.deepEqual(changes.filter(change => change.reason === 'profile-identity-changed').map(({ side, profile, fields }) => ({ side, profile, fields })), [
      { side: 'a', profile: 'baseline', fields: ['environmentId'] },
      { side: 'b', profile: 'strict-review', fields: ['environmentId'] },
    ]);
    assert.equal(JSON.stringify(error.details).includes('replacement-environment'), false);
    return true;
  });
  assert.equal(app.calls.captures.length, 0);
});

test('unchanged previews remain valid while independent same-profile comparisons hold participants', async t => {
  const app = await fixture(t, { capture: 'delayed' });
  const input = { ...request(app), b: 'baseline' };
  const first = await app.provider.runPreview(input), second = await app.provider.runPreview({ ...input, task: 'Independent second task' });
  assert.equal(first.ready, true); assert.equal(second.ready, true);
  const one = await app.provider.startRun({ previewToken: first.previewToken });
  await waitFor(async () => app.calls.captures.length, count => count === 1, 'First comparison did not reach capture');
  const two = await app.provider.startRun({ previewToken: second.previewToken });
  await waitFor(async () => app.calls.captures.length, count => count === 2, 'Unchanged second comparison was refused while the first held participants');
  assert.notEqual(one.id, two.id);
  assert.deepEqual(await app.provider.startRun({ previewToken: first.previewToken }), one);
  assert.equal(app.calls.captures.length, 2, 'Duplicate Start must not dispatch again');
  await Promise.all([app.provider.cancelRun(one), app.provider.cancelRun(two)]);
});

test('same-profile review participants do not invalidate an unchanged comparison preview', async t => {
  let reviewCaptures = 0;
  const app = await createUiRunsFixture({ mode: { capture: 'delayed' }, reviewContext: { capture: async options => {
    reviewCaptures++;
    const threadId = `fixture-review-${reviewCaptures}`, turnId = `fixture-turn-${reviewCaptures}`;
    await options.onSession({ source: { threadId }, events: [], turns: [] }, { status: 'partial' });
    await options.onTurn({ threadId, turnId });
    await new Promise(resolve => options.processOptions.signal.aborted ? resolve()
      : options.processOptions.signal.addEventListener('abort', resolve, { once: true }));
    return { process: { status: 'cancelled', exitCode: 0, shutdown: { groupTerminated: true } },
      run: { source: { threadId }, turns: [] }, capture: { status: 'partial' } };
  } } });
  t.after(() => app.close());
  const secondWorkspace = join(app.root, 'independent-review');
  await mkdir(secondWorkspace, { mode: 0o700 });
  await app.provider.bindProfile({ name: 'baseline', repository: secondWorkspace });
  const source = { schemaVersion: 1, kind: 'audit-comparison', id: 'snapshot-stability', status: 'partial',
    left: { id: 'left', source: { threadId: 'source-left' }, turns: [], checks: [] },
    right: { id: 'right', source: { threadId: 'source-right' }, turns: [], checks: [] } };
  const { ref } = await app.provider.openReport({ fileName: 'snapshot-stability.audit.json', text: JSON.stringify(source) });
  const input = { ...request(app), b: 'baseline' };
  const first = await app.provider.runPreview(input), second = await app.provider.runPreview({ ...input, task: 'Second stable comparison' });
  const one = await app.provider.startRun({ previewToken: first.previewToken });
  await waitFor(async () => app.calls.captures.length, count => count === 1, 'First comparison not capturing');
  const reviews = [];
  for (const cwd of [app.repository, secondWorkspace]) {
    const preview = await app.provider.previewReviewTask({ ref, profile: 'baseline', cwd });
    reviews.push(await app.provider.startReviewTask({ ref, previewToken: preview.previewToken }));
  }
  await waitFor(async () => reviewCaptures, count => count === 2, 'Review participants not active');
  const two = await app.provider.startRun({ previewToken: second.previewToken });
  await waitFor(async () => app.calls.captures.length, count => count === 2, 'Stable comparison preview was invalidated by review lifecycle');
  await Promise.all([app.provider.cancelRun(one), app.provider.cancelRun(two), ...reviews.map(review => app.provider.cancelReviewTask(review))]);
});


test('an unavailable fresh settings snapshot is diagnosed without bypassing its stale guard', async t => {
  const app = await fixture(t);
  let unavailable = false;
  const service = createUiRuns({ store: app.store, context: { ...app.runContext,
    snapshotSettings: profile => unavailable && profile.profileName === 'baseline'
      ? { status: 'unavailable', reason: 'fixture-source-unavailable' } : snapshotAuditProfileSettings(profile),
  } });
  t.after(() => service.close());
  const preview = await service.runPreview(request(app));
  assert.equal(preview.ready, true);
  unavailable = true;
  await assert.rejects(service.startRun({ previewToken: preview.previewToken }), error => {
    assert.equal(error.code, 'preview-stale');
    assert.ok(error.details.changes.some(change => change.reason === 'profile-settings-unavailable'
      && change.side === 'a' && change.profile === 'baseline' && change.changedPaths.length === 0));
    assert.ok(error.details.changes.some(change => change.reason === 'readiness-changed'
      && change.failures.some(failure => failure.code === 'profile-settings-unavailable')));
    return true;
  });
  assert.equal(app.calls.captures.length, 0);
});
