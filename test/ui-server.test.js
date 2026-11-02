import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startUiServer, UiError } from '../src/ui-server.js';
import { createDemoProvider } from '../src/ui-demo.js';

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.once('error', reject);
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body)); else req.end();
  });
}

async function fixture(t, provider = createDemoProvider()) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-ui-'));
  const site = join(root, 'site');
  await mkdir(join(site, 'assets'), { recursive: true });
  await writeFile(join(site, 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(join(site, 'assets', 'app-1.js'), 'console.log(1)');
  await writeFile(join(root, 'secret.txt'), 'outside');
  await symlink(join(root, 'secret.txt'), join(site, 'linked.txt'));
  const server = await startUiServer({ provider, staticRoot: site, launchToken: 'launch-token-for-tests' });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.port}`;
  const api = { 'x-xenoflux-request': '1' };
  const login = async () => {
    const response = await call(server.port, { method: 'POST', path: '/api/session', headers: { ...api, origin, 'content-type': 'application/json' }, body: { token: 'launch-token-for-tests' } });
    assert.equal(response.status, 200);
    return response.headers['set-cookie'][0].split(';')[0];
  };
  return { server, origin, api, login };
}

test('the UI server binds to loopback and refuses other hosts', async t => {
  const { server } = await fixture(t);
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(server.launchUrl, /#launch=launch-token-for-tests$/);
  const rebinding = await call(server.port, { headers: { host: `attacker.example:${server.port}` } });
  assert.equal(rebinding.status, 421);
  await assert.rejects(startUiServer({ provider: {}, host: '0.0.0.0' }), /loopback only/);
});

test('API access needs the request header, the launch token and a same-origin session', async t => {
  const { server, origin, api, login } = await fixture(t);
  assert.equal((await call(server.port, { path: '/api/info' })).status, 403, 'missing app header');
  assert.equal((await call(server.port, { path: '/api/info', headers: api })).status, 401, 'no session');
  const wrong = await call(server.port, { method: 'POST', path: '/api/session', headers: { ...api, origin, 'content-type': 'application/json' }, body: { token: 'nope' } });
  assert.equal(wrong.status, 401);
  const crossSite = await call(server.port, { method: 'POST', path: '/api/session', headers: { ...api, origin: 'https://evil.example', 'content-type': 'application/json' }, body: { token: 'launch-token-for-tests' } });
  assert.equal(crossSite.status, 403);
  const cookie = await login();
  assert.match(cookie, new RegExp(`^xfx_ui_${server.port}=`));
  const info = await call(server.port, { path: '/api/info', headers: { ...api, cookie } });
  assert.equal(info.status, 200);
  assert.equal(info.json.mode, 'demo');
  assert.equal((await call(server.port, { path: '/api/info', headers: { ...api, cookie: `xfx_ui_${server.port}=forged` } })).status, 401);
});

test('mutations refuse cross-site and missing origins even with a session cookie', async t => {
  const { server, origin, api, login } = await fixture(t);
  const cookie = await login();
  const body = { left: 's2', right: 's1' };
  const headers = { ...api, cookie, 'content-type': 'application/json' };
  assert.equal((await call(server.port, { method: 'POST', path: '/api/compare/sessions', headers, body })).status, 403);
  assert.equal((await call(server.port, { method: 'POST', path: '/api/compare/sessions', headers: { ...headers, origin: 'http://127.0.0.1:1' }, body })).status, 403);
  const accepted = await call(server.port, { method: 'POST', path: '/api/compare/sessions', headers: { ...headers, origin }, body });
  assert.equal(accepted.status, 200);
  assert.match(accepted.json.ref, /^demo-/);
  const notJson = await call(server.port, { method: 'POST', path: '/api/compare/sessions', headers: { ...headers, origin, 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(notJson.status, 415);
});

test('static files are served with a strict policy, without escaping the build folder', async t => {
  const { server } = await fixture(t);
  const index = await call(server.port);
  assert.equal(index.status, 200);
  assert.match(index.headers['content-security-policy'], /default-src 'self'/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['cache-control'], 'no-store');
  const route = await call(server.port, { path: '/reports/abc/evidence' });
  assert.equal(route.status, 200, 'client routes fall back to the app shell');
  assert.match(route.text, /<title>app/);
  for (const path of [
    '/reports/s.eyJsIjoibGVmdCIsInIiOiJyaWdodCJ9',
    '/reports/f.saved-report-id',
    '/compare/setups/skills/review-helper.v2?a=baseline&b=strict',
    '/profiles/strict.review/copy?from=baseline',
  ]) {
    const dottedRoute = await call(server.port, { path });
    assert.equal(dottedRoute.status, 200, `${path} is a client route even though it contains dots`);
    assert.match(dottedRoute.text, /<title>app/);
  }
  const asset = await call(server.port, { path: '/assets/app-1.js' });
  assert.match(asset.headers['cache-control'], /immutable/);
  assert.equal((await call(server.port, { path: '/assets/missing.js' })).status, 404, 'missing assets are not app routes');
  assert.equal((await call(server.port, { path: '/missing.js' })).status, 404, 'unknown files are not app routes');
  assert.equal((await call(server.port, { path: '/../secret.txt' })).status, 404);
  assert.equal((await call(server.port, { path: '/%2e%2e/secret.txt' })).status, 404);
  assert.equal((await call(server.port, { path: '/linked.txt' })).status, 404, 'symbolic links are not followed');
  assert.equal((await call(server.port, { method: 'POST', path: '/' })).status, 405);
});

test('provider errors become JSON with their status; unknown routes are 404', async t => {
  const provider = { async info() { return {}; }, async report() { throw new UiError(404, 'gone', 'report-missing'); }, async overview() { throw new Error('boom'); } };
  const { server, api, login } = await fixture(t, provider);
  const cookie = await login();
  const headers = { ...api, cookie };
  const missing = await call(server.port, { path: '/api/reports/x', headers });
  assert.deepEqual([missing.status, missing.json.error.code], [404, 'report-missing']);
  const failed = await call(server.port, { path: '/api/overview', headers });
  assert.deepEqual([failed.status, failed.json.error.code], [500, 'internal']);
  assert.equal((await call(server.port, { path: '/api/nothing', headers })).status, 404);
  const unavailable = await call(server.port, { path: '/api/runs/new', headers });
  assert.deepEqual([unavailable.status, unavailable.json.error.code], [404, 'not-available']);
});

test('review task routes carry only the bound report, token, task, and explicit native response', async t => {
  const calls = [];
  const provider = Object.fromEntries([
    ['previewReviewTask', value => ({ ready: true, previewToken: 'preview-id', received: value })],
    ['startReviewTask', value => ({ id: value.previewToken })],
    ['reviewTask', value => ({ id: value.id, status: 'running' })],
    ['cancelReviewTask', value => ({ id: value.id, status: 'cancelled' })],
    ['respondReviewTask', value => ({ id: value.id, requestId: value.requestId, response: value.response })],
  ].map(([name, result]) => [name, async input => { calls.push([name, input]); return result(input); }]));
  const { server, origin, api, login } = await fixture(t, provider);
  const cookie = await login();
  const headers = { ...api, cookie, origin, 'content-type': 'application/json' };
  const report = encodeURIComponent('s.report:with-dots');
  let result = await call(server.port, { method: 'POST', path: `/api/reports/${report}/review-tasks/preview`, headers,
    body: { ref: 's.attacker', profile: 'Strict', cwd: '/repo', prompt: 'Inspect the report.', includeRecordedContent: true, timeoutMs: null } });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.at(-1), ['previewReviewTask', { ref: 's.report:with-dots', profile: 'Strict', cwd: '/repo',
    prompt: 'Inspect the report.', includeRecordedContent: true, timeoutMs: null }]);

  result = await call(server.port, { method: 'POST', path: `/api/reports/${report}/review-tasks`, headers, body: { previewToken: 'preview-id', profile: 'ignored' } });
  assert.deepEqual(calls.at(-1), ['startReviewTask', { ref: 's.report:with-dots', previewToken: 'preview-id' }]);
  result = await call(server.port, { path: '/api/review-tasks/task-id', headers });
  assert.deepEqual(calls.at(-1), ['reviewTask', { id: 'task-id' }]);
  await call(server.port, { method: 'POST', path: '/api/review-tasks/task-id/cancel', headers, body: {} });
  assert.deepEqual(calls.at(-1), ['cancelReviewTask', { id: 'task-id' }]);
  const explicit = { decision: 'decline' };
  result = await call(server.port, { method: 'POST', path: '/api/review-tasks/task-id/requests/request%3A7', headers,
    body: { response: explicit, other: 'ignored' } });
  assert.deepEqual(calls.at(-1), ['respondReviewTask', { id: 'task-id', requestId: 'request:7', response: explicit }]);
  assert.deepEqual(result.json, { id: 'task-id', requestId: 'request:7', response: explicit });

  assert.equal((await call(server.port, { method: 'POST', path: `/api/reports/${report}/review-tasks`, headers: { ...headers, origin: 'https://evil.example' }, body: { previewToken: 'preview-id' } })).status, 403);
  assert.equal((await call(server.port, { method: 'POST', path: `/api/reports/${report}/review-tasks`, headers: { ...api, origin }, body: { previewToken: 'preview-id' } })).status, 401);
});
