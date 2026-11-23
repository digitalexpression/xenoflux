import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSessionReplay, projectReplayBody, REPLAY_LIMITS } from './audit-session-replay.js';
import { canonicalClaudeDirectory } from './claude-profile.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const boundedId = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const replayLabel = (name, fallback) => boundedId(name) && name.length <= 200 ? name : fallback;
const rejectHistory = () => { throw new Error('Claude native replay could not be bound to the submitted task'); };

export function claudeTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

async function readOwnedTranscript(home, workspace, sessionId) {
  if (!UUID.test(sessionId)) rejectHistory();
  const projects = join(home, 'projects');
  const project = join(projects, workspace.replace(/[^a-zA-Z0-9-]/g, '-'));
  for (const path of [home, projects, project]) await canonicalClaudeDirectory(path, 'Claude replay directory');
  const path = join(project, `${sessionId}.jsonl`), before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() || before.nlink !== 1
    || before.mode & 0o022 || before.size < 1 || before.size > REPLAY_LIMITS.sourceBytes || await realpath(path) !== path) rejectHistory();
  const expected = identity(before), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (identity(await handle.stat()) !== expected) rejectHistory();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) rejectHistory();
      offset += bytesRead;
    }
    if (identity(await handle.stat()) !== expected || identity(await lstat(path)) !== expected || await realpath(path) !== path) rejectHistory();
    return bytes;
  } finally { await handle.close(); }
}

function projectReplay({ sessionId, turnId, rows, fingerprint, cwd, limit }) {
  const budget = { remaining: 2 * 1024 * 1024 }, tools = new Map();
  const events = rows.map(({ text, ...row }, index) => {
    const sourceLine = index + 1;
    const id = `${sessionId}:${fingerprint}:${sourceLine}`;
    const event = { id, sessionId, turnId: UUID.test(turnId ?? '') ? turnId : null, sourceLine, ...row,
      ...projectReplayBody(text, budget) };
    if (row.kind === 'tool-call' || row.kind === 'tool-result') {
      const pair = tools.get(row.callId) ?? { calls: [], results: [] };
      pair[row.kind === 'tool-call' ? 'calls' : 'results'].push(event);
      tools.set(row.callId, pair);
    }
    return event;
  });
  for (const { calls, results } of tools.values()) {
    if (calls.length === 1 && results.length === 1) {
      calls[0].relatedEventId = results[0].id;
      results[0].relatedEventId = calls[0].id;
    } else {
      for (const call of calls) call.linkStatus = calls.length > 1 || results.length > 1 ? 'ambiguous' : 'result-not-found';
      for (const result of results) result.linkStatus = calls.length > 1 || results.length > 1 ? 'ambiguous' : 'call-not-found';
    }
  }
  const status = cwd && events.every(event => event.timestamp && !event.linkStatus) ? 'ready' : 'partial';
  return normalizeSessionReplay({ schemaVersion: 1, kind: 'session-replay', sessions: [{
    id: sessionId, parentId: null, depth: 0, status, ...(cwd ? { cwd } : {}), source: { fingerprint },
    limits: [{ kind: 'capture-boundary', message: limit }], events,
  }] });
}

/** Freeze public root events from the one verified native session after the owned CLI closes. */
export async function captureClaudeNativeReplay({ home, workspace, sessionId, turnId, promptId, task, terminal }) {
  const bytes = await readOwnedTranscript(home, workspace, sessionId);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n');
  if (lines.length > REPLAY_LIMITS.records) rejectHistory();
  const rows = [], seen = new Set(), calls = new Map();
  let foundPrompt = false;
  for (const [index, line] of lines.entries()) {
    const record = JSON.parse(line);
    if (!record || typeof record !== 'object' || Array.isArray(record)) rejectHistory();
    if (!['user', 'assistant'].includes(record.type) || record.isSidechain === true || record.isMeta === true) continue;
    if (record.sessionId !== sessionId || record.cwd !== workspace || record.message?.role !== record.type
      || !UUID.test(record.uuid) || seen.has(record.uuid)) rejectHistory();
    seen.add(record.uuid);
    const timestamp = claudeTimestamp(record.timestamp), sourceLines = [index + 1];
    const event = { sourceLines, timestamp, ...(timestamp ? { timestampSource: 'native' } : {}) };
    const content = record.message.content;
    if (record.uuid === promptId) {
      const text = typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block?.type === 'text')
        ? content.map(block => block.text).join('\n') : null;
      if (foundPrompt || record.type !== 'user' || text !== task) rejectHistory();
      foundPrompt = true;
      rows.push({ ...event, itemId: record.uuid, kind: 'message', role: 'user', label: 'User message', text });
      continue;
    }
    if (!foundPrompt || !Array.isArray(content)) rejectHistory();
    for (const block of content) {
      if (record.type === 'assistant' && block?.type === 'text' && typeof block.text === 'string') {
        rows.push({ ...event, itemId: record.uuid, kind: 'message', role: 'assistant', label: 'Assistant message', text: block.text });
      } else if (record.type === 'assistant' && block?.type === 'tool_use' && boundedId(block.id)) {
        if (calls.has(block.id)) rejectHistory();
        calls.set(block.id, false);
        rows.push({ ...event, itemId: record.uuid, kind: 'tool-call', callId: block.id,
          label: replayLabel(block.name, 'Tool call'), text: block.input });
      } else if (record.type === 'user' && block?.type === 'tool_result' && calls.get(block.tool_use_id) === false) {
        calls.set(block.tool_use_id, true);
        // Claude tool output can contain image and opaque blocks. Keep public text only.
        const blocks = Array.isArray(block.content) ? block.content : [];
        const publicText = blocks.filter(value => value?.type === 'text' && typeof value.text === 'string');
        const text = typeof block.content === 'string' ? block.content : publicText.length ? publicText.map(value => value.text).join('\n') : null;
        rows.push({ ...event, itemId: record.uuid, kind: 'tool-result', callId: block.tool_use_id,
          label: 'Tool result', status: block.is_error === true ? 'failed' : 'completed', text,
          ...(blocks.length !== publicText.length ? { contentOmitted: true } : {}) });
      } else if (record.type === 'user') rejectHistory();
    }
    if (rows.length >= REPLAY_LIMITS.records) rejectHistory();
  }
  if (!foundPrompt || !rows.some(event => event.role === 'assistant')) rejectHistory();
  if (terminal) rows.push(terminal);
  const fingerprint = digest(bytes);
  return { fingerprint, replay: projectReplay({ sessionId, turnId, rows, fingerprint, cwd: workspace,
    limit: 'Frozen root transcript from the owned Claude session. The terminal marker uses the observed SDK receipt. Delegated transcripts, private reasoning, and opaque tool content are outside this capture.' }) };
}

export function captureClaudeObservedReplay({ sessionId, turnId, rows }) {
  const boundedRows = rows.slice(0, REPLAY_LIMITS.records);
  const fingerprint = digest(JSON.stringify([sessionId, turnId, boundedRows]));
  return { fingerprint, replay: projectReplay({ sessionId, turnId, rows: boundedRows, fingerprint,
    limit: 'Owned Claude SDK stream. Observed timestamps reflect SDK receipt. Source lines are projection ordinals. The native transcript, delegated sessions, private reasoning, and opaque tool content are outside this capture.' }) };
}
