// Read-only, bounded ingestion of one selected native Codex workflow.
// Native session content is untrusted data: only whitelisted metadata leaves this module.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { redactText } from './redact.js';
import { resolveAuditProfile } from './audit-discovery.js';
import { assessUsageSequence, normalizeUsageSnapshot, USAGE_FIELDS } from './audit-usage.js';
import { createAuditToolCapture } from './audit-tools.js';
import { createAuditHookCapture } from './audit-hooks.js';
import { parseLiteralSkillRead, parseLiteralSkillReadDetails } from './audit-skill-read.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 32 * 1024 * 1024, MAX_LINE = 1024 * 1024, MAX_RECORDS = 10000;
const MAX_CHILDREN = 100, MAX_DEPTH = 4, MAX_CANDIDATES = 10000, MAX_PHYSICAL_LINES = 100000;
const HOOK_HISTORY_BOUNDARY = 'rollout-hook-lifecycle-not-observed';
const SAFE_TEXT = (v, n = 256) => typeof v === 'string' && v.length > 0 && v.length <= n
  && !/[\x00-\x1f\x7f-\x9f]/.test(v) && redactText(v, 'metadata.txt') === v;
const validPath = v => typeof v === 'string' && v.length <= 4096 && v.startsWith('/')
  && !/[\x00-\x1f\x7f-\x9f]/.test(v) && resolve(v) === v;
const catalogPath = v => validPath(v) || (typeof v === 'string' && /^r\d+\/[A-Za-z0-9_.@+/-]+\/SKILL\.md$/i.test(v));
const safeArtifactPath = v => (validPath(v) && SAFE_TEXT(v, 4096)) || (typeof v === 'string' && v.length <= 4096 && !v.startsWith('/')
  && !/[\x00-\x1f\x7f-\x9f]/.test(v) && !v.split(/[\\/]/).includes('..') && SAFE_TEXT(v, 4096));
const inside = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`); };
const uuid = v => typeof v === 'string' && UUID.test(v);
const USAGE_SOURCE_FIELDS = Object.freeze({ input_tokens: 'inputTokens', output_tokens: 'outputTokens',
  cached_input_tokens: 'cachedInputTokens', reasoning_output_tokens: 'reasoningOutputTokens',
  cache_write_input_tokens: 'cacheWriteInputTokens', total_tokens: 'totalTokens' });
function projectNativeTokenFields(raw) {
  const tokens = {}, invalidFields = [];
  for (const [sourceField, field] of Object.entries(USAGE_SOURCE_FIELDS)) {
    if (!Object.hasOwn(raw, sourceField)) continue;
    const value = raw[sourceField];
    if (Number.isSafeInteger(value) && value >= 0) tokens[sourceField] = value;
    else if (value !== null) invalidFields.push(field);
  }
  return { tokens, invalidFields };
}

function emptyCoverage(status = 'unavailable') {
  return { timeline: status, agents: status, skills: status, usage: status, tools: status, mcp: status,
    hooks: status, workspaceDiff: 'unavailable', outcome: 'unavailable' };
}
function resultBase(profile, id) {
  return { schemaVersion: 1, kind: 'audit-run', id: randomUUID(), profile: {
    profileId: profile.profileId, profileName: profile.profileName, home: profile.home,
    userHome: profile.userHome, environmentId: profile.environmentId ?? null,
  }, status: 'unavailable', reason: null, hookCaptureBoundary: null, source: { kind: 'native-rollout', nativeSessionId: id,
    path: null, fingerprint: null, bytes: null, recordCount: 0, clientVersion: null, originator: null },
  agents: [], events: [], turns: [], skills: [], toolInvocations: [], hookInvocations: [], mcp: { servers: [], inventory: 'not-requested' }, usage: { status: 'unavailable', observations: [], totals: null },
  metrics: { recordedSpanMs: null }, coverage: emptyCoverage(), outcome: { status: 'unverified', checks: [] }, artifacts: [], warnings: [] };
}

async function safeRegular(root, path) {
  try {
    if (!validPath(path) || !inside(resolve(root), resolve(path))) return null;
    const expected = await lstat(path);
    if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) return null;
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)]);
    if (canonicalPath !== path || !inside(canonicalRoot, canonicalPath)) return null;
    return expected;
  } catch { return null; }
}
async function checkedIndex(home) {
  const path = join(home, 'state_5.sqlite');
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native home path is unsafe');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const item = await safeRegular(home, `${path}${suffix}`);
    if (suffix === '' && !item) return null;
    if (suffix && !item) { try { await lstat(`${path}${suffix}`); throw new Error('Native history index sidecar is unsafe'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  return path;
}
async function exactRow(home, id) {
  const path = await checkedIndex(home); if (!path) return { row: null, status: 'not-found' };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(x => x.name));
    if (!columns.has('id') || !columns.has('archived')) throw new Error('Native history index schema is unsupported');
    const rollout = columns.has('rollout_path') ? ', substr(rollout_path,1,4097) AS rollout_path' : '';
    const source = columns.has('source') ? ', substr(source,1,8193) AS native_source' : '';
    const row = db.prepare(`SELECT substr(id,1,37) AS id, archived${rollout}${source} FROM threads WHERE id=? LIMIT 1`).get(id);
    if (row && row.native_source) {
      try {
        const value = JSON.parse(row.native_source), parentId = value?.subagent?.thread_spawn?.parent_thread_id;
        if (parentId !== undefined) {
          if (!uuid(parentId) || parentId === id || !db.prepare('SELECT id FROM threads WHERE id=? LIMIT 1').get(parentId))
            return { row, status: 'unavailable', lineageError: 'The selected child parent is absent or invalid in this profile index.' };
          row.parentId = parentId;
        }
      } catch {
        // Current native indexes also store a scalar source label for ordinary
        // root sessions. Only these observed non-child labels are accepted.
        if (!['cli', 'vscode', 'exec'].includes(row.native_source))
          return { row, status: 'unavailable', lineageError: 'The selected child lineage metadata is malformed.' };
      }
    }
    return { row: row ?? null, status: row ? 'ready' : 'not-found' };
  } finally { db.close(); }
}
function decode(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function safeMetaText(v, limit = 256) { return SAFE_TEXT(v, limit) ? v : null; }

// Extract skill metadata only when the native record carries structured catalog
// entries or an explicit absolute skill-definition/resource path. Never parse
// ordinary assistant prose as a catalog or claim a mention means usage.
function addCatalogSkills(value, agentId, turnId, line, skills, observations) {
  const candidates = [];
  const visit = (node, depth = 0) => {
    if (depth > 5 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node.slice(0, 500)) visit(child, depth + 1); return; }
    const name = node.name ?? node.skill_name;
    const path = node.path ?? node.skill_path ?? node.definition_path;
    if (typeof name === 'string' && typeof path === 'string' && /(?:^|\/)SKILL\.md$/i.test(path)) candidates.push(node);
    for (const key of ['skills', 'skill_catalog', 'skills_instructions', 'available_skills', 'skill']) visit(node[key], depth + 1);
  };
  visit(value);
  // Codex turn contexts may store the native skills_instructions catalog as a
  // rendered block. Parse only explicit catalog entries carrying an absolute
  // definition path, never arbitrary mentions in instructions or conversation.
  const rendered = typeof value?.skills_instructions === 'string' ? value.skills_instructions : '';
  if (rendered.length <= 128 * 1024 && /<skills_instructions\b/i.test(rendered)) {
    const block = rendered.match(/<skills_instructions\b[^>]*>([\s\S]*?)<\/skills_instructions>/i)?.[1] ?? '';
    const entryPattern = /(?:^|\n)\s*(?:[-*]\s*)?(?:name\s*:\s*)?([^\n]{1,160})\n(?:[^\n]*\n){0,4}?\s*(?:path\s*:\s*)?(\/[^\s<>"']+\/SKILL\.md)\s*(?=\n|$)/gim;
    for (const match of block.matchAll(entryPattern)) candidates.push({ name: match[1].replace(/^[-*\s]+/, '').trim(), path: match[2], origin: 'native-catalog', scope: 'unknown' });
  }
  for (const item of candidates) {
    if (!SAFE_TEXT(item.name, 160) || !SAFE_TEXT(item.path, 4096) || !catalogPath(item.path)) continue;
    const origin = SAFE_TEXT(item.origin, 80) ? item.origin : 'unknown';
    const scope = SAFE_TEXT(item.scope, 80) ? item.scope : 'unknown';
    const provider = SAFE_TEXT(item.provider, 160) ? item.provider : null;
    const key = `${provider ?? ''}\0${item.path}`;
    let skill = skills.get(key);
    if (!skill) { skill = { id: createHash('sha256').update(key).digest('hex').slice(0, 24), name: item.name,
      origin, scope, path: item.path, ...(typeof item.rootAlias === 'string' && /^r\d{1,3}$/.test(item.rootAlias) ? { rootAlias: item.rootAlias } : {}), ...(provider ? { provider } : {}), observations: [] }; skills.set(key, skill); }
    const observation = { kind: turnId === null ? 'advertised-session-context' : 'advertised', agentId, turnId, sourceLine: line,
      evidence: { source: 'native-runtime-catalog', confidence: turnId === null ? 'recorded-session-context' : 'recorded' } };
    skill.observations.push(observation); observations.push({ skillId: skill.id, ...observation });
  }
}
function skillPathFromTool(value) {
  if (typeof value !== 'string' || value.length > 8192) return [];
  // Paths are retained only when an explicit path terminates in SKILL.md or is
  // inside a directory whose package includes SKILL.md; command/text is discarded.
  const matches = value.match(/(?:\/[^\s"'`<>]+\/SKILL\.md|\/[^\s"'`<>]+\/skills\/[^\s"'`]+)/gi) ?? [];
  return [...new Set(matches.map(s => s.replace(/[),;]+$/, '')).filter(path => validPath(path) && SAFE_TEXT(path, 4096)))].slice(0, 20);
}
function toolEvents(record, line, agentId, turnId, events, skills) {
  const p = record.payload ?? {};
  const itemType = p.type ?? p.item?.type;
  if (!/function_call|tool_call|custom_tool_call|mcp|command_execution|file_change|error/i.test(String(itemType))) return;
  const item = p.item ?? p;
  const name = safeMetaText(item.name ?? item.tool_name ?? item.server, 128);
  const callId = safeMetaText(item.call_id ?? item.id, 128);
  const kind = /error/i.test(String(itemType)) ? 'error' : /file_change/i.test(String(itemType)) ? 'file-change' : 'tool-call';
  const existing = kind === 'tool-call' && callId ? events.find(entry => entry.kind === 'tool-call' && entry.metadata.callId === callId) : null;
  if (existing) return existing;
  const event = { agentId, turnId, kind, recordedAt: SAFE_TEXT(record.timestamp, 64) && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null,
    sourceLine: line, metadata: { tool: name, callId, itemType: safeMetaText(String(itemType), 80) } };
  if (kind === 'tool-call' && callId) event._callId = callId;
  events.push(event);
  let args = item.arguments ?? item.input ?? item.command;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* inspect only bounded path candidates below */ } }
  const paths = []; let readIntent = false;
  const collect = (v, depth = 0) => {
    if (depth > 4 || paths.length >= 20) return;
    if (typeof v === 'string') { paths.push(...skillPathFromTool(v)); if (/(?:^|[;&|]\s*)(?:cat|head|tail|sed|less|more|open|mdcat)\b[^;\n]*\/SKILL\.md/i.test(v)
        || /(?:cmd|command)\s*:\s*["']\s*(?:cat|head|tail|sed|less|more|open|mdcat)\b[^\n]*\/SKILL\.md/i.test(v)) readIntent = true; }
    else if (Array.isArray(v)) for (const x of v.slice(0, 30)) collect(x, depth + 1);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v).slice(0, 50)) {
      if (/cmd|command|path|file|script|arguments|input|code/i.test(k)) collect(x, depth + 1);
    }
  };
  collect(args);
  // `exec` commonly wraps a JavaScript snippet which invokes a second tool.
  // Record only operation names and safe paths; never retain the snippet.
  const raw = typeof item.input === 'string' ? item.input : typeof item.arguments === 'string' ? item.arguments : '';
  if (raw && raw.length <= 128 * 1024) {
    const operations = [...raw.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)].map(m => `tools.${m[1]}`);
    if (operations.length) event.metadata.operations = [...new Set(operations)].slice(0, 20);
    const pathsFound = skillPathFromTool(raw);
    if (pathsFound.length) event.metadata.resourcePaths = pathsFound.slice(0, 20);
  }
  for (const path of [...new Set(paths)].slice(0, 20)) {
    const skill = [...skills.values()].filter(value => path === value.path || path.startsWith(value.path.replace(/\/SKILL\.md$/i, '/'))).sort((a,b) => b.path.length-a.path.length)[0];
    if (!skill) continue;
    skill.observations.push({ kind: readIntent && /\/SKILL\.md$/i.test(path) ? 'resource-read-intent' : 'package-resource-intent',
      agentId, turnId, sourceLine: line, evidence: { source: 'recorded-tool-input', confidence: 'intent-only' } });
  }
  return event;
}

