import { createHash } from 'node:crypto';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactValue } from './redact.js';
const MAX_LINKED_AGENTS = 64;
const METADATA_NATIVE_EVENTS = new Set(['thread/readState/changed', 'turn/moderationMetadata', 'turn/diff/updated',
  'item/agentMessage/delta', 'item/commandExecution/outputDelta']);
const CAPTURE_NATIVE_EVENTS = new Set(['thread/started', 'thread/status/changed', 'turn/started', 'turn/completed',
  'item/started', 'item/completed', ...METADATA_NATIVE_EVENTS,
  'thread/tokenUsage/updated', 'mcpServer/startupStatus/updated', 'hook/started', 'hook/completed', 'error']);
const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const safeText = (v, max = 160) => typeof v === 'string' && v.length <= max
  ? String(redactValue(v)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max) : undefined;
const idHash = v => createHash('sha256').update(String(v)).digest('hex').slice(0, 24);
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const validId = v => typeof v === 'string' && SAFE_ID.test(v);
const timestampFromNativeSeconds = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000
  ? new Date(value * 1000).toISOString() : null;
function nativePath(value, cwd = null) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
  let path = value;
  if (value.startsWith('file://')) {
    try { const url = new URL(value); if (url.search || url.hash) return null; path = fileURLToPath(url); }
    catch { return null; }
  }
  if (!path.startsWith('/')) { if (!cwd) return null; path = resolve(cwd, path); }
  return path.startsWith('/') ? path : null;
}
function emptyUsage() {
  return { scope: 'per-agent-source-reported', last: null, total: null, snapshots: 0 };
}

function safeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const project = b => {
    if (!b || typeof b !== 'object') return null;
    const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens', 'totalTokens'];
    const result = {};
    for (const field of fields) result[field] = count(b[field]);
    return result;
  };
  return { last: project(raw.last), total: project(raw.total), modelContextWindow: count(raw.modelContextWindow) };
}

function skillProjection(skill, cwd, profileHome = null) {
  if (!skill || typeof skill !== 'object' || typeof skill.name !== 'string' || typeof skill.path !== 'string') return null;
  const scopeMap = { user: 'user', repo: 'project', system: 'system', admin: 'admin' };
  const nativeScope = scopeMap[skill.scope];
  if (!nativeScope) return null;
  const skillPath = nativePath(skill.path, nativePath(cwd));
  if (!skillPath) return null;
  const plugin = safeText(skill.pluginId, 120);
  const profileSkillsRoot = typeof profileHome === 'string' && isAbsolute(profileHome) ? resolve(profileHome, 'skills') : null;
  const absoluteSkillPath = resolve(skillPath);
  const profileRelative = profileSkillsRoot && absoluteSkillPath ? relative(profileSkillsRoot, absoluteSkillPath) : null;
  const isProfileSkill = !plugin && skill.scope === 'user' && profileRelative !== null
    && profileRelative !== '..' && !profileRelative.startsWith(`..${sep}`) && !isAbsolute(profileRelative);
  const scope = isProfileSkill ? 'profile' : nativeScope;
  return {
    id: idHash(`${skill.scope}\0${skill.pluginId ?? ''}\0${skillPath}`),
    name: safeText(skill.name, 120) ?? 'unknown-skill',
    origin: plugin ? 'plugin' : scope === 'project' ? 'repository' : scope === 'user' ? 'user' : scope,
    scope,
    nativeScope: skill.scope,
    path: safeText(skillPath, 512),
    ...(plugin ? { provider: plugin } : {}),
    enabled: skill.enabled === true,
    observations: [],
    catalogs: [{ source: 'skills/list', cwd: safeText(cwd, 512), agentId: null }],
  };
}

