import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, link, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTelemetryJournal, readTelemetryJournal } from '../src/audit-telemetry-journal.js';

const event = (index = 1) => ({
  source: 'native-otel-skill-invocation', threadId: 'thread-123', turnId: 'turn-456',
  skillName: 'product-design:image-to-code', invocationType: 'explicit',
  observationId: `${'a'.repeat(32)}:${index}`,
});
const delivery = (received = 0, accepted = 0) => ({
  schemaVersion: 1, scope: 'receiver-lifetime', classification: 'bounded',
  requests: { received: 0, admitted: received, rejected: 0 },
  records: { examined: accepted, relevant: accepted, accepted, durable: accepted, invalidRelevant: 0,
    unclassified: 0, ignored: 0, eventLimitDropped: 0, persistenceRejected: 0, unexamined: 0 },
  upstreamLoss: 'unknown', acknowledgements: 'unknown',
});
const initial = delivery();

async function privateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'xfx-telemetry-journal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('creates a private v2 stream and recovers only its hash-bound committed prefix and accounting', async t => {
  const dir = await privateDir(t), path = join(dir, 'events.jsonl');
  const journal = createTelemetryJournal(path, initial);
  const streamId = journal.streamId;
  assert.match(streamId, /^[a-f0-9]{32}$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(`${path}.commit.json`)).mode & 0o777, 0o600);
  assert.equal(journal.append([event()], delivery(1, 1)), true);
  const loaded = readTelemetryJournal(path);
  assert.equal(loaded.streamId, streamId);
  assert.equal(loaded.legacy, false);
  assert.deepEqual(loaded.lines.map(JSON.parse), [event()]);
  assert.deepEqual(loaded.accounting, { ...delivery(1, 1), scope: 'committed-prefix' });
  assert.deepEqual(loaded.journal, {
    status: 'available', mode: 'required', format: 2, commit: 'committed-prefix',
    bytes: loaded.bytes, eventCount: 1, committedBytes: loaded.bytes, committedEvents: 1, uncertainBytes: 0,
  });
  assert.equal(journal.close().commit, 'committed-prefix');
});

test('a copied journal and checkpoint pair reopens after the original fixture is removed', async t => {
  const dir = await privateDir(t), source = join(dir, 'source.jsonl'), copy = join(dir, 'copy.jsonl');
  const journal = createTelemetryJournal(source, initial);
  assert.equal(journal.append([event()], delivery(1, 1)), true);
  journal.close();
  await writeFile(copy, await readFile(source), { mode: 0o600 });
  await writeFile(`${copy}.commit.json`, await readFile(`${source}.commit.json`), { mode: 0o600 });
  await rm(source); await rm(`${source}.commit.json`);
  const recovered = readTelemetryJournal(copy);
  assert.deepEqual(recovered.lines.map(JSON.parse), [event()]);
  assert.equal(recovered.accounting.scope, 'committed-prefix');
  assert.equal(recovered.journal.commit, 'committed-prefix');
});

test('keeps an uncommitted tail on disk and excludes it from replay and accounting', async t => {
  const dir = await privateDir(t), path = join(dir, 'events.jsonl');
  const journal = createTelemetryJournal(path, initial);
  assert.equal(journal.append([event()], delivery(1, 1)), true);
  const committed = readTelemetryJournal(path);
  const tail = `${JSON.stringify({ private: 'must not be returned' })}\ntruncated private`;
  await appendFile(path, tail);
  const recovered = readTelemetryJournal(path);
  assert.deepEqual(recovered.lines, committed.lines);
  assert.deepEqual(recovered.accounting, committed.accounting);
  assert.equal(recovered.journal.status, 'partial');
  assert.equal(recovered.journal.uncertainBytes, Buffer.byteLength(tail));
  assert.ok(recovered.warnings.includes('telemetry-journal-uncommitted-tail'));
  assert.equal((await readFile(path, 'utf8')).endsWith(tail), true);
  assert.equal(JSON.stringify(recovered).includes('must not be returned'), false);
  assert.equal(JSON.stringify(recovered).includes('truncated private'), false);
  journal.close();
});

