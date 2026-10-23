// Preparation only. A generated profile is not a successful native-client gate.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export const nativePin = { version: '0.163.0-alpha.10.2',
  sha256: '1afb28c01d7d49e892bd75f11076b10f1451e34e0ee308a95e5ab7f69f9c84fe' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const quoted = value => JSON.stringify(value);

/** Fresh root children only; the native executable is the sole external input.
 * The policy denies preference IPC as well as other host services. The pinned
 * app-server currently refuses configuration loading under this boundary.
 * Do not weaken that failure into an unrestricted native launch.
 */
export async function prepareNativePolicy({ root, executable, providerPort }) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
    || /[\x00-\x1f\x7f"\\]/.test(root) || await realpath(root) !== root
    || !Number.isInteger(providerPort) || providerPort < 1024 || providerPort > 65535)
    throw new Error('native-isolation-input-invalid');
  const info = await lstat(root);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)
    || root === process.env.HOME || root === process.env.CODEX_HOME || root === '/')
    throw new Error('native-isolation-private-root-required');
  const paths = Object.fromEntries(['runtime', 'home', 'codex-home', 'tmp', 'workspace', 'capture', 'inputs']
    .map(name => [name, join(root, name)]));
  for (const path of Object.values(paths)) {
    const child = await lstat(path);
    if (!child.isDirectory() || child.isSymbolicLink() || child.uid !== process.getuid()
      || (child.mode & 0o077) || await realpath(path) !== path) throw new Error('native-isolation-owned-child-required');
  }
  if (typeof executable !== 'string' || !isAbsolute(executable) || await realpath(executable) !== executable
    || (await lstat(executable)).isSymbolicLink() || sha(await readFile(executable)) !== nativePin.sha256)
    throw new Error('native-isolation-binary-mismatch');
  const readonly = [paths.runtime, paths.inputs], writable = ['home', 'codex-home', 'tmp', 'workspace', 'capture'].map(name => paths[name]);
  const profile = [
    '(version 1)', '(deny default)', '(allow process-fork)', '(allow sysctl-read)',
    // Metadata and the root-directory loader open are broader than content reads.
    // Neither grants recursive host contents or a credential-service connection.
    '(allow file-read-metadata)', '(allow file-read* (literal "/"))',
    '(allow file-read* file-map-executable (subpath "/usr/lib") (subpath "/System/Library") (subpath "/private/var/db/dyld") (subpath "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld"))',
    `(allow process-exec file-read* file-map-executable (literal ${quoted(executable)}) (subpath ${quoted(paths.runtime)}) (subpath "/bin") (subpath "/usr/bin"))`,
    `(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") ${readonly.map(path => `(subpath ${quoted(path)})`).join(' ')})`,
    '(allow file-write* (literal "/dev/null"))',
    ...writable.map(path => `(allow file-read* file-write* (subpath ${quoted(path)}))`),
    `(deny file-write* (subpath ${quoted(join(paths.workspace, '.git'))}) (literal ${quoted(join(paths.workspace, '.xfx-audit-owner.json'))}) (literal ${quoted(join(paths.workspace, '.xfx-audit-active'))}))`,
    // Seatbelt requires localhost rather than a numeric host in this filter;
    // it permits loopback TCP at this port, not general DNS or other endpoints.
    `(allow network-outbound (remote tcp ${quoted(`localhost:${providerPort}`)}))`,
    '',
  ].join('\n');
  const environment = { PATH: `${paths.runtime}:/usr/bin:/bin`, HOME: paths.home, CODEX_HOME: paths['codex-home'],
    TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp, CODEX_NATIVE_UPLOADS: '0', CODEX_NATIVE_SIDECARS: '0' };
  return { profile, profileSha256: sha(Buffer.from(profile)), environment, paths, native: nativePin,
    status: 'prepared-native-startup-blocked', executionAuthorized: false,
    limitation: 'Pinned app-server fails managed-preference synchronization before a model request; native isolation acceptance remains unresolved.' };
}
