import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Create one private disposable native-home root for registration tests. */
export async function prepareNativeHome({ directory, executable, codexVersion }) {
  const requested = resolve(directory), root = join(await realpath(dirname(requested)), basename(requested));
  await mkdir(root, { mode: 0o700 });
  const home = join(root, 'codex-home'), cwd = join(root, 'workspace'), userHome = join(root, 'user-home'), temporary = join(root, 'tmp'), desktopData = join(root, 'desktop-data');
  for (const path of [home, cwd, userHome, temporary, desktopData]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(home, 'config.toml'), 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\n', { flag: 'wx', mode: 0o600 });
  const item = await lstat(executable);
  return { root: await realpath(root), home, cwd, userHome, temporary, desktopData,
    native: { environmentId: randomUUID(), root: await realpath(root), executable: resolve(executable), executableIdentity: JSON.stringify([item.dev, item.ino, item.size, item.mtimeMs, item.ctimeMs]), version: codexVersion } };
}
