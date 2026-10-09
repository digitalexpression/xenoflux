import { createHash, randomUUID } from 'node:crypto';
import { chmod as nodeChmod, copyFile as nodeCopyFile, lstat as nodeLstat, mkdir as nodeMkdir,
  readFile as nodeReadFile, realpath as nodeRealpath, rename as nodeRename, rm as nodeRm, rmdir as nodeRmdir,
  writeFile as nodeWriteFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileDefault = promisify(nodeExecFile);
const sourceDefault = fileURLToPath(new URL('./native/profile-launcher.swift', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeText = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const absoluteCanonical = value => safeText(value) && value.startsWith('/') && resolve(value) === value;
const ownerName = '.xfx-owned.json';
const markerName = '.xfx-launcher-owner.json';
const currentUid = () => typeof process.getuid === 'function' ? process.getuid() : -1;
const privateMode = value => (value.mode & 0o077) === 0;
const privateRegular = value => value.isFile() && value.nlink === 1 && value.uid === currentUid() && privateMode(value);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
function plistString(key, value) { return `<key>${xml(key)}</key><string>${xml(value)}</string>`; }
function infoPlist({ profileId, name, store, node, entry }) {
  const displayName = `Codex · ${name}`;
  const bundleId = `com.xenoflux.profile.${profileId.toLowerCase()}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${plistString('CFBundleDevelopmentRegion', 'en')}${plistString('CFBundleDisplayName', displayName)}${plistString('CFBundleExecutable', 'XfxProfileLauncher')}${plistString('CFBundleIdentifier', bundleId)}<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>${plistString('CFBundleName', displayName)}${plistString('CFBundlePackageType', 'APPL')}<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/>${plistString('XfxStore', store)}${plistString('XfxProfileId', profileId)}${plistString('XfxNode', node)}${plistString('XfxEntryPoint', entry)}</dict></plist>\n`;
}
async function ensureDirectory(path, { mkdir, lstat, realpath }) {
  try { await mkdir(path, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== currentUid() || !privateMode(info)) fail('LAUNCHER_DIRECTORY_UNSAFE');
  if (await realpath(path) !== path) fail('LAUNCHER_DIRECTORY_UNSAFE');
  return info;
}
async function requireOwnedFile(path, { lstat }, code = 'LAUNCHER_OWNERSHIP_MISMATCH') {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !privateRegular(info)) fail(code);
  return info;
}
async function writeOwner(path, expected, { lstat, readFile, writeFile }) {
  const marker = join(path, ownerName);
  try {
    await requireOwnedFile(marker, { lstat });
    let found;
    try { found = JSON.parse(await readFile(marker, 'utf8')); } catch { fail('LAUNCHER_OWNERSHIP_MISMATCH'); }
    if (JSON.stringify(found) !== JSON.stringify(expected)) fail('LAUNCHER_OWNERSHIP_MISMATCH');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const entries = await (await import('node:fs/promises')).readdir(path);
    if (entries.length) fail('LAUNCHER_OWNERSHIP_MISMATCH');
    await writeFile(marker, `${JSON.stringify(expected)}\n`, { flag: 'wx', mode: 0o600 });
    await requireOwnedFile(marker, { lstat });
  }
}
async function assertOwnedBundle(bundle, expected, io) {
  const marker = join(bundle, markerName);
  try { await requireOwnedFile(marker, io); }
  catch (error) {
    if (error.code === 'ENOENT') fail('LAUNCHER_OWNERSHIP_MISMATCH');
    throw error;
  }
  let owner;
  try { owner = JSON.parse(await io.readFile(marker, 'utf8')); } catch { fail('LAUNCHER_OWNERSHIP_MISMATCH'); }
  if (owner.kind !== 'xenoflux-profile-launcher' || owner.store !== expected.store || owner.profileId !== expected.profileId)
    fail('LAUNCHER_OWNERSHIP_MISMATCH');
}
async function atomicWrite(path, contents, { writeFile, rename, chmod, lstat }, mode = 0o600) {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await requireOwnedFile(temporary, { lstat }, 'LAUNCHER_BUNDLE_UNSAFE');
    await rename(temporary, path);
    await requireOwnedFile(path, { lstat }, 'LAUNCHER_BUNDLE_UNSAFE');
  } catch (error) {
    await nodeRm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function compileHelper(source, sourceHash, storeDirectory, { build, execFile, mkdir, lstat, realpath, readFile, writeFile, rename, rm, chmod }) {
  const nativeRoot = join(storeDirectory, 'desktop-instances', 'native');
  await ensureDirectory(nativeRoot, { mkdir, lstat, realpath });
  const owner = { kind: 'xenoflux-profile-launcher-native-cache', store: storeDirectory };
  await writeOwner(nativeRoot, owner, { lstat, readFile, writeFile });
  const cacheDir = join(nativeRoot, sourceHash);
  const helper = join(cacheDir, 'XfxProfileLauncher');
  async function cached() {
    const dirInfo = await lstat(cacheDir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || dirInfo.uid !== currentUid() || !privateMode(dirInfo)
        || await realpath(cacheDir) !== cacheDir) fail('LAUNCHER_CACHE_UNSAFE');
    let marker;
    try {
      const markerPath = join(cacheDir, ownerName);
      await requireOwnedFile(markerPath, { lstat }, 'LAUNCHER_CACHE_UNSAFE');
      marker = JSON.parse(await readFile(markerPath, 'utf8'));
    } catch { fail('LAUNCHER_CACHE_UNSAFE'); }
    if (marker.kind !== owner.kind || marker.store !== storeDirectory || marker.sourceHash !== sourceHash
        || typeof marker.helperSha256 !== 'string') fail('LAUNCHER_CACHE_UNSAFE');
    let helperInfo;
    try { helperInfo = await requireOwnedFile(helper, { lstat }, 'LAUNCHER_CACHE_UNSAFE'); }
    catch { fail('LAUNCHER_CACHE_UNSAFE'); }
    if (!(helperInfo.mode & 0o111)) fail('LAUNCHER_CACHE_UNSAFE');
    const helperHash = createHash('sha256').update(await readFile(helper)).digest('hex');
    if (helperHash !== marker.helperSha256) fail('LAUNCHER_CACHE_UNSAFE');
    return { helper, helperSha256: helperHash };
  }
  try { return await cached(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const buildLock = join(nativeRoot, `.${sourceHash}.build-lock`);
  try { await mkdir(buildLock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('LAUNCHER_BUILD_BUSY'); throw error; }
  try {
    await ensureDirectory(buildLock, { mkdir, lstat, realpath });
    try { return await cached(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = join(nativeRoot, `.build-${sourceHash}-${randomUUID()}`);
    await mkdir(temp, { mode: 0o700 });
    try {
      await ensureDirectory(temp, { mkdir, lstat, realpath });
      const temporaryHelper = join(temp, 'XfxProfileLauncher');
      if (build) await build({ source, output: temporaryHelper, sourceHash });
      else {
        if (process.platform !== 'darwin') fail('SWIFT_COMPILER_UNAVAILABLE');
        await mkdir(join(temp, 'ModuleCache'), { mode: 0o700 });
        await execFile('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', join(temp, 'ModuleCache'), source, '-framework', 'AppKit', '-o', temporaryHelper], {
          cwd: '/', encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '/' },
        });
      }
      await rm(join(temp, 'ModuleCache'), { recursive: true, force: true });
      await chmod(temporaryHelper, 0o700);
      const built = await requireOwnedFile(temporaryHelper, { lstat }, 'LAUNCHER_BUILD_INVALID');
      if (!(built.mode & 0o111)) fail('LAUNCHER_BUILD_INVALID');
      const helperSha256 = createHash('sha256').update(await readFile(temporaryHelper)).digest('hex');
      await writeFile(join(temp, ownerName), `${JSON.stringify({ ...owner, sourceHash, helperSha256 })}\n`, { flag: 'wx', mode: 0o600 });
      await requireOwnedFile(join(temp, ownerName), { lstat }, 'LAUNCHER_BUILD_INVALID');
      try { await rename(temp, cacheDir); }
      catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        await rm(temp, { recursive: true, force: true });
        return await cached();
      }
      return { helper, helperSha256 };
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
      if (error.code === 'ENOENT' && !build) fail('SWIFT_COMPILER_UNAVAILABLE');
      throw error;
    }
  } finally { await nodeRmdir(buildLock).catch(() => {}); }
}

/** Prepare the owned per-profile macOS launcher bundle without opening it. */
export async function prepareProfileLauncher(store, plan, {
  build, nodeExecutable = process.execPath, entryPoint = fileURLToPath(new URL('../bin/xfx.js', import.meta.url)),
  source = sourceDefault, execFile = execFileDefault,
  mkdir = nodeMkdir, lstat = nodeLstat, realpath = nodeRealpath, readFile = nodeReadFile,
  writeFile = nodeWriteFile, rename = nodeRename, rm = nodeRm, chmod = nodeChmod,
} = {}) {
  if (!store || !absoluteCanonical(store.directory) || !plan || !uuid.test(plan.profileId ?? '') || !safeText(plan.name)
      || !absoluteCanonical(nodeExecutable) || !absoluteCanonical(entryPoint) || !absoluteCanonical(source)
      || typeof execFile !== 'function' || (build !== undefined && typeof build !== 'function')) fail('INVALID_LAUNCHER_PLAN');
  const canonicalStore = await realpath(store.directory);
  if (canonicalStore !== store.directory) fail('INVALID_LAUNCHER_STORE');
  const canonicalNode = await realpath(nodeExecutable);
  const canonicalEntry = await realpath(entryPoint);
  if (!absoluteCanonical(canonicalNode) || !absoluteCanonical(canonicalEntry)) fail('INVALID_LAUNCHER_PLAN');
  const nodeInfo = await lstat(canonicalNode);
  const entryInfo = await lstat(canonicalEntry);
  if (nodeInfo.isSymbolicLink() || !nodeInfo.isFile() || nodeInfo.nlink !== 1 || !(nodeInfo.mode & 0o111)
      || entryInfo.isSymbolicLink() || !entryInfo.isFile() || entryInfo.nlink !== 1) fail('INVALID_LAUNCHER_PLAN');
  const instancesRoot = join(store.directory, 'desktop-instances');
  await ensureDirectory(instancesRoot, { mkdir, lstat, realpath });
  const sourcePath = await realpath(source);
  const sourceBytes = await readFile(sourcePath);
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const helper = await compileHelper(sourcePath, sourceHash, store.directory, { build, execFile, mkdir, lstat, realpath, readFile, writeFile, rename, rm, chmod });
  const helperExecutable = helper.helper;

  const appsRoot = join(instancesRoot, 'apps');
  await ensureDirectory(appsRoot, { mkdir, lstat, realpath });
  await writeOwner(appsRoot, { kind: 'xenoflux-profile-launcher-apps', store: store.directory }, { lstat, readFile, writeFile });
  const launcherApp = join(appsRoot, `${plan.profileId}.app`);
  try { await mkdir(launcherApp, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const appStat = await lstat(launcherApp);
  if (appStat.isSymbolicLink() || !appStat.isDirectory() || appStat.uid !== currentUid() || !privateMode(appStat)
      || await realpath(launcherApp) !== launcherApp) fail('LAUNCHER_DIRECTORY_UNSAFE');
  const expected = { kind: 'xenoflux-profile-launcher', store: store.directory, profileId: plan.profileId };
  try { await assertOwnedBundle(launcherApp, expected, { lstat, readFile }); }
  catch (error) {
    if (error.code !== 'LAUNCHER_OWNERSHIP_MISMATCH') throw error;
    // A newly created empty directory may be claimed; any existing bundle needs an exact marker.
    const entries = await (await import('node:fs/promises')).readdir(launcherApp);
    if (entries.length) throw error;
    await writeFile(join(launcherApp, markerName), `${JSON.stringify(expected)}\n`, { flag: 'wx', mode: 0o600 });
    await requireOwnedFile(join(launcherApp, markerName), { lstat });
  }
  const contents = join(launcherApp, 'Contents');
  await ensureDirectory(contents, { mkdir, lstat, realpath });
  const macOS = join(contents, 'MacOS');
  await ensureDirectory(macOS, { mkdir, lstat, realpath });
  const launcherExecutable = join(macOS, 'XfxProfileLauncher');
  const existingExe = await lstat(launcherExecutable).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existingExe && (existingExe.isSymbolicLink() || !privateRegular(existingExe) || !(existingExe.mode & 0o111))) fail('LAUNCHER_BUNDLE_UNSAFE');
  const currentLauncherHash = existingExe ? createHash('sha256').update(await readFile(launcherExecutable)).digest('hex') : null;
  if (currentLauncherHash !== helper.helperSha256) {
    const temporaryExecutable = join(macOS, `.XfxProfileLauncher-${randomUUID()}.tmp`);
    try {
      await nodeCopyFile(helperExecutable, temporaryExecutable);
      await chmod(temporaryExecutable, 0o700);
      await requireOwnedFile(temporaryExecutable, { lstat }, 'LAUNCHER_BUNDLE_UNSAFE');
      await rename(temporaryExecutable, launcherExecutable);
      await requireOwnedFile(launcherExecutable, { lstat }, 'LAUNCHER_BUNDLE_UNSAFE');
    } catch (error) {
      await rm(temporaryExecutable, { force: true }).catch(() => {});
      throw error;
    }
  }
  const helperSha256 = helper.helperSha256;
  const metadata = join(contents, 'Info.plist');
  const metadataStat = await lstat(metadata).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (metadataStat && (metadataStat.isSymbolicLink() || !privateRegular(metadataStat))) fail('LAUNCHER_BUNDLE_UNSAFE');
  const plist = infoPlist({ profileId: plan.profileId, name: plan.name, store: store.directory, node: canonicalNode, entry: canonicalEntry });
  await atomicWrite(metadata, plist, { writeFile, rename, chmod, lstat });
  return { launcherApp, launcherExecutable, helperExecutable, helperSha256 };
}
