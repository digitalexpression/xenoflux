// Normal named native homes. Validation never reads credential contents.
import { access, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import { create, find } from './profiles.js';
import { MAX_NATIVE_CONFIG_BYTES } from './native-config.js';
import { nativePath } from './node-runtime.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
const own = process.getuid?.();
const fail = message => { throw new Error(message); };
function safe(path, name) {
  if (typeof path !== 'string' || !path.trim() || /[\x00-\x1f\x7f]/.test(path)) fail(`Invalid ${name}`);
}
async function privateDirectory(path, name) {
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink() || await realpath(path) !== path || (item.mode & 0o077)
    || (own !== undefined && item.uid !== own)) fail(`Invalid ${name}`);
}
async function privateText(path, name, limit = 65536) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const item = await handle.stat();
    if (!item.isFile() || item.nlink !== 1 || item.size > limit || (item.mode & 0o077)
      || (own !== undefined && item.uid !== own)) fail(`Invalid ${name}`);
    const buffer = Buffer.alloc(item.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length) fail(`Invalid ${name}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } finally { await handle.close(); }
}
async function optionalAuth(home) {
  try {
    const item = await lstat(join(home, 'auth.json'));
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || (item.mode & 0o077)
      || (own !== undefined && item.uid !== own)) fail('Invalid native credential metadata');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function identity(item) { return JSON.stringify([item.dev, item.ino, item.size, item.mtimeMs, item.ctimeMs]); }
async function executable(path) {
  safe(path, 'Codex executable');
  if (!isAbsolute(path)) fail('Codex executable must be an absolute path');
  const invocation = resolve(path), target = await realpath(invocation), item = await lstat(target);
  if (!item.isFile() || item.isSymbolicLink()) fail('Invalid Codex executable');
  await access(target, constants.X_OK);
  return { executable: invocation, executableIdentity: identity(item) };
}
function validNative(native) {
  return native && Object.keys(native).sort().join(',') === 'environmentId,executable,executableIdentity,root,version'
    && uuid.test(native.environmentId ?? '')
    && typeof native.root === 'string' && native.root.startsWith('/') && resolve(native.root) === native.root
    && typeof native.executable === 'string' && native.executable.startsWith('/') && resolve(native.executable) === native.executable
    && typeof native.executableIdentity === 'string' && native.executableIdentity.length > 0
    && native.executableIdentity.length <= 1024 && version(native.version);
}
async function load(native) {
  if (!validNative(native)) fail('Invalid native home binding');
  safe(native.root, 'native home root');
  const root = await realpath(native.root);
  if (root !== native.root || root.split(sep).some(part => ['.codex', '.agents'].includes(part.toLowerCase())))
    fail('Invalid native home root');
  await privateDirectory(root, 'native home root');
  const home = join(root, 'codex-home'), cwd = join(root, 'workspace');
  const userHome = join(root, 'user-home'), temporary = join(root, 'tmp');
  for (const [path, name] of [[home, 'Codex home'], [cwd, 'workspace'], [userHome, 'user home'], [temporary, 'temporary directory']])
    await privateDirectory(path, name);
  const desktopData = join(root, 'desktop-data');
  try { await privateDirectory(desktopData, 'desktop data'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let config;
  try { config = parse(await privateText(join(home, 'config.toml'), 'native configuration', MAX_NATIVE_CONFIG_BYTES)); }
  catch { fail('Invalid native configuration'); }
  if (config?.cli_auth_credentials_store !== 'file' || (config.sqlite_home !== undefined && config.sqlite_home !== home))
    fail('Native configuration must use the bound file credential store and sqlite home');
  await optionalAuth(home);
  const binary = await executable(native.executable);
  const environment = { id: native.environmentId, home, cwd, desktopData,
    launch: { executable: binary.executable, args: ['app-server'], cwd,
      env: { PATH: nativePath(), HOME: userHome, CODEX_HOME: home, CODEX_SQLITE_HOME: home,
        TMPDIR: temporary, TMP: temporary, TEMP: temporary } } };
  return { native: { ...native, ...binary }, environment };
}
export async function assertSymlinkedHome(home) {
  let config;
  try { config = parse(await privateText(join(home, 'config.toml'), 'native configuration', MAX_NATIVE_CONFIG_BYTES)); }
  catch { fail(`Native home must enable allow_symlinked_codex_home = true: ${join(home, 'config.toml')}`); }
  if (config?.allow_symlinked_codex_home !== true)
    fail(`Native home must enable allow_symlinked_codex_home = true: ${join(home, 'config.toml')}`);
}
export async function registerHome(store, name, root, { executable: requestedExecutable, version: declaredVersion, expectedProfileId } = {}) {
  safe(root, 'native home root');
  if (!isAbsolute(root) || !version(declaredVersion)) fail('Native home registration requires a recognizable Codex CLI version');
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) fail('Native home root must be canonical');
  const binary = await executable(requestedExecutable);
  const candidate = { environmentId: randomUUID(), root: canonicalRoot, ...binary, version: declaredVersion };
  await load(candidate);
  return store.update(data => {
    // Registration is the public entry point for an existing native profile.
    // Validate the candidate above, then create its registry record in this
    // same locked update so invalid paths cannot leave an empty record behind.
    // Setup must bind the same record it prepared, even if its name was reused
    // after a concurrent deletion. Public registration may create a new record.
    const profile = expectedProfileId !== undefined ? find(data, expectedProfileId)
      : data.profiles.some(item => item.id === name || item.name === name) ? find(data, name) : create(data, name);
    if (profile.native) {
      if (profile.native.root === candidate.root && profile.native.executable === candidate.executable) return profile;
      fail('Profile already has a different native home binding');
    }
    if (data.profiles.some(item => item.id !== profile.id && item.native?.root === candidate.root))
      fail('Native home is already bound to another profile');
    profile.native = candidate;
    profile.revision += 1;
    return profile;
  });
}
export { unbindNativeHome as unbindHome } from './profile-removal.js';
export async function loadHomeBinding(native) { return load(native); }
export async function resolveHome(store, name) {
  const profile = find(await store.read(), name);
  if (!profile.native) fail('Profile has no native home binding');
  const { native, environment } = await load(profile.native);
  return { profile, native, environment };
}
export async function listHomes(store) {
  const data = await store.read();
  return Promise.all(data.profiles.map(async profile => {
    const basic = { id: profile.id, name: profile.name, description: profile.description };
    if (!profile.native) return { ...basic, root: null, home: null, state: 'unbound', reason: null };
    try {
      const { environment } = await load(profile.native);
      return { ...basic, root: profile.native.root, home: environment.home, state: 'ready', reason: null };
    } catch {
      return { ...basic, root: profile.native.root, home: join(profile.native.root, 'codex-home'), state: 'unavailable',
        reason: 'The native home is unavailable or no longer matches this binding.' };
    }
  }));
}
