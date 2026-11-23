import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { exists } from './metadata.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const identity = info => [info.dev, info.ino, info.uid, info.mode];
const stamp = info => info ? [...identity(info), info.nlink, info.size, info.mtimeMs, info.ctimeMs] : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeFile = (info, limit) => info?.isFile() && info.uid === process.getuid() && info.nlink === 1
  && !(info.mode & 0o022) && info.size <= limit;
const unsafe = () => new Error('Project trust settings are unavailable or unsafe.');
const changed = () => new Error('Project trust settings or the selected repository changed. Review the comparison again.');

async function directory(path, protect = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw unsafe();
  const info = await lstat(path);
  if (!info.isDirectory() || await realpath(path) !== path
    || protect && (info.uid !== process.getuid() || info.mode & 0o022)) throw unsafe();
  return identity(info);
}

async function readConfig(path, limit) {
  const info = await exists(path);
  if (!info) return { text: '', mode: 0o600, stamp: null };
  if (!safeFile(info, limit)) throw unsafe();
  const before = stamp(info);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!isDeepStrictEqual(stamp(await file.stat()), before)) throw changed();
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    if (!isDeepStrictEqual(stamp(await file.stat()), before) || !isDeepStrictEqual(stamp(await exists(path)), before))
      throw changed();
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), mode: info.mode & 0o777, stamp: before };
  } finally { await file.close(); }
}

function projectStatus(projects, repository, trustKey, yes, no) {
  if (projects !== undefined && !object(projects)) throw unsafe();
  for (let path = repository; ; path = dirname(path)) {
    if (projects && Object.hasOwn(projects, path)) {
      const project = projects[path];
      if (!object(project)) throw unsafe();
      const value = project[trustKey];
      if (value === no) return 'denied';
      if (value === yes && path === repository) return 'trusted';
      if (value !== undefined && value !== yes) throw unsafe();
    }
    if (dirname(path) === path) return 'needs-trust';
  }
}

function codexTrust(text, repository) {
  const config = parse(text);
  const status = projectStatus(config.projects, repository, 'trust_level', 'trusted', 'untrusted');
  if (status !== 'needs-trust') return { status };
  const target = JSON.stringify(repository);
  config.projects ??= Object.create(null);
  config.projects[repository] ??= Object.create(null);
  config.projects[repository].trust_level = 'trusted';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const withEntry = `${text}${text && !text.endsWith('\n') ? newline : ''}[projects.${target}]${newline}trust_level = "trusted"${newline}`;
  const valid = candidate => {
    try { return isDeepStrictEqual(parse(candidate), config); } catch { return false; }
  };
  if (valid(withEntry)) return { status, updated: withEntry };
  // Insert into an existing project table only when parsing proves the exact change.
  for (const header of text.matchAll(/^[ \t]*\[[ \t]*projects[ \t]*\.[^\r\n]+\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm)) {
    const start = header.index + header[0].length;
    const candidate = `${text.slice(0, start)}${header[0].endsWith('\n') ? '' : newline}trust_level = "trusted"${newline}${text.slice(start)}`;
    if (valid(candidate)) return { status, updated: candidate };
  }
  throw new Error('Add this project to trusted projects in Codex settings and review again.');
}

function jsonTrust(text, repository, client) {
  const config = text ? JSON.parse(text) : {};
  if (!object(config)) throw unsafe();
  if (client === 'claude-code') {
    const status = projectStatus(config.projects, repository, 'hasTrustDialogAccepted', true, false);
    return { status, updated: status === 'needs-trust' ? {
      ...config, projects: { ...config.projects, [repository]: { ...config.projects?.[repository], hasTrustDialogAccepted: true } },
    } : undefined };
  }
  const folders = config.trustedFolders === undefined ? [] : config.trustedFolders;
  if (!Array.isArray(folders) || folders.some(path => typeof path !== 'string')) throw unsafe();
  return folders.includes(repository) ? { status: 'trusted' }
    : { status: 'needs-trust', updated: { ...config, trustedFolders: [...folders, repository] } };
}

async function inspect(profile, repository) {
  const client = profile.client ?? 'codex';
  const home = client === 'claude-code' && profile.rootMode === 'implicit' ? profile.userHome : profile.home;
  const filename = ({ codex: 'config.toml', 'claude-code': '.claude.json', copilot: 'config.json' })[client];
  if (!filename || profile.bindingRepository !== repository) throw unsafe();
  const project = await directory(repository), configHome = await directory(home, true);
  const path = join(home, filename);
  const limit = (client === 'codex' ? 1 : 16) * 1024 * 1024;
  const config = await readConfig(path, limit);
  let status, updated;
  try {
    ({ status, updated } = client === 'codex' ? codexTrust(config.text, repository) : jsonTrust(config.text, repository, client));
  } catch (error) {
    if (error.message.startsWith('Add this project')) throw error;
    throw unsafe();
  }
  const fingerprint = digest(JSON.stringify([client, path, repository, project, configHome, config.stamp, digest(config.text)]));
  const text = updated === undefined || client === 'codex' ? updated : JSON.stringify(updated, null, 2) + '\n';
  if (text !== undefined && Buffer.byteLength(text) > limit) throw unsafe();
  return { plan: { status, fingerprint }, path, project, configHome, config, text };
}

export async function inspectComparisonProjectTrust(profile, repository) {
  return (await inspect(profile, repository)).plan;
}

// The caller owns the profile mutation gate and has checked that native writers are idle.
export async function applyComparisonProjectTrust(profile, repository, reviewed) {
  const current = await inspect(profile, repository);
  if (!isDeepStrictEqual(current.plan, reviewed)) throw changed();
  if (current.plan.status === 'trusted') return;
  if (current.plan.status === 'denied') throw new Error('The native client explicitly marks this project untrusted.');
  const temporary = `${current.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, current.text, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, current.config.mode);
    if (!isDeepStrictEqual(await directory(repository), current.project)
      || !isDeepStrictEqual(await directory(dirname(current.path), true), current.configHome)
      || !isDeepStrictEqual(stamp(await exists(current.path)), current.config.stamp)) throw changed();
    if (current.config.stamp) await rename(temporary, current.path);
    else await link(temporary, current.path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
