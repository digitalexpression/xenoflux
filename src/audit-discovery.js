// Read-only, copy-independent discovery for audit reports. Resource contents are
// never returned: only bounded metadata, names, and content fingerprints are.
import { lstat, realpath, opendir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { find } from './profiles.js';
import { redactText, redactValue } from './redact.js';

const MAX_ENTRIES = 256, MAX_DEPTH = 5, MAX_FILE = 512 * 1024, MAX_DETAIL_BYTES = 48 * 1024, MAX_REPORT_DETAIL_BYTES = 4 * 1024 * 1024;
const PUBLIC_STRING_SETTINGS = new Set(['model', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'model_verbosity', 'personality',
  'service_tier', 'approval_policy', 'approvals_reviewer', 'sandbox_mode']);
const PUBLIC_NUMBER_SETTINGS = new Set(['model_context_window', 'model_auto_compact_token_limit', 'project_doc_max_bytes']);
const PUBLIC_AGENT_NUMBER_SETTINGS = new Set(['max_threads', 'max_concurrent_threads_per_session', 'max_depth', 'job_max_runtime_seconds']);
const PUBLIC_AGENT_STRING_SETTINGS = new Set(['default_subagent_model', 'default_subagent_reasoning_effort']);
const MEMORY_BOOL_SETTINGS = new Set(['enabled', 'auto_save', 'auto_compact', 'project_docs', 'include_project_docs', 'search_enabled']);
const MEMORY_ENUM_SETTINGS = new Set(['mode', 'strategy', 'scope', 'retention']);
const MEMORY_NUMBER_SETTINGS = new Set(['max_entries', 'max_documents', 'max_bytes', 'max_tokens', 'retention_days']);
const PUBLIC_ENUMS = {
  model_reasoning_effort: new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  plan_mode_reasoning_effort: new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  model_verbosity: new Set(['low', 'medium', 'high']),
  personality: new Set(['friendly', 'pragmatic', 'none']),
  service_tier: new Set(['default', 'priority', 'flex']),
  approval_policy: new Set(['untrusted', 'on-failure', 'on-request', 'never']),
  approvals_reviewer: new Set(['auto_review']),
  sandbox_mode: new Set(['read-only', 'workspace-write', 'danger-full-access']),
};
const clean = (value, key) => String(redactValue(value, key)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function safeSettingValue(key, value) {
  const setting = key.startsWith('agents.') ? key.slice('agents.'.length) : key;
  const memorySetting = /^(?:memory|memories)(?:\.[A-Za-z0-9_.-]+)?$/.test(key) ? key.split('.').at(-1).toLowerCase() : null;
  if (memorySetting && MEMORY_BOOL_SETTINGS.has(memorySetting)) return typeof value === 'boolean' ? value : undefined;
  if (memorySetting && MEMORY_ENUM_SETTINGS.has(memorySetting))
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? redactValue(value, key) : undefined;
  if (memorySetting && MEMORY_NUMBER_SETTINGS.has(memorySetting))
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
  if (PUBLIC_STRING_SETTINGS.has(setting) || PUBLIC_AGENT_STRING_SETTINGS.has(setting)) {
    if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:/+-]+$/.test(value)) return undefined;
    if (PUBLIC_ENUMS[setting] && !PUBLIC_ENUMS[setting].has(value)) return undefined;
    return redactValue(value, key);
  }
  if (PUBLIC_NUMBER_SETTINGS.has(setting) || PUBLIC_AGENT_NUMBER_SETTINGS.has(setting))
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
  if (key.startsWith('features.') && typeof value === 'boolean') return value;
  if (key === 'project_doc_fallback_filenames' && Array.isArray(value)
    && value.every(item => typeof item === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(item))) return value;
  return undefined;
}

function publicConfigProjection(config) {
  const values = Object.create(null), keys = Object.keys(config).map(key => clean(key, key)).sort();
  for (const [key, value] of Object.entries(config)) {
    const safe = safeSettingValue(key, value);
    if (safe !== undefined) values[key] = safe;
  }
  for (const [key, value] of Object.entries(config.agents ?? {})) {
    const safe = safeSettingValue(`agents.${key}`, value);
    if (safe !== undefined) values[`agents.${key}`] = safe;
  }
  for (const table of ['memory', 'memories']) {
    for (const [key, value] of Object.entries(config[table] ?? {})) {
      const safe = safeSettingValue(`${table}.${key}`, value);
      if (safe !== undefined) values[`${table}.${key}`] = safe;
    }
  }
  const multiAgent = safeSettingValue('features.multi_agent', config.features?.multi_agent);
  if (multiAgent !== undefined) values['features.multi_agent'] = multiAgent;
  const names = Object.create(null);
  for (const key of ['mcp_servers', 'hooks', 'plugins']) {
    const definitions = config[key];
    if (definitions === undefined) continue;
    names[key] = (Array.isArray(definitions)
      ? definitions.map((item, index) => item?.name ?? item?.id ?? String(index))
      : Object.keys(definitions ?? {})).map(name => clean(name, 'name')).sort();
  }
  return { keys, values, names };
}

