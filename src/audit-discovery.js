// Read-only, copy-independent discovery for audit reports. Resource contents are
// never returned: only bounded metadata, names, and content fingerprints are.
import { lstat, realpath, opendir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';
import { find } from './profiles.js';
import { redactValue } from './redact.js';

const MAX_ENTRIES = 256, MAX_DEPTH = 5, MAX_FILE = 512 * 1024;
const PUBLIC_STRING_SETTINGS = new Set(['model', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'model_verbosity', 'personality',
  'service_tier', 'approval_policy', 'approvals_reviewer', 'sandbox_mode']);
const PUBLIC_NUMBER_SETTINGS = new Set(['model_context_window', 'model_auto_compact_token_limit', 'project_doc_max_bytes']);
const PUBLIC_AGENT_NUMBER_SETTINGS = new Set(['max_threads', 'max_concurrent_threads_per_session', 'max_depth', 'job_max_runtime_seconds']);
const PUBLIC_AGENT_STRING_SETTINGS = new Set(['default_subagent_model', 'default_subagent_reasoning_effort']);
const PUBLIC_ENUMS = {
  model_reasoning_effort: new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  plan_mode_reasoning_effort: new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
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
  if (PUBLIC_STRING_SETTINGS.has(setting) || PUBLIC_AGENT_STRING_SETTINGS.has(setting)) {
    if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:/+-]+$/.test(value)) return undefined;
    if (PUBLIC_ENUMS[setting] && !PUBLIC_ENUMS[setting].has(value)) return undefined;
    return redactValue(value, key);
  }
  if (PUBLIC_NUMBER_SETTINGS.has(setting) || PUBLIC_AGENT_NUMBER_SETTINGS.has(setting))
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000 ? value : undefined;
  if (key === 'features.multi_agent') return typeof value === 'boolean' ? value : undefined;
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
  const sourceRole = extra.sourceRole ?? (scope === 'plugin' ? `plugin:${clean(extra.provider ?? 'unknown')}`
    : scope === 'admin' ? 'administrator-skills' : scope === 'system' ? 'system-skills'
      : category === 'skill' ? `${scope}-skills` : scope === 'project' ? 'project-root'
        : origin.includes('machine-user') ? 'machine-user' : origin.includes('user-home') ? 'profile-user' : `${scope}-home`);
  resources.push({ id: resourceId(category, canonicalPath ?? path, extra.provider ?? '', safeName, scope, origin), category, name: safeName,
    scope, origin: safeOrigin, path, ...(canonicalPath ? { canonicalPath } : {}),
    sourceRole, logicalPath: safeName,
    ...(extra.provider ? { provider: clean(extra.provider) } : {}), ...(extra.version ? { version: clean(extra.version) } : {}),
    status, ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    ...(extra.fingerprintScope ? { fingerprintScope: extra.fingerprintScope } : {}),
    ...(extra.comparison ? { comparison: extra.comparison } : {}),
    ...(extra.valueStatus ? { valueStatus: extra.valueStatus } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {}),
    observations: [{ kind: 'present', status, source: path, ...(extra.note ? { note: clean(extra.note) } : {}) }] });
}
async function discoverSkillRoot(root, scope, origin, resources, coverage, parentPlugin, boundary = dirname(root)) {
  const scan = await safeNames(root);
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
    add(resources, 'skill', ent.name, scope, origin, alias, status, {
      ...(inspected.status === 'symlink' ? { canonicalPath: target } : {}), ...(provider ? { provider } : {}),
      ...(body !== null ? { fingerprint: hash(body) } : {}),
      ...(parentPlugin ? { note: `Plugin skill grouped under ${parentPlugin}` } : {}),
    });
  }
}
async function fileResource(resources, category, name, scope, origin, path, { fingerprint = false, value } = {}) {
  const checked = await inspectPath(path);
  if (checked.status === 'missing') { add(resources, category, name, scope, origin, path, 'missing'); return 'missing'; }
  let digest;
  if (fingerprint && checked.status === 'file') {
    const body = await safeText(path); if (body !== null) digest = hash(body);
  }
  const status = checked.status === 'file' || checked.status === 'directory' ? digest || !fingerprint ? 'present' : 'unreadable' : checked.status === 'symlink' ? 'unsafe' : checked.status;
  add(resources, category, name, scope, origin, path, status, { ...(digest ? { fingerprint: digest } : {}), ...(value !== undefined ? { value } : {}) });
  return status;
}
async function discoverHome(home, scope, origin, resources, coverage, { includeSettings = true, skillBoundary = home } = {}) {
  if (includeSettings) {
    const configPath = join(home, 'config.toml'), body = await safeText(configPath);
    if (body === null) {
      const status = (await inspectPath(configPath)).status === 'missing' ? 'missing' : 'unreadable';
      add(resources, 'config', 'config.toml', scope, origin, configPath, status);
      if (status === 'unreadable') coverage.config = 'partial';
    }
    else {
      let config;
      try { config = parse(body); } catch { add(resources, 'config', 'config.toml', scope, origin, configPath, 'unsupported'); coverage.config = 'partial'; config = null; }
      if (config) {
        const projection = publicConfigProjection(config);
        add(resources, 'config', 'config.toml', scope, origin, configPath, 'present', {
          fingerprint: hash(JSON.stringify(projection)), fingerprintScope: 'public-safe-projection', comparison: 'partial',
          note: 'Digest covers public-safe settings and names only; omitted values remain unknown.',
        });
        if (projection.keys.length > 0) coverage.config = 'partial';
        for (const [key, value] of Object.entries(config)) {
          if (['mcp_servers', 'hooks', 'plugins'].includes(key)) continue;
          const safeValue = safeSettingValue(key, value);
          add(resources, 'config', key, scope, origin, configPath, 'present', {
            ...(safeValue !== undefined ? { value: safeValue, comparison: 'available', valueStatus: 'present' }
              : { comparison: 'unknown', valueStatus: 'omitted', note: 'Setting name only; value omitted from the public projection' }),
          });
          if (key === 'agents' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [agentKey, agentValue] of Object.entries(value)) {
              const qualified = `agents.${agentKey}`, publicValue = safeSettingValue(qualified, agentValue);
              add(resources, 'config', qualified, scope, origin, configPath, 'present', {
                ...(publicValue !== undefined ? { value: publicValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: 'Setting name only; value omitted from the public projection' }),
              });
            }
          }
          if (key === 'features' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [feature, featureValue] of Object.entries(value)) {
              const qualified = `features.${feature}`, publicValue = safeSettingValue(qualified, featureValue);
              add(resources, 'config', qualified, scope, origin, configPath, 'present', {
                ...(publicValue !== undefined ? { value: publicValue, comparison: 'available', valueStatus: 'present' }
                  : { comparison: 'unknown', valueStatus: 'omitted', note: 'Setting name only; value omitted from the public projection' }),
              });
            }
          }
        }
        for (const key of ['mcp_servers', 'hooks', 'plugins']) {
          const definitions = config[key]; if (definitions === undefined) continue;
          const entries = Array.isArray(definitions) ? definitions.map((v, i) => [String(v?.name ?? v?.id ?? i), v]) : Object.entries(definitions ?? {});
          add(resources, key === 'mcp_servers' ? 'mcp' : key === 'hooks' ? 'hook' : 'plugin', key, scope, origin, configPath, 'present', { comparison: 'unknown', valueStatus: 'omitted', note: 'Configuration presence only; details omitted and activation unknown' });
          for (const [name] of entries) add(resources, key === 'mcp_servers' ? 'mcp' : key === 'hooks' ? 'hook' : 'plugin', name, scope, origin, configPath, 'present', { comparison: 'unknown', valueStatus: 'omitted', note: 'Configured name only; definition values omitted' });
        }
      }
    }
    for (const [category, file] of [['instruction', 'AGENTS.md'], ['instruction', 'AGENTS.override.md']]) {
      const status = await fileResource(resources, category, file, scope, origin, join(home, file), { fingerprint: true });
      if (!['present', 'missing'].includes(status)) coverage.instructions = 'partial';
    }
    for (const [category, directory, suffix] of [['agent', 'agents', '.toml'], ['rule', 'rules', '.rules']]) {
      const root = join(home, directory), scan = await safeNames(root);
      if (!scan.entries) { if (scan.status !== 'missing') coverage[category === 'agent' ? 'agents' : 'rules'] = 'partial'; continue; }
      if (scan.partial) coverage[category === 'agent' ? 'agents' : 'rules'] = 'partial';
      for (const entry of scan.entries) if (entry.name.endsWith(suffix)) {
        const status = await fileResource(resources, category, entry.name, scope, origin, join(root, entry.name), { fingerprint: true });
        if (!['present', 'missing'].includes(status))
          coverage[category === 'agent' ? 'agents' : 'rules'] = 'partial';
      }
    }
  }
  await discoverSkillRoot(join(home, 'skills'), scope, origin, resources, coverage, undefined, skillBoundary);
  const bundled = join(home, 'skills', '.system');
  await discoverSkillRoot(bundled, 'system', `${origin}:bundled`, resources, coverage, undefined, skillBoundary);
}

