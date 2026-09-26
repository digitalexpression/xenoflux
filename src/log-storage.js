import { readFileSync, lstatSync } from 'node:fs';
import { mkdir, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRamLogs } from './ram-logs.js';
import { userPaths } from './paths.js';
import { nativePath } from './node-runtime.js';

function validate(value) {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.backgroundPath !== 'string')
    throw new Error('Invalid RAM-log settings');
  return { enabled: value.enabled, backgroundPath: nativePath({ PATH: value.backgroundPath }) };
}
function owned(info, directory = false) {
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())
    || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('RAM-log settings must be private and owned by this user');
}
export function readLogSettings({ home, env = process.env } = {}) {
  const paths = userPaths(home);
  try {
    owned(lstatSync(paths.ramlogs), true);
    const file = join(paths.ramlogs, 'settings.json');
    owned(lstatSync(file));
    return validate(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { enabled: false, backgroundPath: nativePath(env) };
    throw error;
  }
}
export async function writeLogSettings(value, { home } = {}) {
  const settings = validate(value), paths = userPaths(home);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  owned(await lstat(paths.root), true);
  await mkdir(paths.ramlogs, { recursive: true, mode: 0o700 });
  owned(await lstat(paths.ramlogs), true);
  const file = join(paths.ramlogs, 'settings.json');
  try { owned(await lstat(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(paths.ramlogs, `.settings-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return settings;
}
export function createLogStorage({ userHome, ...options } = {}) {
  const settings = readLogSettings({ home: userHome });
  return createRamLogs({ registry: join(userPaths(userHome).ramlogs, 'homes'), ...options, enabled: settings.enabled });
}
