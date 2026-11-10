// Explicit local-file admission and projection; this does not select a Claude execution transport.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { privateDirectory } from './metadata.js';
import { normalizeSessionReplay, REPLAY_LIMITS } from './audit-session-replay.js';

const MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DECODER = '@anthropic-ai/claude-agent-sdk@0.3.322';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runReader = promisify(execFile);
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => new Error('The Claude transcript is invalid, changed, empty, or exceeds the import limits.');
function onlyKeys(value, keys) {
  if (!ownObject(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail();
}

function admit(fileName, text) {
  if (typeof fileName !== 'string' || basename(fileName) !== fileName || !fileName.endsWith('.jsonl') || !UUID.test(fileName.slice(0, -6))
    || typeof text !== 'string' || !text.length || text.length > MAX_BYTES || text.startsWith('\ufeff')) throw fail();
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_BYTES || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== text
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) throw fail();
  const sessionId = fileName.slice(0, -6); let count = 0, lines = 0, start = 0;
  for (let end = text.indexOf('\n'); start < text.length; end = text.indexOf('\n', start)) {
    if (++lines > REPLAY_LIMITS.records + 1) throw fail();
    const line = text.slice(start, end < 0 ? text.length : end).trim();
    start = end < 0 ? text.length : end + 1;
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { throw fail(); }
    if (!ownObject(record) || ++count > REPLAY_LIMITS.records) throw fail();
    if (record.sessionId !== undefined && record.sessionId !== sessionId) throw fail();
    if (['user', 'assistant'].includes(record.type) && (!UUID.test(record.uuid) || record.sessionId !== sessionId)) throw fail();
  }
  if (!count) throw fail();
  return { bytes, sessionId };
}

const token = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.uid, stat.nlink]);
async function verifySnapshot(path, expectedBytes, expectedToken) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid()
    || before.mode & 0o077 || before.size !== expectedBytes.length || await realpath(path) !== path
    || expectedToken && token(before) !== expectedToken) throw fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (token(stat) !== token(before)) throw fail();
    const bytes = Buffer.alloc(expectedBytes.length); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    if (hash(bytes) !== hash(expectedBytes) || token(await handle.stat()) !== token(stat) || token(await lstat(path)) !== token(stat)) throw fail();
    return token(stat);
  } finally { await handle.close(); }
}

function validateReader(result, sessionId, size) {
  onlyKeys(result, ['schemaVersion', 'decoder', 'sessionId', 'guardAttempts', 'info', 'messages', 'omissions']);
  if (result.info !== null) onlyKeys(result.info, ['sessionId', 'fileSize']);
  onlyKeys(result.omissions, ['systemMessages', 'nonTextBlocks', 'omittedBodies']);
  if (result.schemaVersion !== 1 || result.decoder !== DECODER || result.sessionId !== sessionId || result.guardAttempts !== 0
    || result.info !== null && (result.info.sessionId !== sessionId || result.info.fileSize !== size) || !Array.isArray(result.messages)
    || !result.messages.length || result.messages.length > REPLAY_LIMITS.records
    || ['systemMessages', 'nonTextBlocks', 'omittedBodies'].some(key => !Number.isSafeInteger(result.omissions[key])
      || result.omissions[key] < 0 || result.omissions[key] > REPLAY_LIMITS.records * 1000)) throw fail();
  const seen = new Set(); let bodyBytes = 0;
  for (const message of result.messages) {
    onlyKeys(message, ['sessionId', 'itemId', 'type', 'timestamp', 'body', 'bodyStatus', 'bodyBytes', 'omittedBlocks', 'bodyReason']);
    if (message.sessionId !== sessionId || !UUID.test(message.itemId) || seen.has(message.itemId) || !['user', 'assistant'].includes(message.type)
      || message.timestamp !== null && (typeof message.timestamp !== 'string' || !Number.isFinite(Date.parse(message.timestamp)) || new Date(message.timestamp).toISOString() !== message.timestamp)
      || !Number.isSafeInteger(message.bodyBytes) || message.bodyBytes < 0 || message.bodyBytes > MAX_BYTES
      || !Number.isSafeInteger(message.omittedBlocks) || message.omittedBlocks < 0 || message.omittedBlocks > REPLAY_LIMITS.records * 1000
      || !['included', 'omitted'].includes(message.bodyStatus)
      || message.bodyReason !== undefined && !['non-text-content', 'body-size-limit', 'projection-size-limit'].includes(message.bodyReason)) throw fail();
    seen.add(message.itemId);
    if (message.bodyStatus === 'included') {
      if (typeof message.body !== 'string' || Buffer.from(message.body, 'utf8').toString('utf8') !== message.body || Buffer.byteLength(message.body) !== message.bodyBytes || message.bodyBytes > REPLAY_LIMITS.bodyBytes
        || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(message.body)) throw fail();
      bodyBytes += message.bodyBytes;
    } else if (message.body !== null || !message.bodyReason) throw fail();
  }
  if (result.omissions.nonTextBlocks !== result.messages.reduce((sum, message) => sum + message.omittedBlocks, 0)
    || result.omissions.omittedBodies !== result.messages.filter(message => message.bodyStatus === 'omitted').length) throw fail();
  if (bodyBytes > REPLAY_LIMITS.totalBodyBytes || !result.messages.some(message => message.body?.length)) throw fail();
  return result;
}

