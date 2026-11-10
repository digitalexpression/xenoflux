// Selected-session import via the public SDK; no native execution adapter is enabled.
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privateDirectory } from './metadata.js';
import { runAuditProcess } from './audit-process.js';
import { normalizeSessionReplay, REPLAY_LIMITS } from './audit-session-replay.js';
import { assertCopilotImplicitEnvironment, COPILOT_IMPORT_BYTES as MAX_BYTES, COPILOT_READER, readCopilotJournal } from './copilot-transcript-reader.mjs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const failure = () => new Error('The Copilot stored-session reader could not import this local session. Check the session ID, native sign-in, persisted-reading support and import limits.');
const identity = s => JSON.stringify([s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
async function capturedFile(path, expected) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid() || before.mode & 0o077
    || before.size !== expected.bytes || before.size > MAX_BYTES || await realpath(path) !== path) throw failure();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(await handle.stat()) !== identity(before)) throw failure();
    const raw = Buffer.alloc(before.size); let offset = 0;
    while (offset < raw.length) { const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset); if (!bytesRead) throw failure(); offset += bytesRead; }
    if (hash(raw) !== expected.sha256 || identity(await handle.stat()) !== identity(before) || identity(await lstat(path)) !== identity(before)) throw failure();
    return { raw, token: identity(before) };
  } finally { await handle.close(); }
}
async function readNativeJournal({ sessionId, directory, signal }) {
  assertCopilotImplicitEnvironment(process.env);
  let executable, executableIdentity;
  for (const path of (process.env.PATH ?? '').split(':').filter(path => path.startsWith('/'))) {
    const candidate = join(path, 'copilot');
    try { const target = await realpath(candidate), stat = await lstat(target); if (!stat.isFile() || stat.isSymbolicLink()) continue; await access(target, constants.X_OK); executable = candidate; executableIdentity = hash(identity(stat)); break; } catch { /* Continue through the inherited PATH without shell discovery. */ }
  }
  if (!executable) throw failure();
  const status = await runAuditProcess({ executable: process.execPath,
    args: ['--max-old-space-size=128', fileURLToPath(new URL('./copilot-transcript-reader.mjs', import.meta.url)), JSON.stringify({ sessionId, directory, executable })],
    cwd: directory, env: { ...process.env }, signal, timeoutMs: 49000, outputLimitBytes: MAX_BYTES,
    stdoutPath: join(directory, 'reader.stdout'), stderrPath: join(directory, 'reader.stderr') });
  if (status.status !== 'exited' || status.exitCode !== 0 || !status.shutdown.groupTerminated || status.output.truncated) throw failure();
  const bytes = await readFile(join(directory, 'reader.stdout')); if (bytes.length > 65536) throw failure();
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return { ...result, readerExecutableIdentitySha256: executableIdentity };
}
function publicMessages(pages, sessionId) {
  const messages = [], ids = new Set(), observedModels = new Set(); let omittedEvents = 0, omittedBodies = 0;
  for (const page of pages) for (const event of page.events) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw failure();
    if (event.type === 'session.start' && event.data?.sessionId !== undefined && event.data.sessionId !== sessionId) throw failure();
    if (event.sessionId !== undefined && event.sessionId !== sessionId) throw failure();
    if (!['user.message', 'assistant.message'].includes(event.type)) { omittedEvents++; continue; }
    if (event.id !== undefined && !opaque(event.id)) throw failure();
    if (event.id !== undefined && ids.has(event.id)) throw failure();
    if (event.id !== undefined) ids.add(event.id);
    const text = event.data?.content;
    if (typeof text === 'string' && (Buffer.from(text).toString('utf8') !== text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text))) throw failure();
    const bodyBytes = typeof text === 'string' ? Buffer.byteLength(text) : 0;
    const included = typeof text === 'string' && bodyBytes <= REPLAY_LIMITS.bodyBytes;
    if (!included) omittedBodies++;
    if (event.type === 'assistant.message' && typeof event.data?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(event.data.model)) observedModels.add(event.data.model);
    messages.push({ sessionId, itemId: event.id ?? null, type: event.type === 'user.message' ? 'user' : 'assistant',
      timestamp: typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? new Date(event.timestamp).toISOString() : null,
      body: included ? text : null, bodyStatus: included ? 'included' : 'omitted', bodyBytes,
      ...(!included ? { bodyReason: typeof text === 'string' ? 'body-size-limit' : 'non-text-content' } : {}) });
  }
  if (!messages.length || !messages.some(message => message.body?.length)) throw failure();
  return { messages, omittedEvents, omittedBodies, observedModels: [...observedModels] };
}
/** readJournal is a fixture seam; production uses only the isolated public-SDK reader. */
export async function importCopilotTranscript({ sessionId } = {}, { directory, onArtifactCreated, readJournal = readNativeJournal, signal } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory) throw failure();
  await privateDirectory(dirname(directory)); await mkdir(directory, { mode: 0o700 });
  const owned = await lstat(directory);
  try {
    onArtifactCreated?.({ directory, dev: owned.dev, ino: owned.ino }); signal?.throwIfAborted();
    const result = await readJournal({ sessionId, directory, signal }); signal?.throwIfAborted();
    const current = await lstat(directory); if (current.dev !== owned.dev || current.ino !== owned.ino) throw failure();
    if (result?.complete !== true || result.sessionId !== undefined && result.sessionId !== sessionId
      || result.decoder !== undefined && result.decoder !== COPILOT_READER || result.schemaVersion !== undefined && result.schemaVersion !== 1
      || result.shutdown?.sdkStopJoined !== true || result.shutdown?.childrenClosed !== true || result.runtime?.protocolVersion !== 3
      || !opaque(result.runtime?.version) || !Array.isArray(result.pages) || result.pages.length < 1 || result.pages.length > 8
      || result.nativeOutputBytes !== undefined && (!Number.isSafeInteger(result.nativeOutputBytes) || result.nativeOutputBytes < 0 || result.nativeOutputBytes > MAX_BYTES)) throw failure();
    const captures = [], pages = []; let rawBytes = 0;
    for (const [index, page] of result.pages.entries()) {
      if (page.file !== `raw-page-${String(index + 1).padStart(2, '0')}.json` || !Number.isSafeInteger(page.bytes) || page.bytes < 1 || !/^[a-f0-9]{64}$/.test(page.sha256)) throw failure();
      rawBytes += page.bytes; if (rawBytes > MAX_BYTES) throw failure();
      const capture = await capturedFile(join(directory, page.file), page); captures.push(capture);
      pages.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(capture.raw)));
    }
    let next = 0;
    const check = await readCopilotJournal(async () => pages[next++], { sessionId, signal, savePage: async () => {} });
    if (next !== pages.length || check.complete !== true) throw failure();
    const projected = publicMessages(pages, sessionId), text = projected.messages.map(row => JSON.stringify(row)).join('\n') + '\n';
    let metadataBytes = 0;
    for (const file of ['reader.stdout', 'reader.stderr', 'native-process.json']) {
      try { metadataBytes += (await lstat(join(directory, file))).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (rawBytes + Buffer.byteLength(text) + metadataBytes > MAX_BYTES) throw failure();
    const fingerprint = hash(text), rawHash = hash(Buffer.concat(captures.map(capture => capture.raw)));
    for (let i = 0; i < captures.length; i++) if ((await capturedFile(join(directory, result.pages[i].file), result.pages[i])).token !== captures[i].token) throw failure();
    signal?.throwIfAborted();
    await writeFile(join(directory, 'sdk-messages.jsonl'), text, { flag: 'wx', mode: 0o600 });
    const limits = [{ kind: 'imported-projection', message: 'Durable journal public text only; full turns, tools, outcome, usage, account, original surface and execution location are unknown.' },
      { kind: 'journal-snapshot', message: 'Pinned journal generation and byte boundary; later appends, ephemeral events and activation-only payloads are excluded. Historical lifecycle events do not mean this read activated the session.' },
      { kind: 'source-line-basis', message: 'Source lines are ordinals in the sanitized SDK message snapshot.' },
      { kind: 'omitted-events', omitted: projected.omittedEvents, message: 'All system, reasoning, tool, opaque, asset and non-message event content is omitted.' }];
    if (projected.omittedBodies) limits.push({ kind: 'omitted-bodies', omitted: projected.omittedBodies, message: 'Non-text or oversized public message bodies are omitted.' });
    const sessionReplay = normalizeSessionReplay({ schemaVersion: 1, kind: 'session-replay', sessions: [{ id: sessionId, parentId: null, depth: 0, status: 'partial', source: { fingerprint }, limits,
      events: projected.messages.map((message, index) => ({ id: `${sessionId}:${fingerprint}:${index + 1}`, sessionId, turnId: null, sourceLine: index + 1,
        ...(message.itemId !== null ? { itemId: message.itemId } : {}), kind: 'message', role: message.type, label: message.type === 'user' ? 'User message' : 'Assistant message',
        timestamp: message.timestamp, body: message.body, bodyStatus: message.bodyStatus, bodyBytes: message.bodyBytes,
        ...(message.bodyReason ? { bodyReason: message.bodyReason, contentOmitted: true } : {}) })) }] });
    const finalDirectory = await lstat(directory); if (finalDirectory.dev !== owned.dev || finalDirectory.ino !== owned.ino) throw failure();
    return { schemaVersion: 1, kind: 'audit-run', id: randomUUID(), status: 'partial',
      reason: 'Imported stored public conversation; execution completion, full turns, tools, usage and account evidence are unknown.',
      profile: { profileName: 'Imported Copilot' }, clientIdentity: { client: 'copilot' },
      source: { kind: 'copilot-sdk-persisted-import', nativeSessionId: sessionId, rawSourceSha256: rawHash, decoder: COPILOT_READER, projectionSha256: fingerprint,
        readerRuntime: { version: result.runtime.version, protocolVersion: result.runtime.protocolVersion },
        ...(/^[a-f0-9]{64}$/.test(result.readerExecutableIdentitySha256 ?? '') ? { readerExecutableIdentitySha256: result.readerExecutableIdentitySha256 } : {}),
        observedModels: projected.observedModels, sourceLineBasis: 'sanitized-sdk-message-snapshot-ordinal',
        projectionBasis: 'Public data.content text from SDK durable-event pages; not a native execution capture' }, sessionReplay };
  } catch {
    const current = await lstat(directory).catch(() => null);
    if (current?.dev === owned.dev && current.ino === owned.ino) await rm(directory, { recursive: true, force: true });
    throw failure();
  }
}