function eventProjection(method, p, index) {
  const threadId = validId(p?.threadId) ? p.threadId : undefined;
  const turnId = validId(p?.turnId) ? p.turnId : undefined;
  const at = Number.isFinite(p?.completedAtMs) ? p.completedAtMs : Number.isFinite(p?.startedAtMs) ? p.startedAtMs : null;
  const out = { kind: method, recordedAt: at, sourceLine: index };
  if (threadId) out.threadId = threadId;
  if (turnId) out.turnId = turnId;
  // Streaming text, command output, diffs and moderation/read-state payloads
  // stay private. Their known notification kind and item identity are enough
  // to explain activity without duplicating terminal items or token counters.
  if (METADATA_NATIVE_EVENTS.has(method)) {
    if (method === 'thread/readState/changed') delete out.turnId;
    if (['item/agentMessage/delta', 'item/commandExecution/outputDelta'].includes(method)
      && validId(p?.itemId)) out.itemId = p.itemId;
    return out;
  }
  if (p?.item && typeof p.item === 'object') {
    const item = p.item;
    const type = safeText(item.type, 80);
    const itemId = validId(item.id) ? item.id : undefined;
    if (type) out.itemType = type;
    if (itemId) out.itemId = itemId;
    if (typeof item.status === 'string') out.status = safeText(item.status, 60);
    if (Number.isSafeInteger(item.exitCode)) out.exitCode = item.exitCode;
    // A collab link is accepted only from structured native metadata; the
    // prompt/description accompanying it is intentionally omitted.
    const call = item.collabAgentToolCall ?? item;
    const receivers = call?.receiverThreadIds;
    if (Array.isArray(receivers)) out.receiverThreadIds = receivers.filter(validId).slice(0, MAX_LINKED_AGENTS);
    const parent = call?.threadId ?? call?.senderThreadId;
    if (validId(parent)) out.parentThreadId = parent;
    const name = safeText(item.name ?? item.toolName, 100);
    if (name) out.toolName = name;
    if (typeof item.error === 'boolean') out.failed = item.error;
  }
  if (p?.turn && typeof p.turn === 'object') {
    out.turnId ??= validId(p.turn.id) ? p.turn.id : undefined;
    if (typeof p.turn.status === 'string') out.status = safeText(p.turn.status, 60);
  }
  if (p?.status && typeof p.status.type === 'string') out.status = safeText(p.status.type, 40);
  if (method === 'error') {
    if (typeof p?.willRetry === 'boolean') out.willRetry = p.willRetry;
    const info = p?.error?.codexErrorInfo;
    const allowed = new Set(['contextWindowExceeded','sessionBudgetExceeded','usageLimitExceeded','rateLimitExceeded','flexUnavailable',
      'serverOverloaded','cyberPolicy','misalignmentPolicyViolation','tooManyDenials','internalServerError','unauthorized','badRequest',
      'threadRollbackFailed','sandboxError','other']);
    if (typeof info === 'string' && allowed.has(info)) out.errorCode = info;
    else if (info && typeof info === 'object' && !Array.isArray(info)) {
      const tag = Object.keys(info).find(key => ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected',
        'responseTooManyFailedAttempts','activeTurnNotSteerable'].includes(key));
      if (tag) {
        out.errorCode = tag;
        const detail = info[tag];
        if (tag === 'activeTurnNotSteerable' && ['review','compact'].includes(detail?.turnKind)) out.turnKind = detail.turnKind;
        else if (Number.isSafeInteger(detail?.httpStatusCode) && detail.httpStatusCode >= 0 && detail.httpStatusCode <= 65535)
          out.httpStatusCode = detail.httpStatusCode;
      }
    }
  }
  return out;
}

function linkedAgentCandidates(item) {
  if (!item || typeof item !== 'object') return [];
  // Current Codex schemas can report delegated work as a sub-agent activity
  // item without the older collaboration tool-call receiver list. Keep only
  // the thread identifier; agentPath and any surrounding prose are ignored.
  if (item.type === 'subAgentActivity')
    return validId(item.agentThreadId) ? [item.agentThreadId] : [];
  const call = item.collabAgentToolCall ?? item;
  return Array.isArray(call?.receiverThreadIds) ? call.receiverThreadIds.filter(validId).slice(0, MAX_LINKED_AGENTS) : [];
}


export { CAPTURE_NATIVE_EVENTS, safeText, idHash, count, validId, timestampFromNativeSeconds, nativePath, emptyUsage, safeUsage, skillProjection, eventProjection, linkedAgentCandidates };
