// Static, read-only Claude Code/Copilot setup. Credential and application-state
// stores are deliberately excluded, even when they also hold setup metadata.
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { redactValue } from './redact.js';

const MAX_ENTRIES = 256, MAX_DEPTH = 5;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const coverageKey = { instruction: 'instructions', agent: 'agents', rule: 'rules', skill: 'skills', plugin: 'plugins', config: 'config', hook: 'hooks', mcp: 'mcp' };
const safeSettings = new Set(['model', 'effortLevel', 'reasoningEffort', 'theme', 'autoUpdate', 'autoUpdatesChannel',
  'disableAllHooks', 'askUser', 'stream', 'autoTier', 'banner', 'beep']);

// JSONC settings support comments and trailing commas without changing strings.
function parseSettings(text) {
  let output = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      output += char;
      if (char === '\\') output += text[++i] ?? '';
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; output += char; }
    else if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; output += '\n'; }
    else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment');
      i = end + 1; output += ' ';
    } else output += char;
  }
  let result = ''; quoted = false;
  for (let i = 0; i < output.length; i++) {
    const char = output[i];
    if (quoted) {
      result += char;
      if (char === '\\') result += output[++i] ?? '';
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; result += char; }
    else if (char !== ',' || !/^\s*[}\]]/.test(output.slice(i + 1))) result += char;
  }
  const value = JSON.parse(result);
  if (!object(value)) throw new Error('Expected settings object');
  return value;
}

