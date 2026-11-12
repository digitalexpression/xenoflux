import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { createMixedClientFixture, duplicateSession, pinnedCheck } from '../test-support/ui-mixed-client-fixture.js';
import { readAuditRecord } from '../src/audit-experiment-store.js';

async function httpFixture(t) {
  const app = await createMixedClientFixture();
  t.after(() => app.close());
  for (const [command, executable] of [
    ['codex', app.executable],
    ['claude', app.profiles['claude-code'].native.executable],
    ['copilot', app.profiles.copilot.native.executable],
  ]) assert.equal(await realpath(join(app.root, command)), await realpath(executable));
  const headers = { origin: app.origin, 'content-type': 'application/json', 'x-xenoflux-request': '1' };
  const token = new URLSearchParams(new URL(app.url).hash.slice(1)).get('launch');
  const auth = await fetch(app.origin + '/api/session', { method: 'POST', headers, body: JSON.stringify({ token }) });
  assert.equal(auth.status, 200);
  headers.cookie = auth.headers.get('set-cookie').split(';')[0];
  const request = async (path, body, status = 200) => {
    const response = await fetch(app.origin + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  return { ...app, request };
}

async function waitFor(read, match) {
  let value;
  for (let i = 0; i < 400; i++) {
    value = await read();
    if (match(value)) return value;
    await setTimeout(25);
  }
  assert.fail(JSON.stringify(value));
}
const names = { codex: 'baseline', 'claude-code': 'Claude managed', copilot: 'Copilot managed' };
const terminal = view => !['running', 'cancelling'].includes(view.state);
const runInput = (app, a, b) => ({ task: 'Read the pinned disposable fixture.', a: names[a], b: names[b],
  clients: { a, b }, repository: app.repository, commit: 'HEAD', checks: [{ name: 'Pinned fixture input', command: pinnedCheck }] });

async function start(app, input) {
  const preview = await app.request('/api/runs/preview', input);
  assert.equal(preview.ready, true, JSON.stringify(preview));
  assert.match(preview.where.join(' '), /Pinned commit: [0-9a-f]{40}/);
  return app.request('/api/runs', { previewToken: preview.previewToken });
}

async function exportAndReopen(app, ref) {
  const saved = await app.request('/api/reports/' + ref + '/export', { includeReplayContent: true });
  const text = await readFile(join(saved.folder, saved.files[1]), 'utf8');
  const opened = await app.request('/api/reports/open', { fileName: saved.files[1], text });
  return { text, view: await app.request('/api/reports/' + opened.ref) };
}

test('all six pairs run native fixture streams on the pinned input and reopen both results', { timeout: 180000 }, async t => {
  const app = await httpFixture(t);
  const clients = Object.keys(names);
  for (const [index, a] of clients.entries()) for (const b of clients.slice(index)) {
    await t.test(a + ' / ' + b, async () => {
      const input = runInput(app, a, b);
      if (a === 'codex' && b === 'codex') input.execution = { a: { permissionMode: 'read-only' }, b: { permissionMode: 'workspace-write' } };
      const { id } = await start(app, input);
      const done = await waitFor(() => app.request('/api/runs/' + id), terminal);
      const parent = await readAuditRecord(app.store, id);
      const records = await Promise.all(parent.state.runs.map(run => readAuditRecord(app.store, run.id)));
      const diagnostics = async () => JSON.stringify(await Promise.all(records.map(async row => ({
        state: row.state.status, reason: row.report?.reason, capture: row.report?.capture?.errors,
        stderr: await readFile(join(row.directory, (row.record.profile?.client ?? 'codex') + '.stderr'), 'utf8').catch(() => null),
      }))));
      assert.ok(['finished', 'finished-partial'].includes(done.state), JSON.stringify(done) + ' ' + await diagnostics());
      const report = await app.request('/api/reports/e.' + id);
      assert.deepEqual([report.a.nativeClient, report.b.nativeClient], [a, b]);
      assert.deepEqual(report.attempt.cells.map(cell => cell.state), ['completed', 'completed'], JSON.stringify(report.attempt) + ' ' + await diagnostics());
      assert.equal(report.verification.rows.length, 1);
      assert.deepEqual([report.verification.rows[0].a.status, report.verification.rows[0].b.status], ['passed', 'passed']);
      assert.deepEqual(records.map(row => row.report.nativeReference.client), [a, b]);
      assert.notEqual(records[0].report.sourceWorkspace.directory, records[1].report.sourceWorkspace.directory);
      if (a === 'codex' && b === 'codex') {
        assert.deepEqual([report.a, report.b].map(side => side.permissions.confirmed), ['read-only', 'workspace-write']);
      }
      if (b === 'copilot') {
        assert.match(report.limits.join(' '), /may not be reproducible/);
        assert.deepEqual(report.b.autoTurns.at(-1).models, ['fixture-routed-model']);
      }
      const { text, view: reopened } = await exportAndReopen(app, 'e.' + id);
      assert.deepEqual([reopened.a, reopened.b], [report.a, report.b]);
      assert.deepEqual(reopened.verification.rows, report.verification.rows);
      const exported = JSON.parse(text);
      assert.deepEqual([exported.left.clientIdentity.client, exported.right.clientIdentity.client], [a, b]);
      assert.equal(reopened.timeTokens.rows.some(row => [row.a, row.b].some(value => /not recorded/i.test(value))), true);
    });
  }
});

test('opaque listed sessions preserve distinct owners with the same native ID and refuse a changed root', async t => {
  const app = await httpFixture(t);
  const list = async client => (await app.request('/api/sessions/' + client + '?profile=' + encodeURIComponent(names[client]))).sessions[0];
  const claude = await list('claude-code'), copilot = await list('copilot'), codex = await list('codex');
  assert.equal(codex.id, duplicateSession);
  assert.equal(claude.id, duplicateSession);
  assert.equal(copilot.sessionId, duplicateSession);
  assert.notEqual(claude.token, copilot.token);
  const left = { client: 'claude-code', token: claude.token }, right = { client: 'copilot', token: copilot.token };
  const imported = await app.request('/api/compare/sessions/import', { left, right });
  const mixed = await app.request('/api/compare/sessions/import', { left: { client: 'codex', token: codex.token }, right });
  const codexMixed = await exportAndReopen(app, mixed.ref);
  assert.deepEqual([codexMixed.view.a.nativeClient, codexMixed.view.b.nativeClient], ['codex', 'copilot']);
  assert.equal(codexMixed.view.a.provenance.surface, 'cli');
  assert.doesNotMatch(codexMixed.text, /Synthetic baseline citation fixture/);
  const { text, view } = await exportAndReopen(app, imported.ref);
  assert.deepEqual([view.a.session, view.b.session], [duplicateSession, duplicateSession]);
  assert.deepEqual([view.a.provenance.rootMode, view.b.provenance.rootMode], ['explicit', 'explicit']);
  assert.doesNotMatch(text, /Private (Claude|Copilot) list title|private-claude-folder/);
  await app.request('/api/compare/sessions/import', { left: { ...left, token: copilot.token }, right }, 400);
  await writeFile(join(app.profiles.copilot.native.configRoot, 'settings.json'), '{}', { mode: 0o600 });
  await app.request('/api/compare/sessions/import', { left, right }, 422);
  await app.request('/api/compare/sessions/import', { left, right: { ...right, token: claude.token } }, 400);
  const stillOpen = await app.request('/api/reports/' + imported.ref);
  assert.deepEqual([stillOpen.a, stillOpen.b], [view.a, view.b]);
});

test('permission choices are scoped, failure is visible and prior paired evidence survives', { timeout: 60000 }, async t => {
  const app = await httpFixture(t);
  const input = runInput(app, 'codex', 'claude-code');
  const blocked = await app.request('/api/runs/preview', { ...input, execution: { b: { permissionMode: 'manual' } } }, 422);
  assert.equal(blocked.error.code, 'catalog-permission-unavailable');
  const pick = { profile: names['claude-code'], client: 'claude-code', workspace: app.repository };
  const catalog = await app.request('/api/catalog/refresh', { ...pick, requestId: randomUUID() });
  assert.equal(catalog.status, 'ready');
  const reviewed = await app.request('/api/runs/preview', { ...input, execution: { b: { permissionMode: 'plan' } } });
  assert.equal(reviewed.ready, true);
  await writeFile(join(app.profiles['claude-code'].native.configRoot, 'settings.json'), '{"model":"haiku"}\n', { mode: 0o600 });
  await app.request('/api/runs', { previewToken: reviewed.previewToken }, 422);
  const { id } = await start(app, input);
  const paired = await waitFor(() => app.request('/api/runs/' + id), terminal);
  const ref = 'e.' + id;
  const report = await app.request('/api/reports/' + ref);
  assert.equal(paired.state, 'finished-partial');
  await writeFile(app.reportsRoot, 'deliberate fixture publication failure', { mode: 0o600 });
  await app.request('/api/reports/' + ref + '/export', {}, 500);
  const preview = await app.request('/api/reports/' + ref + '/review-tasks/preview', { profile: 'baseline', cwd: app.repository });
  const review = await app.request('/api/reports/' + ref + '/review-tasks', { previewToken: preview.previewToken });
  const failed = await waitFor(() => app.request('/api/review-tasks/' + review.id), value => value.status === 'failed' && value.shutdown);
  assert.equal(failed.status, 'failed');
  assert.deepEqual((await app.request('/api/reports/' + ref)).attempt.cells, report.attempt.cells);
  await rm(app.reportsRoot);
  const reopened = await exportAndReopen(app, ref);
  assert.deepEqual([reopened.view.a, reopened.view.b], [report.a, report.b]);

  await writeFile(app.copilotConfig, JSON.stringify({ label: 'Fixture', rateLimited: true }), { mode: 0o600 });
  const limited = await start(app, runInput(app, 'copilot', 'codex'));
  const done = await waitFor(() => app.request('/api/runs/' + limited.id), terminal);
  assert.match(done.columns[0].failure, /usage or rate limit/i);
  const limitedReport = await app.request('/api/reports/e.' + limited.id);
  assert.match(limitedReport.attempt.cells[0].text, /limit reached/i);
  assert.equal(limitedReport.attempt.cells[1].state, 'completed');
});