function canonicalIdentity(category, canonicalPath, provider = '') {
  return hash(`${category}\0${provider}\0${canonicalPath}`);
}
function sourceRoleFor(category, scope, origin, provider) {
  return provider ? `plugin:${clean(provider)}` : scope === 'admin' ? 'administrator-skills' : scope === 'system' ? 'system-skills'
    : category === 'skill' ? `${scope}-skills` : scope === 'project' ? 'project-root'
      : origin.includes('machine-user') ? 'machine-user' : origin.includes('user-home') ? 'profile-user' : `${scope}-home`;
}
function inventoryKeyFor(category, scope, sourceRole, logicalRoot) {
  return hash(`${category}\0${scope}\0${sourceRole}\0${logicalRoot}`);
}
function recordInventory(inventory, { category, scope, sourceRole, logicalRoot, status, names = [] }) {
  const key = inventoryKeyFor(category, scope, sourceRole, logicalRoot);
  const previous = inventory.find(item => item.key === key);
  const rank = { complete: 0, partial: 1, unavailable: 2 };
  if (previous) {
    previous.status = rank[status] > rank[previous.status] ? status : previous.status;
    previous.names = [...new Set([...previous.names, ...names.map(name => clean(name, 'name'))])].sort();
  } else inventory.push({ key, category, scope, sourceRole, status, names: [...new Set(names.map(name => clean(name, 'name')))].sort() });
  return key;
}

/** True only when the other snapshot completely scanned the same logical scope. */
export function auditResourceAbsent(resource, snapshot) {
  if (!resource?.inventoryKey || typeof resource.logicalPath !== 'string') return false;
  const entry = snapshot?.inventory?.find(item => item.key === resource.inventoryKey
    && item.category === resource.category && item.scope === resource.scope && item.sourceRole === resource.sourceRole);
  return entry?.status === 'complete' && !entry.names.includes(resource.logicalPath);
}

export function resourceId(category, canonicalPath, provider = '', name = '', scope = '', origin = '') {
  const pathIdentity = category === 'skill' ? canonicalPath : `${canonicalPath}\0${scope}\0${origin}`;
  const detail = category === 'skill' ? '' : name;
  return canonicalIdentity(category, pathIdentity, `${provider}\0${detail}`);
}