async function discoverPlugins(home, resources, coverage) {
  const root = join(home, 'plugins', 'cache');
  let visited = 0;
  async function walk(dir, depth, provider = '') {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) { coverage.plugins = 'partial'; return; }
    const scan = await safeNames(dir);
    if (!scan.entries) { if (scan.status !== 'missing') coverage.plugins = 'partial'; return; }
    if (scan.partial) coverage.plugins = 'partial';
    for (const ent of scan.entries) {
      if (visited++ >= MAX_ENTRIES) { coverage.plugins = 'partial'; break; }
      if (ent.isSymbolicLink()) {
        const path = join(dir, ent.name);
        add(resources, 'plugin', ent.name, 'plugin', 'native-cache', path, 'unsafe', { note: 'Symbolic link is visible but its target is not followed' });
        coverage.plugins = 'partial';
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
          add(resources, 'plugin', typeof manifest.name === 'string' ? clean(manifest.name, 'name') : ent.name, 'plugin', 'native-cache', path, 'present', {
            canonicalPath: await realpath(path), provider: id, ...(version ? { version } : {}),
            note: 'Cached plugin metadata; installation and activation are unknown',
          });
          const skills = join(path, 'skills');
          await discoverSkillRoot(skills, 'plugin', `plugin:${id}`, resources, coverage, id, path);
        } catch { add(resources, 'plugin', ent.name, 'plugin', 'native-cache', path, 'unsupported', { note: 'Malformed plugin manifest' }); coverage.plugins = 'partial'; }
      } else await walk(path, depth + 1, provider || ent.name);
    }
  }
  await walk(root, 0);
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
  const resources = [], warnings = [], coverage = { client: 'partial', config: 'complete', instructions: 'complete', agents: 'complete', skills: 'complete', rules: 'complete', plugins: 'partial', mcp: 'complete', hooks: 'complete', system: 'partial' };
  const addWarning = text => warnings.push(clean(text));
  await discoverHome(profile.home, 'profile', profile.profileName, resources, coverage, { skillBoundary: profile.nativeRoot ?? profile.userHome });
  await discoverPlugins(profile.home, resources, coverage);
  await discoverHome(join(profile.userHome, '.codex'), 'user', `${profile.profileName}:user-home`, resources, coverage);
  // The actual machine user tree is relevant for Default and Desktop, and may
  // be separately relevant to CLI profiles. It is always identified distinctly.
  const actualUser = resolve(defaultUserHome);
  if (actualUser !== profile.userHome) await discoverHome(join(actualUser, '.codex'), 'user', 'machine-user', resources, coverage);
  for (const base of new Set([profile.userHome, actualUser])) await discoverSkillRoot(join(base, '.agents', 'skills'), 'user', base === actualUser ? 'machine-user:.agents' : 'profile-user:.agents', resources, coverage, undefined, base);
  if (repo !== undefined) {
    if (typeof repo !== 'string' || !repo.startsWith('/') || resolve(repo) !== repo) throw new Error('Repository path must be absolute and normalized');
    const checked = await inspectPath(repo); if (checked.status !== 'directory') throw new Error(`Repository path is missing or unsafe: ${repo}`);
    let current = checked.real;
    const ancestors = [];
    while (true) { ancestors.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
    for (const root of ancestors.reverse()) {
      await discoverHome(join(root, '.codex'), 'project', root, resources, coverage);
      await discoverSkillRoot(join(root, '.agents', 'skills'), 'project', root, resources, coverage, undefined, root);
      for (const file of ['AGENTS.md', 'AGENTS.override.md']) {
        const status = await fileResource(resources, 'instruction', file, 'project', root, join(root, file), { fingerprint: true });
        if (!['present', 'missing'].includes(status)) coverage.instructions = 'partial';
      }
    }
    addWarning('Repository ancestor discovery is limited to root-level instruction and resource directories; nested unrelated repositories are not scanned.');
  } else coverage.project = 'unavailable';
  for (const root of adminRoots) {
    if (typeof root !== 'string' || !root.startsWith('/') || resolve(root) !== root) { addWarning('An invalid administrator discovery root was skipped.'); coverage.system = 'partial'; continue; }
    await discoverSkillRoot(root, 'admin', 'administrator', resources, coverage);
  }
  for (const resource of resources) resource.clientApplicability = {
    client, status: 'unknown', reason: 'Static discovery does not establish that this source applies to the selected client.'
  };
  // Native bundled discovery varies by client/version. Native home metadata is
  // included above; do not claim that it proves runtime activation.
  addWarning(`${client} setup inventory is a current filesystem/configuration snapshot; it does not prove historical loading or use.`);
  if (client === 'desktop') addWarning('Desktop-specific discovery locations and activation metadata are version-dependent; unavailable sources remain partial.');
  return { schemaVersion: 1, kind: 'audit-profile', status: Object.values(coverage).some(value => value !== 'complete') ? 'partial' : 'present', profile, context: { client, ...(repo ? { repo: resolve(repo) } : {}) }, resources, coverage, warnings };
}
