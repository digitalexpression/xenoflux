import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

// Recognize the same-name links used by skills installers. An arbitrary alias
// or link inside a package must never become an input to the copy transaction.
export async function resolveSharedSkill(userHome, configRoot, alias) {
  const aliasRoot = join(configRoot, 'skills');
  const name = relative(aliasRoot, alias);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return;
  const sharedRoot = join(userHome, '.agents', 'skills');
  const shared = join(sharedRoot, name);
  try {
    for (const path of [userHome, configRoot, aliasRoot, dirname(sharedRoot), sharedRoot, shared]) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o7022 || await realpath(path) !== path) return;
    }
    const link = await lstat(alias);
    if (!link.isSymbolicLink() || link.uid !== process.getuid()
      || resolve(aliasRoot, await readlink(alias)) !== shared || await realpath(alias) !== shared) return;
    const definition = await lstat(join(shared, 'SKILL.md'));
    if (!definition.isFile() || definition.nlink !== 1 || definition.uid !== process.getuid() || definition.mode & 0o7022) return;
    return shared;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR', 'EINVAL', 'EACCES', 'EPERM'].includes(error.code)) return;
    throw error;
  }
}