async function inspectPath(path) {
  try {
    const info = await lstat(path);
    return { info, real: await realpath(path), status: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported' };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
}
async function safeText(path) {
  let handle;
  try {
    if (await realpath(dirname(path)) !== dirname(path)) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE || (before.mode & 0o022) || (before.mode & 0o7000)) return null;
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || offset > MAX_FILE || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } catch { return null; } finally { await handle?.close(); }
}
async function safeNames(path) {
  const checked = await inspectPath(path);
  if (checked.status !== 'directory' || checked.real !== path || (checked.info.mode & 0o022) || (checked.info.mode & 0o7000))
    return { entries: null, status: checked.status === 'directory' ? 'unsafe' : checked.status };
  let dir;
  try {
    dir = await opendir(path); const entries = []; let partial = false;
    for await (const entry of dir) {
      if (['.DS_Store', '.git', '.tmp'].includes(entry.name)) continue;
      if (entries.length >= MAX_ENTRIES) { partial = true; break; }
      entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, partial, status: partial ? 'partial' : 'present' };
  } catch { return { entries: null, status: 'unreadable' }; }
}
function add(resources, category, name, scope, origin, path, status, extra = {}) {
  const safeName = clean(name, 'name'), safeOrigin = clean(origin, 'origin');
  const canonicalPath = extra.canonicalPath;
  const sourceRole = extra.sourceRole ?? sourceRoleFor(category, scope, origin, extra.provider);
  resources.push({ id: resourceId(category, canonicalPath ?? path, extra.provider ?? '', safeName, scope, origin), category, name: safeName,
    scope, origin: safeOrigin, path, ...(canonicalPath ? { canonicalPath } : {}),
    sourceRole, logicalPath: clean(extra.logicalPath ?? safeName, 'name'),
    ...(extra.provider ? { provider: clean(extra.provider) } : {}), ...(extra.version ? { version: clean(extra.version) } : {}),
    status, ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    ...(extra.fingerprintScope ? { fingerprintScope: extra.fingerprintScope } : {}),
    ...(extra.comparison ? { comparison: extra.comparison } : {}),
    ...(extra.valueStatus ? { valueStatus: extra.valueStatus } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.state ? { state: extra.state } : {}),
    ...(extra.inventoryKey ? { inventoryKey: extra.inventoryKey } : {}),
    ...(extra.note ? { note: clean(extra.note, 'note') } : {}),
    observations: [{ kind: 'present', status, source: path, ...(extra.note ? { note: clean(extra.note) } : {}) }] });
}
function boundedRedactedText(body, path, budget) {
  try {
    const text = redactText(body, path), redacted = text !== body;
    const remaining = budget ? Math.max(0, budget.remaining) : MAX_DETAIL_BYTES;
    const limit = Math.min(MAX_DETAIL_BYTES, remaining);
    if (limit === 0) return { status: 'partial', text: null, truncated: true, redacted };
    let result = text, truncated = false;
    if (Buffer.byteLength(text) > limit) {
      let end = Math.min(text.length, limit);
      while (end > 0 && Buffer.byteLength(text.slice(0, end)) > limit) end--;
      result = text.slice(0, end); truncated = true;
    }
    if (budget) budget.remaining -= Buffer.byteLength(result);
    return { status: redacted || truncated ? 'partial' : 'available', text: result, redacted, ...(truncated ? { truncated: true } : {}) };
  } catch { return { status: 'redacted', text: null }; }
}

const MEMORY_TOP_LEVEL = new Set(['memory', 'memories']);
function memorySettingEntries(config) {
  const rows = [];
  for (const section of MEMORY_TOP_LEVEL) {
    const table = config?.[section];
    if (typeof table === 'boolean' || typeof table === 'number' || typeof table === 'string') { rows.push([section, table]); continue; }
    if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
    for (const [key, value] of Object.entries(table)) rows.push([`${section}.${key}`, value]);
  }
  return rows;
}

function safeIntegrationValue(category, definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return { status: 'unknown' };
  const value = Object.create(null);
  const fields = category === 'mcp'
    ? ['type', 'transport', 'command', 'enabled', 'required', 'timeout', 'startup_timeout_ms', 'tool_timeout_sec']
    : category === 'plugin' ? ['enabled', 'marketplace', 'version'] : ['event', 'enabled', 'required'];
  for (const field of fields) {
    if (!Object.hasOwn(definition, field)) continue;
    const raw = definition[field];
    if (['enabled', 'required'].includes(field) && typeof raw === 'boolean') { value[field] = raw; continue; }
    if (['timeout', 'startup_timeout_ms', 'tool_timeout_sec'].includes(field)
      && typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1_000_000) { value[field] = raw; continue; }
    if (['type', 'transport', 'marketplace', 'version', 'event'].includes(field)
      && typeof raw === 'string' && raw.length <= 128 && /^[A-Za-z0-9._:/+-]+$/.test(raw)) { value[field] = clean(raw, field); continue; }
    if (field === 'command') {
      if (typeof raw === 'string' && raw.length <= 128 && !raw.startsWith('/') && /^[A-Za-z0-9._+-]+$/.test(raw)) value[field] = clean(raw, field);
      continue;
    }
    const safe = safeSettingValue(field, raw);
    if (safe !== undefined) value[field] = safe;
  }
  return { status: Object.keys(value).length ? 'available' : 'unknown', value,
    omitted: Object.keys(definition).filter(key => !fields.includes(key) || !Object.hasOwn(value, key)).map(key => clean(key, 'name')).sort() };
}
async function discoverSkillRoot(root, scope, origin, resources, coverage, parentPlugin, boundary = dirname(root), detailBudget, inventory, logicalRoot = 'skills') {
  const scan = await safeNames(root);
  const sourceRole = sourceRoleFor('skill', scope, origin, parentPlugin);
  const inventoryKey = recordInventory(inventory, { category: 'skill', scope, sourceRole, logicalRoot,
    status: scan.entries ? scan.partial ? 'partial' : 'complete' : scan.status === 'missing' ? 'complete' : 'unavailable',
    names: scan.entries?.map(entry => entry.name) ?? [] });
  if (!scan.entries) { coverage.skills = coverage.skills === 'partial' ? 'partial' : scan.status === 'missing' ? coverage.skills : 'partial'; return; }
  if (scan.partial) coverage.skills = 'partial';
  for (const ent of scan.entries) {
    if (ent.name === '.system' && scope !== 'system') continue;
    const alias = join(root, ent.name), inspected = await inspectPath(alias);
    if (!['directory', 'symlink'].includes(inspected.status)) {
      add(resources, 'skill', ent.name, scope, origin, alias, inspected.status === 'missing' ? 'missing' : 'unsupported'); continue;
    }
    let target = inspected.real;
    // Follow a symlink only when its resolved package remains within a known
    // discovery root. The alias remains visible even when the target is out of scope.
    const bounded = inspected.status !== 'symlink' || inside(boundary, target);
    const skillFile = join(target, 'SKILL.md');
    const skill = bounded ? await inspectPath(skillFile) : { status: 'unsafe' };
    const body = skill.status === 'file' || (skill.status === 'symlink' && bounded) ? await safeText(skillFile) : null;
    const status = body === null ? (skill.status === 'missing' ? 'missing' : skill.status === 'unsafe' || !bounded ? 'unsafe' : 'unreadable') : 'present';
    if (!['present', 'missing'].includes(status)) coverage.skills = 'partial';
    const provider = parentPlugin ?? '';
    const primaryDetail = body === null ? null : boundedRedactedText(body, skillFile, detailBudget);
    const detail = status === 'present' ? await readSkillPackage(target, alias, boundary, body, primaryDetail, detailBudget, skill.info?.mode & 0o777) : { status: 'unavailable', files: [] };
    if (detail.status !== 'available') coverage.skills = 'partial';
    add(resources, 'skill', ent.name, scope, origin, alias, status, {
      ...(inspected.status === 'symlink' ? { canonicalPath: target } : {}), ...(provider ? { provider } : {}),
      ...(primaryDetail && primaryDetail.text !== null && !primaryDetail.redacted && !primaryDetail.truncated ? { fingerprint: hash(primaryDetail.text) } : {}),
      comparison: detail.status === 'available' ? 'available' : 'partial',
      detail, inventoryKey,
      ...(parentPlugin ? { note: `Plugin skill grouped under ${parentPlugin}` } : {}),
    });
  }
}

async function readSkillPackage(target, alias, boundary, skillBody, primaryDetail, detailBudget, skillMode = null) {
  const files = [], root = target;
  let visited = 0, bytes = 0, partial = false;
  async function walk(directory, depth) {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES || bytes >= MAX_DETAIL_BYTES || detailBudget?.remaining <= 0) { partial = true; return; }
    const scan = await safeNames(directory);
    if (!scan.entries) { partial = true; return; }
    if (scan.partial) partial = true;
    for (const entry of scan.entries) {
      if (visited++ >= MAX_ENTRIES) { partial = true; break; }
      const absolute = join(directory, entry.name), rel = relative(root, absolute).split(sep).join('/');
      const checked = await inspectPath(absolute);
      if (checked.status === 'directory' && checked.real === absolute) { await walk(absolute, depth + 1); continue; }
      if (checked.status !== 'file' || checked.real !== absolute) {
        files.push({ path: clean(rel, 'name'), status: checked.status === 'symlink' ? 'unsafe' : checked.status,
          ...(checked.info ? { mode: checked.info.mode & 0o777 } : {}) }); partial = true; continue;
      }
      if (rel === 'SKILL.md') continue; // Use the already-read primary file for a stable comparison snapshot.
      if (detailBudget?.remaining <= 0) { files.push({ path: clean(rel, 'name'), status: 'partial', bytes: checked.info.size }); partial = true; continue; }
      if (bytes + checked.info.size > MAX_DETAIL_BYTES) {
        files.push({ path: clean(rel, 'name'), status: 'partial', bytes: checked.info.size, mode: checked.info.mode & 0o777 }); partial = true; continue;
      }
      const body = await safeText(absolute);
      if (body === null) { files.push({ path: clean(rel, 'name'), status: 'unavailable' }); partial = true; continue; }
      const safe = boundedRedactedText(body, absolute, detailBudget);
      const size = Buffer.byteLength(body);
      bytes += size;
      files.push({ path: clean(rel, 'name'), status: safe.status, ...(safe.text !== null && !safe.redacted && !safe.truncated ? { fingerprint: hash(safe.text) } : {}),
        ...(safe.text !== null ? { content: safe.text } : {}), bytes: size, mode: checked.info.mode & 0o777, ...(safe.truncated ? { truncated: true } : {}) });
      if (safe.status !== 'available') partial = true;
    }
  }
  // The package's primary instruction file is read once above so its displayed
  // content and fingerprint describe the same bounded read.
  if (skillBody !== null) {
    const safe = primaryDetail ?? boundedRedactedText(skillBody, join(alias, 'SKILL.md'));
    files.push({ path: 'SKILL.md', status: safe.status, ...(safe.text !== null && !safe.redacted && !safe.truncated ? { fingerprint: hash(safe.text) } : {}),
      ...(safe.text !== null ? { content: safe.text } : {}), bytes: Buffer.byteLength(skillBody), ...(Number.isFinite(skillMode) ? { mode: skillMode } : {}), ...(safe.truncated ? { truncated: true } : {}) });
    bytes += Buffer.byteLength(skillBody);
    if (safe.status !== 'available') partial = true;
  }
  // Symlink aliases are followed only after the existing boundary check.
  if (!inside(boundary, root)) return { status: 'partial', files };
  await walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  // Defensive deduplication keeps malformed directory listings from duplicating rows.
  const unique = [...new Map(files.map(file => [file.path, file])).values()];
  return { status: partial ? 'partial' : 'available', files: unique, coverage: { files: unique.length, truncated: partial } };
}
async function fileResource(resources, category, name, scope, origin, path, { fingerprint = false, value, includeContent = false, detailBudget, inventoryKey } = {}) {
  const checked = await inspectPath(path);
  if (checked.status === 'missing') { add(resources, category, name, scope, origin, path, 'missing', { inventoryKey }); return 'missing'; }
  let digest;
  let detail;
  if (fingerprint && checked.status === 'file') {
    const body = await safeText(path);
    if (includeContent && body !== null) {
      detail = boundedRedactedText(body, path, detailBudget);
      if (detail.text !== null && !detail.redacted && !detail.truncated) digest = hash(detail.text);
    } else if (body !== null) digest = hash(body);
  }
  const status = checked.status === 'file' || checked.status === 'directory' ? digest || !fingerprint ? 'present' : 'unreadable' : checked.status === 'symlink' ? 'unsafe' : checked.status;
  add(resources, category, name, scope, origin, path, status, { ...(digest ? { fingerprint: digest } : {}), ...(value !== undefined ? { value } : {}), ...(detail ? { detail,
    comparison: detail.status === 'available' ? 'available' : 'partial', valueStatus: detail.status === 'available' ? 'present' : 'partial' } : {}), inventoryKey });
  return detail && detail.status !== 'available' ? 'partial' : status;
}
async function discoverHome(home, scope, origin, resources, coverage, { includeSettings = true, skillBoundary = home, detailBudget, inventory, inventoryRoot = scope } = {}) {
  if (includeSettings) {
    const configPath = join(home, 'config.toml'), body = await safeText(configPath);
    const settingRole = sourceRoleFor('config', scope, origin);
    const configKey = inventoryKeyFor('config', scope, settingRole, `${inventoryRoot}/config.toml`);
    const categoryKey = category => inventoryKeyFor(category, scope, sourceRoleFor(category, scope, origin), `${inventoryRoot}/config.toml`);
    const discoveryCategories = ['config', 'memory-setting', 'feature', 'mcp', 'hook', 'plugin', 'tool'];
    if (body === null) {
      const status = (await inspectPath(configPath)).status === 'missing' ? 'missing' : 'unreadable';
      add(resources, 'config', 'config.toml', scope, origin, configPath, status, { inventoryKey: configKey });
      for (const category of discoveryCategories) recordInventory(inventory, { category, scope,
        sourceRole: sourceRoleFor(category, scope, origin), logicalRoot: `${inventoryRoot}/config.toml`, status: status === 'missing' ? 'complete' : 'unavailable' });
      if (status === 'unreadable') coverage.config = 'partial';
    }
    else {
      let config;
      try { config = parse(body); } catch { add(resources, 'config', 'config.toml', scope, origin, configPath, 'unsupported', { inventoryKey: configKey }); coverage.config = 'partial';
        for (const category of discoveryCategories) recordInventory(inventory, { category, scope, sourceRole: sourceRoleFor(category, scope, origin), logicalRoot: `${inventoryRoot}/config.toml`, status: 'partial' }); config = null; }
      if (config) {
        const projection = publicConfigProjection(config);
        const configNames = ['config.toml', ...Object.keys(config)];
        const memoryNames = memorySettingEntries(config).map(([key]) => key);
        const featureNames = Object.keys(config.features ?? {});
        const integrationNames = {
          mcp: config.mcp_servers === undefined ? [] : ['mcp_servers', ...(Array.isArray(config.mcp_servers)
            ? config.mcp_servers.map((item, index) => String(item?.name ?? item?.id ?? index)) : Object.keys(config.mcp_servers ?? {}))],
          hook: config.hooks === undefined ? [] : ['hooks', ...(Array.isArray(config.hooks)
            ? config.hooks.map((item, index) => String(item?.name ?? item?.id ?? index)) : Object.keys(config.hooks ?? {}))],
          plugin: config.plugins === undefined ? [] : ['plugins', ...(Array.isArray(config.plugins)
            ? config.plugins.map((item, index) => String(item?.name ?? item?.id ?? index)) : Object.keys(config.plugins ?? {}))],
          tool: config.tools === undefined ? [] : (Array.isArray(config.tools)
            ? config.tools.map((item, index) => String(item?.name ?? item?.id ?? index)) : Object.keys(config.tools ?? {})),
        };
        const isTable = value => value && typeof value === 'object' && !Array.isArray(value);
        const integrationStatus = key => config[key] === undefined || Array.isArray(config[key]) || isTable(config[key]) ? 'complete' : 'partial';
        const featureStatus = config.features === undefined || isTable(config.features) ? 'complete' : 'partial';
        const memoryStatus = ['memory', 'memories'].every(key => config[key] === undefined || typeof config[key] === 'boolean'
          || typeof config[key] === 'number' || typeof config[key] === 'string' || isTable(config[key])) ? 'complete' : 'partial';
        for (const [key, value] of Object.entries(config)) {
          if (key === 'agents' && value && typeof value === 'object' && !Array.isArray(value)) configNames.push(...Object.keys(value).map(name => `agents.${name}`));
          if (key === 'features' && value && typeof value === 'object' && !Array.isArray(value)) configNames.push(...Object.keys(value).map(name => `features.${name}`));
        }
        recordInventory(inventory, { category: 'config', scope, sourceRole: settingRole, logicalRoot: `${inventoryRoot}/config.toml`, status: 'complete', names: configNames });
        recordInventory(inventory, { category: 'memory-setting', scope, sourceRole: sourceRoleFor('memory-setting', scope, origin), logicalRoot: `${inventoryRoot}/config.toml`, status: memoryStatus, names: memoryNames });
        recordInventory(inventory, { category: 'feature', scope, sourceRole: sourceRoleFor('feature', scope, origin), logicalRoot: `${inventoryRoot}/config.toml`, status: featureStatus, names: featureNames });
        for (const [category, names] of Object.entries(integrationNames)) recordInventory(inventory, { category, scope,
          sourceRole: sourceRoleFor(category, scope, origin), logicalRoot: `${inventoryRoot}/config.toml`,
          status: integrationStatus(category === 'mcp' ? 'mcp_servers' : category === 'hook' ? 'hooks' : category === 'plugin' ? 'plugins' : 'tools'), names });
        add(resources, 'config', 'config.toml', scope, origin, configPath, 'present', {
          fingerprint: hash(JSON.stringify(projection)), fingerprintScope: 'public-safe-projection', comparison: 'partial',
          note: 'Digest covers public-safe settings and names only; omitted values remain unknown.', inventoryKey: configKey,
        });
        if (projection.keys.length > 0) coverage.config = 'partial';
        for (const [key, value] of Object.entries(config)) {
        if (['mcp_servers', 'hooks', 'plugins', 'tools'].includes(key) || MEMORY_TOP_LEVEL.has(key)) continue;
          const safeValue = safeSettingValue(key, value);
          add(resources, 'config', key, scope, origin, configPath, 'present', {
            ...(safeValue !== undefined ? { value: safeValue, comparison: 'available', valueStatus: 'present' }
              : { comparison: 'unknown', valueStatus: 'omitted', note: 'Setting name only; value omitted from the public projection' }),
            inventoryKey: configKey,
          });
          if (key === 'agents' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [agentKey, agentValue] of Object.entries(value)) {
              const qualified = `agents.${agentKey}`, publicValue = safeSettingValue(qualified, agentValue);
              add(resources, 'config', qualified, scope, origin, configPath, 'present', {
                ...(publicValue !== undefined ? { value: publicValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: 'Setting name only; value omitted from the public projection' }),
                inventoryKey: configKey,
              });
            }
          }
          if (key === 'features' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [feature, featureValue] of Object.entries(value)) {
              const qualified = `features.${feature}`, publicValue = safeSettingValue(qualified, featureValue);
              add(resources, 'config', qualified, scope, origin, configPath, 'present', {
                ...(publicValue !== undefined ? { value: publicValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: 'Setting name only; value omitted from the public projection' }),
                inventoryKey: configKey,
              });
              add(resources, 'feature', feature, scope, origin, configPath, 'present', {
                ...(typeof featureValue === 'boolean' ? { value: featureValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: 'Feature setting is present but its value is not in the safe projection.' }),
                note: 'Declared feature setting; does not prove runtime availability or use.',
                inventoryKey: categoryKey('feature'),
              });
            }
          }
        }
        for (const [key, value] of memorySettingEntries(config)) {
          const safe = safeSettingValue(key, value);
          add(resources, 'memory-setting', key, scope, origin, configPath, 'present', {
            ...(safe !== undefined ? { value: safe, comparison: 'available', valueStatus: 'present' }
              : { comparison: 'unknown', valueStatus: 'omitted', note: 'Memory setting name only; value omitted from the public projection' }),
            inventoryKey: categoryKey('memory-setting'),
          });
        }
        for (const key of ['mcp_servers', 'hooks', 'plugins']) {
          const definitions = config[key]; if (definitions === undefined) continue;
          const entries = Array.isArray(definitions) ? definitions.map((v, i) => [String(v?.name ?? v?.id ?? i), v]) : Object.entries(definitions ?? {});
          const category = key === 'mcp_servers' ? 'mcp' : key === 'hooks' ? 'hook' : 'plugin';
          add(resources, category, key, scope, origin, configPath, 'present', { comparison: 'unknown', valueStatus: 'omitted', note: 'Configuration presence only; details omitted and activation unknown', inventoryKey: categoryKey(category) });
          for (const [name, definition] of entries) {
            const safe = safeIntegrationValue(category, definition);
            add(resources, category, name, scope, origin, configPath, 'present', {
              ...(safe.value ? { value: safe.value } : {}), comparison: safe.status,
              valueStatus: safe.status === 'available' ? 'partial' : 'omitted',
              state: { configured: 'present', installed: 'unknown', enabled: typeof definition?.enabled === 'boolean' ? definition.enabled : 'unknown',
                available: 'unknown', loaded: 'unknown', used: 'unknown' },
              inventoryKey: categoryKey(category),
              note: safe.omitted?.length ? `Safe fields only; omitted: ${safe.omitted.join(', ')}. Configuration does not prove activation, availability or use.`
                : 'Safe fields only; configuration does not prove activation, availability or use.',
            });
          }
        }
        if (config.tools !== undefined) {
          const definitions = Array.isArray(config.tools) ? config.tools.map((item, index) => [String(item?.name ?? item?.id ?? index), item]) : Object.entries(config.tools ?? {});
          for (const [name, definition] of definitions) {
            const enabled = typeof definition === 'boolean' ? definition : definition && typeof definition === 'object' ? definition.enabled : undefined;
            add(resources, 'tool', name, scope, origin, configPath, 'present', {
              ...(typeof enabled === 'boolean' ? { value: { enabled } } : {}),
              comparison: typeof enabled === 'boolean' ? 'partial' : 'unknown', valueStatus: typeof enabled === 'boolean' ? 'partial' : 'omitted',
              state: { configured: 'present', enabled: typeof enabled === 'boolean' ? enabled : 'unknown', available: 'unknown', used: 'unknown' },
              inventoryKey: categoryKey('tool'),
              note: 'Configured tool entry only; actual availability and use are not established.',
            });
          }
        }
      }
    }
    for (const [category, file] of [['instruction', 'AGENTS.md'], ['instruction', 'AGENTS.override.md']]) {
      const key = recordInventory(inventory, { category, scope, sourceRole: sourceRoleFor(category, scope, origin),
        logicalRoot: `${inventoryRoot}/${file}`, status: 'complete', names: [file] });
      const status = await fileResource(resources, category, file, scope, origin, join(home, file), { fingerprint: true, includeContent: true, detailBudget, inventoryKey: key });
      if (!['present', 'missing'].includes(status)) coverage.instructions = 'partial';
    }
    for (const [category, directory, suffix] of [['agent', 'agents', '.toml'], ['rule', 'rules', '.rules']]) {
      const root = join(home, directory), scan = await safeNames(root);
      const key = recordInventory(inventory, { category, scope, sourceRole: sourceRoleFor(category, scope, origin),
        logicalRoot: `${inventoryRoot}/${directory}`, status: scan.entries ? scan.partial ? 'partial' : 'complete' : scan.status === 'missing' ? 'complete' : 'unavailable',
        names: scan.entries?.filter(entry => entry.name.endsWith(suffix)).map(entry => entry.name) ?? [] });
      if (!scan.entries) { if (scan.status !== 'missing') coverage[category === 'agent' ? 'agents' : 'rules'] = 'partial'; continue; }
      if (scan.partial) coverage[category === 'agent' ? 'agents' : 'rules'] = 'partial';
      for (const entry of scan.entries) if (entry.name.endsWith(suffix)) {
        const status = await fileResource(resources, category, entry.name, scope, origin, join(root, entry.name), { fingerprint: true, includeContent: true, detailBudget, inventoryKey: key });
        if (!['present', 'missing'].includes(status))
          coverage[category === 'agent' ? 'agents' : 'rules'] = 'partial';
      }
    }
  }
  await discoverSkillRoot(join(home, 'skills'), scope, origin, resources, coverage, undefined, skillBoundary, detailBudget, inventory, `${inventoryRoot}/skills`);
  const bundled = join(home, 'skills', '.system');
  await discoverSkillRoot(bundled, 'system', `${origin}:bundled`, resources, coverage, undefined, skillBoundary, detailBudget, inventory, `${inventoryRoot}/skills/.system`);
}

