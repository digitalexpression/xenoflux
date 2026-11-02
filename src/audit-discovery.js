// Read-only setup discovery, independent of copying. Public audit discovery
// projects bounded, redacted detail; the local UI can opt into parsed source values.
import { lstat, realpath, opendir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { find } from './profiles.js';
import { redactText, redactValue } from './redact.js';

const MAX_ENTRIES = 256, MAX_DEPTH = 5, MAX_LOCAL_PACKAGE_ENTRIES = 4096, MAX_LOCAL_PACKAGE_DEPTH = 16,
  MAX_FILE = 512 * 1024, MAX_PACKAGE_FILE_BYTES = 64 * 1024 * 1024,
  MAX_PACKAGE_BYTES = 256 * 1024 * 1024, MAX_SOURCE_DIGEST_BYTES = 512 * 1024 * 1024,
  MAX_DETAIL_BYTES = 48 * 1024, MAX_REPORT_DETAIL_BYTES = 4 * 1024 * 1024;
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

function localSourceValue(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return { __xfxTomlType: 'number', value: Number.isNaN(value) ? 'NaN' : value < 0 ? '-Infinity' : 'Infinity' };
  if (value instanceof Date) return { __xfxTomlType: 'date', value: value.toISOString() };
  if (Array.isArray(value)) return value.map(localSourceValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, localSourceValue(value[key])]));
  return value;
}
function includeLocalSourceValue(value, enabled, detailBudget) {
  if (!enabled) return false;
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(localSourceValue(value))); } catch { detailBudget.sourceValuesComplete = false; return false; }
  if (!Number.isFinite(bytes) || bytes > detailBudget.sourceValuesRemaining) { detailBudget.sourceValuesComplete = false; return false; }
  detailBudget.sourceValuesRemaining -= bytes;
  return true;
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
  } else inventory.push({ key, category, scope, sourceRole, logicalRoot, status, names: [...new Set(names.map(name => clean(name, 'name')))].sort() });
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
async function safeText(path, { withDigest = false } = {}) {
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
    const raw = buffer.subarray(0, offset), text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return withDigest ? { text, digest: createHash('sha256').update(raw).digest('hex') } : text;
  } catch { return null; } finally { await handle?.close(); }
}
async function safeFileDigest(path, expected) {
  let handle;
  try {
    if (await realpath(dirname(path)) !== dirname(path)) return { status: 'unsafe' };
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o022) || (before.mode & 0o7000)) return { status: 'unsafe' };
    if (before.size > MAX_PACKAGE_FILE_BYTES) return { status: 'too-large', bytes: before.size, mode: before.mode & 0o777 };
    if (expected && (before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size
      || before.mode !== expected.mode || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs)) return { status: 'changed' };
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) return { status: 'changed' };
      digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { status: 'changed' };
    const pathAfter = await lstat(path);
    if (pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      || pathAfter.size !== before.size || pathAfter.mtimeMs !== before.mtimeMs || pathAfter.ctimeMs !== before.ctimeMs)
      return { status: 'changed' };
    return { status: 'available', digest: digest.digest('hex'), bytes: before.size, mode: before.mode & 0o777 };
  } catch (error) { return { status: ['ELOOP', 'ENOTDIR'].includes(error.code) ? 'unsafe' : 'unavailable' }; }
  finally { await handle?.close(); }
}
async function safeNames(path, maxEntries = MAX_ENTRIES, includeIgnored = false) {
  const checked = await inspectPath(path);
  if (checked.status !== 'directory' || checked.real !== path || (checked.info.mode & 0o022) || (checked.info.mode & 0o7000))
    return { entries: null, status: checked.status === 'directory' ? 'unsafe' : checked.status };
  let dir;
  try {
    dir = await opendir(path); const entries = []; let partial = false;
    for await (const entry of dir) {
      if (!includeIgnored && ['.DS_Store', '.git', '.tmp'].includes(entry.name)) continue;
      if (entries.length >= maxEntries) { partial = true; break; }
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
  const resource = { id: resourceId(category, canonicalPath ?? path, extra.provider ?? '', safeName, scope, origin), category, name: safeName,
    scope, origin: safeOrigin, path, ...(canonicalPath ? { canonicalPath } : {}),
    sourceRole, logicalPath: clean(extra.logicalPath ?? safeName, 'name'),
    ...(extra.provider ? { provider: clean(extra.provider) } : {}), ...(extra.version ? { version: clean(extra.version) } : {}),
    status, ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    ...(extra.fingerprintScope ? { fingerprintScope: extra.fingerprintScope } : {}),
    ...(extra.comparison ? { comparison: extra.comparison } : {}),
    ...(extra.valueStatus ? { valueStatus: extra.valueStatus } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    ...(extra.integrationId ? { integrationId: clean(extra.integrationId, 'integration id') } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.state ? { state: extra.state } : {}),
    ...(extra.inventoryKey ? { inventoryKey: extra.inventoryKey } : {}),
    ...(extra.note ? { note: clean(extra.note, 'note') } : {}),
    observations: [{ kind: 'present', status, source: path, ...(extra.note ? { note: clean(extra.note) } : {}) }] };
  resources.push(resource);
  return resource;
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
async function discoverSkillRoot(root, scope, origin, resources, coverage, parentPlugin, boundary = dirname(root), detailBudget, inventory, logicalRoot = 'skills', includeSourceValues = false) {
  const scan = await safeNames(root);
  const sourceRole = sourceRoleFor('skill', scope, origin, parentPlugin);
  if (!scan.entries) {
    recordInventory(inventory, { category: 'skill', scope, sourceRole, logicalRoot,
      status: scan.status === 'missing' ? 'complete' : 'unavailable', names: [] });
    coverage.skills = coverage.skills === 'partial' ? 'partial' : scan.status === 'missing' ? coverage.skills : 'partial'; return;
  }
  if (scan.partial) coverage.skills = 'partial';
  const candidates = []; let candidateScanPartial = false;
  for (const ent of scan.entries) {
    if (ent.name === '.system' && scope !== 'system') continue;
    const alias = join(root, ent.name), inspected = await inspectPath(alias);
    if (inspected.status === 'unreadable') {
      try {
        const info = await lstat(alias);
        if (info.isSymbolicLink()) candidates.push({ ent, alias, inspected: { ...inspected, info, status: 'symlink', real: alias },
          target: alias, bounded: false, skill: { status: 'unsafe' }, skillFile: join(alias, 'SKILL.md') });
      } catch { candidateScanPartial = true; }
      if (!candidates.some(candidate => candidate.ent === ent)) candidateScanPartial = true;
      continue;
    }
    if (inspected.status === 'missing') { candidateScanPartial = true; continue; }
    if (inspected.status === 'unreadable') { candidateScanPartial = true; continue; }
    if (!['directory', 'symlink'].includes(inspected.status)) continue;
    const target = inspected.real;
    // Follow a symlink only when its resolved package remains within a known
    // discovery root. The alias remains visible even when the target is out of scope.
    const bounded = inspected.status !== 'symlink' || inside(boundary, target);
    const skillFile = join(target, 'SKILL.md');
    const skill = bounded ? await inspectPath(skillFile) : { status: 'unsafe' };
    if (skill.status !== 'missing') candidates.push({ ent, alias, inspected, target, bounded, skill, skillFile });
  }
  const inventoryKey = recordInventory(inventory, { category: 'skill', scope, sourceRole, logicalRoot,
    status: scan.partial || candidateScanPartial ? 'partial' : 'complete', names: candidates.map(candidate => candidate.ent.name) });
  if (candidateScanPartial) coverage.skills = 'partial';
  for (const { ent, alias, inspected, target, bounded, skill, skillFile } of candidates) {
    const bodyRead = skill.status === 'file' || (skill.status === 'symlink' && bounded)
      ? await safeText(skillFile, { withDigest: includeSourceValues }) : null;
    let body = includeSourceValues ? bodyRead?.text ?? null : bodyRead;
    let primaryDigest = { status: ['unsafe', 'symlink'].includes(skill.status) || !bounded ? 'unsafe' : 'withheld', bytes: skill.info?.size, mode: skill.info?.mode & 0o777 };
    if (includeSourceValues && skill.status === 'file' && bounded && skill.info.size <= MAX_PACKAGE_FILE_BYTES
      && skill.info.size <= (detailBudget?.sourceDigestRemaining ?? 0)) {
      primaryDigest = await safeFileDigest(skillFile, skill.info);
      if (primaryDigest.status === 'available') detailBudget.sourceDigestRemaining -= primaryDigest.bytes;
    } else if (includeSourceValues && skill.status === 'file') primaryDigest = { status: 'budget-exceeded', bytes: skill.info.size };
    if (includeSourceValues && primaryDigest.status === 'available' && bodyRead !== null && bodyRead?.digest !== primaryDigest.digest) {
      detailBudget.sourceDigestRemaining += primaryDigest.bytes;
      primaryDigest = { status: 'changed', bytes: primaryDigest.bytes, mode: primaryDigest.mode };
      body = null;
    }
    const primaryFileSafe = skill.status === 'file' && bounded && skill.info.nlink === 1
      && !(skill.info.mode & 0o022) && !(skill.info.mode & 0o7000);
    const status = body !== null || primaryDigest.status === 'available' || primaryFileSafe
      ? 'present' : primaryDigest.status === 'unsafe' || !bounded ? 'unsafe' : 'unreadable';
    if (!['present', 'missing'].includes(status)) coverage.skills = 'partial';
    const provider = parentPlugin ?? '';
    const primaryDetail = body === null ? null : boundedRedactedText(body, skillFile, detailBudget);
    const detail = status === 'present' ? await readSkillPackage(target, alias, boundary, body, primaryDetail, detailBudget, skill.info?.mode & 0o777, includeSourceValues, primaryDigest) : { status: 'unavailable', files: [] };
    if (detail.status !== 'available') coverage.skills = 'partial';
    add(resources, 'skill', ent.name, scope, origin, alias, status, {
      ...(inspected.status === 'symlink' ? { canonicalPath: target } : {}), ...(provider ? { provider } : {}),
      ...(detail.fingerprint ? { fingerprint: detail.fingerprint, fingerprintScope: 'local-skill-package' }
        : primaryDetail && primaryDetail.text !== null && !primaryDetail.redacted && !primaryDetail.truncated
          ? { fingerprint: hash(primaryDetail.text), fingerprintScope: 'visible-safe-skill-text' } : {}),
      comparison: detail.coverage?.comparison === 'complete' ? 'available' : 'partial',
      detail, inventoryKey,
      ...(parentPlugin ? { note: `Plugin skill grouped under ${parentPlugin}` } : {}),
    });
  }
}

async function readSkillPackage(target, alias, boundary, skillBody, primaryDetail, detailBudget, skillMode = null, includeSourceValues = false, primaryDigest = {}) {
  const files = [], root = target, maxEntries = includeSourceValues ? MAX_LOCAL_PACKAGE_ENTRIES : MAX_ENTRIES,
    maxDepth = includeSourceValues ? MAX_LOCAL_PACKAGE_DEPTH : MAX_DEPTH, reasons = new Set(), rawPaths = new Set(), shownPaths = new Set();
  let visited = 0, bytes = 0, comparedBytes = primaryDigest.status === 'available' ? primaryDigest.bytes : 0,
    partial = false, comparisonPartial = false, contentPartial = false;
  if (primaryDigest.status === 'changed') reasons.add('source-changed-during-read');
  function incomplete(reason) { partial = true; comparisonPartial = true; contentPartial = true; reasons.add(reason); }
  function packagePath(rel) {
    const safe = includeSourceValues ? rel : clean(rel, 'name');
    if (rawPaths.has(rel)) incomplete('duplicate-relative-path');
    rawPaths.add(rel);
    if (!shownPaths.has(safe)) { shownPaths.add(safe); return safe; }
    incomplete('display-path-collision');
    return `${safe}~${hash(rel)}`;
  }
  async function walk(directory, depth) {
    if (depth > maxDepth) { incomplete('depth-limit'); return; }
    const scan = await safeNames(directory, maxEntries, includeSourceValues);
    if (!scan.entries) { incomplete(`directory-${scan.status ?? 'unavailable'}`); return; }
    if (scan.partial) incomplete('directory-entry-limit');
    for (const entry of scan.entries) {
      if (visited++ >= maxEntries) { incomplete('entry-limit'); break; }
      const absolute = join(directory, entry.name), rel = relative(root, absolute).split(sep).join('/');
      const checked = await inspectPath(absolute);
      if (checked.status === 'directory' && checked.real === absolute) { await walk(absolute, depth + 1); continue; }
      if (checked.status !== 'file' || checked.real !== absolute) {
        files.push({ path: packagePath(rel), status: checked.status === 'symlink' ? 'unsafe' : checked.status,
          comparison: 'unknown', comparisonReason: checked.status === 'symlink' ? 'unsafe' : checked.status,
          ...(checked.info ? { mode: checked.info.mode & 0o777 } : {}) }); incomplete(checked.status === 'missing' ? 'entry-vanished' : `file-${checked.status}`); continue;
      }
      if (rel === 'SKILL.md') continue; // Use the already-read primary file for a stable comparison snapshot.
      let comparison = { status: 'withheld' };
      if (includeSourceValues) {
        if (checked.info.size > MAX_PACKAGE_FILE_BYTES) comparison.status = 'too-large';
        else if (comparedBytes + checked.info.size > MAX_PACKAGE_BYTES) comparison.status = 'package-budget-exceeded';
        else if (checked.info.size > (detailBudget?.sourceDigestRemaining ?? 0)) comparison.status = 'report-budget-exceeded';
        else {
          comparison = await safeFileDigest(absolute, checked.info);
          if (comparison.status === 'available') { comparedBytes += comparison.bytes; detailBudget.sourceDigestRemaining -= comparison.bytes; }
        }
      }
      let preview = { status: 'partial', text: null, truncated: true }, contentReason = checked.info.size > MAX_FILE ? 'preview-file-limit'
        : bytes >= MAX_DETAIL_BYTES ? 'preview-resource-limit' : detailBudget?.remaining <= 0 ? 'report-detail-budget-exceeded' : 'unreadable-or-unsafe';
      let body = null;
      if (checked.info.size <= MAX_FILE && bytes < MAX_DETAIL_BYTES && detailBudget?.remaining > 0) {
        const bodyRead = await safeText(absolute, { withDigest: includeSourceValues });
        body = includeSourceValues ? bodyRead?.text ?? null : bodyRead;
        if (body !== null && comparison.status === 'available' && bodyRead?.digest !== comparison.digest) {
          if (detailBudget?.sourceDigestRemaining !== undefined) detailBudget.sourceDigestRemaining += comparison.bytes;
          comparedBytes -= comparison.bytes;
          comparison = { status: 'changed' }; body = null; contentReason = 'source-changed-during-read';
        }
        if (body !== null) {
          preview = boundedRedactedText(body, absolute, detailBudget); bytes += Buffer.byteLength(preview.text ?? '');
          contentReason = preview.truncated ? 'preview-truncated' : preview.status !== 'available' ? 'redacted' : undefined;
        }
      }
      const visibleTextComparable = !includeSourceValues && body !== null && preview.redacted === false;
      if (comparison.status !== 'available' && !visibleTextComparable) comparisonPartial = true;
      files.push({ path: packagePath(rel), status: preview.status,
        ...(comparison.status === 'available' ? { digest: comparison.digest, comparison: 'available', comparisonBasis: 'full-bytes' }
          : visibleTextComparable ? { fingerprint: hash(body), comparison: 'available', comparisonBasis: 'public-safe-text' }
            : { comparison: 'unknown', comparisonReason: includeSourceValues ? comparison.status : 'source-values-not-included' }),
        ...(preview.text !== null ? { content: preview.text } : {}), bytes: checked.info.size, mode: checked.info.mode & 0o777,
        ...(contentReason ? { contentReason } : {}),
        ...(preview.truncated ? { truncated: true } : {}) });
      if (preview.status !== 'available') contentPartial = true;
    }
  }
  // The package's primary instruction file is read once above so its displayed
  // content and fingerprint describe the same bounded read.
  if (skillBody !== null || Number.isFinite(primaryDigest.bytes)) {
    let safe = skillBody === null ? { status: 'partial', text: null, truncated: true } : primaryDetail ?? boundedRedactedText(skillBody, join(alias, 'SKILL.md'));
    if (includeSourceValues && skillBody !== null && primaryDigest.status === 'available'
      && createHash('sha256').update(skillBody).digest('hex') !== primaryDigest.digest) {
      if (detailBudget?.sourceDigestRemaining !== undefined) detailBudget.sourceDigestRemaining += primaryDigest.bytes;
      primaryDigest = { status: 'changed', bytes: primaryDigest.bytes, mode: skillMode };
      comparedBytes -= primaryDigest.bytes; skillBody = null; safe = { status: 'partial', text: null, truncated: true, redacted: true };
      reasons.add('source-changed-during-read');
    }
    const primaryBytes = skillBody === null ? primaryDigest.bytes : Buffer.byteLength(skillBody);
    const primaryComparisonReason = includeSourceValues ? primaryDigest.status : 'source-values-not-included';
    const contentReason = skillBody === null ? primaryBytes > MAX_FILE ? 'preview-file-limit' : 'unreadable-or-unsafe'
      : safe.truncated ? 'preview-truncated' : safe.redacted ? 'redacted' : undefined;
    const primaryVisibleTextComparable = !includeSourceValues && skillBody !== null && safe.redacted === false;
    if (primaryDigest.status !== 'available' && !primaryVisibleTextComparable) comparisonPartial = true;
    files.push({ path: packagePath('SKILL.md'), status: safe.status, ...(includeSourceValues && primaryDigest.status === 'available'
      ? { digest: primaryDigest.digest, comparison: 'available', comparisonBasis: 'full-bytes' }
        : primaryVisibleTextComparable ? { fingerprint: hash(skillBody), comparison: 'available', comparisonBasis: 'public-safe-text' }
        : { comparison: 'unknown', comparisonReason: primaryComparisonReason }),
      ...(safe.text !== null ? { content: safe.text } : {}), bytes: primaryBytes, ...(Number.isFinite(skillMode) ? { mode: skillMode } : {}),
      ...(contentReason ? { contentReason } : {}), ...(safe.truncated ? { truncated: true } : {}) });
    bytes += primaryBytes;
    if (safe.status !== 'available') contentPartial = true;
  }
  // Symlink aliases are followed only after the existing boundary check.
  if (!inside(boundary, root)) { incomplete('unsafe-package-root'); }
  else await walk(root, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const unique = [...new Map(files.map(file => [file.path, file])).values()];
  const packageFingerprint = includeSourceValues && !comparisonPartial
    ? createHash('sha256').update(unique.map(file => `${file.path}\0${file.comparisonBasis}\0${file.digest ?? file.fingerprint}\0${file.bytes}\0${file.mode}`).join('\n')).digest('hex') : undefined;
  partial = partial || comparisonPartial || contentPartial;
  return { status: partial ? 'partial' : 'available', files: unique, coverage: { files: unique.length,
    comparison: comparisonPartial ? 'partial' : 'complete', content: contentPartial ? 'partial' : 'complete', comparedBytes,
    ...(reasons.size ? { reasons: [...reasons].sort() } : {}), truncated: partial },
    ...(packageFingerprint ? { fingerprint: packageFingerprint } : {}) };
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
async function discoverHome(home, scope, origin, resources, coverage, { includeSettings = true, includeSourceValues = false, skillBoundary = home, detailBudget, inventory, inventoryRoot = scope } = {}) {
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
        const configValueIncluded = includeLocalSourceValue(config, includeSourceValues, detailBudget);
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
          ...(configValueIncluded ? { value: localSourceValue(config), valueStatus: 'present' } : includeSourceValues ? { valueStatus: 'omitted' } : {}),
          fingerprint: hash(JSON.stringify(includeSourceValues ? localSourceValue(config) : projection)),
          fingerprintScope: includeSourceValues ? 'local-source-config' : 'public-safe-projection',
          comparison: configValueIncluded ? 'available' : includeSourceValues ? 'unknown' : 'partial',
          note: includeSourceValues ? configValueIncluded ? 'Parsed local configuration source; does not establish effective settings or runtime use.'
            : 'Source value exceeds the local source-value limit; source comparison is incomplete.'
            : 'Digest covers public-safe settings and names only; omitted values remain unknown.', inventoryKey: configKey,
        });
        for (const [key, value] of Object.entries(config)) {
        if (['mcp_servers', 'hooks', 'plugins', 'tools'].includes(key) || MEMORY_TOP_LEVEL.has(key)) continue;
          const sourceIncluded = includeLocalSourceValue(value, includeSourceValues, detailBudget);
          const safeValue = includeSourceValues ? localSourceValue(value) : safeSettingValue(key, value);
          add(resources, 'config', key, scope, origin, configPath, 'present', {
            ...(safeValue !== undefined && (!includeSourceValues || sourceIncluded) ? { value: safeValue, comparison: 'available', valueStatus: 'present' }
              : { comparison: 'unknown', valueStatus: 'omitted', note: includeSourceValues
                ? 'Source value exceeds the local source-value limit.'
                : 'Setting name only; value omitted from the public projection' }),
            inventoryKey: configKey,
          });
          if (key === 'agents' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [agentKey, agentValue] of Object.entries(value)) {
              const qualified = `agents.${agentKey}`, sourceIncluded = includeLocalSourceValue(agentValue, includeSourceValues, detailBudget), publicValue = includeSourceValues ? localSourceValue(agentValue) : safeSettingValue(qualified, agentValue);
              add(resources, 'config', qualified, scope, origin, configPath, 'present', {
                ...(publicValue !== undefined && (!includeSourceValues || sourceIncluded) ? { value: publicValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: includeSourceValues
                    ? 'Source value exceeds the local source-value limit.'
                    : 'Setting name only; value omitted from the public projection' }),
                inventoryKey: configKey,
              });
            }
          }
          if (key === 'features' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [feature, featureValue] of Object.entries(value)) {
              const qualified = `features.${feature}`, sourceIncluded = includeLocalSourceValue(featureValue, includeSourceValues, detailBudget),
                featureValueIncluded = includeLocalSourceValue(featureValue, includeSourceValues, detailBudget),
                publicValue = includeSourceValues ? localSourceValue(featureValue) : safeSettingValue(qualified, featureValue);
              add(resources, 'config', qualified, scope, origin, configPath, 'present', {
                ...(publicValue !== undefined && (!includeSourceValues || sourceIncluded) ? { value: publicValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: includeSourceValues
                    ? 'Source value exceeds the local source-value limit.'
                    : 'Setting name only; value omitted from the public projection' }),
                inventoryKey: configKey,
              });
              add(resources, 'feature', feature, scope, origin, configPath, 'present', {
                ...(includeSourceValues && featureValueIncluded ? { value: publicValue, comparison: 'available', valueStatus: 'present' }
                  : typeof featureValue === 'boolean' && (!includeSourceValues || featureValueIncluded) ? { value: featureValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: includeSourceValues
                    ? 'Source value exceeds the local source-value limit.'
                    : 'Feature setting is present but its value is not in the safe projection.' }),
                note: includeSourceValues && !featureValueIncluded ? 'Source value exceeds the local source-value limit; feature definition comparison is incomplete.'
                  : 'Declared feature setting; does not prove runtime availability or use.',
                inventoryKey: categoryKey('feature'),
              });
            }
          }
        }
        for (const [key, value] of memorySettingEntries(config)) {
          const sourceIncluded = includeLocalSourceValue(value, includeSourceValues, detailBudget), safe = includeSourceValues ? localSourceValue(value) : safeSettingValue(key, value);
          add(resources, 'memory-setting', key, scope, origin, configPath, 'present', {
            ...(safe !== undefined && (!includeSourceValues || sourceIncluded) ? { value: safe, comparison: 'available', valueStatus: 'present' }
              : { comparison: 'unknown', valueStatus: 'omitted', note: includeSourceValues
                ? 'Source value exceeds the local source-value limit.'
                : 'Memory setting name only; value omitted from the public projection' }),
            inventoryKey: categoryKey('memory-setting'),
          });
        }
        for (const key of ['mcp_servers', 'hooks', 'plugins']) {
          const definitions = config[key]; if (definitions === undefined) continue;
          const entries = Array.isArray(definitions) ? definitions.map((v, i) => [String(v?.name ?? v?.id ?? i), v]) : Object.entries(definitions ?? {});
          const category = key === 'mcp_servers' ? 'mcp' : key === 'hooks' ? 'hook' : 'plugin';
          const sourceIncluded = includeLocalSourceValue(definitions, includeSourceValues, detailBudget);
          add(resources, category, key, scope, origin, configPath, 'present', {
            ...(includeSourceValues && sourceIncluded ? { value: localSourceValue(definitions), comparison: 'available', valueStatus: 'present' }
              : { comparison: 'unknown', valueStatus: 'omitted' }),
            note: includeSourceValues ? sourceIncluded ? 'Full parsed local definitions; configuration does not prove activation, availability or use.'
              : 'Source value exceeds the local source-value limit; definition comparison is incomplete.'
              : 'Configuration presence only; details omitted and activation unknown',
            inventoryKey: categoryKey(category),
          });
          for (const [name, definition] of entries) {
            const sourceIncluded = includeLocalSourceValue(definition, includeSourceValues, detailBudget);
            const safe = safeIntegrationValue(category, definition);
            add(resources, category, name, scope, origin, configPath, 'present', {
              ...(category === 'plugin' ? { integrationId: name } : {}),
              ...(includeSourceValues ? sourceIncluded ? { value: localSourceValue(definition) } : {} : safe.value ? { value: safe.value } : {}),
              comparison: includeSourceValues ? sourceIncluded ? 'available' : 'unknown' : safe.status,
              valueStatus: includeSourceValues ? sourceIncluded ? 'present' : 'omitted' : safe.status === 'available' ? 'partial' : 'omitted',
              state: { configured: 'present', installed: 'unknown', enabled: typeof definition?.enabled === 'boolean' ? definition.enabled : 'unknown',
                available: 'unknown', loaded: 'unknown', used: 'unknown' },
              inventoryKey: categoryKey(category),
              note: includeSourceValues && sourceIncluded ? 'Full parsed local definition; configuration does not prove activation, availability or use.'
                : includeSourceValues ? 'Source value exceeds the local source-value limit; definition comparison is incomplete.'
                : safe.omitted?.length ? `Safe fields only; omitted: ${safe.omitted.join(', ')}. Configuration does not prove activation, availability or use.`
                : 'Safe fields only; configuration does not prove activation, availability or use.',
            });
          }
        }
        if (config.tools !== undefined) {
          const definitions = Array.isArray(config.tools) ? config.tools.map((item, index) => [String(item?.name ?? item?.id ?? index), item]) : Object.entries(config.tools ?? {});
          for (const [name, definition] of definitions) {
            const sourceIncluded = includeLocalSourceValue(definition, includeSourceValues, detailBudget);
            const enabled = typeof definition === 'boolean' ? definition : definition && typeof definition === 'object' ? definition.enabled : undefined;
            add(resources, 'tool', name, scope, origin, configPath, 'present', {
              ...(includeSourceValues ? sourceIncluded ? { value: localSourceValue(definition) } : {} : typeof enabled === 'boolean' ? { value: { enabled } } : {}),
              comparison: includeSourceValues ? sourceIncluded ? 'available' : 'unknown' : typeof enabled === 'boolean' ? 'partial' : 'unknown',
              valueStatus: includeSourceValues ? sourceIncluded ? 'present' : 'omitted' : typeof enabled === 'boolean' ? 'partial' : 'omitted',
              state: { configured: 'present', enabled: typeof enabled === 'boolean' ? enabled : 'unknown', available: 'unknown', used: 'unknown' },
              inventoryKey: categoryKey('tool'),
              note: includeSourceValues && sourceIncluded ? 'Full parsed local definition; actual availability and use are not established.'
                : includeSourceValues ? 'Source value exceeds the local source-value limit; definition comparison is incomplete.'
                : 'Configured tool entry only; actual availability and use are not established.',
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
  await discoverSkillRoot(join(home, 'skills'), scope, origin, resources, coverage, undefined, skillBoundary, detailBudget, inventory, `${inventoryRoot}/skills`, includeSourceValues);
  const bundled = join(home, 'skills', '.system');
  await discoverSkillRoot(bundled, 'system', `${origin}:bundled`, resources, coverage, undefined, skillBoundary, detailBudget, inventory, `${inventoryRoot}/skills/.system`, includeSourceValues);
}

async function discoverPlugins(home, resources, coverage, detailBudget, inventory, includeSourceValues = false, inventoryRoot = '$CODEX_HOME') {
  const root = join(home, 'plugins', 'cache');
  let visited = 0, inventoryStatus = 'complete';
  const inventoryNames = [], safePackageRoots = new Map(), pluginInventoryKey = inventoryKeyFor('plugin', 'plugin', 'plugin-cache', `${inventoryRoot}/plugins/cache`);
  async function walk(dir, depth, provider = '') {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) { coverage.plugins = 'partial'; inventoryStatus = 'partial'; return; }
    const scan = await safeNames(dir);
    if (!scan.entries) { if (scan.status !== 'missing') { coverage.plugins = 'partial'; inventoryStatus = 'unavailable'; } return; }
    if (scan.partial) { coverage.plugins = 'partial'; inventoryStatus = 'partial'; }
    for (const ent of scan.entries) {
      if (visited++ >= MAX_ENTRIES) { coverage.plugins = 'partial'; inventoryStatus = 'partial'; break; }
      if (ent.isSymbolicLink()) {
        const path = join(dir, ent.name);
        try {
          const target = await realpath(path), known = safePackageRoots.get(target);
          if (inside(root, target) && known) {
            known.aliasPaths ??= [];
            if (!known.aliasPaths.includes(path)) known.aliasPaths.push(path);
            known.observations.push({ kind: 'alias', status: 'present', source: path, note: 'In-cache symlink to an already inventoried canonical plugin package' });
            continue;
          }
        } catch { /* unresolved aliases remain visible as unsafe */ }
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
          const manifestValueIncluded = includeLocalSourceValue(manifest, includeSourceValues, detailBudget);
          const cachePluginName = basename(dirname(path));
          const inferredId = depth === 2 && provider && cachePluginName && ent.name
            ? `${cachePluginName}@${provider}` : undefined;
          const declaredId = typeof manifest.id === 'string' && manifest.id.trim() && manifest.id.length <= 200
            && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(manifest.id) ? clean(manifest.id, 'id') : undefined;
          const integrationId = declaredId ?? inferredId;
          const id = integrationId ?? clean(ent.name, 'name');
          const version = typeof manifest.version === 'string' ? clean(manifest.version, 'version') : undefined;
          const logicalPath = `${id}/${version ?? 'unknown-version'}`; inventoryNames.push(logicalPath);
          const canonicalPath = await realpath(path);
          const pluginResource = add(resources, 'plugin', typeof manifest.name === 'string' ? clean(manifest.name, 'name') : ent.name, 'plugin', 'native-cache', path, 'present', {
            ...(manifestValueIncluded ? { value: localSourceValue(manifest), valueStatus: 'present' } : includeSourceValues ? { valueStatus: 'omitted' } : {}),
            ...(includeSourceValues ? { comparison: manifestValueIncluded ? 'available' : 'unknown' } : {}),
            canonicalPath, provider: provider || undefined, ...(integrationId ? { integrationId } : {}), ...(version ? { version } : {}),
            sourceRole: 'plugin-cache', inventoryKey: pluginInventoryKey, logicalPath,
            state: { cached: 'present', installed: 'unknown', enabled: 'unknown', available: 'unknown', loaded: 'unknown', used: 'unknown' },
            note: includeSourceValues ? manifestValueIncluded
              ? 'Full parsed local manifest; package contents, installation and activation are unknown.'
              : 'Source manifest exceeds the local source-value limit; package contents, installation and activation are unknown.'
              : 'Cached plugin metadata; installation and activation are unknown',
          });
          safePackageRoots.set(canonicalPath, pluginResource);
          const skills = join(path, 'skills');
          await discoverSkillRoot(skills, 'plugin', `plugin:${id}`, resources, coverage, id, path, detailBudget, inventory,
            `${inventoryRoot}/plugins/${id}/${version ?? 'unknown-version'}/skills`, includeSourceValues);
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
export async function discoverAuditProfile(store, name, { repo, client = 'cli', defaultUserHome = homedir(), adminRoots = ['/etc/codex/skills'], includeSourceValues = false } = {}) {
  if (typeof includeSourceValues !== 'boolean') throw new Error('includeSourceValues must be a boolean');
  const profile = await resolveAuditProfile(store, name, { defaultUserHome, client });
  const detailBudget = { remaining: MAX_REPORT_DETAIL_BYTES,
    ...(includeSourceValues ? { sourceValuesRemaining: MAX_REPORT_DETAIL_BYTES, sourceValuesComplete: true, sourceDigestRemaining: MAX_SOURCE_DIGEST_BYTES } : {}) };
  const resources = [], inventory = [], warnings = [], coverage = { client: 'partial', config: 'complete', instructions: 'complete', agents: 'complete', skills: 'complete', rules: 'complete', plugins: 'partial', mcp: 'partial', hooks: 'partial', tools: 'unavailable', memorySettings: 'partial', system: 'partial' };
  const addWarning = text => warnings.push(clean(text));
  await discoverHome(profile.home, 'profile', profile.profileName, resources, coverage, { includeSourceValues, skillBoundary: profile.nativeRoot ?? profile.userHome, detailBudget, inventory, inventoryRoot: '$CODEX_HOME' });
  await discoverPlugins(profile.home, resources, coverage, detailBudget, inventory, includeSourceValues);
  const profileUserCodex = join(profile.userHome, '.codex');
  if (resolve(profileUserCodex) !== resolve(profile.home))
    await discoverHome(profileUserCodex, 'user', `${profile.profileName}:user-home`, resources, coverage, { includeSourceValues, detailBudget, inventory, inventoryRoot: '$HOME/.codex' });
  else {
    // Default's user and Codex roots coincide. Retain that logical source role
    // without reading the same files again or duplicating discovered resources.
    for (const entry of [...inventory]) {
      if (entry.scope !== 'profile' || entry.category === 'skill' || !entry.logicalRoot.startsWith('$CODEX_HOME/')) continue;
      const logicalRoot = entry.logicalRoot.replace('$CODEX_HOME/', '$HOME/.codex/');
      const key = recordInventory(inventory, { ...entry, scope: 'user', sourceRole: 'profile-user', logicalRoot });
      inventory.find(item => item.key === key).aliasOf = entry.key;
    }
  }
  // The actual machine user tree is relevant for Default and Desktop, and may
  // be separately relevant to CLI profiles. It is always identified distinctly.
  const actualUser = resolve(defaultUserHome);
  if (actualUser !== profile.userHome) await discoverHome(join(actualUser, '.codex'), 'user', 'machine-user', resources, coverage, { includeSourceValues, detailBudget, inventory, inventoryRoot: '$MACHINE_HOME/.codex' });
  for (const base of new Set([profile.userHome, actualUser])) {
    const machine = base === actualUser;
    await discoverSkillRoot(join(base, '.agents', 'skills'), 'user', machine ? 'machine-user:.agents' : 'profile-user:.agents', resources, coverage, undefined, base,
      detailBudget, inventory, `${machine ? '$MACHINE_HOME' : '$HOME'}/.agents/skills`, includeSourceValues);
  }
  if (repo !== undefined) {
    if (typeof repo !== 'string' || !repo.startsWith('/') || resolve(repo) !== repo) throw new Error('Repository path must be absolute and normalized');
    const checked = await inspectPath(repo); if (checked.status !== 'directory') throw new Error(`Repository path is missing or unsafe: ${repo}`);
    let current = checked.real;
    const ancestors = [];
    while (true) { ancestors.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
    for (const root of ancestors.reverse()) {
      await discoverHome(join(root, '.codex'), 'project', root, resources, coverage, { includeSourceValues, detailBudget, inventory, inventoryRoot: `project:${root}` });
      await discoverSkillRoot(join(root, '.agents', 'skills'), 'project', root, resources, coverage, undefined, root, detailBudget, inventory, `project:${root}/.agents/skills`, includeSourceValues);
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
    await discoverSkillRoot(root, 'admin', 'administrator', resources, coverage, undefined, dirname(root), detailBudget, inventory, `admin:${root}`, includeSourceValues);
  }
  for (const resource of resources) resource.clientApplicability = {
    client, status: 'unknown', reason: 'Static discovery does not establish that this source applies to the selected client.'
  };
  // Native bundled discovery varies by client/version. Native home metadata is
  // included above; do not claim that it proves runtime activation.
  addWarning(`${client} setup inventory is a current filesystem/configuration snapshot; it does not prove historical loading or use.`);
  addWarning(`${includeSourceValues ? 'Memory setting values reflect locally parsed configuration only; ' : 'Memory setting values are shown only for recognized safe config keys; '}memory documents and generated memory contents are not read. Effective memory behavior may remain unknown.`);
  addWarning('Static configuration does not establish the runtime available-tool list; configured tools and integration definitions are only partial evidence.');
  if (includeSourceValues && !detailBudget.sourceValuesComplete) {
    coverage.sourceValues = 'partial';
    addWarning('Some locally parsed configuration values exceeded the local source-value limit and are omitted.');
  } else if (includeSourceValues) coverage.sourceValues = 'complete';
  if (detailBudget.remaining === 0) addWarning('The aggregate text preview limit was reached; remaining resource previews are partial.');
  if (client === 'desktop') addWarning('Desktop-specific discovery locations and activation metadata are version-dependent; unavailable sources remain partial.');
  return { schemaVersion: 1, kind: 'audit-profile', status: Object.values(coverage).some(value => value !== 'complete') ? 'partial' : 'present', profile, context: { client, ...(includeSourceValues ? { includeSourceValues: true } : {}), ...(repo ? { repo: resolve(repo) } : {}) }, resources, inventory, coverage, warnings };
}
