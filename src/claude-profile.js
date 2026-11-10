// Profile resolution never initializes Claude or reads credentials.
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { nativePath } from './node-runtime.js';

export const CLAUDE_CLIENT = 'claude-code';
const AMBIENT = /^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDE_API_KEY$|CLAUDE_OAUTH_TOKEN$|CLAUDECODE$|AWS_|GOOGLE_APPLICATION_CREDENTIALS$|CLOUD_ML_REGION$|VERTEX_|HTTPS?_PROXY$|ALL_PROXY$|NODE_OPTIONS$|DYLD_|LD_PRELOAD$)/i;
const INHERITED = ['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'];

export function claudeEnvironment(ambient, { userHome, home, rootMode }) {
  if (Object.keys(ambient).some(key => AMBIENT.test(key)))
    throw Object.assign(new Error('Remove ambient Claude authentication, provider and root overrides before using this profile'), { code: 'claude-ambient-override' });
  const env = Object.fromEntries(INHERITED.filter(key => typeof ambient[key] === 'string').map(key => [key, ambient[key]]));
  return { ...env, PATH: nativePath(ambient), HOME: userHome, ...(rootMode === 'explicit' ? { CLAUDE_CONFIG_DIR: home } : {}) };
}

export async function canonicalClaudeDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw new Error(`Invalid ${label}`);
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022) || await realpath(path) !== path)
    throw new Error(`Unsafe ${label}`);
  return path;
}

export async function inspectClaudeExecutable(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path)
    throw new Error('Invalid selected Claude executable');
  const executable = await realpath(path), info = await lstat(executable);
  if (!info.isFile() || (info.mode & 0o022)) throw new Error('Selected Claude executable is unsafe');
  await access(executable, constants.X_OK);
  return { executable, executableIdentity: JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]) };
}

async function discoverClaudeExecutable(env) {
  for (const directory of env.PATH.split(':')) {
    if (!isAbsolute(directory)) continue;
    try { return await inspectClaudeExecutable(join(directory, 'claude')); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw new Error('Claude Code executable is unavailable on PATH');
}

function descendant(root, path) {
  const subpath = relative(root, path);
  return Boolean(subpath && subpath !== '..' && !subpath.startsWith('..' + sep) && !isAbsolute(subpath));
}

export async function resolveClaudeProfile({ selected, repository, defaultUserHome, terminalEnvironment, sessionOnly = false }) {
  const userHome = await canonicalClaudeDirectory(defaultUserHome, 'Claude user home');
  const rootMode = selected ? selected.native?.rootMode : 'implicit';
  if (selected && (selected.client !== CLAUDE_CLIENT || rootMode !== 'explicit'))
    throw new Error('Managed Claude Code profile has no explicit native binding');
  const home = await canonicalClaudeDirectory(selected ? selected.native?.configRoot : join(userHome, '.claude'), 'Claude configuration root');
  const reservationRoot = selected ? await canonicalClaudeDirectory(selected.native.root, 'Claude reservation root') : home;
  if (selected && !descendant(reservationRoot, home))
    throw new Error('Claude configuration is outside the selected managed profile');
  const env = claudeEnvironment(terminalEnvironment, { userHome, home, rootMode });
  const binary = selected ? await inspectClaudeExecutable(selected.native.executable) : await discoverClaudeExecutable(env);
  if (selected && selected.native.executableIdentity !== binary.executableIdentity)
    throw new Error('The bound Claude executable has changed');
  const cwd = sessionOnly ? null : repository ?? selected?.repositories?.[0]?.path;
  if (!cwd && !sessionOnly) throw new Error('Select a workspace for Claude Code');
  const canonical = cwd === null ? null : await canonicalClaudeDirectory(await realpath(cwd), 'Claude workspace');
  if (canonical && selected && !selected.repositories.some(row => row.path === canonical))
    throw Object.assign(new Error('The selected repository is not already bound to this profile'), { code: 'profile-repository-unbound' });
  return { ...binary, profileId: selected?.id ?? 'default-claude-code', profileName: selected?.name ?? 'Default',
    client: CLAUDE_CLIENT, surface: 'cli', executionLocation: 'local', rootMode, home, userHome,
    nativeRoot: selected ? reservationRoot : null, reservationRoot, environmentId: selected?.native.environmentId ?? null,
    version: selected?.native.version ?? null, versionSource: selected ? 'registered' : 'unavailable',
    executableSource: selected ? 'registered' : 'path', bindingRepository: canonical, cwd: canonical, env };
}