export async function discoverClientSetup(profile, { repo, client = 'cli', includeSourceValues = false }, helpers) {
  const { add, safeText, safeNames, inspectPath, fileResource, discoverSkillRoot, recordInventory,
    sourceRoleFor, safeIntegrationValue, hash, clean } = helpers;
  const claude = profile.clientId === 'claude-code';
  const resources = [], inventory = [], warnings = [];
  const coverage = { client: 'partial', config: 'complete', instructions: 'complete', skills: 'complete', agents: 'complete',
    rules: 'complete', hooks: 'complete', mcp: 'partial', plugins: 'partial', system: 'partial', tools: 'unavailable' };
  const installed = new Map();
  const detailBudget = { remaining: 4 * 1024 * 1024, sourceValuesRemaining: 4 * 1024 * 1024,
    sourceValuesComplete: true, sourceDigestRemaining: 512 * 1024 * 1024 };
  let entries = 0;
  const partial = category => { coverage[coverageKey[category]] = 'partial'; };
  const role = (category, scope, origin, provider) => sourceRoleFor(category, scope, origin, provider);
  function sourceInventory(category, scope, origin, logicalRoot, status, names = [], provider) {
    return recordInventory(inventory, { category, scope, sourceRole: role(category, scope, origin, provider), logicalRoot, status, names });
  }
  async function json(path, category, scope, origin, logical, provider) {
    const body = await safeText(path);
    if (body !== null) {
      try { return { value: parseSettings(body), status: 'complete' }; } catch { /* malformed stays unknown */ }
    }
    const inspected = await inspectPath(path);
    const status = inspected.status === 'missing' ? 'missing' : body === null ? 'unreadable' : 'unsupported';
    const key = sourceInventory(category, scope, origin, logical, status === 'missing' ? 'complete' : 'unavailable', [], provider);
    if (status !== 'missing') {
      partial(category);
      add(resources, category, clean(path.split('/').at(-1)), scope, origin, path, status,
        { inventoryKey: key, ...(provider ? { provider } : {}), comparison: 'unknown' });
    }
    return { value: null, status: status === 'missing' ? 'complete' : 'unavailable' };
  }
  async function text(path, category, scope, origin, logical, provider) {
    const key = sourceInventory(category, scope, origin, logical, 'complete', [path.split('/').at(-1)], provider);
    const before = resources.length;
    const body = category === 'agent' ? await safeText(path) : null;
    if (body !== null && /^---[\s\S]*?\n(?:mcp-servers|mcpServers|hooks):/m.test(body)) {
      const close = body.indexOf('\n---', 3);
      add(resources, category, path.split('/').at(-1), scope, origin, path, 'present', {
        inventoryKey: key, ...(provider ? { provider, sourceRole: `plugin:${provider}` } : {}),
        detail: { status: 'partial', text: null }, valueStatus: 'omitted', comparison: 'unknown',
        note: close >= 0 ? 'Agent includes integration frontmatter; source preview withheld to protect inline secrets.' : 'Unterminated agent integration frontmatter; preview withheld.' });
      partial(category); inventory.find(item => item.key === key).status = 'partial'; return;
    }
    const status = await fileResource(resources, category, path.split('/').at(-1), scope, origin, path,
      { fingerprint: true, includeContent: true, detailBudget, inventoryKey: key });
    if (provider) for (const item of resources.slice(before)) { item.provider = provider; item.sourceRole = `plugin:${provider}`; }
    if (!['present', 'missing'].includes(status)) { partial(category); inventory.find(item => item.key === key).status = 'partial'; }
  }
  async function directory(path, category, suffix, scope, origin, logical, provider, depth = 0) {
    const scan = await safeNames(path);
    const status = scan.entries ? scan.partial ? 'partial' : 'complete' : scan.status === 'missing' ? 'complete' : 'unavailable';
    const key = sourceInventory(category, scope, origin, logical, status,
      scan.entries?.filter(item => item.name.endsWith(suffix)).map(item => item.name) ?? [], provider);
    if (status !== 'complete') partial(category);
    for (const entry of scan.entries ?? []) {
      if (entries++ >= MAX_ENTRIES || depth >= MAX_DEPTH) { partial(category); inventory.find(item => item.key === key).status = 'partial'; break; }
      const next = join(path, entry.name);
      if (entry.isDirectory()) await directory(next, category, suffix, scope, origin, `${logical}/${entry.name}`, provider, depth + 1);
      else if (entry.name.endsWith(suffix)) {
        if (category === 'hook') await definitions(next, 'hook', scope, origin, `${logical}/${entry.name}`, provider);
        else await text(next, category, scope, origin, `${logical}/${entry.name}`, provider);
      } else if (entry.isSymbolicLink()) { partial(category); inventory.find(item => item.key === key).status = 'partial'; }
    }
  }
  function integrations(value, category, path, scope, origin, logical, provider) {
    if (!object(value)) { partial(category); sourceInventory(category, scope, origin, logical, 'partial', [], provider); return; }
    const names = Object.keys(value), key = sourceInventory(category, scope, origin, logical,
      names.length > MAX_ENTRIES ? 'partial' : 'complete', names.slice(0, MAX_ENTRIES), provider);
    if (names.length > MAX_ENTRIES) partial(category);
    for (const name of names.slice(0, MAX_ENTRIES)) {
      const definition = value[name];
      // Never include commands, arguments, env, URLs or headers: these can hold
      // arbitrary unrecognizable secrets, even inside otherwise safe JSON.
      const safe = category === 'plugin' && typeof definition === 'boolean'
        ? { value: { enabled: definition }, status: 'available' } : safeIntegrationValue(category, definition);
      const enabled = category === 'plugin' && typeof definition === 'boolean' ? definition
        : typeof definition?.enabled === 'boolean' ? definition.enabled : 'unknown';
      if (safe.value) delete safe.value.command;
      const projected = { ...(safe.value ?? {}), ...(Array.isArray(definition) ? { definitions: definition.length } : {}) };
      const state = { configured: 'present', installed: 'unknown', enabled, available: 'unknown', loaded: 'unknown', used: 'unknown' };
      add(resources, category, name, scope, origin, path, 'present', {
        inventoryKey: key, ...(provider ? { provider, sourceRole: `plugin:${provider}` } : {}),
        ...(category === 'plugin' ? { integrationId: name } : {}), value: projected, valueStatus: 'partial', comparison: 'partial', state,
        note: 'Safe definition fields only; commands, arguments, environment and endpoint values omitted. Activation is unknown.' });
    }
  }
  async function definitions(path, category, scope, origin, logical, provider) {
    const { value } = await json(path, category, scope, origin, logical, provider);
    if (value) integrations(category === 'mcp' ? value.mcpServers ?? value.servers ?? value : value.hooks ?? value,
      category, path, scope, origin, logical, provider);
  }
  async function settings(path, scope, origin, logical, sharedOnly = false) {
    const { value } = await json(path, 'config', scope, origin, logical);
    if (!value) return;
    const projected = Object.create(null);
    if (!sharedOnly) for (const key of safeSettings) {
      const raw = value[key];
      if (typeof raw === 'boolean' || (typeof raw === 'string' && raw.length <= 128 && /^[A-Za-z0-9._+-]+$/.test(raw)))
        projected[key] = redactValue(raw, key);
    }
    const key = sourceInventory('config', scope, origin, logical, 'complete', ['settings']);
    const complete = !sharedOnly && isDeepStrictEqual(value, projected);
    add(resources, 'config', path.split('/').at(-1), scope, origin, path, 'present', {
      value: projected, valueStatus: complete ? 'present' : 'partial', comparison: complete ? 'available' : 'partial', inventoryKey: key,
      ...(complete ? { fingerprint: hash(JSON.stringify(projected)), fingerprintScope: 'safe-settings' } : {}),
      note: 'Recognized safe settings only; effective precedence and omitted values are unknown.' });
    for (const [field, category] of [['hooks', 'hook'], ['mcpServers', 'mcp'], ['enabledPlugins', 'plugin']]) {
      if (value[field] !== undefined) integrations(value[field], category, path, scope, origin, `${logical}/${field}`);
      else sourceInventory(category, scope, origin, `${logical}/${field}`, 'complete');
    }
  }
  async function skills(path, scope, origin, logical, provider) {
    await discoverSkillRoot(path, scope, origin, resources, coverage, provider, dirname(path), detailBudget, inventory, logical, includeSourceValues);
  }
  const homeLogical = claude ? '$CLAUDE_CONFIG_DIR' : '$COPILOT_HOME';
  const homeScope = profile.rootMode === 'implicit' || !profile.nativeRoot ? 'user' : 'profile';
  const homeOrigin = homeScope === 'user' ? 'user-home' : 'profile-home';
  await settings(join(profile.home, 'settings.json'), homeScope, homeOrigin, `${homeLogical}/settings.json`);
  await text(join(profile.home, claude ? 'CLAUDE.md' : 'copilot-instructions.md'), 'instruction', homeScope, homeOrigin, `${homeLogical}/instructions`);
  await skills(join(profile.home, 'skills'), homeScope, homeOrigin, `${homeLogical}/skills`);
  await directory(join(profile.home, 'agents'), 'agent', '.md', homeScope, homeOrigin, `${homeLogical}/agents`);
  await directory(join(profile.home, claude ? 'rules' : 'instructions'), 'rule', '.md', homeScope, homeOrigin, `${homeLogical}/rules`);
  if (!claude) {
    await definitions(join(profile.home, 'mcp-config.json'), 'mcp', homeScope, homeOrigin, `${homeLogical}/mcp-config.json`);
    await directory(join(profile.home, 'hooks'), 'hook', '.json', homeScope, homeOrigin, `${homeLogical}/hooks`);
  }
  if (repo !== undefined) {
    if (typeof repo !== 'string' || !isAbsolute(repo) || resolve(repo) !== repo) throw new Error('Repository path must be absolute and normalized');
    const checked = await inspectPath(repo);
    if (checked.status !== 'directory' || checked.real !== repo) throw new Error('Repository path is missing or unsafe');
    let current = repo;
    do {
      if (claude) {
        await text(join(current, 'CLAUDE.md'), 'instruction', 'project', 'project-root', `project:${current}/CLAUDE.md`);
        await text(join(current, 'CLAUDE.local.md'), 'instruction', 'project', 'project-root', `project:${current}/CLAUDE.local.md`);
        await text(join(current, '.claude', 'CLAUDE.md'), 'instruction', 'project', 'project-root', `project:${current}/.claude/CLAUDE.md`);
      } else await text(join(current, 'AGENTS.md'), 'instruction', 'project', 'project-root', `project:${current}/AGENTS.md`);
      const parent = dirname(current); if (parent === current) break; current = parent;
    } while (true);
    const root = join(repo, claude ? '.claude' : '.github');
    const logical = `project:${repo}/${claude ? '.claude' : '.github'}`;
    await settings(join(root, ...(claude ? [] : ['copilot']), 'settings.json'), 'project', 'project-shared', `${logical}/settings.json`);
    await settings(join(root, ...(claude ? [] : ['copilot']), 'settings.local.json'), 'project', 'project-local', `${logical}/settings.local.json`);
    await skills(join(root, 'skills'), 'project', 'project-root', `${logical}/skills`);
    await directory(join(root, 'agents'), 'agent', '.md', 'project', 'project-root', `${logical}/agents`);
    await directory(join(root, claude ? 'rules' : 'instructions'), 'rule', '.md', 'project', 'project-root', `${logical}/rules`);
    await definitions(join(repo, claude ? '.mcp.json' : '.github/mcp.json'), 'mcp', 'project', 'project-root', `${logical}/mcp`);
    if (!claude) {
      await text(join(root, 'copilot-instructions.md'), 'instruction', 'project', 'project-root', `${logical}/copilot-instructions.md`);
      await skills(join(repo, '.agents', 'skills'), 'project', 'project-root', `project:${repo}/.agents/skills`);
      await directory(join(root, 'hooks'), 'hook', '.json', 'project', 'project-root', `${logical}/hooks`);
      for (const file of ['settings.json', 'settings.local.json'])
        await settings(join(repo, '.claude', file), 'project', 'cross-tool-shared', `project:${repo}/.claude/${file}`, true);
    }
  } else coverage.project = 'unavailable';

  if (claude) {
    const path = join(profile.home, 'plugins', 'installed_plugins.json');
    const { value } = await json(path, 'plugin', homeScope, homeOrigin, `${homeLogical}/plugins/installed_plugins.json`);
    if (value) {
      if (value.version !== 2 || !object(value.plugins)) coverage.plugins = 'partial';
      else for (const [id, registrations] of Object.entries(value.plugins).slice(0, MAX_ENTRIES)) {
        if (!Array.isArray(registrations)) continue;
        for (const registration of registrations.slice(0, MAX_ENTRIES)) {
          if (!object(registration) || typeof registration.installPath !== 'string') continue;
          const path = registration.installPath, rel = relative(join(profile.home, 'plugins', 'cache'), path);
          if (!isAbsolute(path) || resolve(path) !== path || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
          if (!['managed', 'user', 'project', 'local'].includes(registration.scope)) continue;
          if (['project', 'local'].includes(registration.scope) && registration.projectPath !== repo) continue;
          const existing = installed.get(path);
          installed.set(path, installed.has(path) && existing?.id !== id ? null
            : { id, scopes: [...new Set([...(existing?.scopes ?? []), registration.scope])] });
        }
      }
    }
  }

  // Scan only package metadata/components in the native cache, never plugin-data,
  // authentication files, generated memory, sessions, logs, or the whole home.
  async function plugins(path, logical, depth = 0) {
    const scan = await safeNames(path);
    if (!scan.entries) return;
    if (scan.partial) partial('plugin');
    for (const entry of scan.entries) {
      if (entries++ >= MAX_ENTRIES || depth >= MAX_DEPTH) { partial('plugin'); break; }
      if (!entry.isDirectory()) { if (entry.isSymbolicLink()) partial('plugin'); continue; }
      const packageRoot = join(path, entry.name);
      let manifest, manifestPath;
      for (const file of claude ? ['.claude-plugin/plugin.json'] : ['plugin.json', '.github/plugin/plugin.json', '.claude-plugin/plugin.json']) {
        const body = await safeText(join(packageRoot, file));
        if (body !== null) {
          manifestPath = join(packageRoot, file);
          try { manifest = parseSettings(body); } catch { partial('plugin'); }
          break;
        }
      }
      if (!manifest) { await plugins(packageRoot, `${logical}/${entry.name}`, depth + 1); continue; }
      const registration = installed.get(packageRoot);
      const provider = registration ? clean(registration.id, 'name') : clean(`${relative(profile.home, packageRoot).split(sep).slice(claude ? 2 : 1).join('/')}`, 'name');
      const metadata = Object.fromEntries(['name', 'version'].filter(key => typeof manifest[key] === 'string').map(key => [key, clean(manifest[key], key)]));
      const key = sourceInventory('plugin', 'plugin', 'native-package', logical, 'partial', [entry.name], provider);
      add(resources, 'plugin', metadata.name ?? entry.name, 'plugin', 'native-package', packageRoot, 'present', {
        provider, sourceRole: `plugin:${provider}`, value: { ...metadata, ...(registration ? { installationScopes: registration.scopes } : {}) }, valueStatus: 'partial', comparison: 'partial', inventoryKey: key,
        ...(metadata.version ? { version: metadata.version } : {}), ...(registration ? { integrationId: registration.id } : {}),
        state: { cached: 'present', installed: registration ? 'present' : 'unknown', configured: 'unknown', enabled: 'unknown', available: 'unknown', loaded: 'unknown', used: 'unknown' },
        note: registration ? 'Package files and matching scoped installation registration observed; enablement and loading remain unknown.'
          : 'Package files observed; cache presence does not prove installation, enablement or loading.' });
      const portable = !claude && /^https:\/\/agent-plugins.org\/schemas\//.test(manifest.$schema ?? '');
      const componentRoot = portable ? join(packageRoot, 'com.github.copilot') : packageRoot;
      const seen = new Set();
      async function component(path, category, logicalPath) {
        const identity = `${category}:${path}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        if (category === 'skill') await skills(path, 'plugin', `plugin:${provider}`, logicalPath, provider);
        else if (['agent', 'rule', 'instruction'].includes(category)) {
          const checked = await inspectPath(path);
          if (checked.status === 'file') await text(path, category, 'plugin', `plugin:${provider}`, logicalPath, provider);
          else await directory(path, category, '.md', 'plugin', `plugin:${provider}`, logicalPath, provider);
        } else await definitions(path, category, 'plugin', `plugin:${provider}`, logicalPath, provider);
      }
      for (const [field, category] of [['skills', 'skill'], ['agents', 'agent'], ['rules', 'rule'], ['commands', 'instruction'], ['hooks', 'hook'], ['mcpServers', 'mcp']]) {
        const defaults = field === 'hooks' ? ['hooks.json', 'hooks/hooks.json']
          : field === 'mcpServers' ? portable ? ['mcp.json'] : ['.mcp.json', '.github/mcp.json']
            : [field];
        for (const file of defaults) await component(join(field === 'skills' || field === 'mcpServers' ? packageRoot : componentRoot, file), category, `${logical}/${entry.name}/${file}`);
        if (object(manifest[field])) {
          if (category === 'hook' || category === 'mcp') integrations(manifest[field], category, manifestPath, 'plugin', `plugin:${provider}`, `${logical}/${entry.name}/${field}`, provider);
          else { partial(category); warnings.push('Unsupported plugin component declaration; discovery remains partial.'); }
        } else if (!portable && manifest[field] !== undefined) {
          const paths = Array.isArray(manifest[field]) ? manifest[field] : [manifest[field]];
          if (paths.length > MAX_ENTRIES) partial(category);
          for (const file of paths.slice(0, MAX_ENTRIES)) {
            if (typeof file !== 'string' || isAbsolute(file) || file.includes('\0')) { partial(category); continue; }
            const path = resolve(packageRoot, file), rel = relative(packageRoot, path);
            if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
              || rel.split(sep).some(part => /^(?:\.credentials(?:\.json)?|auth\.json|config\.json|\.claude\.json|mcp-secrets|mcp-oauth-config|session-state|plugin-data)$/i.test(part))) {
              partial(category); warnings.push('Unsafe plugin component path was not read.'); continue;
            }
            await component(path, category, `${logical}/${entry.name}/${rel}`);
          }
        }
      }
    }
  }
  await plugins(join(profile.home, ...(claude ? ['plugins', 'cache'] : ['installed-plugins'])), `${homeLogical}/plugins`);
  for (const resource of resources) resource.clientApplicability = { client, clientId: profile.clientId, status: 'unknown',
    reason: 'Static source discovery does not establish native loading or use.' };
  warnings.push('Static setup discovery does not resolve effective precedence, policy, bundled resources, native loading or use.');
  warnings.push(claude ? 'Account-bearing .claude.json and credential stores are not read; user/local MCP discovery remains partial.'
    : 'Authentication-bearing config.json and credential stores are not read; legacy settings and installed plugin registrations remain unknown.');
  if (client === 'desktop') warnings.push('Desktop-specific sources are not qualified; this snapshot covers CLI setup locations only.');
  if (includeSourceValues && !detailBudget.sourceValuesComplete) coverage.sourceValues = 'partial';
  return { schemaVersion: 1, kind: 'audit-profile', status: 'partial', profile,
    context: { client, clientId: profile.clientId, ...(includeSourceValues ? { includeSourceValues: true } : {}), ...(repo ? { repo } : {}) },
    resources, inventory, coverage, warnings: [...new Set(warnings)] };
}
