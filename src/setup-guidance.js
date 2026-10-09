// Read-only, deliberately bounded guidance for integrations that Xenoflux does
// not transfer. This inspects active profile definitions and the known personal
// marketplace catalog; plugin caches and runtime/history stores are out of scope.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { find } from './profiles.js';
import { resolveNativeSettingsHome } from './native-copy.js';
import { redactValue } from './redact.js';

const MAX_FILE = 384 * 1024;
const MAX_ITEMS = 256;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

function cleanLabel(value, fallback = 'unknown') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return String(redactValue(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 120) || fallback;
}

async function readSafeText(path) {
  let handle;
  try {
    const parentPath = dirname(path), parent = await lstat(parentPath);
    if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(parentPath) !== parentPath
      || (process.getuid && parent.uid !== process.getuid()) || (parent.mode & 0o022) || (parent.mode & 0o7000)) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE
      || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) || (stat.mode & 0o7000)) return null;
    const bytes = await handle.readFile();
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
  finally { await handle?.close(); }
}

async function readConfig(home) {
  const path = join(home, 'config.toml'), text = await readSafeText(path);
  if (text === null) {
    try { await lstat(path); return { path, config: null, missing: false }; }
    catch (error) { return { path, config: null, missing: error.code === 'ENOENT' }; }
  }
  try { return { path, config: parse(text), missing: false }; }
  catch { return { path, config: null, missing: false }; }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function setupItem(sourceName, { identity, label, scope, origin, path, steps, destinationStatus = 'unknown', ...metadata }) {
  return {
    id: hash([sourceName, scope, origin, path ?? '', identity].join('\0')),
    label: cleanLabel(label), category: 'setup', setup: true, copyable: false,
    scope, origin, ...(path ? { path } : {}), destinationStatus, steps,
    ...metadata,
  };
}

function objectNames(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
}

function boundedNames(value) {
  const names = objectNames(value).sort();
  return { names: names.slice(0, MAX_ITEMS), partial: names.length > MAX_ITEMS };
}

async function localManifestVersion(entry, expectedName) {
  const source = entry?.source;
  if (source?.source !== 'local' || typeof source.path !== 'string' || !source.path.startsWith('/')
    || /[\x00-\x1f\x7f]/.test(source.path) || join(source.path) !== source.path) return undefined;
  try {
    const dir = await lstat(source.path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || await realpath(source.path) !== source.path
      || (process.getuid && dir.uid !== process.getuid()) || (dir.mode & 0o022) || (dir.mode & 0o7000)) return undefined;
  } catch { return undefined; }
  for (const manifestPath of [join(source.path, 'plugin.json'), join(source.path, '.codex-plugin', 'plugin.json')]) {
    const text = await readSafeText(manifestPath);
    if (text === null) continue;
    try {
      const manifest = JSON.parse(text);
      if (manifest?.name === expectedName && typeof manifest.version === 'string'
        && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) return manifest.version;
    } catch { /* The other supported manifest location may still be readable. */ }
  }
  return undefined;
}

async function profileEndpoint(store, profile, defaultUserHome) {
  return resolveNativeSettingsHome(store, profile.name, { defaultUserHome });
}

function resolveProfile(data, value) {
  if (value && typeof value === 'object' && typeof value.name === 'string') return value;
  return String(value).toLowerCase() === 'default' ? { name: 'Default' } : find(data, value);
}

async function personalMarketplace(userHome) {
  const path = join(userHome, '.agents', 'plugins', 'marketplace.json');
  const text = await readSafeText(path);
  if (text === null) return { path, catalog: null, status: 'unknown' };
  try {
    const catalog = JSON.parse(text);
    if (!catalog || typeof catalog !== 'object' || typeof catalog.name !== 'string' || !Array.isArray(catalog.plugins)) {
      return { path, catalog: null, status: 'unknown' };
    }
    return { path, catalog, status: 'present' };
  } catch { return { path, catalog: null, status: 'unknown' }; }
}

function pluginCatalogEntry(catalog, pluginName) {
  if (!catalog) return null;
  const matches = catalog.plugins.filter(entry => entry && typeof entry === 'object' && entry.name === pluginName);
  return matches.length === 1 ? matches[0] : null;
}

function sourceLocator(source) {
  if (!source || typeof source !== 'object') return undefined;
  if (source.source === 'local' && typeof source.path === 'string' && source.path.length <= 512
    && !/[\x00-\x1f\x7f]/.test(source.path)) return cleanLabel(source.path);
  if (source.source === 'npm' && typeof source.package === 'string'
    && /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(source.package)) return source.package;
  if (['url', 'git-subdir'].includes(source.source) && typeof source.url === 'string') {
    try {
      const url = new URL(source.url);
      if (['https:', 'ssh:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
        && source.url.length <= 512 && !/[\x00-\x1f\x7f]/.test(source.url)) return source.url;
    } catch { /* Keep unsafe or unsupported locators unknown. */ }
  }
  return undefined;
}

function hookDefinitions(value) {
  return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
    .filter(([name, definition]) => name !== 'state'
      && (Array.isArray(definition) || (definition && typeof definition === 'object' && Array.isArray(definition.hooks)))));
}

function hookEvents(value) {
  return Object.keys(hookDefinitions(value)).map(cleanLabel).sort().slice(0, MAX_ITEMS);
}

function integrationSteps(kind, name, destinationStatus) {
  if (kind === 'plugin') {
    if (destinationStatus === 'same') return [`The destination has matching configuration for ${name}. Check its installation and availability in the Codex Plugins directory; do not reinstall or change enablement automatically.`, 'Complete any required sign-in or hook-trust review in Codex, then verify the expected capability in a fresh session.'];
    if (destinationStatus === 'different') return [`Review ${name} in the destination Codex Plugins directory, including its marketplace source and enablement. Change it only if wanted; Xenoflux does not install or activate plugins.`, 'Complete any required sign-in or hook-trust review in Codex, then verify the expected capability in a fresh session.'];
    if (destinationStatus === 'missing') return [`If wanted, find ${name} in the Codex Plugins directory and install it only from the intended marketplace. Review enablement separately; Xenoflux does not activate plugins.`, 'Complete any required sign-in or hook-trust review in Codex, then verify the expected capability in a fresh session.'];
    return [`Check ${name} in the destination Codex Plugins directory and confirm its marketplace source. Install only if absent and wanted; review enablement separately.`, 'Complete any required sign-in or hook-trust review in Codex, then verify the expected capability in a fresh session.'];
  }
  if (kind === 'mcp') {
    if (destinationStatus === 'same') return ['The destination has a matching MCP definition. Verify its connection and authentication in Codex settings; no definition change is needed.'];
    if (destinationStatus === 'different') return [`Review the existing MCP entry ${name} in Codex settings. Change it only if the destination should use the source definition; enter credentials and local dependencies separately.`];
    if (destinationStatus === 'missing') return [`If wanted, add MCP entry ${name} through Codex settings. Enter its endpoint or local executable details and any credentials there.`];
    return [`Check whether MCP entry ${name} already exists in Codex settings. Add or update it only after confirming the destination needs a change; enter credentials and local dependencies there.`];
  }
  if (destinationStatus === 'same') return ['The destination has a matching hook definition. Review trust and executable availability in Codex; no definition change is needed.'];
  if (destinationStatus === 'different') return ['Review the destination hook definition in Codex settings. Change it only if wanted, then review its trust and executable dependencies in Codex.'];
  if (destinationStatus === 'missing') return ['If wanted, set up this hook through the supported Codex settings file or interface. Review each command, required files, permissions, and trust before use.'];
  return ['Check the destination hook definitions in Codex settings. Add or update only after confirming a change is needed, then review commands, dependencies, permissions, and trust.'];
}

/**
 * Report conditional, manual-only setup candidates from bounded native metadata.
 * No integration is installed, enabled, authenticated, or modified.
 */
export async function inspectSetupGuidance(store, source, target = null, { defaultUserHome = homedir() } = {}) {
  const data = await store.read();
  const sourceProfile = resolveProfile(data, source);
  const targetProfile = target == null ? null : resolveProfile(data, target);
  const sourceEndpoint = await profileEndpoint(store, sourceProfile, defaultUserHome);
  const sourceHome = sourceEndpoint.home;
  const sourceConfigResult = await readConfig(sourceHome);
  const sourceConfig = sourceConfigResult.config;
  const targetEndpoint = targetProfile ? await profileEndpoint(store, targetProfile, defaultUserHome) : null;
  const targetConfigResult = targetEndpoint ? await readConfig(targetEndpoint.home) : null;
  const targetConfig = targetConfigResult?.config;
  const items = [], limitations = [
    'This guide reports configured definitions only; it does not establish installation, enablement, trust, connection, or runtime availability.',
    'Command strings, environment values, endpoints, credentials, and hook bodies are not returned. Configuration is parsed in memory only to identify names, compare definitions, and read safe plugin metadata; commands are never executed. Plugin caches, conversation history, memory, and project contents are not scanned.'
  ];

  const sourceUserHome = sourceProfile.name === 'Default' ? defaultUserHome : join(sourceEndpoint.root, 'user-home');
  const marketplace = await personalMarketplace(sourceUserHome);
  const marketplaceEntries = new Map();
  for (const entry of marketplace.catalog?.plugins ?? []) {
    if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      const key = `${entry.name}@${marketplace.catalog.name}`;
      marketplaceEntries.set(key, (marketplaceEntries.get(key) ?? 0) + 1);
    }
  }
  const bounded = (value, label) => {
    const result = boundedNames(value);
    if (result.partial) limitations.push(`${label} discovery was capped at ${MAX_ITEMS} entries.`);
    return result.names;
  };
  const append = item => {
    if (items.length >= MAX_ITEMS) {
      if (!limitations.includes(`Setup guidance was capped at ${MAX_ITEMS} items.`)) limitations.push(`Setup guidance was capped at ${MAX_ITEMS} items.`);
      return false;
    }
    items.push(item);
    return true;
  };
  if (sourceConfig) {
    const plugins = sourceConfig.plugins;
    if (Object.hasOwn(sourceConfig, 'plugins') && (!plugins || typeof plugins !== 'object' || Array.isArray(plugins))) {
      limitations.push('Plugin configuration had an unsupported structure and was omitted.');
    }
    for (const identity of bounded(plugins, 'Plugin')) {
      const split = identity.lastIndexOf('@');
      if (split <= 0 || split === identity.length - 1) {
        limitations.push(`Plugin configuration identity could not be resolved for ${cleanLabel(identity)}; no setup item was generated.`);
        continue;
      }
      const pluginName = identity.slice(0, split), marketplaceName = identity.slice(split + 1);
      const entry = marketplace.catalog?.name === marketplaceName && marketplaceEntries.get(identity) === 1
        ? pluginCatalogEntry(marketplace.catalog, pluginName) : null;
      const sourceType = entry?.source && typeof entry.source === 'object' && typeof entry.source.source === 'string'
        ? cleanLabel(entry.source.source, 'unknown') : 'unknown';
      const enabled = typeof plugins[identity]?.enabled === 'boolean' ? plugins[identity].enabled : undefined;
      const destPlugins = targetConfig?.plugins;
      const destinationStatus = !targetProfile ? 'unknown'
        : !targetConfig ? (targetConfigResult?.missing ? 'missing' : 'unknown')
          : destPlugins !== undefined && (!destPlugins || typeof destPlugins !== 'object' || Array.isArray(destPlugins)) ? 'unknown'
          : !Object.hasOwn(destPlugins ?? {}, identity) ? 'missing'
            : !destPlugins[identity] || typeof destPlugins[identity] !== 'object' || Array.isArray(destPlugins[identity]) ? 'unknown'
            : canonical(plugins[identity]) === canonical(destPlugins[identity]) ? 'same' : 'different';
      const version = await localManifestVersion(entry, pluginName);
      const safePluginIdentity = cleanLabel(identity);
      const safePluginName = cleanLabel(pluginName);
      const safeMarketplaceName = cleanLabel(marketplaceName);
      append(setupItem(sourceProfile.name, {
        identity: `plugin:${identity}`, label: `${safePluginName} @ ${safeMarketplaceName}`, integration: 'plugin',
        scope: 'profile', origin: 'config.toml', path: sourceConfigResult.path,
        pluginIdentity: safePluginIdentity, pluginName: safePluginName, marketplace: safeMarketplaceName,
        marketplaceSourceType: sourceType, marketplaceMetadata: entry ? 'known-personal-marketplace-entry' : 'unknown',
        ...(entry?.source ? { marketplaceLocator: sourceLocator(entry.source) } : {}),
        enabled, status: enabled === false ? 'disabled-in-source-config' : enabled === true ? 'enabled-in-source-config' : 'configuration-state-unknown',
        installedVersion: 'unknown',
        ...(version ? { sourceVersion: version, versionEvidence: 'local-source-manifest' } : {}),
        destinationStatus,
        steps: integrationSteps('plugin', safePluginIdentity, destinationStatus),
      }));
      if (!entry || !version) limitations.push(`Plugin ${safePluginIdentity} is configured, but its local source manifest or version is unknown; cache data was not used.`);
    }

    const sourceServers = sourceConfig.mcp_servers;
    if (Object.hasOwn(sourceConfig, 'mcp_servers') && (!sourceServers || typeof sourceServers !== 'object' || Array.isArray(sourceServers))) {
      limitations.push('MCP configuration had an unsupported structure and was omitted.');
    }
    for (const name of bounded(sourceServers, 'MCP')) {
      const sourceDefinitionValid = Boolean(sourceServers[name]) && typeof sourceServers[name] === 'object' && !Array.isArray(sourceServers[name]);
      const targetDefinition = targetConfig?.mcp_servers?.[name];
      const targetServers = targetConfig?.mcp_servers;
      const destinationStatus = !sourceDefinitionValid ? 'unknown'
        : !targetProfile ? 'unknown'
        : !targetConfig ? (targetConfigResult?.missing ? 'missing' : 'unknown')
          : targetServers !== undefined && (!targetServers || typeof targetServers !== 'object' || Array.isArray(targetServers)) ? 'unknown'
          : !Object.hasOwn(targetServers ?? {}, name) ? 'missing'
            : !targetDefinition || typeof targetDefinition !== 'object' || Array.isArray(targetDefinition) ? 'unknown'
              : canonical(sourceServers[name]) === canonical(targetDefinition) ? 'same' : 'different';
      append(setupItem(sourceProfile.name, {
        identity: `mcp:${name}`, label: `MCP · ${name}`, scope: 'profile', origin: 'config.toml',
        path: sourceConfigResult.path, integration: 'mcp', definitionStatus: 'configured-only', destinationStatus,
        steps: integrationSteps('mcp', cleanLabel(name), destinationStatus),
      }));
    }

    if (Object.hasOwn(sourceConfig, 'hooks')) {
      const sourceHooks = hookDefinitions(sourceConfig.hooks), names = hookEvents(sourceHooks);
      const targetHooksRaw = targetConfig?.hooks;
      const targetHooks = hookDefinitions(targetHooksRaw);
      const destinationStatus = !targetProfile ? 'unknown'
        : !targetConfig ? (targetConfigResult?.missing ? 'missing' : 'unknown')
          : targetHooksRaw !== undefined && (!targetHooksRaw || typeof targetHooksRaw !== 'object' || Array.isArray(targetHooksRaw)) ? 'unknown'
          : canonical(sourceHooks) === canonical(targetHooks) ? 'same'
            : Object.keys(targetHooks).length ? 'different' : 'missing';
      if (names.length) append(setupItem(sourceProfile.name, {
        identity: 'hooks:config.toml', label: 'Hooks · config.toml', scope: 'profile', origin: 'config.toml',
        path: sourceConfigResult.path, integration: 'hooks', definitionStatus: 'configured-only',
        events: names, destinationStatus,
        steps: integrationSteps('hooks', 'config.toml', destinationStatus),
      }));
    }
  } else if (!sourceConfigResult.missing) {
    limitations.push('Source config.toml was unreadable or malformed; configured integrations could not be inventoried.');
  }

  const sourceHooksPath = join(sourceHome, 'hooks.json');
  const sourceHooksText = await readSafeText(sourceHooksPath);
  if (sourceHooksText !== null) {
    try {
      const hooks = JSON.parse(sourceHooksText);
      if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
        const names = hookEvents(hooks.hooks);
        if (names.length) {
          const sourceHookDefinitions = hookDefinitions(hooks.hooks);
          let destinationStatus = 'unknown';
          if (targetEndpoint) {
            const targetPath = join(targetEndpoint.home, 'hooks.json'), targetText = await readSafeText(targetPath);
            if (targetText !== null) {
              try {
                const parsed = JSON.parse(targetText), targetHookDefinitions = hookDefinitions(parsed?.hooks);
                destinationStatus = canonical(sourceHookDefinitions) === canonical(targetHookDefinitions) ? 'same'
                  : Object.keys(targetHookDefinitions).length ? 'different' : 'missing';
              }
              catch { destinationStatus = 'unknown'; }
            } else {
              try { await lstat(targetPath); destinationStatus = 'unknown'; }
              catch (error) { destinationStatus = error.code === 'ENOENT' ? 'missing' : 'unknown'; }
            }
          }
          append(setupItem(sourceProfile.name, {
            identity: 'hooks:hooks.json', label: 'Hooks · hooks.json', scope: 'profile', origin: 'hooks.json',
            path: sourceHooksPath, integration: 'hooks', definitionStatus: 'configured-only', events: names,
            destinationStatus, steps: integrationSteps('hooks', 'hooks.json', destinationStatus),
          }));
        }
      } else limitations.push('Source hooks.json had an unsupported structure and was omitted.');
    } catch { limitations.push('Source hooks.json was malformed and was omitted.'); }
  } else {
    try { await lstat(sourceHooksPath); limitations.push('Source hooks.json was unreadable or unsafe and was omitted.'); }
    catch (error) { if (error.code !== 'ENOENT') limitations.push('Source hooks.json could not be checked and was omitted.'); }
  }

  if (items.some(item => item.integration === 'mcp' || item.integration === 'hooks')) {
    limitations.push('Integration definitions are compared only in memory; their contents and secret-bearing fields are omitted from the guide.');
  }
  if (items.some(item => item.integration === 'plugin')) {
    limitations.push('Configured plugin state does not prove installation. Disabled source entries are informational and will never cause implicit activation.');
  }
  return { items, limitations: [...new Set(limitations)] };
}
