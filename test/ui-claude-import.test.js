import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function transcript(number = 1) {
  const sessionId = `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  return { fileName: `${sessionId}.jsonl`, text: JSON.stringify({ type: 'user', sessionId,
    uuid: '11111111-1111-4111-8111-111111111111', parentUuid: null,
    timestamp: '2026-11-10T00:00:00Z', message: { role: 'user', content: 'PUBLIC IMPORT QUESTION' } }) + '\n' };
}
const pair = () => ({ left: transcript(), right: transcript(2) });
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ui-claude-import-')));
  const store = new Store(join(root, 'store'));
  const provider = createEngineProvider({ store, defaultUserHome: join(root, 'unused'), reportsRoot: join(root, 'reports'),
    resolveClient: async () => assert.fail('Transcript imports cannot resolve a native client'),
    runContext: { capture: async () => assert.fail('Transcript imports cannot submit a task') },
    reviewContext: { capture: async () => assert.fail('Transcript imports cannot submit a review') }, ...options });
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, provider, imports: join(store.directory, 'ui-imports') };
}

test('Claude import HTTP route requires authenticated mutation and returns a bounded stored-file comparison', async t => {
  const f = await fixture(t), site = join(f.root, 'site');
  await mkdir(site, { mode: 0o700 }); await writeFile(join(site, 'index.html'), '<title>fixture</title>');
  const server = await startUiServer({ provider: f.provider, staticRoot: site, launchToken: 'claude-import-test-token' });
  t.after(() => server.close());
  const headers = { origin: server.origin, 'content-type': 'application/json', 'x-xenoflux-request': '1' };
  const post = (path, body, extra = {}) => fetch(server.origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/reports/import/claude-code', pair())).status, 401);
  const session = await post('/api/session', { token: 'claude-import-test-token' });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const invalid = await post('/api/reports/import/claude-code', { left: transcript() }, { cookie });
  assert.equal(invalid.status, 422); assert.equal((await invalid.json()).error.code, 'invalid-claude-import');
  const imported = await post('/api/reports/import/claude-code', pair(), { cookie });
  assert.equal(imported.status, 200);
  const summary = await imported.json();
  assert.equal(summary.origin, 'claude-code-import'); assert.match(summary.ref, /^f\./);
  assert.equal((await readdir(f.imports)).length, 2);
  const report = await f.provider.report({ ref: summary.ref });
  assert.equal(report.a.profile, 'Imported Claude Code (left)');
  assert.equal(report.b.profile, 'Imported Claude Code (right)');
});

test('second Claude import failure removes the first new artifact, preserves unrelated data and releases admission', async t => {
  const f = await fixture(t, { maxActiveJobs: 1 });
  await mkdir(f.store.directory, { mode: 0o700 }); await mkdir(f.imports, { mode: 0o700 });
  const caller = join(f.imports, 'caller-owned'); await mkdir(caller, { mode: 0o700 });
  await writeFile(join(caller, 'keep'), 'UNCHANGED', { mode: 0o600 });
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  let readers = 0;
  childProcess.ChildProcess.prototype.spawn = function(options) {
    assert.equal(options.file, process.execPath);
    assert.ok(options.args.some(argument => argument.endsWith('/claude-transcript-reader.mjs')));
    readers++; return originalSpawn.call(this, options);
  };
  try {
    await assert.rejects(f.provider.importClaudeComparison({ left: transcript(), right: { fileName: 'bad.jsonl', text: '{}' } }),
      { status: 422, code: 'invalid-claude-import' });
    assert.equal(readers, 1, 'Only the admitted first SDK reader runs');
    assert.deepEqual(await readdir(f.imports), ['caller-owned']);
    assert.equal(await readFile(join(caller, 'keep'), 'utf8'), 'UNCHANGED');
    const imported = await f.provider.importClaudeComparison(pair());
    assert.equal(imported.origin, 'claude-code-import'); assert.equal(readers, 3, 'Failure released the single admission slot');
  } finally { childProcess.ChildProcess.prototype.spawn = originalSpawn; }
});

test('imports share admission, and shutdown waits for admitted work while refusing later imports', async t => {
  const f = await fixture(t, { maxActiveJobs: 1 }), entered = deferred(), proceed = deferred();
  const originalMkdir = fsPromises.mkdir;
  let paused = false, first, stopping;
  fsPromises.mkdir = async function(path, ...args) {
    if (path === f.imports && !paused) { paused = true; entered.resolve(); await proceed.promise; }
    return originalMkdir.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    first = f.provider.importClaudeComparison(pair()); await entered.promise;
    await assert.rejects(f.provider.importClaudeComparison(pair()), { status: 409, code: 'job-capacity' });
    let closed = false;
    stopping = f.provider.close().then(() => { closed = true; });
    await assert.rejects(f.provider.importClaudeComparison(pair()), { status: 409, code: 'stopping' });
    assert.equal(closed, false, 'close must join the admitted import');
    proceed.resolve();
    assert.equal((await first).origin, 'claude-code-import'); await stopping;
    assert.equal(closed, true);
    await assert.rejects(f.provider.importClaudeComparison(pair()), { status: 409, code: 'stopping' });
    assert.equal((await readdir(f.imports)).length, 2, 'No artifacts from rejected imports');
  } finally {
    proceed.resolve(); await first?.catch(() => {}); await stopping?.catch(() => {});
    fsPromises.mkdir = originalMkdir; syncBuiltinESMExports();
  }
});


test('failed second import never removes a foreign directory replacing the first successful artifact', async t => {
  const f = await fixture(t);
  const originalMkdir = fsPromises.mkdir;
  let artifactCount = 0, replaced, preserved;
  fsPromises.mkdir = async function(path, ...args) {
    if (typeof path === 'string' && path.startsWith(f.imports + '/') && !path.slice(f.imports.length + 1).includes('/')) {
      artifactCount++;
      if (artifactCount === 2) {
        const [first] = await readdir(f.imports);
        replaced = join(f.imports, first); preserved = join(f.imports, 'preserved-original');
        await rename(replaced, preserved);
        await originalMkdir(replaced, { mode: 0o700 });
        await writeFile(join(replaced, 'keep'), 'FOREIGN DATA', { mode: 0o600 });
        throw new Error('Second import creation failed');
      }
    }
    return originalMkdir.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.provider.importClaudeComparison(pair()), { status: 422, code: 'invalid-claude-import' });
    assert.equal(artifactCount, 2);
    assert.equal(await readFile(join(replaced, 'keep'), 'utf8'), 'FOREIGN DATA');
    assert.ok((await readFile(join(preserved, 'source.jsonl'), 'utf8')).includes('PUBLIC IMPORT QUESTION'));
  } finally { fsPromises.mkdir = originalMkdir; syncBuiltinESMExports(); }
});