async function discoverPlugins(home, resources, coverage, detailBudget, inventory, inventoryRoot = '$CODEX_HOME') {
  const root = join(home, 'plugins', 'cache');
  let visited = 0, inventoryStatus = 'complete';
  const inventoryNames = [], pluginInventoryKey = inventoryKeyFor('plugin', 'plugin', 'plugin-cache', `${inventoryRoot}/plugins/cache`);
  async function walk(dir, depth, provider = '') {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) { coverage.plugins = 'partial'; inventoryStatus = 'partial'; return; }
    const scan = await safeNames(dir);
    if (!scan.entries) { if (scan.status !== 'missing') { coverage.plugins = 'partial'; inventoryStatus = 'unavailable'; } return; }
    if (scan.partial) { coverage.plugins = 'partial'; inventoryStatus = 'partial'; }
    for (const ent of scan.entries) {
      if (visited++ >= MAX_ENTRIES) { coverage.plugins = 'partial'; break; }
      if (ent.isSymbolicLink()) {
        const path = join(dir, ent.name);
        add(resources, 'plugin', ent.name, 'plugin', 'native-cache', path, 'unsafe', { sourceRole: 'plugin-cache', inventoryKey: pluginInventoryKey,
          logicalPath: `${provider ? `${provider}/` : ''}${ent.name}`, note: 'Symbolic link is visible but its target is not followed' });
        coverage.plugins = 'partial';
        inventoryStatus = 'partial';
        continue;
      }
      if (!ent.isDirectory()) continue;
      const path = join(dir, ent.name), manifestPath = join(path, '.codex-plugin', 'plugin.json');
      let manifestText = await safeText(manifestPath);
      if (manifestText === null) manifestText = await safeText(join(path, 'plugin.json'));
      if (manifestText === null) manifestText = await safeText(join(path, 'manifest.json'));
      if (manifestText !== null) {
        try {
          const manifest = JSON.parse(manifestText);
          const id = typeof manifest.id === 'string' ? clean(manifest.id, 'id') : clean(ent.name, 'name');
          const version = typeof manifest.version === 'string' ? clean(manifest.version, 'version') : undefined;
          const logicalPath = `${id}/${version ?? 'unknown-version'}`; inventoryNames.push(logicalPath);
          add(resources, 'plugin', typeof manifest.name === 'string' ? clean(manifest.name, 'name') : ent.name, 'plugin', 'native-cache', path, 'present', {
            canonicalPath: await realpath(path), provider: id, ...(version ? { version } : {}),
            sourceRole: 'plugin-cache', inventoryKey: pluginInventoryKey, logicalPath,
            state: { cached: 'present', installed: 'unknown', enabled: 'unknown', available: 'unknown', loaded: 'unknown', used: 'unknown' },
            note: 'Cached plugin metadata; installation and activation are unknown',
          });
          const skills = join(path, 'skills');
          await discoverSkillRoot(skills, 'plugin', `plugin:${id}`, resources, coverage, id, path, detailBudget, inventory,
            `${inventoryRoot}/plugins/${id}/${version ?? 'unknown-version'}/skills`);
        } catch { add(resources, 'plugin', ent.name, 'plugin', 'native-cache', path, 'unsupported', { sourceRole: 'plugin-cache', inventoryKey: pluginInventoryKey,
          logicalPath: `${provider ? `${provider}/` : ''}${ent.name}`, note: 'Malformed plugin manifest' }); coverage.plugins = 'partial'; inventoryStatus = 'partial'; }
      } else await walk(path, depth + 1, provider || ent.name);
    }
  }
  await walk(root, 0);
  recordInventory(inventory, { category: 'plugin', scope: 'plugin', sourceRole: 'plugin-cache', logicalRoot: `${inventoryRoot}/plugins/cache`,
    status: inventoryStatus, names: inventoryNames });
}