test('never falls back to event replay when a v2 header, sidecar, or committed prefix is invalid', async t => {
  const dir = await privateDir(t), path = join(dir, 'events.jsonl');
  const journal = createTelemetryJournal(path, initial);
  journal.append([event()], delivery(1, 1));
  journal.close();
  const data = await readFile(path);
  const checkpoint = await readFile(`${path}.commit.json`);

  await writeFile(path, Buffer.concat([Buffer.from(`${JSON.stringify(event())}\n`), data.subarray(data.indexOf(10) + 1)]), { mode: 0o600 });
  let result = readTelemetryJournal(path);
  assert.deepEqual(result.lines, []);
  assert.equal(result.accounting, undefined);
  assert.equal(result.journal.commit, 'unavailable');

  await writeFile(path, data, { mode: 0o600 });
  await writeFile(`${path}.commit.json`, '{invalid}\n', { mode: 0o600 });
  result = readTelemetryJournal(path);
  assert.deepEqual(result.lines, []);
  assert.equal(result.accounting, undefined);

  await writeFile(`${path}.commit.json`, checkpoint);
  const changed = Buffer.from(data); changed[changed.length - 3] ^= 1;
  await writeFile(path, changed, { mode: 0o600 });
  result = readTelemetryJournal(path);
  assert.deepEqual(result.lines, []);
  assert.equal(result.journal.commit, 'unavailable');
});

test('reads a private legacy event-only journal as explicitly unverified', async t => {
  const dir = await privateDir(t), path = join(dir, 'legacy.jsonl');
  await writeFile(path, `${JSON.stringify(event())}\n`, { mode: 0o600 });
  const result = readTelemetryJournal(path);
  assert.deepEqual(result.lines.map(JSON.parse), [event()]);
  assert.equal(result.legacy, true);
  assert.equal(result.journal.commit, 'legacy-unverified');
  assert.equal(result.journal.mode, 'unknown');
  assert.equal(result.accounting, undefined);
});

test('keeps valid legacy rows while reporting malformed records and a truncated tail', async t => {
  const dir = await privateDir(t), path = join(dir, 'legacy-partial.jsonl');
  await writeFile(path, `${JSON.stringify(event())}\nnot json\n${JSON.stringify(event(2)).slice(0, 14)}`, { mode: 0o600 });
  const result = readTelemetryJournal(path);
  assert.deepEqual(result.lines.map(JSON.parse), [event()]);
  assert.equal(result.journal.commit, 'legacy-unverified');
  assert.ok(result.warnings.includes('telemetry-journal-malformed-record'));
  assert.ok(result.warnings.includes('telemetry-journal-truncated-tail'));
  assert.equal(JSON.stringify(result).includes('not json'), false);
});

test('accepts a namespaced plugin market identifier in a committed row', async t => {
  const dir = await privateDir(t), path = join(dir, 'plugin-market.jsonl');
  const journal = createTelemetryJournal(path, initial);
  const namespaced = { ...event(), pluginId: 'market/shared' };
  assert.equal(journal.append([namespaced], initial), true);
  const loaded = readTelemetryJournal(path);
  assert.deepEqual(loaded.lines.map(JSON.parse), [namespaced]);
  journal.close();
});

test('requires private regular single-link data and sidecar files', async t => {
  const dir = await privateDir(t), path = join(dir, 'events.jsonl');
  const journal = createTelemetryJournal(path, initial);
  journal.close();
  await chmod(path, 0o640);
  assert.deepEqual(readTelemetryJournal(path).lines, []);
  await chmod(path, 0o600);
  await link(path, join(dir, 'second-link'));
  assert.deepEqual(readTelemetryJournal(path).lines, []);
});

