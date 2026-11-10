// Public SDK durable-journal reader; importing this module has no native effects.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { userInfo } from 'node:os';
export const COPILOT_READER = '@github/copilot-sdk@1.0.29';
export const COPILOT_IMPORT_BYTES = 8 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
export function assertCopilotImplicitEnvironment(env) {
  if (env.HOME !== undefined && env.HOME !== userInfo().homedir)
    throw new Error('Copilot import requires the native user home.');
  for (const key of ['COPILOT_HOME', 'COPILOT_DISABLE_KEYTAR', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_SDK_AUTH_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDERS_CONFIG',
    ...Object.keys(env).filter(key => key.startsWith('COPILOT_PROVIDER_'))])
    if (env[key] !== undefined) throw new Error('Copilot import requires the unchanged implicit native authentication and settings route.');
}
/** Read one pinned journal generation, sequentially. Expiry never changes generations. */
export async function readCopilotJournal(read, { sessionId, savePage, signal } = {}) {
  if (!opaque(sessionId) || typeof savePage !== 'function') throw new Error('Invalid journal request');
  const cursors = new Set(), pages = []; let cursor, bytes = 0;
  for (let index = 0; index < 8; index++) {
    signal?.throwIfAborted();
    const page = await read({ sessionId, direction: 'forward', max: 200, ...(cursor === undefined ? {} : { cursor }) });
    signal?.throwIfAborted();
    if (!page || !Array.isArray(page.events) || page.events.length > 200 || !opaque(page.cursor)
      || typeof page.hasMore !== 'boolean' || !['ok', 'expired'].includes(page.cursorStatus)) throw new Error('Invalid journal page');
    const raw = encode(page); bytes += raw.length;
    if (bytes > COPILOT_IMPORT_BYTES - 65536) throw new Error('Journal byte limit');
    const file = `raw-page-${String(index + 1).padStart(2, '0')}.json`;
    await savePage(file, raw); signal?.throwIfAborted();
    pages.push({ file, bytes: raw.length, sha256: hash(raw) });
    if (page.cursorStatus !== 'ok') throw new Error('Journal snapshot expired');
    if (!page.hasMore) return { complete: true, pages };
    if (cursors.has(page.cursor)) throw new Error('Journal cursor reused');
    cursors.add(page.cursor); cursor = page.cursor;
  }
  throw new Error('Journal page limit');
}
async function bounded(work, ms) {
  let timer; try { return await Promise.race([work.then(() => true, () => false), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
async function main() {
  const config = JSON.parse(process.argv[2]), { sessionId, directory, executable } = config;
  if (!opaque(sessionId) || resolve(directory) !== directory || resolve(executable) !== executable) throw new Error('Invalid reader request');
  assertCopilotImplicitEnvironment(process.env);
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || await fsp.realpath(directory) !== directory) throw new Error('Unsafe reader directory');
  const controller = new AbortController(), closes = [], children = [], originalSpawn = childProcess.spawn;
  let client, result, nativeBytes = 0, rawOpen = true, failure = false;
  const stop = () => { failure = true; controller.abort(); };
  const timer = setTimeout(stop, 30000);
  const out = fs.openSync(join(directory, 'native.stdout'), 'wx', 0o600), err = fs.openSync(join(directory, 'native.stderr'), 'wx', 0o600);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const active = work => {
    controller.signal.throwIfAborted();
    return new Promise((yes, no) => {
      const aborted = () => no(new Error('Reader stopped'));
      controller.signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve(work).then(value => { controller.signal.removeEventListener('abort', aborted); yes(value); }, error => { controller.signal.removeEventListener('abort', aborted); no(error); });
    });
  };
  childProcess.spawn = function(command, args, options) {
    controller.signal.throwIfAborted();
    if (children.length || command !== executable) throw new Error('Unexpected reader process');
    const child = originalSpawn.call(this, command, args, options), record = { pid: child.pid ?? null, closed: false };
    children.push(record); closes.push(new Promise(resolve => child.once('close', () => { record.closed = true; resolve(); })));
    fs.writeFileSync(join(directory, 'native-process.json'), encode({ workerPid: process.pid, nativePid: record.pid }), { flag: 'wx', mode: 0o600 });
    for (const [stream, fd] of [[child.stdout, out], [child.stderr, err]]) stream?.on('data', chunk => {
      const remaining = Math.max(0, COPILOT_IMPORT_BYTES - nativeBytes);
      if (rawOpen && remaining) fs.writeSync(fd, chunk.subarray(0, remaining));
      nativeBytes += chunk.length; if (nativeBytes > COPILOT_IMPORT_BYTES) stop();
    });
    return child;
  };
  syncBuiltinESMExports();
  let shutdown;
  try {
    const sdkUrl = import.meta.resolve('@github/copilot-sdk');
    const pkg = JSON.parse(await active(fsp.readFile(new URL('../package.json', sdkUrl), 'utf8')));
    if (pkg.version !== '1.0.29') throw new Error('Unsupported reader SDK');
    const sdk = await active(import(sdkUrl)); controller.signal.throwIfAborted();
    client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ path: executable, args: ['--log-dir', join(directory, 'native-logs')] }), workingDirectory: directory, logLevel: 'error' });
    await active(client.start());
    const status = await active(client.getStatus()), auth = await active(client.getAuthStatus());
    if (!opaque(status.version) || status.version.length > 128 || status.protocolVersion !== 3 || auth.isAuthenticated !== true || auth.authType !== 'gh-cli') throw new Error('Unsupported reader runtime');
    const journal = await readCopilotJournal(params => active(client.rpc.sessions.readPersistedEvents(params)), {
      sessionId, signal: controller.signal, savePage: (file, raw) => active(fsp.writeFile(join(directory, file), raw, { flag: 'wx', mode: 0o600 })),
    });
    result = { schemaVersion: 1, decoder: COPILOT_READER, sessionId, ...journal, runtime: { version: status.version, protocolVersion: status.protocolVersion } };
  } catch { failure = true; }
  finally {
    clearTimeout(timer); const deadline = Date.now() + 18000; let errors;
    const joined = client ? await bounded(client.stop().then(value => { errors = value; }), 12000) : false;
    const closed = await bounded(Promise.all(closes), Math.max(0, deadline - Date.now()));
    shutdown = { sdkStopJoined: joined && errors?.length === 0, childrenClosed: closed && children.length === 1 && children.every(child => child.closed) };
    rawOpen = false; fs.closeSync(out); fs.closeSync(err); childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
  if (failure || !result || !shutdown.sdkStopJoined || !shutdown.childrenClosed || nativeBytes > COPILOT_IMPORT_BYTES) throw new Error('Reader failed');
  process.stdout.write(JSON.stringify({ ...result, nativeOutputBytes: nativeBytes, shutdown }));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.stderr.write('Copilot stored-session reader failed.'); process.exitCode = 1; });
}