export async function importClaudeTranscript({ fileName, text } = {}, { directory, onArtifactCreated } = {}) {
  const { bytes, sessionId } = admit(fileName, text);
  if (typeof directory !== 'string' || !isAbsolute(directory) || resolve(directory) !== directory) throw fail();
  await privateDirectory(dirname(directory));
  // Exclusive creation makes failure cleanup belong only to this import.
  await mkdir(directory, { mode: 0o700 });
  const directoryToken = await lstat(directory);
  try {
    onArtifactCreated?.({ directory, dev: directoryToken.dev, ino: directoryToken.ino });
    await privateDirectory(directory);
    const home = join(directory, 'snapshot'), projects = join(home, 'projects'), selected = join(projects, 'selected');
    for (const path of [home, projects, selected]) { await mkdir(path, { mode: 0o700 }); await privateDirectory(path); }
    const original = join(directory, 'source.jsonl'), snapshot = join(selected, fileName);
    for (const path of [original, snapshot]) await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const originalToken = await verifySnapshot(original, bytes), snapshotToken = await verifySnapshot(snapshot, bytes);
    let stdout;
    try {
      ({ stdout } = await runReader(process.execPath,
        ['--max-old-space-size=128', fileURLToPath(new URL('./claude-transcript-reader.mjs', import.meta.url)), sessionId], {
          cwd: home, env: { HOME: home, CLAUDE_CONFIG_DIR: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
          timeout: 10000, maxBuffer: MAX_BYTES, killSignal: 'SIGKILL', encoding: 'buffer', windowsHide: true,
        }));
    } catch { throw new Error('The isolated Claude stored-session reader could not import this file.'); }
    await verifySnapshot(original, bytes, originalToken); await verifySnapshot(snapshot, bytes, snapshotToken);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout)); } catch { throw fail(); }
    const result = validateReader(parsed, sessionId, bytes.length);
    const sanitized = result.messages.map(message => JSON.stringify(message)).join('\n') + '\n';
    const fingerprint = hash(sanitized);
    await writeFile(join(directory, 'sdk-messages.jsonl'), sanitized, { flag: 'wx', mode: 0o600 });
    const limits = [{ kind: 'imported-projection', message: 'SDK-projected stored conversation only; full turns, tools, outcome, usage, account, original surface and execution location are unknown.' },
      { kind: 'source-line-basis', message: 'Source lines are ordinals in the retained sanitized SDK message snapshot, not original transcript lines.' }];
    for (const [kind, omitted] of Object.entries(result.omissions)) if (omitted) limits.push({ kind, omitted, message: 'Private, non-text, system or oversized content was omitted from the public conversation projection.' });
    const sessionReplay = normalizeSessionReplay({ schemaVersion: 1, kind: 'session-replay', sessions: [{
      id: sessionId, parentId: null, depth: 0, status: 'partial', source: { fingerprint }, limits,
      events: result.messages.map((message, index) => ({ id: `${sessionId}:${fingerprint}:${index + 1}`, sessionId, turnId: null,
        sourceLine: index + 1, itemId: message.itemId, kind: 'message', role: message.type,
        label: message.type === 'user' ? 'User message' : 'Assistant message', timestamp: message.timestamp,
        body: message.body, bodyStatus: message.bodyStatus, bodyBytes: message.bodyBytes,
        ...(message.bodyReason ? { bodyReason: message.bodyReason } : {}),
        ...(message.omittedBlocks || message.bodyStatus === 'omitted' ? { contentOmitted: true } : {}) })),
    }] });
    return { schemaVersion: 1, kind: 'audit-run', id: randomUUID(), status: 'partial',
      reason: 'Imported stored conversation; full turn, tool, outcome, usage, account, original surface and execution location evidence is unknown.',
      profile: { profileName: 'Imported Claude Code' }, clientIdentity: { client: 'claude-code' },
      source: { kind: 'claude-code-sdk-file-import', nativeSessionId: sessionId, rawSourceSha256: hash(bytes), decoder: DECODER,
        projectionSha256: fingerprint, sourceLineBasis: 'sanitized-sdk-message-snapshot-ordinal',
        projectionBasis: 'SDK-selected public user/assistant text; not a complete native execution capture' }, sessionReplay };
  } catch (error) {
    const current = await lstat(directory).catch(() => null);
    if (current?.dev === directoryToken.dev && current.ino === directoryToken.ino) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