test('latches when either journal or checkpoint path is replaced after creation', async t => {
  const dir = await privateDir(t), journalPath = join(dir, 'replaced-journal.jsonl');
  const journal = createTelemetryJournal(journalPath, initial);
  await rename(journalPath, join(dir, 'original-journal.jsonl'));
  await writeFile(journalPath, 'replacement bytes', { mode: 0o600 });
  assert.equal(journal.append([event()], initial), false);
  assert.equal(journal.append([], initial), false);
  assert.equal(journal.close().commit, 'failed');
  assert.equal(await readFile(journalPath, 'utf8'), 'replacement bytes');

  const checkpointPath = join(dir, 'replaced-checkpoint.jsonl');
  const second = createTelemetryJournal(checkpointPath, initial);
  await rename(`${checkpointPath}.commit.json`, join(dir, 'original-checkpoint.json'));
  await writeFile(`${checkpointPath}.commit.json`, 'replacement checkpoint', { mode: 0o600 });
  assert.equal(second.append([event()], initial), false);
  assert.equal(second.append([], initial), false);
  assert.equal(second.close().commit, 'failed');
  assert.equal(await readFile(`${checkpointPath}.commit.json`, 'utf8'), 'replacement checkpoint');
});

test('refuses to replace an existing journal or checkpoint', async t => {
  const dir = await privateDir(t), path = join(dir, 'events.jsonl');
  await writeFile(path, 'preserve these original bytes', { mode: 0o600 });
  assert.throws(() => createTelemetryJournal(path, initial));
  assert.equal(await readFile(path, 'utf8'), 'preserve these original bytes');

  const second = join(dir, 'second.jsonl');
  await writeFile(`${second}.commit.json`, 'preserve sidecar', { mode: 0o600 });
  assert.throws(() => createTelemetryJournal(second, initial));
  assert.equal(await readFile(`${second}.commit.json`, 'utf8'), 'preserve sidecar');
  await symlink(path, join(dir, 'linked.jsonl'));
  assert.throws(() => createTelemetryJournal(join(dir, 'linked.jsonl'), initial));
});

test('latches failed journal fsync and checkpoint replacement across later empty appends', async t => {
  const dir = await privateDir(t), path = join(dir, 'fault.jsonl');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalSync = fs.fsyncSync;
    let failSync = false;
    fs.fsyncSync = (...args) => { if (failSync) { const e = new Error('injected'); e.code = 'EIO'; throw e; } return originalSync(...args); };
    syncBuiltinESMExports();
    const { pathToFileURL } = await import('node:url');
    const { createTelemetryJournal, readTelemetryJournal } = await import(pathToFileURL(process.argv[1] + '/src/audit-telemetry-journal.js'));
    const path = process.argv[2];
    const accounting = ${JSON.stringify(initial)};
    const journal = createTelemetryJournal(path, accounting);
    failSync = true;
    const event = ${JSON.stringify(event())};
    const first = journal.append([event], accounting);
    const second = journal.append([], accounting);
    failSync = false;
    const status = journal.close();
    const recovered = readTelemetryJournal(path);
    console.log(JSON.stringify({ first, second, status: status.commit, uncertain: status.uncertainBytes,
      recovered: recovered.lines.length, uncertainRecovered: recovered.journal.uncertainBytes }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, process.cwd(), path], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result, { first: false, second: false, status: 'failed', uncertain: Buffer.byteLength(`${JSON.stringify(event())}\n`),
    recovered: 0, uncertainRecovered: Buffer.byteLength(`${JSON.stringify(event())}\n`) });
});