function parsedReadPaths(value) {
  const results = [];
  const visit = (node, depth = 0) => {
    if (depth > 5 || !node) return;
    if (Array.isArray(node)) { for (const child of node.slice(0, 100)) visit(child, depth + 1); return; }
    if (typeof node !== 'object') return;
    const operation = node.type ?? node.command_type ?? node.operation;
    const path = node.path ?? node.file_path ?? node.target;
    if (typeof operation === 'string' && /^read$/i.test(operation) && validPath(path)) results.push(path);
    for (const [key, child] of Object.entries(node).slice(0, 50)) if (/command|parsed|operation|action|input/i.test(key)) visit(child, depth + 1);
  };
  visit(value);
  return results;
}
function actorCatalogMatches(skills, agentId, path, sourceLine = Infinity) {
  return [...skills.values()].filter(skill => skill.observations.some(observation => observation.agentId === agentId
    && ['advertised', 'advertised-session-context'].includes(observation.kind) && observation.sourceLine <= sourceLine)
    && (path === skill.path || path.startsWith(skill.path.replace(/\/SKILL\.md$/i, '/'))));
}
function nativeCwd(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let path = value;
  if (value.startsWith('file://')) {
    try { const url = new URL(value); if (url.search || url.hash) return null; path = fileURLToPath(url); }
    catch { return null; }
  }
  return validPath(path) && SAFE_TEXT(path, 4096) ? path : null;
}
function literalCatTargets(command) {
  if (typeof command !== 'string' || command.length > 8192 || /[;&|<>$`()\\\n\r#~*?\[\]{}]/.test(command)) return null;
  const tokens = []; let position = 0;
  while (position < command.length) {
    while (/\s/.test(command[position] ?? '')) position++;
    if (position >= command.length) break;
    const quote = command[position] === '"' || command[position] === "'" ? command[position++] : null;
    const start = position;
    while (position < command.length && (quote ? command[position] !== quote : !/\s/.test(command[position]))) position++;
    if (quote && command[position] !== quote) return null;
    const value = command.slice(start, position);
    if (!value || (!quote && /['"]/.test(value))) return null;
    tokens.push(value);
    if (quote) position++;
    if (position < command.length && !/\s/.test(command[position])) return null;
  }
  if (tokens.length < 2 || tokens[0] !== 'cat'
    || tokens.slice(1).some(value => value.startsWith('-'))) return null;
  return tokens.slice(1);
}

function inferOrigin(profile, path) {
  if (/^r\d+\//.test(path)) return path.split('/')[0];
  if (path.includes('/plugins/cache/')) return 'plugin-cache';
  if (path.startsWith('/etc/') || path.includes('/admin/skills/')) return 'admin';
  if (path.includes('/skills/.system/') || /\/(?:opt|usr\/share)\/.*(?:codex|skills)/i.test(path)) return 'system';
  for (const root of [profile?.defaultUserHome, profile?.userHome].filter(Boolean))
    if (path.startsWith(`${root}/.agents/skills/`) || path.startsWith(`${root}/.codex/skills/`)) return 'user';
  if (profile?.home && path.startsWith(`${profile.home}/`)) return 'profile-home';
  if (recordedProjectSkillPath(profile, path)) return 'project';
  if (path.includes('/.agents/skills/') || path.includes('/.codex/skills/')) return 'unknown';
  if (profile?.userHome && path.startsWith(`${profile.userHome}/`)) return 'profile-user-home';
  return 'repository-or-external';
}
function inferScope(profile, path) {
  if (path.includes('/plugins/cache/')) return 'plugin';
  if (path.startsWith('/etc/') || path.includes('/admin/skills/')) return 'admin';
  if (path.includes('/skills/.system/') || /\/(?:opt|usr\/share)\/.*(?:codex|skills)/i.test(path)) return 'system';
  for (const root of [profile?.defaultUserHome, profile?.userHome].filter(Boolean))
    if (path.startsWith(`${root}/.agents/skills/`) || path.startsWith(`${root}/.codex/skills/`)) return 'user';
  if (profile?.home && path.startsWith(`${profile.home}/`)) return 'profile';
  if (profile?.userHome && path.startsWith(`${profile.userHome}/`)) return 'user';
  if (recordedProjectSkillPath(profile, path)) return 'project';
  if (path.includes('/.agents/skills/') || path.includes('/.codex/skills/')) return 'unknown';
  return 'system-or-external';
}
function recordedProjectSkillPath(profile, path) {
  const match = path.match(/^(.*)\/(?:\.agents|\.codex)\/skills\//);
  if (!match || !match[1]) return false;
  return [...(profile?.recordedCwds ?? [])].some(cwd => cwd === match[1] || cwd.startsWith(`${match[1]}/`));
}
function parseRenderedCatalog(text, profile) {
  if (typeof text !== 'string' || text.length > 256 * 1024) return [];
  const block = text.match(/<skills_instructions\b[^>]*>([\s\S]*?)<\/skills_instructions>/i)?.[1] ?? text;
  const roots = new Map();
  for (const line of block.split(/\r?\n/)) {
    const root = line.match(/^\s*[-*]\s*`(r\d+)`\s*=\s*`([^`]+)`\s*$/i);
    if (root && validPath(root[2])) roots.set(root[1], root[2]);
  }
  if (!/<skills_instructions\b/i.test(text) && !/^\s*[-*]\s*(?:skill\s*:|[^\s:]+(?:[^:]*):\s+).*\(file\s*:/im.test(block)) return [];
  const rows = [];
  for (const line of block.split(/\r?\n/).slice(0, 1000)) {
    const match = line.match(/^\s*[-*]\s*(?:skill\s*:\s*)?(.+?):\s+[^\n]*?\(file\s*:\s*([^)\s]+\/SKILL\.md)[^)]*\)/i);
    if (!match) continue;
    let name = match[1].trim(), recordedPath = match[2].replaceAll('`', ''), path = recordedPath, rootAlias = null;
    const alias = recordedPath.match(/^(r\d+)\/(.+)$/i);
    if (alias) {
      rootAlias = alias[1]; const root = roots.get(rootAlias);
      if (!root) continue;
      const relativePath = alias[2]; path = resolve(root, relativePath);
      if (!inside(root, path) || !path.endsWith('/SKILL.md')) continue;
    }
    if (!catalogPath(path)) continue;
    if (name.toLowerCase() === 'skill') name = line.match(/^\s*[-*]\s*skill\s*:\s*([^:()]{1,160})\s*:/i)?.[1]?.trim() ?? name;
    const plugin = path.match(/\/plugins\/cache\/([^/]+)/i)?.[1];
    rows.push({ name, path, origin: inferOrigin(profile, path), scope: inferScope(profile, path),
      ...(rootAlias ? { rootAlias } : {}), ...(plugin ? { provider: plugin } : {}) });
  }
  return rows;
}
function summarizeUsage(rows, warnings) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.sourceLine}:${row.agentId}:${row.turnId ?? ''}`;
    const entry = grouped.get(key) ?? { agentId: row.agentId, turnId: row.turnId ?? null, sourceLine: row.sourceLine,
      recordedAt: row.recordedAt, source: row.source ?? 'native-rollout-token-usage', last: null, total: null,
      modelContextWindow: row.modelContextWindow ?? null, present: { last: false, total: false,
        modelContextWindow: Number.isSafeInteger(row.modelContextWindow) && row.modelContextWindow >= 0 }, scope: row.scope,
      invalidFields: { last: [], total: [] } };
    if (row.mode === 'last-snapshot') { entry.last = row.tokens; entry.present.last = true; entry.invalidFields.last = row.invalidFields ?? []; }
    else if (row.mode === 'total-snapshot') { entry.total = row.tokens; entry.present.total = true; entry.invalidFields.total = row.invalidFields ?? []; }
    else if (row.mode === 'unknown-snapshot') { entry.total = row.tokens; entry.present.total = true; entry.invalidFields.total = row.invalidFields ?? []; entry.scope = 'reported-scope-unknown'; }
    grouped.set(key, entry);
  }
  const assessed = assessUsageSequence([...grouped.values()].map(row => normalizeUsageSnapshot(row)));
  const cumulative = rows.filter(row => row.mode === 'total-snapshot');
  const totals = {};
  if (cumulative.length) {
    for (const key of ['input_tokens','output_tokens','cached_input_tokens','reasoning_output_tokens','cache_write_input_tokens','total_tokens']) {
      const values = cumulative.map(row => row.tokens[key]).filter(Number.isSafeInteger);
      if (values.length) {
        let monotonic = true; for (let i=1;i<values.length;i++) if (values[i] < values[i-1]) monotonic = false;
        if (monotonic) totals[key] = values.at(-1);
        else warnings.add(`Token cumulative ${key} counter regressed; affected total is unavailable.`);
      }
    }
  }
  const values = Object.keys(totals).length ? { scope: rows[0]?.scope ?? 'selected-session-only', values: totals } : null;
  const agentId = rows[0]?.agentId;
  return { status: rows.length ? 'partial' : 'unavailable', observations: assessed.observations,
    coverageByAgent: assessed.byAgent, totals: values,
    byAgent: agentId ? [{ agentId, totals: values }] : [] };
}

const HISTORICAL_TOOL_TYPES = new Map([
  ['mcpToolCall', 'mcpToolCall'], ['mcp_tool_call', 'mcpToolCall'], ['McpToolCall', 'mcpToolCall'],
  ['dynamicToolCall', 'dynamicToolCall'], ['dynamic_tool_call', 'dynamicToolCall'], ['DynamicToolCall', 'dynamicToolCall'],
  ['commandExecution', 'commandExecution'], ['command_execution', 'commandExecution'], ['CommandExecution', 'commandExecution'],
  ['webSearch', 'webSearch'], ['web_search', 'webSearch'], ['WebSearch', 'webSearch'],
  ['fileChange', 'fileChange'], ['file_change', 'fileChange'], ['FileChange', 'fileChange'],
  ['collabAgentToolCall', 'collabAgentToolCall'], ['collab_agent_tool_call', 'collabAgentToolCall'],
  ['imageView', 'imageView'], ['image_view', 'imageView'], ['sleep', 'sleep'],
  ['imageGeneration', 'imageGeneration'], ['image_generation', 'imageGeneration'],
]);
const firstOwn = (value, ...keys) => {
  for (const key of keys) if (Object.hasOwn(value, key)) return value[key];
  return undefined;
};
function nativeDurationMs(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const secs = firstOwn(value, 'secs', 'seconds'), nanos = firstOwn(value, 'nanos');
  if (Number.isSafeInteger(secs) && secs >= 0 && secs <= 86400 && Number.isSafeInteger(nanos)
    && nanos >= 0 && nanos < 1_000_000_000) return secs * 1000 + Math.floor(nanos / 1_000_000);
  return undefined;
}
function historicalToolItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = HISTORICAL_TOOL_TYPES.get(firstOwn(raw, 'type', 'item_type', 'itemType'));
  if (!type) return null;
  const id = firstOwn(raw, 'id', 'item_id', 'itemId', 'call_id', 'callId');
  if (typeof id !== 'string') return null;
  const item = { id, type };
  for (const [field, aliases] of Object.entries({
    status: ['status'], server: ['server'], tool: ['tool'], namespace: ['namespace'], pluginId: ['pluginId', 'plugin_id'],
    scriptPath: ['scriptPath', 'script_path'], exitCode: ['exitCode', 'exit_code'], success: ['success'],
  })) {
    const value = firstOwn(raw, ...aliases);
    if (value !== undefined) item[field] = value;
  }
  const duration = nativeDurationMs(firstOwn(raw, 'durationMs', 'duration_ms', 'duration'));
  if (duration !== undefined) item.durationMs = duration;
  if (raw.failure?.type === 'usageLimitExceeded' || raw.failure?.type === 'usage_limit_exceeded')
    item.failure = { type: 'usageLimitExceeded' };
  if (item.status === 'in_progress' || item.status === 'inprogress') item.status = 'inProgress';
  if (item.status === 'cancelled' || item.status === 'error' || item.status === 'declined') item.status = 'failed';
  if (raw.error != null || raw.is_error === true || raw.isError === true || raw.result?.is_error === true || raw.result?.isError === true) item.status = 'failed';
  if (item.status !== undefined && !['inProgress', 'completed', 'failed'].includes(item.status)) return null;
  return item;
}
function legacyMcpToolItem(payload, phase) {
  if (!payload || typeof payload !== 'object') return null;
  const callId = firstOwn(payload, 'call_id', 'callId');
  const invocation = payload.invocation;
  if (typeof callId !== 'string' || !invocation || typeof invocation !== 'object') return null;
  const item = { id: callId, type: 'mcpToolCall', status: phase === 'started' ? 'inProgress' : 'completed' };
  for (const [field, aliases] of Object.entries({ server: ['server'], tool: ['tool'], pluginId: ['pluginId', 'plugin_id'] })) {
    const value = firstOwn(invocation, ...aliases) ?? firstOwn(payload, ...aliases);
    if (value !== undefined) item[field] = value;
  }
  if (phase === 'completed') {
    const result = payload.result;
    if (result && typeof result === 'object' && (Object.hasOwn(result, 'Err') || Object.hasOwn(result, 'err'))) item.status = 'failed';
    const duration = nativeDurationMs(payload.duration);
    if (duration !== undefined) item.durationMs = duration;
  }
  return item;
}
function legacyExecCommandItem(payload, phase) {
  if (!payload || typeof payload !== 'object') return null;
  const id = firstOwn(payload, 'call_id', 'callId');
  if (typeof id !== 'string') return null;
  const item = { id, type: 'commandExecution', status: phase === 'started' ? 'inProgress' : 'completed' };
  const pluginId = firstOwn(payload, 'plugin_id', 'pluginId'), scriptPath = firstOwn(payload, 'script_path', 'scriptPath');
  if (pluginId !== undefined) item.pluginId = pluginId;
  if (scriptPath !== undefined) item.scriptPath = scriptPath;
  const exitCode = firstOwn(payload, 'exit_code', 'exitCode');
  if (exitCode !== undefined) item.exitCode = exitCode;
  if (phase === 'completed') {
    const status = firstOwn(payload, 'status');
    if (status !== undefined && !['completed', 'failed', 'declined'].includes(status)) return null;
    if (status === 'failed' || status === 'declined') item.status = 'failed';
    else if (status === 'completed') item.status = 'completed';
    const duration = nativeDurationMs(payload.duration);
    if (duration !== undefined) item.durationMs = duration;
  }
  return item;
}
const HOOK_ENUMS = Object.freeze({
  eventName: new Map(['preToolUse','permissionRequest','postToolUse','preCompact','postCompact','sessionStart','sessionEnd','userPromptSubmit','subagentStart','subagentStop','stop','interrupt'].map(value => [value.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value])),
  handlerType: new Map([['command','command'],['mcp_tool','mcpTool'],['prompt','prompt'],['agent','agent']]),
  executionMode: new Map([['sync','sync'],['async','async']]), scope: new Map([['thread','thread'],['turn','turn']]),
  source: new Map(['system','user','project','mdm','sessionFlags','plugin','cloudRequirements','cloudManagedConfig','legacyManagedConfigFile','legacyManagedConfigMdm','unknown'].map(value => [value.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), value])),
  status: new Map(['running','completed','failed','blocked','stopped'].map(value => [value,value])),
});
function historicalHookRun(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const run = { id: firstOwn(raw, 'id') };
  for (const [out, aliases] of Object.entries({ eventName: ['eventName','event_name'], handlerType: ['handlerType','handler_type'],
    executionMode: ['executionMode','execution_mode'], scope: ['scope'], status: ['status'], source: ['source'] })) {
    const value = firstOwn(raw, ...aliases);
    if (value !== undefined) run[out] = HOOK_ENUMS[out].get(value) ?? value;
  }
  for (const [out, aliases] of Object.entries({ startedAt: ['startedAt','started_at'], completedAt: ['completedAt','completed_at'], durationMs: ['durationMs','duration_ms'] })) {
    const value = firstOwn(raw, ...aliases);
    if (value !== undefined) run[out] = value;
  }
  return run;
}

async function readRollout(profile, id, path, options = {}) {
  const unavailable = reason => ({ status: 'unavailable', reason, source: { path: null, fingerprint: null, bytes: null, recordCount: 0 }, agents: [], turns: [], events: [], skills: [], toolInvocations: [], hookInvocations: [], mcp: { servers: [], inventory: 'not-requested' }, toolCoverage: { tools: 'unavailable', mcp: 'unavailable' }, hookCoverage: 'unavailable', hookCaptureBoundary: null, toolWarnings: [], hookWarnings: [], artifacts: [], outcomeClaim: null, usage: { status: 'unavailable', observations: [], totals: null, byAgent: [] }, metrics: { recordedSpanMs: null }, warnings: [] });
  if (!path || typeof path !== 'string' || path.length > 4096) return unavailable('No rollout is indexed for this session.');
  const expected = await safeRegular(profile.home, path);
  if (!expected) return unavailable('The selected rollout path is unsafe or unavailable.');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || before.dev !== expected.dev || before.ino !== expected.ino
      || !await safeRegular(profile.home, path)) return unavailable('The selected rollout changed or is unsafe.');
    const upper = Math.min(before.size, MAX_BYTES), hash = createHash('sha256');
    let sourceLine = 0, relevant = 0, recordsTotal = 0, physicalLines = 0, pending = Buffer.alloc(0), pos = 0, discarding = false;
    const physicalLimit = Number.isSafeInteger(options.maxPhysicalLines)
      ? Math.max(1, Math.min(MAX_PHYSICAL_LINES, options.maxPhysicalLines)) : MAX_PHYSICAL_LINES;
    let header = false, badIdentity = false, firstAt = null, lastAt = null, headerPayload, outcomeClaim = null;
    const turns = [], events = [], skills = new Map(), usageRows = [], artifacts = [], warnings = new Set();
    const toolCapture = createAuditToolCapture({ maxInvocations: MAX_RECORDS, maxServers: 1000 });
    const hookCapture = createAuditHookCapture({ maxInvocations: 500 });
    const turnById = new Map();
    const actorCwds = [], absoluteReads = [];
    const calls = new Map(), itemStarts = new Map(); let currentTurn = null;
    const agents = [{ id, parentId: options.parentId ?? null, depth: options.depth ?? 0, role: options.parentId ? 'subagent' : 'primary', sessionId: id, status: 'selected', source: { path: null, fingerprint: null } }];
    const parse = bytes => {
      sourceLine++; if (!bytes.length) return;
      recordsTotal++;
      let record; try { record = decode(bytes); } catch { warnings.add('Malformed rollout record encountered.'); return; }
      if (!header) {
        const parentId = options.parentId;
        const validRoot = !parentId && record?.type === 'session_meta' && record.payload?.id === id
          && (record.payload.session_id === undefined || uuid(record.payload.session_id))
          && record.payload?.source?.subagent === undefined;
        const validChild = parentId && record?.type === 'session_meta' && record.payload?.id === id
          && (options.sessionRootId ? record.payload.session_id === options.sessionRootId : uuid(record.payload.session_id))
          && record.payload.parent_thread_id === parentId
          && record.payload.source?.subagent?.thread_spawn?.parent_thread_id === parentId
          && (record.payload.forked_from_id === undefined || record.payload.forked_from_id === parentId);
        if (!validRoot && !validChild) { badIdentity = true; return; }
        header = true; headerPayload = record.payload;
        const sessionCwd = nativeCwd(record.payload.cwd);
        if (sessionCwd) { profile.recordedCwds.add(sessionCwd); actorCwds.push({ cwd: sessionCwd, source: 'session', sourceLine }); }
        return;
      }
      const p = record?.payload ?? {}; let turnId = p.turn_id ?? p.turnId ?? null;
      if (turnId === '') turnId = null;
      if (!turnId && (record.type === 'response_item' || record.type === 'event_msg')) turnId = currentTurn;
      if (!uuid(turnId) && turnId !== null) {
        const subType = record.type === 'event_msg' ? p.type : null;
        const rawItem = p.item ?? p;
        const typedTool = rawItem && typeof rawItem === 'object' && HISTORICAL_TOOL_TYPES.has(firstOwn(rawItem, 'type', 'item_type', 'itemType'));
        if (['item_started','item_completed','mcp_tool_call_begin','mcp_tool_call_end','exec_command_begin','exec_command_end','hook_started','hook_completed'].includes(subType) || typedTool)
          warnings.add('Malformed native tool or hook turn identity omitted.');
        return;
      }
      if (['turn_context', 'event_msg', 'response_item', 'token_count', 'token_usage_record'].includes(record.type)) {
        if (++relevant > MAX_RECORDS) { warnings.add('Relevant rollout record limit reached.'); return; }
      }
      if (options.parentId && record.type === 'token_usage_record') {
        if (!uuid(p.thread_id) || !uuid(p.session_id) || !uuid(p.turn_id) || !uuid(p.root_turn_id)) { warnings.add('Child turn ownership metadata is incomplete.'); return; }
        const identity = `${p.thread_id}:${p.session_id}:${p.root_turn_id}`;
        const previous = options.owners.get(p.turn_id);
        if (previous && previous !== identity) { badIdentity = true; return; }
        options.owners.set(p.turn_id, identity);
        if (p.thread_id === id && p.session_id === (options.sessionRootId ?? headerPayload?.session_id ?? options.parentId)) {
          options.ownedTurns.add(p.turn_id);
          const raw = p.total_token_usage ?? p.token_usage ?? p.last_token_usage;
          if (raw && typeof raw === 'object') {
            const { tokens, invalidFields } = projectNativeTokenFields(raw);
            usageRows.push({ agentId: id, turnId: p.turn_id, sourceLine,
              recordedAt: SAFE_TEXT(record.timestamp, 64) && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null,
              source: 'token_usage_record', scope: 'child-session', mode: 'unknown-snapshot', tokens, invalidFields });
          }
        }
        return;
      }
      const time = SAFE_TEXT(record.timestamp, 64) && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null;
      if (time) { const ms = Date.parse(time); firstAt = firstAt === null ? ms : Math.min(firstAt, ms); lastAt = lastAt === null ? ms : Math.max(lastAt, ms); }
      if (record.type === 'event_msg' && p.type === 'token_count') {
        const detail = p.info ?? p, scopeId = p.thread_id;
        if (scopeId && scopeId !== id) return;
        const addUsage = (raw, mode) => {
          if (!raw || typeof raw !== 'object') return;
          const tokens = {}, invalidFields = [];
          for (const [out, keys] of Object.entries({ input_tokens:['input_tokens','input'], output_tokens:['output_tokens','output'], cached_input_tokens:['cached_input_tokens','cached_input'], reasoning_output_tokens:['reasoning_output_tokens','reasoning_output'], cache_write_input_tokens:['cache_write_input_tokens','cache_write'], total_tokens:['total_tokens','total'] })) {
            const key = keys.find(k => Object.hasOwn(raw, k)); const value = key === undefined ? undefined : raw[key];
            if (Number.isSafeInteger(value) && value >= 0) tokens[out] = value;
            else if (key !== undefined && value !== null) invalidFields.push(({input_tokens:'inputTokens',output_tokens:'outputTokens',cached_input_tokens:'cachedInputTokens',reasoning_output_tokens:'reasoningOutputTokens',cache_write_input_tokens:'cacheWriteInputTokens',total_tokens:'totalTokens'})[out]);
          }
          usageRows.push({ agentId: id, turnId, sourceLine, recordedAt: time,
            source: 'event_msg.token_count', modelContextWindow: detail.model_context_window ?? detail.modelContextWindow,
            scope: scopeId === id ? (options.parentId ? 'child-session' : 'selected-session') : 'reported-scope-unknown',
            mode: scopeId === id ? mode : 'unknown-snapshot', tokens, invalidFields });
        };
        addUsage(detail.total_token_usage ?? detail.total, 'total-snapshot');
        addUsage(detail.last_token_usage ?? detail.last, 'last-snapshot');
        return;
      }
      if (record.type === 'turn_context') {
        if (validPath(p.cwd) && SAFE_TEXT(p.cwd, 4096)) {
          profile.recordedCwds.add(p.cwd); actorCwds.push({ cwd: p.cwd, source: 'turn', turnId, sourceLine });
        }
        const row = { agentId: id, turnId, model: safeMetaText(p.model), reasoningEffort: safeMetaText(p.effort), cwd: validPath(p.cwd) && SAFE_TEXT(p.cwd, 4096) ? p.cwd : null,
          recordedAt: time, sourceLine, ...(Array.isArray(p.skills_instructions) ? { skillCatalogCount: p.skills_instructions.length } : {}) };
        turns.push(row); turnById.set(turnId, row); currentTurn = turnId;
        if (!options.parentId || uuid(turnId)) {
          addCatalogSkills(p, id, turnId, sourceLine, skills, []);
          for (const entry of parseRenderedCatalog(p.skills_instructions, profile)) addCatalogSkills({ skills: [entry] }, id, turnId, sourceLine, skills, []);
        }
      } else if (record.type === 'event_msg') {
        const sub = safeMetaText(p.type, 80);
        if (sub === 'task_started' && uuid(turnId)) currentTurn = turnId;
        if (sub === 'item_started' || sub === 'item_completed') {
          const rawItem = p.item && typeof p.item === 'object' ? p.item : p;
          const item = historicalToolItem(rawItem);
          if (item) {
            if (!toolCapture.consumeItem({ item, agentId: id, turnId, phase: sub === 'item_started' ? 'started' : 'completed', source: 'native-rollout', sourceLine }))
              warnings.add('Malformed native tool identity or metadata omitted.');
          } else if (HISTORICAL_TOOL_TYPES.has(firstOwn(rawItem, 'type', 'item_type', 'itemType')))
            warnings.add('Malformed native tool identity or metadata omitted.');
        }
        if (sub === 'mcp_tool_call_begin' || sub === 'mcp_tool_call_end') {
          const item = legacyMcpToolItem(p, sub === 'mcp_tool_call_begin' ? 'started' : 'completed');
          const legacyTurnId = p.turn_id ?? p.turnId;
          if (item) {
            if (!toolCapture.consumeItem({ item, agentId: id, turnId: uuid(legacyTurnId) ? legacyTurnId : null,
              phase: sub === 'mcp_tool_call_begin' ? 'started' : 'completed', source: 'native-rollout-legacy-mcp', sourceLine }))
              warnings.add('Malformed native MCP identity or metadata omitted.');
          } else warnings.add('Malformed native MCP identity or metadata omitted.');
        }
        if (sub === 'exec_command_begin' || sub === 'exec_command_end') {
          const phase = sub === 'exec_command_begin' ? 'started' : 'completed';
          const item = legacyExecCommandItem(p, phase);
          const nativeTime = phase === 'started' ? p.started_at_ms : p.completed_at_ms;
          if (!item || !toolCapture.consumeItem({ item, agentId: id, turnId, phase, source: 'native-rollout-exec-command', sourceLine,
            ...(phase === 'started' ? { startedAtMs: nativeTime } : { completedAtMs: nativeTime }) }))
            warnings.add('Malformed native command identity or metadata omitted.');
        }
        if (sub === 'hook_started' || sub === 'hook_completed') {
          const run = historicalHookRun(p.run);
          if (!run || !hookCapture.consume({ phase: sub === 'hook_started' ? 'started' : 'completed', agentId: id,
            turnId: uuid(p.turn_id ?? p.turnId) ? (p.turn_id ?? p.turnId) : null, run, source: 'native-rollout', sourceLine }))
            warnings.add('Malformed native hook identity or metadata omitted.');
        }
        if (sub === 'item_started' || sub === 'item_completed') {
          const item = p.item && typeof p.item === 'object' ? p.item : p;
          const key = safeMetaText(item.call_id ?? item.id, 128), itemType = safeMetaText(item.type, 80);
          if (sub === 'item_started' && key && Number.isSafeInteger(p.started_at_ms)) itemStarts.set(key, p.started_at_ms);
          if (sub === 'item_completed') {
            let call = key ? calls.get(key) : null;
            if (/^CommandExecution$/i.test(itemType ?? '')) {
              const command = Array.isArray(item.command) ? item.command : [];
              const operation = parsedReadPaths(item.parsed_cmd).length ? 'Read'
                : safeMetaText(item.parsed_cmd?.[0]?.type ?? item.parsed_cmd?.[0]?.operation, 64)
                  ?? (typeof command[0] === 'string' ? safeMetaText(basename(command[0]), 64) : null);
              const event = { agentId: id, turnId, kind: 'command-execution', recordedAt: time, sourceLine,
                metadata: { id: key, processId: safeMetaText(item.process_id, 128), operation,
                  status: safeMetaText(item.status, 64), exitCode: Number.isSafeInteger(item.exit_code) ? item.exit_code : null,
                  result: item.exit_code === 0 ? 'returned' : Number.isSafeInteger(item.exit_code) ? 'error' : 'unknown' } };
              if (item.duration && typeof item.duration === 'object') {
                const duration = {};
                for (const field of ['milliseconds','millis','seconds','secs','nanos']) if (Number.isFinite(item.duration[field]) && item.duration[field] >= 0) duration[field] = item.duration[field];
                if (Object.keys(duration).length) event.metadata.duration = duration;
              }
              events.push(event);
              const parsedPaths = parsedReadPaths(item.parsed_cmd);
              const simpleDirectRead = Array.isArray(command) && command.length === 2
                && ['/bin/cat','/usr/bin/cat'].includes(command[0]) && validPath(command[1]);
              const shellWrapped = Array.isArray(command) && command.length === 3
                && ['/bin/zsh','/bin/bash','/bin/sh'].includes(command[0]) && ['-c','-lc'].includes(command[1])
                && typeof command[2] === 'string';
              const cwd = nativeCwd(item.cwd);
              const recordedCwd = cwd && [...profile.recordedCwds].some(root => cwd === root || cwd.startsWith(`${root}/`));
              const shellTarget = shellWrapped && item.exit_code === 0 ? parseLiteralSkillRead(command[2]) : null;
              const shellTargetPath = shellTarget && (validPath(shellTarget) ? shellTarget : recordedCwd ? resolve(cwd, shellTarget) : null);
              const readObservations = new Set();
              // Historical unknown actions must independently corroborate the
              // literal absolute-cat command. Resolve only recorded paths; never
              // consult today's filesystem for historical aliases or ownership.
              const absoluteCommand = shellWrapped
                ? parseLiteralSkillReadDetails(command[2], { absoluteExecutableOnly: true }) : null;
              const actions = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
              const unknownAction = actions.length === 1 && actions[0]?.type === 'unknown'
                ? parseLiteralSkillReadDetails(actions[0].cmd, { absoluteExecutableOnly: true }) : null;
              const recordedActorCwd = cwd && actorCwds.some(source => cwd === source.cwd || cwd.startsWith(`${source.cwd}/`));
              const literalPath = simpleDirectRead ? command[1]
                : absoluteCommand?.wrapper === 'direct' && recordedActorCwd ? resolve(cwd, absoluteCommand.target) : null;
              const absoluteCorroboration = item.status === 'completed' && item.exit_code === 0 && recordedActorCwd
                && unknownAction?.wrapper === 'direct' && literalPath && validPath(literalPath) && SAFE_TEXT(literalPath, 4096)
                && resolve(cwd, unknownAction.target) === literalPath;
              if (absoluteCorroboration) {
                // Defer catalog resolution until inherited child turns have
                // been removed. A later catalog cannot corroborate an earlier read.
                absoluteReads.push({ path: literalPath, cwd, observation: { agentId: id, turnId, sourceLine,
                    evidence: { source: 'native-command-parsed', confidence: 'native-direct-read-exit-zero',
                      pathAuthority: 'literal-command-target', commandWrapper: simpleDirectRead ? 'direct'
                        : command[1] === '-c' ? 'shell-command' : 'login-shell-command',
                      readCorroboration: 'native-unknown-absolute-cat' } } });
              }
              for (const readPath of parsedPaths) {
                const matches = actorCatalogMatches(skills, id, readPath);
                if (matches.length === 1) {
                  const skill = matches[0];
                  const observationKey = `${skill.id}\0${readPath}`;
                  if (readObservations.has(observationKey)) continue;
                  readObservations.add(observationKey);
                  const singleNativeRead = parsedPaths.length === 1;
                  const provenRead = item.exit_code === 0 && singleNativeRead
                    && (simpleDirectRead && command[1] === readPath || shellTargetPath && validPath(shellTargetPath)
                      && SAFE_TEXT(shellTargetPath, 4096) && shellTargetPath === readPath);
                  skill.observations.push({ kind: provenRead
                    ? readPath === skill.path ? 'definition-read-observed' : 'package-resource-read-observed'
                    : 'resource-read-intent', agentId: id, turnId, sourceLine,
                  evidence: { source: 'native-command-parsed', confidence: provenRead ? 'native-direct-read-exit-zero' : 'native-read-attempt',
                    ...(provenRead ? { readCorroboration: 'native-read-action' } : {}) } });
                }
              }
              if (shellWrapped) {
                const targets = recordedCwd ? literalCatTargets(command[2]) : null;
                if (targets) for (const target of targets) {
                  const targetPath = validPath(target) ? target : cwd ? resolve(cwd, target) : null;
                  if (!targetPath || !validPath(targetPath) || !SAFE_TEXT(targetPath, 4096)) continue;
                  const matches = actorCatalogMatches(skills, id, targetPath);
                  if (matches.length === 1 && !readObservations.has(`${matches[0].id}\0${targetPath}`)) matches[0].observations.push({ kind: 'resource-read-intent', agentId: id, turnId, sourceLine,
                    evidence: { source: 'native-command-literal-cwd', confidence: 'parsed-read-intent' } });
                }
              }
            } else if (/^FileChange$/i.test(itemType ?? '')) {
              const sourceChanges = item.changes && typeof item.changes === 'object' ? Object.entries(item.changes) : [];
              const changes = sourceChanges.slice(0, 100), truncated = sourceChanges.length > changes.length;
              if (truncated) warnings.add('Native file-change artifact limit reached.');
              events.push({ agentId: id, turnId, kind: 'file-change', recordedAt: time, sourceLine,
                metadata: { id: key, status: safeMetaText(item.status, 64), changeCount: changes.length,
                  sourceChangeCount: sourceChanges.length, retainedChangeCount: changes.length, truncated } });
              for (const [path, detail] of changes) artifacts.push({ kind: 'recorded-file-change', agentId: id, turnId, sourceLine,
                path: safeArtifactPath(path) ? path : null, status: safeMetaText(detail?.kind ?? detail?.type ?? detail?.status, 48) });
            } else if (!call && /function_call|tool_call|custom_tool_call|mcp|command_execution/i.test(itemType ?? '')) {
              call = toolEvents({ timestamp: record.timestamp, payload: item }, sourceLine, id, turnId, events, skills);
              if (!call && key) call = events.find(entry => entry.kind === 'tool-call' && entry.metadata.callId === key);
              if (!call) {
                call = { agentId: id, turnId, kind: 'tool-call', recordedAt: time, sourceLine,
                  metadata: { tool: safeMetaText(item.name ?? item.tool_name, 128), callId: key, itemType } };
                events.push(call);
              }
              if (call?.kind === 'tool-call' && key) calls.set(key, call);
            }
            if (call?.kind === 'tool-call') {
              const startedAtMs = p.started_at_ms ?? itemStarts.get(key) ?? null, completedAtMs = p.completed_at_ms ?? null;
              const failed = item.is_error === true || Boolean(item.error)
                || ['failed','error','cancelled'].includes(String(item.status ?? '').toLowerCase())
                || (Number.isSafeInteger(item.exit_code) && item.exit_code !== 0);
              call.metadata.result = failed ? 'error' : 'returned'; call.metadata.resultSourceLine = sourceLine;
              if (Number.isSafeInteger(startedAtMs)) call.metadata.startedAtMs = startedAtMs;
              if (Number.isSafeInteger(completedAtMs)) call.metadata.completedAtMs = completedAtMs;
              if (Number.isSafeInteger(startedAtMs) && Number.isSafeInteger(completedAtMs) && completedAtMs >= startedAtMs)
                call.metadata.durationMs = completedAtMs - startedAtMs;
              if (failed) events.push({ agentId: id, turnId, kind: 'tool-error', recordedAt: time, sourceLine, metadata: { tool: call.metadata.tool, callId: key, error: true } });
            } else if (!/^CommandExecution$|^FileChange$/i.test(itemType ?? ''))
              events.push({ agentId: id, turnId, kind: 'item-completed', recordedAt: time, sourceLine, metadata: { itemType, status: safeMetaText(item.status, 64) } });
          }
        }
        if (sub && /task_started|task_complete|turn_started|turn_complete|retry|error|warning|patch_apply_end|file_change|skill_invoked|skill_loaded|skill_read/i.test(sub)) {
          events.push({ agentId: id, turnId, kind: sub.toLowerCase().replaceAll('_', '-'), recordedAt: time, sourceLine, metadata: {} });
        }
        if (/skill_invoked|skill_loaded|skill_read/i.test(sub ?? '')) {
          const skillPath = validPath(p.path ?? p.skill_path) ? (p.path ?? p.skill_path) : null;
          const skillName = safeMetaText(p.name ?? p.skill_name, 160);
          const namedCandidates = skillName ? [...skills.values()].filter(skill => skill.name === skillName) : [];
          let target = skillPath ? [...skills.values()].find(skill => skill.path === skillPath)
            : namedCandidates.length === 1 ? namedCandidates[0] : null;
          if (!target && skillPath && skillName) {
            const key = `native-event\0${skillPath}`; target = { id: createHash('sha256').update(key).digest('hex').slice(0,24), name: skillName,
              origin: inferOrigin(profile, skillPath), scope: inferScope(profile, skillPath), path: skillPath, observations: [] }; skills.set(key, target);
          }
          if (target) target.observations.push({ kind: sub === 'skill_invoked' ? 'explicit-invocation' : sub === 'skill_loaded' ? 'load-observed' : 'definition-read-observed',
            agentId: id, turnId, sourceLine, evidence: { source: 'native-skill-event', confidence: 'recorded-event' } });
          else {
            const event = events.at(-1);
            if (event?.sourceLine === sourceLine && event.agentId === id) event.metadata = {
              attribution: 'unresolved', reason: namedCandidates.length > 1 ? 'ambiguous-skill-name' : 'no-matching-skill',
              candidateSkillIds: namedCandidates.map(skill => skill.id), skillName,
            };
          }
        }
        if (/task_complete|turn_complete/i.test(sub ?? '')) {
          const ev = events.at(-1); if (ev?.turnId === turnId) ev.metadata = { status: safeMetaText(p.status, 80), success: typeof p.success === 'boolean' ? p.success : null };
          if (sub === 'task_complete') outcomeClaim = { success: typeof p.success === 'boolean' ? p.success : null,
            status: safeMetaText(p.status, 80), sourceLine, agentId: id, turnId, evidence: 'native-task-completion-record' };
        }
        if (sub === 'patch_apply_end' || sub === 'file_change') {
          const sourceChanges = Array.isArray(p.changes) ? p.changes
            : p.changes && typeof p.changes === 'object' ? Object.entries(p.changes).map(([path, detail]) => ({ path, ...(detail && typeof detail === 'object' ? detail : {}) })) : [];
          const changes = sourceChanges.slice(0, 100), truncated = sourceChanges.length > changes.length;
          if (truncated) warnings.add('Native file-change artifact limit reached.');
          const event = events.at(-1);
          if (event?.sourceLine === sourceLine && event.agentId === id) event.metadata = {
            sourceChangeCount: sourceChanges.length, retainedChangeCount: changes.length, truncated };
          for (const item of changes) artifacts.push({ kind: 'recorded-file-change', agentId: id, turnId, sourceLine,
            path: typeof item?.path === 'string' && SAFE_TEXT(item.path, 4096) ? item.path : null,
            status: safeMetaText(item?.kind ?? item?.status, 48) });
        }
        if (['task_complete','turn_complete'].includes(sub)) currentTurn = null;
      } else if (record.type === 'response_item') {
        const response = p.item ?? p, responseType = response.type ?? p.type;
        const typedItem = historicalToolItem(response);
        if (typedItem) {
          if (!toolCapture.consumeItem({ item: typedItem, agentId: id, turnId, phase: 'completed', source: 'native-rollout-response-item', sourceLine }))
            warnings.add('Malformed native tool identity or metadata omitted.');
        } else if (HISTORICAL_TOOL_TYPES.has(firstOwn(response, 'type', 'item_type', 'itemType')))
          warnings.add('Malformed native tool identity or metadata omitted.');
        if (responseType === 'file_change') {
          const sourceChanges = Array.isArray(response.changes) ? response.changes
            : response.changes && typeof response.changes === 'object' ? Object.entries(response.changes).map(([path, detail]) => ({ path, ...(detail && typeof detail === 'object' ? detail : {}) })) : [response];
          const changes = sourceChanges.slice(0, 100);
          const truncated = sourceChanges.length > changes.length;
          if (truncated) warnings.add('Native file-change artifact limit reached.');
          events.push({ agentId: id, turnId, kind: 'file-change', recordedAt: time, sourceLine,
            metadata: { sourceChangeCount: sourceChanges.length, retainedChangeCount: changes.length, truncated } });
          for (const item of changes) artifacts.push({ kind: 'recorded-file-change', agentId: id, turnId, sourceLine,
            path: typeof item?.path === 'string' && SAFE_TEXT(item.path, 4096) ? item.path : null,
            status: safeMetaText(item?.kind ?? item?.status, 48) });
        }
        if (/^(?:function_call|tool_call|custom_tool_call)_output$/.test(responseType ?? '')) {
          const callId = safeMetaText(response.call_id ?? response.id ?? p.call_id, 128), prior = calls.get(callId);
          const matched = prior ?? events.find(entry => entry.kind === 'tool-call' && entry.agentId === id
            && entry.turnId === turnId && entry.metadata.callId === callId);
          if (matched) {
            const failed = response.is_error === true || Boolean(response.error)
              || ['failed','error','cancelled'].includes(String(response.status ?? '').toLowerCase());
            matched.metadata.result = failed ? 'error' : 'returned'; matched.metadata.resultSourceLine = sourceLine;
            for (const skill of skills.values()) {
              const related = skill.observations.filter(observation => observation.agentId === id && observation.turnId === turnId
                && observation.sourceLine === matched.sourceLine && ['resource-read-intent','package-resource-intent'].includes(observation.kind));
              for (const observation of related) skill.observations.push({ kind: failed ? 'paired-call-error' : 'paired-call-returned', agentId: id, turnId,
                sourceLine: observation.sourceLine, resultSourceLine: sourceLine,
                evidence: { source: 'paired-tool-result', confidence: failed ? 'recorded-error' : 'outer-tool-result' } });
            }
          }
          if (response.is_error === true || response.error || ['failed','error','cancelled'].includes(String(response.status ?? '').toLowerCase()))
            events.push({ agentId: id, turnId, kind: 'tool-error', recordedAt: time, sourceLine, metadata: { tool: prior?.metadata.tool ?? null, callId, error: true } });
        } else if (responseType !== 'file_change') {
          if (['developer','system'].includes(response.role)) {
            for (const block of (Array.isArray(response.content) ? response.content : [])) {
              if (block?.type !== 'input_text' || typeof block.text !== 'string') continue;
              for (const entry of parseRenderedCatalog(block.text, profile)) addCatalogSkills({ skills: [entry] }, id, turnId, sourceLine, skills, []);
            }
          }
          if (response.role === 'user') {
            let inspected = 0;
            for (const block of (Array.isArray(response.content) ? response.content : [])) {
              if (block?.type !== 'input_text' || typeof block.text !== 'string' || block.text.length > 128 * 1024) continue;
              for (const match of block.text.matchAll(/(?<!\\)\$([A-Za-z0-9][A-Za-z0-9_.:-]{0,159})/g)) {
                if (++inspected > 100) { warnings.add('User skill request scan limit reached.'); break; }
                const skillName = match[1].replace(/[.:]+$/, '');
                const candidates = [...skills.values()].filter(skill => skill.name === skillName);
                if (!candidates.length) continue;
                if (candidates.length === 1) {
                  candidates[0].observations.push({ kind: 'selection-mentioned', agentId: id, turnId, sourceLine,
                    evidence: { source: 'user-textual-selection-mention', confidence: 'textual-candidate' } });
                  events.push({ agentId: id, turnId, kind: 'skill-selection-mention', recordedAt: time, sourceLine,
                    metadata: { attribution: 'matched-name', skillId: candidates[0].id, skillName } });
                } else events.push({ agentId: id, turnId, kind: 'skill-selection-mention', recordedAt: time, sourceLine,
                  metadata: { attribution: 'unresolved', reason: 'ambiguous-skill-name', candidateSkillIds: candidates.map(skill => skill.id), skillName } });
              }
              if (inspected > 100) break;
            }
          }
          const call = toolEvents(record, sourceLine, id, turnId, events, skills);
          if (call?.kind === 'tool-call') {
            const item = response;
            for (const key of [item.call_id, item.id].filter(value => SAFE_TEXT(value, 128))) calls.set(key, call);
          }
        }
      } else if (record.type === 'token_count' || record.type === 'token_usage_record') {
        if (p.thread_id && p.thread_id !== id) return;
        const detail = p.info ?? p;
        const addUsage = (raw, mode) => {
          if (!raw || typeof raw !== 'object') return;
          const { tokens: vals, invalidFields } = projectNativeTokenFields(raw);
          if (raw && typeof raw === 'object') usageRows.push({ agentId: id, turnId, sourceLine, recordedAt: time, source: 'token_count',
            modelContextWindow: detail.model_context_window ?? detail.modelContextWindow,
            scope: options.parentId ? 'child-session' : 'selected-session', mode, tokens: vals, invalidFields });
        };
        const hasTotal = detail.total_token_usage ?? detail.total;
        const hasLast = detail.last_token_usage ?? detail.last;
        if (hasTotal || hasLast) {
          addUsage(hasTotal, 'total-snapshot');
          addUsage(hasLast, 'last-snapshot');
        } else addUsage(p.token_usage ?? p.total_token_usage, 'unknown-snapshot');
      }
    };
    const buf = Buffer.alloc(65536);
    readLoop: while (pos < upper && relevant <= MAX_RECORDS && physicalLines <= physicalLimit) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, upper-pos), pos);
      if (!bytesRead) { warnings.add('Rollout truncated during read.'); break; }
      const chunk = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead); pos += bytesRead; hash.update(buf.subarray(0, bytesRead));
      let offset = 0, end;
      while ((end = chunk.indexOf(10, offset)) !== -1) {
        if (++physicalLines > physicalLimit) { warnings.add('Physical rollout line limit reached.'); break readLoop; }
        if (discarding || end-offset > MAX_LINE) { sourceLine++; warnings.add('Oversized rollout line skipped.'); discarding = false; }
        else parse(chunk.subarray(offset, end));
        offset = end + 1;
      }
      pending = discarding ? Buffer.alloc(0) : Buffer.from(chunk.subarray(offset));
      if (pending.length > MAX_LINE) { pending = Buffer.alloc(0); discarding = true; warnings.add('Oversized rollout line skipped.'); }
    }
    if (pending.length && relevant <= MAX_RECORDS && physicalLines < physicalLimit) { parse(pending); warnings.add('Unterminated final rollout record.'); }
    if (!header || badIdentity) return unavailable('The rollout identity could not be verified.');
    if (before.size > MAX_BYTES) warnings.add('Rollout byte limit reached.');
    const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) warnings.add('Rollout changed during ingestion.');
    const toolResult = toolCapture.result(), hookResult = hookCapture.result();
    let toolInvocations = toolResult.toolInvocations;
    let toolCoverage = { ...toolResult.coverage };
    let hookInvocations = hookResult.hookInvocations;
    let hookCoverage = hookResult.coverage.hooks;
    const hookCaptureBoundary = hookCoverage === 'none-recorded' ? HOOK_HISTORY_BOUNDARY : null;
    if (hookCoverage === 'none-recorded') hookCoverage = 'unavailable';
    if (options.parentId) {
      const owned = options.ownedTurns;
      const candidates = new Set([...turns.map(x => x.turnId), ...events.map(x => x.turnId)].filter(Boolean));
      if (![...candidates].some(turn => owned.has(turn))) return unavailable('No positively attributed child turn evidence is available.');
      for (const turn of [...owned]) {
        const owner = options.owners.get(turn)?.split(':');
        if (owner && owner[0] !== id) owned.delete(turn);
      }
      for (let i = turns.length - 1; i >= 0; i--) if (!owned.has(turns[i].turnId)) turns.splice(i, 1);
      for (let i = events.length - 1; i >= 0; i--) if (!events[i].turnId || !owned.has(events[i].turnId)) events.splice(i, 1);
      for (let i = usageRows.length - 1; i >= 0; i--) if (!usageRows[i].turnId || !owned.has(usageRows[i].turnId)) usageRows.splice(i, 1);
      for (const skill of skills.values()) skill.observations = skill.observations.filter(obs => obs.agentId === id
        && (obs.turnId ? owned.has(obs.turnId) : obs.kind === 'advertised-session-context'));
      // Existing parsed reads also need a catalog that survives ownership filtering.
      for (const skill of skills.values()) {
        const hasCatalog = skill.observations.some(obs => ['advertised', 'advertised-session-context'].includes(obs.kind));
        skill.observations = skill.observations.filter(obs => hasCatalog || !['definition-read-observed', 'package-resource-read-observed'].includes(obs.kind));
      }
      for (let i = artifacts.length - 1; i >= 0; i--) if (!artifacts[i].turnId || !owned.has(artifacts[i].turnId)) artifacts.splice(i, 1);
      if (outcomeClaim && (!outcomeClaim.turnId || !owned.has(outcomeClaim.turnId))) outcomeClaim = null;
      const ownedTools = toolInvocations.filter(row => row.turnId && owned.has(row.turnId));
      if (ownedTools.length !== toolInvocations.length) { toolCoverage.tools = 'partial'; toolCoverage.mcp = 'partial'; }
      toolInvocations = ownedTools;
      const ownedHooks = hookInvocations.filter(row => row.turnId ? owned.has(row.turnId) : row.scope === 'thread');
      if (ownedHooks.length !== hookInvocations.length) hookCoverage = 'partial';
      hookInvocations = ownedHooks;
    }
    for (const candidate of absoluteReads) {
      const { observation, cwd } = candidate;
      if (options.parentId && (!options.ownedTurns.has(observation.turnId)
        || !actorCwds.some(source => source.sourceLine <= observation.sourceLine && (cwd === source.cwd || cwd.startsWith(`${source.cwd}/`))
          && (source.source === 'session' || uuid(source.turnId) && options.ownedTurns.has(source.turnId))))) continue;
      const matches = actorCatalogMatches(skills, id, candidate.path, observation.sourceLine);
      if (matches.length === 1) matches[0].observations.push({ ...observation,
        kind: candidate.path === matches[0].path ? 'definition-read-observed' : 'package-resource-read-observed' });
    }
    const retainedTimes = options.parentId
      ? [...turns.map(row => row.recordedAt), ...events.map(row => row.recordedAt), ...usageRows.map(row => row.recordedAt)]
        .filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).map(Date.parse)
      : null;
    const recordedSpanMs = retainedTimes
      ? (retainedTimes.length >= 2 ? Math.max(...retainedTimes) - Math.min(...retainedTimes) : null)
      : (firstAt === null || lastAt === null ? null : Math.max(0, lastAt-firstAt));
    const usage = summarizeUsage(usageRows, warnings);
    const sortedSkills = [...skills.values()].filter(skill => skill.observations.length).map(skill => ({ ...skill, observations: skill.observations }));
    const agentStatus = warnings.size ? 'partial' : 'ready';
    const fingerprint = hash.digest('hex');
    agents[0].source = { path, fingerprint };
    const sourceComplete = warnings.size === 0 && turns.length > 0;
    if (!sourceComplete) { toolCoverage.tools = 'partial'; toolCoverage.mcp = 'partial'; hookCoverage = 'partial'; }
    return { status: sourceComplete ? 'ready' : 'partial', reason: warnings.size ? [...warnings].join(' ') : (!turns.length ? 'No turn contexts were recorded.' : null),
      source: { path, fingerprint, bytes: pos, fileBytes: before.size,
        fingerprintScope: pos === before.size ? 'source-snapshot' : 'read-prefix', recordCount: recordsTotal,
        clientVersion: safeMetaText(headerPayload?.cli_version, 128), originator: safeMetaText(headerPayload?.originator, 128) },
      agents, turns, events: events.map(({ _callId, ...event }) => event), skills: sortedSkills, usage, artifacts,
      toolInvocations, mcp: toolResult.mcp, toolCoverage, toolWarnings: toolResult.warnings,
      hookInvocations, hookCoverage, hookCaptureBoundary, hookWarnings: hookResult.warnings,
      metrics: { recordedSpanMs, recordedSpanKind: options.parentId ? 'owned-turn-evidence' : 'source-recorded-span' },
      warnings: [...warnings], outcomeClaim, sessionRootId: headerPayload.session_id ?? id,
      _agentStatus: agentStatus, _verifiedChild: !options.parentId || turns.length > 0 || events.length > 0 };
  } catch { return unavailable('The rollout could not be read safely.'); }
  finally { await handle?.close(); }
}

/** Audit one exact selected native session and corroborated same-home children. */
export async function auditNativeSession(store, profileName, id, options = {}) {
  if (!uuid(id)) throw new Error('Invalid native session ID');
  const profile = await resolveAuditProfile(store, profileName, options);
  profile.defaultUserHome = options.defaultUserHome ?? homedir();
  profile.recordedCwds = new Set();
  const base = resultBase(profile, id);
  let selected;
  try { selected = await exactRow(profile.home, id); }
  catch { base.status = 'unavailable'; base.reason = 'The selected native history index is unavailable.'; base.coverage = emptyCoverage(); return base; }
  if (!selected.row) { base.status = selected.status; base.reason = selected.status === 'not-found' ? 'The session is not present in the selected profile home.' : 'The selected native session is unavailable.'; base.coverage = emptyCoverage(selected.status); return base; }
  if (selected.lineageError) { base.status = 'unavailable'; base.reason = selected.lineageError; base.coverage = emptyCoverage(); return base; }
  const selectedParent = selected.row.parentId ?? null;
  const selectedOwners = { owners: new Map(), ownedTurns: new Set() };
  const root = await readRollout(profile, id, selected.row.rollout_path, selectedParent
    ? { parentId: selectedParent, ...selectedOwners, depth: 1, maxPhysicalLines: options.maxPhysicalLines }
    : { maxPhysicalLines: options.maxPhysicalLines });
  base.source = { ...base.source, ...root.source };
  base.status = root.status; base.reason = root.reason; base.agents = root.agents; base.turns = root.turns; base.events = root.events;
  if (base.agents[0]) base.agents[0].status = root.status;
  base.skills = root.skills; base.usage = root.usage; base.metrics = root.metrics; base.warnings = root.warnings;
  base.artifacts = root.artifacts;
  base.toolInvocations = root.toolInvocations ?? [];
  base.hookInvocations = root.hookInvocations ?? [];
  base.hookCaptureBoundary = root.hookCaptureBoundary ?? null;
  base.mcp = root.mcp ?? { servers: [], inventory: 'not-requested' };
  base.coverage.tools = root.toolCoverage?.tools ?? 'unavailable';
  base.coverage.mcp = root.toolCoverage?.mcp ?? 'unavailable';
  for (const warning of root.toolWarnings ?? []) if (base.warnings.length < 500) base.warnings.push(warning);
  for (const warning of root.hookWarnings ?? []) if (base.warnings.length < 500) base.warnings.push(warning);
  base.coverage = { timeline: root.events.length || root.turns.length ? root.status : 'unavailable', agents: 'partial',
    skills: 'partial', usage: root.usage.status, tools: root.toolCoverage?.tools ?? 'unavailable', mcp: root.toolCoverage?.mcp ?? 'unavailable',
    hooks: root.hookCoverage ?? 'unavailable',
    workspaceDiff: root.artifacts.length ? 'partial' : 'unavailable', outcome: root.outcomeClaim ? 'partial' : 'unavailable' };
  base.outcome = root.outcomeClaim ? { status: 'claim-recorded', checks: [], claim: root.outcomeClaim } : { status: 'unverified', checks: [] };
  // Child discovery is bounded and strictly same-home. It requires both index
  // parent metadata and a child rollout header plus positively-owned turn evidence.
  try {
    const childIndex = await discoverChildren(profile.home, options);
    const queue = [{ id, depth: selectedParent ? 1 : 0 }], visited = new Set([id]);
    let scannedChildren = 0;
    while (queue.length) {
      const parent = queue.shift();
      if (parent.depth >= MAX_DEPTH) {
        if ((childIndex.byParent.get(parent.id) ?? []).length) { childIndex.partial = true; childIndex.reason = 'Agent tree depth limit reached.'; }
        continue;
      }
      for (const child of childIndex.byParent.get(parent.id) ?? []) {
        if (visited.has(child.id)) { childIndex.partial = true; childIndex.reason = 'Agent lineage cycle or duplicate link detected.'; continue; }
        visited.add(child.id); scannedChildren++;
        const depth = parent.depth + 1;
        if (scannedChildren > MAX_CHILDREN) { childIndex.partial = true; childIndex.reason = 'Child session limit reached.'; break; }
        const childAudit = await readRollout(profile, child.id, child.rollout_path, { parentId: parent.id, sessionRootId: root.sessionRootId,
          depth, owners: new Map(), ownedTurns: new Set(), maxPhysicalLines: options.maxPhysicalLines });
        const verified = childAudit._verifiedChild === true;
        const agent = { id: child.id, parentId: parent.id, depth, role: 'subagent', sessionId: child.id, source: childAudit.source,
          status: verified ? childAudit.status : 'unavailable', ...(verified ? {} : { reason: childAudit.reason ?? 'Child ownership could not be corroborated.' }) };
        base.agents.push(agent);
        if (!verified) {
          base.coverage.tools = 'partial'; base.coverage.mcp = 'partial'; base.coverage.hooks = 'partial';
          continue;
        }
        if (childAudit.status === 'partial') {
          base.status = 'partial';
          base.reason ??= 'A verified child session contains partial captured evidence.';
          base.coverage.timeline = 'partial';
          base.coverage.tools = 'partial'; base.coverage.mcp = 'partial'; base.coverage.hooks = 'partial';
          for (const warning of childAudit.warnings.slice(0, 50)) {
            const projected = safeMetaText(warning, 256);
            if (projected && base.warnings.length < 500) base.warnings.push(`Child ${child.id}: ${projected}`);
          }
        }
        queue.push({ id: child.id, depth });
        base.turns.push(...childAudit.turns); base.events.push(...childAudit.events);
      base.toolInvocations.push(...(childAudit.toolInvocations ?? []));
      base.hookInvocations.push(...(childAudit.hookInvocations ?? []));
      const childMcpServers = childAudit.mcp?.servers ?? [];
      for (const server of childMcpServers) {
        if (!(childAudit.toolInvocations ?? []).some(call => call.kind === 'mcp' && call.serverName === server.name && (call.pluginId ?? null) === (server.pluginId ?? null))) continue;
        if (!base.mcp.servers.some(existing => existing.name === server.name && (existing.pluginId ?? null) === (server.pluginId ?? null)
          && existing.status === server.status && existing.source === server.source && existing.sourceLine === server.sourceLine)) base.mcp.servers.push(server);
      }
      if (childAudit.toolCoverage?.tools === 'partial') base.coverage.tools = 'partial';
      else if (childAudit.toolCoverage?.tools === 'observed' && base.coverage.tools === 'none-recorded') base.coverage.tools = 'observed';
      if (childAudit.toolCoverage?.mcp === 'partial') base.coverage.mcp = 'partial';
      else if (childAudit.toolCoverage?.mcp === 'observed' && base.coverage.mcp === 'none-recorded') base.coverage.mcp = 'observed';
      if (childAudit.hookCoverage === 'partial') base.coverage.hooks = 'partial';
      else if (childAudit.hookCoverage === 'observed') base.coverage.hooks = base.coverage.hooks === 'unavailable' ? 'partial' : 'observed';
      else if (childAudit.hookCoverage === 'unavailable' && base.coverage.hooks === 'observed') base.coverage.hooks = 'partial';
      if (!base.hookCaptureBoundary && childAudit.hookCaptureBoundary) base.hookCaptureBoundary = childAudit.hookCaptureBoundary;
      for (const skill of childAudit.skills) {
        const existing = base.skills.find(s => s.id === skill.id);
        if (existing) existing.observations.push(...skill.observations); else base.skills.push(skill);
      }
      base.usage.observations.push(...childAudit.usage.observations);
      base.usage.byAgent.push(...childAudit.usage.byAgent);
      base.usage.coverageByAgent ??= {};
      Object.assign(base.usage.coverageByAgent, childAudit.usage.coverageByAgent ?? {});
      if (childAudit.usage.observations.length && base.usage.status === 'unavailable') base.usage.status = 'partial';
        base.artifacts.push(...childAudit.artifacts);
        if (childAudit.outcomeClaim) base.events.push({ agentId: child.id, turnId: childAudit.outcomeClaim.turnId, kind: 'task-complete-claim',
          recordedAt: null, sourceLine: childAudit.outcomeClaim.sourceLine, metadata: { success: childAudit.outcomeClaim.success, status: childAudit.outcomeClaim.status } });
      }
    }
    if (childIndex.partial || base.agents.some(agent => agent.status === 'unavailable')) {
      base.warnings.push(childIndex.reason ?? 'Some linked agent sessions could not be corroborated.');
      base.status = base.status === 'ready' ? 'partial' : base.status; base.coverage.agents = 'partial';
      base.coverage.tools = 'partial'; base.coverage.mcp = 'partial'; base.coverage.hooks = 'partial';
    } else base.coverage.agents = base.agents.length > 1 ? 'partial' : 'partial'; // Native lineage is only one documented source of agent activity.
    if (base.skills.length) base.coverage.skills = 'partial';
  } catch { base.warnings.push('Same-home child discovery is unavailable.'); base.coverage.agents = 'partial';
    base.coverage.tools = 'partial'; base.coverage.mcp = 'partial'; base.coverage.hooks = 'partial'; if (base.status === 'ready') base.status = 'partial'; }
  return base;
}

async function discoverChildren(home, options = {}) {
  const path = await checkedIndex(home); if (!path) return { rows: [], partial: true, reason: 'Child discovery index unavailable.' };
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map(x => x.name));
    if (!cols.has('source') || !cols.has('rollout_path')) return { rows: [], partial: true, reason: 'Child lineage columns are unavailable.' };
    const cap = Math.min(MAX_CANDIDATES, options.maxChildCandidates ?? MAX_CANDIDATES);
    const candidates = db.prepare('SELECT substr(id,1,37) id, substr(source,1,8193) source, substr(rollout_path,1,4097) rollout_path FROM threads ORDER BY id LIMIT ?').all(cap + 1);
    let partial = candidates.length > cap; if (partial) candidates.length = cap;
    const byParent = new Map();
    for (const row of candidates) {
      if (!uuid(row.id) || typeof row.source !== 'string') continue;
      let src; try { src = JSON.parse(row.source); } catch { continue; }
      const linked = src?.subagent?.thread_spawn?.parent_thread_id;
      if (uuid(linked) && linked !== row.id) {
        const siblings = byParent.get(linked) ?? [];
        if (siblings.length < MAX_CHILDREN) { siblings.push(row); byParent.set(linked, siblings); }
        else partial = true;
      }
    }
    return { byParent, partial, reason: partial ? 'Child candidate scan limit reached.' : null };
  } finally { db.close(); }
}
