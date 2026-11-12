// Explicit file-only sessions. The selected configuration root is never substituted.
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, opendir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertEnvironmentBinding, createEnvironmentBinding, createNativeReference } from './client-contracts.js';
import { canonicalClaudeDirectory } from './claude-profile.js';
import { importClaudeTranscript } from './claude-transcript.js';

const exec = promisify(execFile), UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxBytes = 8 * 1024 * 1024, maxFiles = 5000, maxProjects = 1000;
const stamp = stat => JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs]);
const match = (row, expected) => expected === stamp(row);
const sourceError = () => new Error('The selected Claude session is unavailable or changed. List sessions again.');

function route(profile) {
  const binding = createEnvironmentBinding(profile.environmentBinding);
  if (binding.client !== 'claude-code' || binding.surface !== 'cli' || binding.executionLocation !== 'local'
    || binding.roots.config !== profile.home || binding.roots.user !== profile.userHome || binding.rootMode !== profile.rootMode
    || binding.profileId !== profile.profileId || (profile.rootMode === 'implicit' && profile.home !== join(profile.userHome, '.claude')))
    throw sourceError();
  return binding;
}

async function inventory(home) {
  const root = join(home, 'projects');
  await canonicalClaudeDirectory(home, 'Claude configuration root');
  try { await canonicalClaudeDirectory(root, 'Claude sessions root'); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const map = new Map();
  let projects = 0, files = 0;
  for await (const project of await opendir(root)) {
    if (++projects > maxProjects || project.isSymbolicLink()) throw sourceError();
    if (!project.isDirectory()) continue;
    const parent = join(root, project.name);
    await canonicalClaudeDirectory(parent, 'Claude session project');
    for await (const file of await opendir(parent)) {
      if (++files > maxFiles || file.isSymbolicLink()) throw sourceError();
      const id = file.name.endsWith('.jsonl') ? file.name.slice(0, -6) : null;
      if (!UUID.test(id ?? '')) continue;
      const path = join(parent, file.name), info = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.mode & 0o022 || await realpath(path) !== path)
        throw sourceError();
      if (map.has(id)) throw new Error('Duplicate Claude session identity in the selected profile');
      map.set(id, { path, parent, stamp: stamp(info), bytes: info.size });
    }
  }
  return map;
}

export async function listClaudeSessions(profile, { limit = 30, offset = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000)
    throw new Error('Invalid Claude session page');
  const binding = route(profile), sources = await inventory(profile.home);
  if (!sources.size) return { sessions: [], nextOffset: null };
  let result;
  try {
    const { stdout } = await exec(process.execPath,
      ['--max-old-space-size=128', fileURLToPath(new URL('./claude-transcript-reader.mjs', import.meta.url)), '--list', String(limit + 1), String(offset)],
      { cwd: profile.home, env: { HOME: profile.userHome, ...(profile.rootMode === 'explicit' ? { CLAUDE_CONFIG_DIR: profile.home } : {}),
        PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' }, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    result = JSON.parse(stdout);
  } catch { throw new Error('The isolated Claude stored-session list is unavailable'); }
  if (result?.guardAttempts !== 0 || !Array.isArray(result.rows) || result.rows.length > limit + 1) throw sourceError();
  const seen = new Set();
  const sessions = [];
  for (const row of result.rows.slice(0, limit)) {
    const source = sources.get(row.id);
    if (!source || seen.has(row.id) || row.bytes != null && row.bytes !== source.bytes || !match(await lstat(source.path), source.stamp))
      throw sourceError();
    seen.add(row.id);
    sessions.push({ id: row.id, title: row.title?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim() || 'Untitled session',
      cwd: row.cwd, modifiedAt: row.mtime, importable: source.bytes > 0 && source.bytes <= maxBytes,
      selection: { binding, id: row.id, source } });
  }
  return { sessions, nextOffset: result.rows.length > limit ? offset + limit : null };
}

export async function importClaudeSession(profile, selection, options) {
  const binding = route(profile);
  assertEnvironmentBinding(selection?.binding, binding);
  if (!UUID.test(selection?.id ?? '')) throw sourceError();
  const source = (await inventory(profile.home)).get(selection.id);
  if (!source || source.path !== selection.source?.path || source.stamp !== selection.source?.stamp
    || source.bytes < 1 || source.bytes > maxBytes) throw sourceError();
  const handle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let content;
  try {
    if (!match(await handle.stat(), source.stamp)) throw sourceError();
    const buffer = Buffer.alloc(source.bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw sourceError();
      offset += bytesRead;
    }
    if (!match(await handle.stat(), source.stamp) || !match(await lstat(source.path), source.stamp)
      || await realpath(source.path) !== source.path) throw sourceError();
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } finally { await handle.close(); }
  const imported = await importClaudeTranscript({ fileName: selection.id + '.jsonl', text: content }, options);
  return { ...imported, profile: { profileId: profile.profileId, profileName: profile.profileName, client: 'claude-code' },
    environmentBinding: binding, nativeReference: createNativeReference({ client: 'claude-code', jobId: imported.id,
      profileId: profile.profileId, sessionId: selection.id }) };
}