test('leaves a durable but uncheckpointed tail and retains the prior committed prefix after checkpoint failure', async t => {
  const dir = await privateDir(t), path = join(dir, 'checkpoint-fault.jsonl');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const originalRename = fs.renameSync;
    let failRename = false;
    fs.renameSync = (...args) => { if (failRename) { const e = new Error('injected'); e.code = 'EIO'; throw e; } return originalRename(...args); };
    syncBuiltinESMExports();
    const { pathToFileURL } = await import('node:url');
    const { createTelemetryJournal, readTelemetryJournal } = await import(pathToFileURL(process.argv[1] + '/src/audit-telemetry-journal.js'));
    const path = process.argv[2];
    const accounting = ${JSON.stringify(initial)};
    const journal = createTelemetryJournal(path, accounting);
    const event = ${JSON.stringify(event())};
    failRename = true;
    const first = journal.append([event], accounting);
    const second = journal.append([], accounting);
    failRename = false;
    const status = journal.close();
    const recovered = readTelemetryJournal(path);
    console.log(JSON.stringify({ first, second, status: status.commit,
      recovered: recovered.lines.length, uncertain: recovered.journal.uncertainBytes }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, process.cwd(), path], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result, { first: false, second: false, status: 'failed', recovered: 0,
    uncertain: Buffer.byteLength(`${JSON.stringify(event())}\n`) });
});

test('restart after an owned process dies before or after checkpoint publication recovers only the published prefix', async t => {
  const dir = await privateDir(t);
  for (const stage of ['before-checkpoint', 'after-checkpoint']) {
    const path = join(dir, `${stage}.jsonl`);
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      let armed = false;
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        if (armed && process.argv[3] === 'before-checkpoint') process.kill(process.pid, 'SIGKILL');
        const result = rename(...args);
        if (armed && process.argv[3] === 'after-checkpoint') process.kill(process.pid, 'SIGKILL');
        return result;
      };
      syncBuiltinESMExports();
      const { pathToFileURL } = await import('node:url');
      const { createTelemetryJournal } = await import(pathToFileURL(process.argv[1] + '/src/audit-telemetry-journal.js'));
      const journal = createTelemetryJournal(process.argv[2], ${JSON.stringify(initial)});
      journal.append([${JSON.stringify(event())}], ${JSON.stringify(delivery(1, 1))});
      armed = true;
      journal.append([${JSON.stringify(event(2))}], ${JSON.stringify(delivery(2, 2))});
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, process.cwd(), path, stage], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const recovered = readTelemetryJournal(path);
    assert.equal(recovered.lines.length, stage === 'before-checkpoint' ? 1 : 2);
    assert.equal(recovered.accounting.scope, 'committed-prefix');
    assert.equal(recovered.journal.uncertainBytes > 0, stage === 'before-checkpoint');
    assert.equal(recovered.accounting.acknowledgements, 'unknown', 'published checkpoint does not establish HTTP acknowledgement');
  }
});

test('directory sync failure can leave a recoverable published prefix while the writer remains failed', async t => {
  const dir = await privateDir(t), path = join(dir, 'directory-sync-fault.jsonl');
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    let armed = false; const sync = fs.fsyncSync;
    fs.fsyncSync = fd => { if (armed && fs.fstatSync(fd).isDirectory()) throw new Error('injected'); return sync(fd); };
    syncBuiltinESMExports();
    const { pathToFileURL } = await import('node:url');
    const { createTelemetryJournal, readTelemetryJournal } = await import(pathToFileURL(process.argv[1] + '/src/audit-telemetry-journal.js'));
    const journal = createTelemetryJournal(process.argv[2], ${JSON.stringify(initial)});
    armed = true;
    const accepted = journal.append([${JSON.stringify(event())}], ${JSON.stringify(delivery(1, 1))});
    armed = false;
    console.log(JSON.stringify({ accepted, live: journal.close(), recovered: readTelemetryJournal(process.argv[2]) }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, process.cwd(), path], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  const { accepted, live, recovered } = JSON.parse(child.stdout);
  assert.equal(accepted, false);
  assert.equal(live.commit, 'failed');
  assert.equal(recovered.lines.length, 1, 'recovery verifies the currently published pair, not the response outcome');
  assert.equal(recovered.accounting.acknowledgements, 'unknown');
});