/** Resolve the selected identity and its read roots without launcher readiness checks. */
export async function resolveAuditProfile(store, name, { defaultUserHome = homedir(), client = 'cli' } = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Profile name is required');
  if (!['cli', 'desktop'].includes(client)) throw new Error(`Unsupported audit client: ${client}`);
  if (name.toLowerCase() === 'default') {
    const userHome = resolve(defaultUserHome), home = join(userHome, '.codex');
    return { profileId: 'default', profileName: 'Default', home, userHome, nativeRoot: null, environmentId: null, executable: null, version: null };
  }
  let profile;
  try { profile = find(await store.read(), name); }
  catch (error) {
    if (/^(?:Profile not found|Ambiguous profile)/i.test(error.message)) throw new Error('Selected audit profile is unavailable or ambiguous');
    throw error;
  }
  if (!profile.native) throw new Error(`Profile has no native home binding: ${name}`);
  const nativeRoot = profile.native.root;
  const checked = await inspectPath(nativeRoot);
  if (checked.status !== 'directory' || checked.real !== nativeRoot) throw new Error(`Native home root is missing or unsafe: ${nativeRoot}`);
  const home = join(nativeRoot, 'codex-home'), userHome = join(nativeRoot, 'user-home');
  const state = await inspectPath(home);
  if (state.status !== 'directory' || state.real !== home) throw new Error('Audit native home is missing or unsafe');
  return { profileId: profile.id, profileName: profile.name, home, userHome, nativeRoot,
    environmentId: profile.native.environmentId, executable: profile.native.executable, version: profile.native.version };
}

