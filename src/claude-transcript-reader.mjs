// Isolated, file-only entry point. Never initialize or resume a Claude agent here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const DECODER = '@anthropic-ai/claude-agent-sdk@0.3.322';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const BODY_BYTES = 1024 * 1024, OUTPUT_BYTES = 8 * 1024 * 1024, RECORDS = 10000;
let guardAttempts = 0;
const deny = () => { guardAttempts++; throw new Error('Reader effect refused'); };

function guardEffects() {
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = deny;
  net.Socket.prototype.connect = deny;
  for (const module of [tls, http, https]) for (const name of ['connect', 'request', 'get']) if (typeof module[name] === 'function') module[name] = deny;
  dgram.createSocket = deny;
  globalThis.fetch = deny;
  for (const module of [fs, fsp]) {
    for (const base of ['appendFile', 'writeFile', 'mkdir', 'mkdtemp', 'rename', 'unlink', 'rm', 'rmdir', 'symlink', 'link',
      'copyFile', 'cp', 'write', 'writev', 'chmod', 'chown', 'lchmod', 'lchown', 'fchmod', 'fchown', 'truncate', 'ftruncate', 'utimes', 'lutimes', 'futimes'])
      for (const name of [base, `${base}Sync`]) if (typeof module[name] === 'function') module[name] = deny;
    if (module === fs) module.createWriteStream = deny;
    for (const name of ['open', 'openSync']) if (typeof module[name] === 'function') {
      const original = module[name];
      module[name] = (...args) => {
        const flags = args[1];
        if (typeof flags === 'string' ? !['r', 'rs'].includes(flags) : typeof flags !== 'number'
          || Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))) return deny();
        const result = original(...args);
        if (module !== fsp) return result;
        return result.then(handle => {
          for (const method of ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream'])
            if (typeof handle[method] === 'function') handle[method] = deny;
          return handle;
        });
      };
    }
  }
  syncBuiltinESMExports();
}

function publicMessage(row, sessionId, omissions) {
  if (!row || !UUID.test(row.uuid) || row.session_id !== sessionId || !['user', 'assistant', 'system'].includes(row.type)) throw new Error('Invalid stored message identity');
  if (row.type === 'system') { omissions.systemMessages++; return null; }
  if (!row.message || row.message.role !== row.type) throw new Error('Invalid stored message role');
  let omittedBlocks = 0, texts = [];
  const content = row.message.content;
  if (typeof content === 'string') texts = [content];
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else omittedBlocks++;
    }
  } else omittedBlocks++;
  // Only public text is selected; thinking, signatures, tools and opaque payloads never leave this process.
  omissions.nonTextBlocks += omittedBlocks;
  const text = texts.length ? texts.join('\n\n') : null;
  if (text !== null && (Buffer.from(text, 'utf8').toString('utf8') !== text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text))) throw new Error('Invalid public text');
  const bodyBytes = text === null ? 0 : Buffer.byteLength(text);
  const body = text !== null && bodyBytes <= BODY_BYTES ? text : null;
  if (body === null) omissions.omittedBodies++;
  return { sessionId, itemId: row.uuid, type: row.type,
    timestamp: typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) ? new Date(row.timestamp).toISOString() : null,
    body, bodyStatus: body === null ? 'omitted' : 'included', bodyBytes, omittedBlocks,
    ...(body === null ? { bodyReason: text === null ? 'non-text-content' : 'body-size-limit' } : {}) };
}

try {
  const sessionId = process.argv[2];
  if (!UUID.test(sessionId)) throw new Error('Invalid source session');
  const sdkUrl = import.meta.resolve('@anthropic-ai/claude-agent-sdk');
  const packageInfo = JSON.parse(await fsp.readFile(new URL('./package.json', sdkUrl), 'utf8'));
  if (packageInfo.version !== '0.3.322') throw new Error('Unexpected reader version');
  guardEffects();
  const { getSessionInfo, getSessionMessages } = await import(sdkUrl);
  // The private config root contains one snapshot. Omitting dir also prevents the SDK's Git worktree fallback.
  const info = await getSessionInfo(sessionId);
  if (info && info.sessionId !== sessionId) throw new Error('Mismatched stored session');
  const stored = await getSessionMessages(sessionId, { includeSystemMessages: true, limit: RECORDS + 1 });
  if (!Array.isArray(stored) || stored.length > RECORDS) throw new Error('Stored message limit');
  const omissions = { systemMessages: 0, nonTextBlocks: 0, omittedBodies: 0 };
  const messages = []; let outputBytes = 2048;
  for (const row of stored) {
    const message = publicMessage(row, sessionId, omissions);
    if (!message) continue;
    let size = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (outputBytes + size > OUTPUT_BYTES && message.body !== null) {
      message.body = null; message.bodyStatus = 'omitted'; message.bodyReason = 'projection-size-limit';
      omissions.omittedBodies++; size = Buffer.byteLength(JSON.stringify(message)) + 1;
    }
    outputBytes += size;
    if (outputBytes > OUTPUT_BYTES) throw new Error('Reader output limit');
    messages.push(message);
  }
  if (guardAttempts || !messages.length || !messages.some(message => message.body?.length)) throw new Error('No public stored messages');
  const result = JSON.stringify({ schemaVersion: 1, decoder: DECODER, sessionId, guardAttempts,
    info: info ? { sessionId: info.sessionId, fileSize: info.fileSize } : null, messages, omissions });
  if (Buffer.byteLength(result) > OUTPUT_BYTES) throw new Error('Reader output limit');
  process.stdout.write(result);
} catch {
  // SDK errors can contain source fragments. Never return those or raw message payloads to the caller.
  process.stderr.write('Claude stored-session reader failed.');
  process.exitCode = 1;
}
