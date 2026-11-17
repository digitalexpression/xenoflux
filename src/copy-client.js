// Transfer eligibility is narrower than setup discovery. Native integrations stay manual.
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { discoverAuditProfile } from './audit-discovery.js';
import { inspectProfile } from './profile-inventory.js';
import { redactValue } from './redact.js';

export const CLIENT_COPY_SETTINGS = Object.freeze({
  'claude-code': Object.freeze(['model', 'effortLevel', 'theme', 'autoUpdatesChannel']),
  copilot: Object.freeze(['model', 'reasoningEffort', 'theme', 'stream', 'banner', 'beep']),
});
export function validClientSetting(key, value) {
  if (['stream', 'banner', 'beep'].includes(key)) return typeof value === 'boolean';
  return typeof value === 'string' && /^[A-Za-z0-9._+-]{1,128}$/.test(value) && redactValue(value, key) === value;
}
export function clientCopyPath(clientId, path, kind) {
  if (!CLIENT_COPY_SETTINGS[clientId]) return false;
  if (kind === 'config') return path === 'settings.json';
  if (kind === 'instruction') return path === (clientId === 'claude-code' ? 'CLAUDE.md' : 'copilot-instructions.md');
  if (kind === 'skill') return /^skills\/[A-Za-z0-9_-]+$/.test(path);
  const prefix = kind === 'agent' ? 'agents' : kind === 'rule' ? clientId === 'claude-code' ? 'rules' : 'instructions' : null;
  return prefix !== null && new RegExp('^' + prefix + '/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.md$').test(path);
}
export async function resolveClaudeGlobalSkill(userHome, alias) {
  const name = relative(join(userHome, '.claude', 'skills'), alias);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return;
  const shared = join(userHome, '.agents', 'skills', name);
  try {
    for (const path of [userHome, join(userHome, '.claude'), dirname(alias), join(userHome, '.agents'), dirname(shared), shared]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o7022 || await realpath(path) !== path) return;
    }
    const link = await lstat(alias);
    if (!link.isSymbolicLink() || link.uid !== process.getuid()
      || resolve(dirname(alias), await readlink(alias)) !== shared || await realpath(alias) !== shared) return;
    const definition = await lstat(join(shared, 'SKILL.md'));
    if (!definition.isFile() || definition.nlink !== 1 || definition.uid !== process.getuid() || definition.mode & 0o7022) return;
    return shared;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR', 'EINVAL', 'EACCES', 'EPERM'].includes(error.code)) return;
    throw error;
  }
}

export async function inspectCopyProfile(store, name, options = {}) {
  if (!options.clientId || options.clientId === 'codex') return inspectProfile(store, name, { ...options, includeProjects: false, copyOnly: true });
  const { clientId, binding, defaultUserHome } = options;
  const snapshot = await discoverAuditProfile(store, name, { clientId, binding, defaultUserHome });
  const { profile } = snapshot;
  const items = [];
  const packages = new Map();
  for (const item of snapshot.resources) if (item.category === 'plugin' && item.integrationId && item.provider) {
    const versions = packages.get(item.integrationId) ?? new Set();
    if (item.version) versions.add(item.version);
    packages.set(item.integrationId, versions);
  }
  const configuredPlugins = new Set(snapshot.resources.filter(item => item.category === 'plugin' && !item.provider).map(item => item.integrationId));
  const manual = new Set();
  for (const resource of snapshot.resources) {
    // A plugin owns all of its components, including custom component paths.
    if (resource.category !== 'plugin' && (resource.provider || resource.scope === 'plugin')) continue;
    if (resource.category === 'plugin' && resource.provider && configuredPlugins.has(resource.integrationId)) continue;
    const path = relative(profile.home, resource.path);
    const owned = ['user', 'profile'].includes(resource.scope) && ['user-home', 'profile-home'].includes(resource.origin)
      && resource.status === 'present' && !resource.canonicalPath;
    const globalClaudeSkill = clientId === 'claude-code' && profile.rootMode === 'implicit'
      && resource.category === 'skill' && resource.scope === 'user' && Boolean(resource.canonicalPath)
      && await resolveClaudeGlobalSkill(dirname(profile.home), resource.path) === resource.canonicalPath;
    const eligible = (owned || globalClaudeSkill) && clientCopyPath(profile.clientId, path, resource.category);
    const base = { ...resource, ...(globalClaudeSkill && {
      id: createHash('sha256').update(resource.id + '\0' + resource.path).digest('hex'),
      status: 'present',
    }), label: resource.name, origin: profile.profileName, copyable: false,
      reason: 'Native/manual or unsupported ownership; discovery does not authorize transfer.' };
    if (['plugin', 'hook', 'mcp'].includes(resource.category) && resource.status === 'present') {
      const identity = resource.integrationId ?? resource.provider ?? resource.name;
      const key = resource.category + ':' + identity;
      if (manual.has(key)) continue;
      manual.add(key);
      const versions = [...(packages.get(identity) ?? [])];
      if (resource.version && !versions.includes(resource.version)) versions.push(resource.version);
      const client = clientId === 'claude-code' ? 'Claude Code' : 'Copilot CLI';
      const steps = resource.category === 'plugin'
        ? [`Check ${identity} in ${client}, including the intended source${versions.length ? ' and version (' + versions.join(', ') + ')' : ''}. Install only if wanted and absent; cache presence does not prove installation.`,
          'Review enablement, dependencies, trust and any account connection separately in the client.']
        : [`Check whether ${identity} is already configured in ${client}. Set it up only if wanted and needed; review dependencies, permissions, trust and any credentials there.`];
      items.push({ ...base, setup: true, destinationStatus: 'unknown', steps });
    } else if (eligible && resource.category === 'config') {
      for (const key of CLIENT_COPY_SETTINGS[profile.clientId]) {
        if (!validClientSetting(key, resource.value?.[key])) continue;
        items.push({ ...base, id: createHash('sha256').update(resource.id + ':' + key).digest('hex'), label: key, copyable: true,
          transfer: { kind: 'config', path, key, sourcePath: resource.path } });
      }
      // Retain an explicit kept entry for unselected/unknown settings.
      items.push(base);
    } else items.push(eligible ? { ...base, copyable: true,
      transfer: { kind: resource.category, path, sourcePath: resource.path, ...(globalClaudeSkill && { globalClaudeSkill }) } } : base);
  }
  return { profile: { ...profile, name: profile.profileName }, items,
    limitations: snapshot.warnings, coverage: snapshot.coverage };
}