/** Discover current setup sources for the selected client/repository context. */
export async function discoverAuditProfile(store, name, { repo, client = 'cli', defaultUserHome = homedir(), adminRoots = ['/etc/codex/skills'] } = {}) {
  const profile = await resolveAuditProfile(store, name, { defaultUserHome, client });
  const detailBudget = { remaining: MAX_REPORT_DETAIL_BYTES };
  const resources = [], inventory = [], warnings = [], coverage = { client: 'partial', config: 'complete', instructions: 'complete', agents: 'complete', skills: 'complete', rules: 'complete', plugins: 'partial', mcp: 'partial', hooks: 'partial', tools: 'unavailable', memorySettings: 'partial', system: 'partial' };
  const addWarning = text => warnings.push(clean(text));
  await discoverHome(profile.home, 'profile', profile.profileName, resources, coverage, { skillBoundary: profile.nativeRoot ?? profile.userHome, detailBudget, inventory, inventoryRoot: '$CODEX_HOME' });
  await discoverPlugins(profile.home, resources, coverage, detailBudget, inventory);
  await discoverHome(join(profile.userHome, '.codex'), 'user', `${profile.profileName}:user-home`, resources, coverage, { detailBudget, inventory, inventoryRoot: '$HOME/.codex' });
  // The actual machine user tree is relevant for Default and Desktop, and may
  // be separately relevant to CLI profiles. It is always identified distinctly.
  const actualUser = resolve(defaultUserHome);
  if (actualUser !== profile.userHome) await discoverHome(join(actualUser, '.codex'), 'user', 'machine-user', resources, coverage, { detailBudget, inventory, inventoryRoot: '$MACHINE_HOME/.codex' });
  for (const base of new Set([profile.userHome, actualUser])) {
    const machine = base === actualUser;
    await discoverSkillRoot(join(base, '.agents', 'skills'), 'user', machine ? 'machine-user:.agents' : 'profile-user:.agents', resources, coverage, undefined, base,
      detailBudget, inventory, `${machine ? '$MACHINE_HOME' : '$HOME'}/.agents/skills`);
  }
  if (repo !== undefined) {
    if (typeof repo !== 'string' || !repo.startsWith('/') || resolve(repo) !== repo) throw new Error('Repository path must be absolute and normalized');
    const checked = await inspectPath(repo); if (checked.status !== 'directory') throw new Error(`Repository path is missing or unsafe: ${repo}`);
    let current = checked.real;
    const ancestors = [];
    while (true) { ancestors.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
    for (const root of ancestors.reverse()) {
      await discoverHome(join(root, '.codex'), 'project', root, resources, coverage, { detailBudget, inventory, inventoryRoot: `project:${root}` });
      await discoverSkillRoot(join(root, '.agents', 'skills'), 'project', root, resources, coverage, undefined, root, detailBudget, inventory, `project:${root}/.agents/skills`);
      for (const file of ['AGENTS.md', 'AGENTS.override.md']) {
        const key = recordInventory(inventory, { category: 'instruction', scope: 'project', sourceRole: 'project-root', logicalRoot: `project:${root}/${file}`, status: 'complete', names: [file] });
        const status = await fileResource(resources, 'instruction', file, 'project', root, join(root, file), { fingerprint: true, includeContent: true, detailBudget, inventoryKey: key });
        if (!['present', 'missing'].includes(status)) coverage.instructions = 'partial';
      }
    }
    addWarning('Repository ancestor discovery is limited to root-level instruction and resource directories; nested unrelated repositories are not scanned.');
  } else coverage.project = 'unavailable';
  for (const root of adminRoots) {
    if (typeof root !== 'string' || !root.startsWith('/') || resolve(root) !== root) { addWarning('An invalid administrator discovery root was skipped.'); coverage.system = 'partial'; continue; }
    await discoverSkillRoot(root, 'admin', 'administrator', resources, coverage, undefined, dirname(root), detailBudget, inventory, `admin:${root}`);
  }
  for (const resource of resources) resource.clientApplicability = {
    client, status: 'unknown', reason: 'Static discovery does not establish that this source applies to the selected client.'
  };
  // Native bundled discovery varies by client/version. Native home metadata is
  // included above; do not claim that it proves runtime activation.
  addWarning(`${client} setup inventory is a current filesystem/configuration snapshot; it does not prove historical loading or use.`);
  addWarning('Memory setting values are shown only for recognized safe config keys; memory documents and generated memory contents are not read. Effective memory behavior may remain unknown.');
  addWarning('Static configuration does not establish the runtime available-tool list; configured tools and integration definitions are only partial evidence.');
  if (detailBudget.remaining === 0) addWarning('The aggregate safe-content detail limit was reached; remaining source details are partial and were not read.');
  if (client === 'desktop') addWarning('Desktop-specific discovery locations and activation metadata are version-dependent; unavailable sources remain partial.');
  return { schemaVersion: 1, kind: 'audit-profile', status: Object.values(coverage).some(value => value !== 'complete') ? 'partial' : 'present', profile, context: { client, ...(repo ? { repo: resolve(repo) } : {}) }, resources, inventory, coverage, warnings };
}
