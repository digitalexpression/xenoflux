import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod as nodeChmod, copyFile as nodeCopyFile, cp as nodeCp, lstat as nodeLstat, mkdir as nodeMkdir,
  readFile as nodeReadFile, readdir as nodeReaddir, readlink as nodeReadlink, realpath as nodeRealpath, rename as nodeRename, rm as nodeRm, rmdir as nodeRmdir,
  writeFile as nodeWriteFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDesktopApp, DESKTOP_APP } from './desktop-runtime.js';

const execFileDefault = promisify(nodeExecFile);
const prebuiltDirectoryDefault = fileURLToPath(new URL('./native/', import.meta.url));
const sourceDefault = fileURLToPath(new URL('./native/profile-launcher.swift', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeText = value => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const absoluteCanonical = value => safeText(value) && value.startsWith('/') && resolve(value) === value;
const ownerName = '.xfx-owned.json';
const markerName = '.xfx-profile-app-owner.json';
const signingPolicy = 'main-host-disable-library-validation-v1';
const currentUid = () => typeof process.getuid === 'function' ? process.getuid() : -1;
const privateMode = value => (value.mode & 0o077) === 0;
const privateRegular = value => value.isFile() && value.nlink === 1 && value.uid === currentUid() && privateMode(value);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function safeName(value) {
  const result = String(value).normalize('NFC').replace(/[\x00-\x1f\x7f/\\:]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\.+|\.+$/g, '').slice(0, 80).trim();
  return result || 'Profile';
}
function appPathFor(root, id, name) { return join(root, id, `Codex · ${safeName(name)}.app`); }
function isWithin(root, path) { const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }
async function ensureDirectory(path, { mkdir, lstat, realpath }) {
  try { await mkdir(path, { recursive: false, mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return requireDirectory(path, { lstat, realpath });
}
async function requireDirectory(path, { lstat, realpath }) {
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
async function packagedHelper(directory, sourceHash, { lstat, readFile }) {
  try {
    const binary = join(directory, 'XfxProfileLauncher');
    const manifest = join(directory, 'profile-launcher-prebuilt.json');
    for (const path of [binary, manifest]) {
      const info = await lstat(path);
      // Installed package files may belong to an administrator; private cache
      // ownership rules apply only after copying them into the controller store.
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o022)
          || (path === binary && !(info.mode & 0o111))) fail('PREBUILT_LAUNCHER_INVALID');
    }
    const metadata = JSON.parse(await readFile(manifest, 'utf8'));
    if (!metadata || typeof metadata !== 'object' || metadata.schemaVersion !== 1 || metadata.minimumMacOS !== '13.0'
        || JSON.stringify(metadata.architectures) !== JSON.stringify(['arm64', 'x86_64'])
        || !/^[a-f0-9]{64}$/.test(metadata.helperSha256 ?? '')) fail('PREBUILT_LAUNCHER_INVALID');
    if (metadata.sourceSha256 !== sourceHash) fail('PREBUILT_LAUNCHER_STALE');
    const bytes = await readFile(binary);
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.helperSha256) fail('PREBUILT_LAUNCHER_INVALID');
    return { bytes, helperSha256: metadata.helperSha256 };
  } catch (error) {
    if (error.code === 'ENOENT') fail('PREBUILT_LAUNCHER_MISSING');
    if (error instanceof SyntaxError) fail('PREBUILT_LAUNCHER_INVALID');
    throw error;
  }
}
async function cachedHelper(sourceHash, storeDirectory, { lstat, realpath, readFile }, cacheKey = sourceHash) {
  const nativeRoot = join(storeDirectory, 'desktop-instances', 'native');
  await requireDirectory(nativeRoot, { lstat, realpath });
  const owner = { kind: 'xenoflux-profile-launcher-native-cache', store: storeDirectory };
  await loadOwnedMarker(join(nativeRoot, ownerName), { lstat, readFile }, owner);
  const cacheDir = join(nativeRoot, cacheKey), helper = join(cacheDir, 'XfxProfileLauncher');
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
  return { helper, helperSha256: helperHash, sourceHash };
}
async function prepareHelper(source, sourceHash, storeDirectory, packaged, { build, mkdir, lstat, realpath, readFile, writeFile, rename, rm, chmod }) {
  const nativeRoot = join(storeDirectory, 'desktop-instances', 'native');
  await ensureDirectory(nativeRoot, { mkdir, lstat, realpath });
  const owner = { kind: 'xenoflux-profile-launcher-native-cache', store: storeDirectory };
  await writeOwner(nativeRoot, owner, { lstat, readFile, writeFile });
  const cacheKey = packaged?.helperSha256 ?? sourceHash;
  const cacheDir = join(nativeRoot, cacheKey);
  const helper = join(cacheDir, 'XfxProfileLauncher');
  const cached = () => cachedHelper(sourceHash, storeDirectory, { lstat, realpath, readFile }, cacheKey);
  try { return await cached(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const buildLock = join(nativeRoot, `.${cacheKey}.build-lock`);
  try { await mkdir(buildLock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('LAUNCHER_BUILD_BUSY'); throw error; }
  try {
    await ensureDirectory(buildLock, { mkdir, lstat, realpath });
    try { return await cached(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = join(nativeRoot, `.build-${cacheKey}-${randomUUID()}`);
    await mkdir(temp, { mode: 0o700 });
    try {
      await ensureDirectory(temp, { mkdir, lstat, realpath });
      const temporaryHelper = join(temp, 'XfxProfileLauncher');
      if (build) await build({ source, output: temporaryHelper, sourceHash });
      else await writeFile(temporaryHelper, packaged.bytes, { flag: 'wx', mode: 0o700 });
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
      return { helper, helperSha256, sourceHash };
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } finally { await nodeRmdir(buildLock).catch(() => {}); }
}

async function hashFile(path, { readFile, lstat }, code = 'PROFILE_APP_UNSAFE', privateOnly = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (privateOnly && !privateRegular(info))) fail(code);
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
async function scanLinks(root, dir, { lstat, readdir, readlink, realpath }) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name), info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      if (!isWithin(root, target)) fail('PROFILE_APP_EXTERNAL_LINK');
      const rawTarget = await readlink(path);
      if (isAbsolute(rawTarget)) fail('PROFILE_APP_EXTERNAL_LINK');
    } else if (info.isDirectory()) await scanLinks(root, path, { lstat, readdir, readlink, realpath });
    else if (info.isFile() && info.nlink !== 1) fail('PROFILE_APP_HARDLINK');
  }
}
async function readPlist(path, execFile) {
  const { stdout } = await execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  try { return JSON.parse(stdout); } catch { fail('PROFILE_APP_INVALID_PLIST'); }
}
async function updatePlistDefault(path, { set, remove }, execFile, writeFile, rm) {
  const info = await readPlist(path, execFile);
  for (const key of remove) delete info[key];
  Object.assign(info, set);
  const temporary = `${path}.${randomUUID()}.json`;
  try {
    await writeFile(temporary, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
    await execFile('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, temporary], { encoding: 'utf8', timeout: 30000 });
  } finally { await rm(temporary, { force: true }); }
}
async function verifySignature(path, execFile) {
  await execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', path], { encoding: 'utf8', timeout: 30000 });
}
async function signDefault(path, vendorExecutable, bootstrapExecutable, execFile, writeFile, rm) {
  // This small Swift process uses AppKit only to request LaunchServices; it must
  // not inherit the vendor app's restricted entitlements or application groups.
  await execFile('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', bootstrapExecutable], { encoding: 'utf8', timeout: 30000 });
  const entitlements = join(path, `.xfx-main-entitlements-${randomUUID()}.plist`);
  try {
    await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>`, { flag: 'wx', mode: 0o600 });
    await execFile('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, vendorExecutable], { encoding: 'utf8', timeout: 30000 });
  } finally { await rm(entitlements, { force: true }); }
  // Sign only the changed outer bundle. Nested vendor signatures remain intact.
  await execFile('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', path], { encoding: 'utf8', timeout: 120000 });
  await verifySignature(path, execFile);
  const bootstrapEntitlements = await execFile('/usr/bin/codesign', ['--display', '--entitlements', ':-', bootstrapExecutable], {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000,
  });
  if (/<key>/.test(`${bootstrapEntitlements.stdout ?? ''}${bootstrapEntitlements.stderr ?? ''}`)) fail('PROFILE_BOOTSTRAP_ENTITLEMENTS_PRESENT');
}
function validateInput(store, plan, nodeExecutable, entryPoint, source) {
  if (!store || !absoluteCanonical(store.directory) || !plan || !uuid.test(plan.profileId ?? '') || !safeText(plan.name)
      || !absoluteCanonical(nodeExecutable) || !absoluteCanonical(entryPoint) || !absoluteCanonical(source)
      || !absoluteCanonical(plan.nativeRoot ?? '') || !plan.app || !absoluteCanonical(plan.app.appPath)
      || !absoluteCanonical(plan.app.executable) || plan.app.bundleId !== DESKTOP_APP.bundleId
      || !/^[a-f0-9]{64}$/i.test(plan.app.asarSha256 ?? '')) fail('INVALID_LAUNCHER_PLAN');
}
async function verifyOriginal(sourceAppPath, app, verifyOriginalFn) {
  const verified = await verifyOriginalFn(sourceAppPath, app);
  if (!verified || verified.appPath !== sourceAppPath || verified.bundleId !== app.bundleId
      || verified.executable !== app.executable || verified.asarSha256 !== app.asarSha256) fail('PROFILE_APP_SOURCE_CHANGED');
}
async function markerFor(storeDirectory, plan, appPath, helperSha256, helperSourceSha256, hashes) {
  return { kind: 'xenoflux-profile-app', signingPolicy, store: storeDirectory, profileId: plan.profileId, nativeRoot: plan.nativeRoot,
    appPath, bundleId: `com.xenoflux.profile.${plan.profileId.toLowerCase()}`, sourceAppPath: plan.app.appPath,
    sourceBundleId: plan.app.bundleId, sourceAsarSha256: plan.app.asarSha256,
    node: hashes.node, entry: hashes.entry,
    sourceExecutable: basename(plan.app.executable), sourceExecutableSha256: hashes.sourceExecutableSha256,
    helperSourceSha256, copiedAsarSha256: hashes.copiedAsarSha256, copiedExecutableSha256: hashes.copiedExecutableSha256,
    bootstrapSha256: hashes.bootstrapSha256, helperSha256 };
}
async function loadOwnedMarker(path, { lstat, readFile }, expected) {
  await requireOwnedFile(path, { lstat }, 'PROFILE_APP_OWNERSHIP_MISMATCH');
  let marker;
  try { marker = JSON.parse(await readFile(path, 'utf8')); } catch { fail('PROFILE_APP_OWNERSHIP_MISMATCH'); }
  for (const [key, value] of Object.entries(expected)) if (marker[key] !== value) fail('PROFILE_APP_OWNERSHIP_MISMATCH');
  return marker;
}
function applicationFor(appPath, bundleId, executable) { return { appPath, bundleId, executable }; }

/** Prepare a signed, profile-labelled copy of the verified vendor app. */
export function prepareProfileApp(store, plan, options = {}) {
  return profileApp(store, plan, true, options);
}
/** Load a current prepared app using reads and signature verification only. */
export function loadPreparedProfileApp(store, plan, options = {}) {
  return profileApp(store, plan, false, options);
}
function preparationRequired(plan, refresh) {
  const code = refresh ? 'PROFILE_APP_REFRESH_REQUIRED' : 'PROFILE_APP_PREPARE_REQUIRED';
  return Object.assign(new Error(`${code}: Run xfx desktop ${refresh ? 'refresh' : 'prepare'} ${JSON.stringify(plan.name)} before opening this profile.`), { code });
}
async function profileApp(store, plan, allowRebuild, {
  build, nodeExecutable = process.execPath, entryPoint = fileURLToPath(new URL('../bin/xfx.js', import.meta.url)),
  source = sourceDefault, prebuiltDirectory = prebuiltDirectoryDefault, execFile = execFileDefault,
  verifyOriginal: verifyOriginalFn = async (appPath, expected) => inspectDesktopApp({ appPath, expected, execFile, readFile, realpath }),
  copyApp = (from, to) => nodeCp(from, to, { recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE }),
  updatePlist = (path, operations) => updatePlistDefault(path, operations, execFile, writeFile, rm),
  signApp = (path, sourcePath, context) => signDefault(path, context.vendorExecutable, context.bootstrapExecutable, execFile, writeFile, rm),
  mkdir = nodeMkdir, lstat = nodeLstat, realpath = nodeRealpath, readFile = nodeReadFile, readdir = nodeReaddir,
  readlink = nodeReadlink, writeFile = nodeWriteFile, rename = nodeRename, rm = nodeRm, chmod = nodeChmod,
} = {}) {
  validateInput(store, plan, nodeExecutable, entryPoint, source);
  const canonicalStore = await realpath(store.directory);
  if (canonicalStore !== store.directory) fail('INVALID_LAUNCHER_STORE');
  const canonicalNode = await realpath(nodeExecutable), canonicalEntry = await realpath(entryPoint);
  if (!absoluteCanonical(canonicalNode) || !absoluteCanonical(canonicalEntry)) fail('INVALID_LAUNCHER_PLAN');
  const nodeInfo = await lstat(canonicalNode), entryInfo = await lstat(canonicalEntry);
  if (nodeInfo.isSymbolicLink() || !nodeInfo.isFile() || nodeInfo.nlink !== 1 || !(nodeInfo.mode & 0o111)
      || entryInfo.isSymbolicLink() || !entryInfo.isFile() || entryInfo.nlink !== 1) fail('INVALID_LAUNCHER_PLAN');
  const sourceAppPath = await realpath(plan.app.appPath);
  if (sourceAppPath !== plan.app.appPath) fail('PROFILE_APP_SOURCE_CHANGED');
  await verifyOriginal(sourceAppPath, plan.app, verifyOriginalFn);
  const sourceExecutableSha256 = await hashFile(plan.app.executable, { readFile, lstat });
  const copiedAsarSha256 = await hashFile(join(sourceAppPath, 'Contents', 'Resources', 'app.asar'), { readFile, lstat });
  if (copiedAsarSha256 !== plan.app.asarSha256) fail('PROFILE_APP_SOURCE_CHANGED');
  const instancesRoot = join(store.directory, 'desktop-instances');
  const sourcePath = await realpath(source);
  const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  const packaged = build ? null : await packagedHelper(prebuiltDirectory, sourceHash, { lstat, readFile });
  const appsRoot = join(instancesRoot, 'apps');
  const profileDir = join(appsRoot, plan.profileId);
  const appPath = appPathFor(appsRoot, plan.profileId, plan.name);
  const ownerPath = join(profileDir, markerName);
  const tempApp = join(profileDir, `.profile-app-${randomUUID()}.app`);
  const bundleId = `com.xenoflux.profile.${plan.profileId.toLowerCase()}`;
  const expectedBase = { kind: 'xenoflux-profile-app', store: store.directory, profileId: plan.profileId, nativeRoot: plan.nativeRoot, appPath };
  const existingMarker = await lstat(ownerPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!allowRebuild && !existingMarker) throw preparationRequired(plan, false);
  for (const path of [instancesRoot, appsRoot, profileDir]) {
    if (allowRebuild) await ensureDirectory(path, { mkdir, lstat, realpath });
    else await requireDirectory(path, { lstat, realpath });
  }
  let helper;
  if (allowRebuild) helper = await prepareHelper(sourcePath, sourceHash, store.directory, packaged, { build, mkdir, lstat, realpath, readFile, writeFile, rename, rm, chmod });
  else {
    try { helper = await cachedHelper(sourceHash, store.directory, { lstat, realpath, readFile }, packaged?.helperSha256 ?? sourceHash); }
    catch (error) { if (error.code === 'ENOENT') throw preparationRequired(plan, true); throw error; }
  }
  if (packaged && helper.helperSha256 !== packaged.helperSha256) fail('LAUNCHER_CACHE_UNSAFE');
  let previousAppPath = null;
  if (existingMarker) {
    const existing = await loadOwnedMarker(ownerPath, { lstat, readFile }, {
      kind: expectedBase.kind, store: expectedBase.store, profileId: expectedBase.profileId, nativeRoot: expectedBase.nativeRoot,
    });
    if (!absoluteCanonical(existing.appPath) || !isWithin(profileDir, existing.appPath)
        || !basename(existing.appPath).startsWith('Codex · ') || !basename(existing.appPath).endsWith('.app')) fail('PROFILE_APP_OWNERSHIP_MISMATCH');
    const existingApp = await lstat(existing.appPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!existingApp) fail('PROFILE_APP_OWNERSHIP_MISMATCH');
    const oldLabel = basename(existing.appPath).slice('Codex · '.length, -'.app'.length);
    const oldPlan = { ...plan, name: oldLabel };
    const existingBundle = applicationFor(existing.appPath, existing.bundleId, join(existing.appPath, 'Contents', 'MacOS', existing.sourceExecutable));
    const validation = await validateProfileApp(store, oldPlan, existingBundle, { execFile, lstat, realpath, readFile, readdir, readlink });
    const needsRefresh = existing.appPath !== appPath || existing.sourceAppPath !== sourceAppPath
      || existing.sourceBundleId !== plan.app.bundleId || existing.sourceAsarSha256 !== copiedAsarSha256
      || existing.sourceExecutableSha256 !== sourceExecutableSha256
      || existing.helperSourceSha256 !== helper.sourceHash || existing.helperSha256 !== helper.helperSha256
      || existing.signingPolicy !== signingPolicy || existing.node !== canonicalNode || existing.entry !== canonicalEntry;
    if (!needsRefresh) {
      return { ...validation, helperExecutable: helper.helper, helperSha256: helper.helperSha256 };
    }
    if (!allowRebuild) throw preparationRequired(plan, true);
    previousAppPath = existing.appPath;
  }
  const entries = await readdir(profileDir);
  if (entries.some(entry => entry !== markerName && (!previousAppPath || join(profileDir, entry) !== previousAppPath)))
    fail('PROFILE_APP_OWNERSHIP_MISMATCH');
  try {
    await scanLinks(sourceAppPath, sourceAppPath, { lstat, readdir, readlink, realpath });
    await copyApp(sourceAppPath, tempApp);
    const tempContents = join(tempApp, 'Contents'), infoPath = join(tempContents, 'Info.plist');
    const vendorExecutable = join(tempContents, 'MacOS', basename(plan.app.executable));
    const bootstrapExecutable = join(tempContents, 'MacOS', 'XfxProfileLauncher');
    if (basename(plan.app.executable) === 'XfxProfileLauncher') fail('PROFILE_APP_INVALID_SOURCE');
    await nodeCopyFile(helper.helper, bootstrapExecutable);
    await chmod(bootstrapExecutable, 0o700);
    const sourceInfo = await readPlist(infoPath, execFile);
    const removeInfoKeys = ['CFBundleURLTypes', 'CFBundleDocumentTypes'];
    if (Object.hasOwn(sourceInfo, 'SUFeedURL')) removeInfoKeys.push('SUFeedURL');
    await updatePlist(infoPath, { set: {
      CFBundleName: `Codex · ${safeName(plan.name)}`, CFBundleDisplayName: `Codex · ${safeName(plan.name)}`,
      CFBundleIdentifier: bundleId, CFBundleExecutable: 'XfxProfileLauncher',
      XfxStore: store.directory, XfxProfileId: plan.profileId, XfxNode: canonicalNode,
      XfxEntryPoint: canonicalEntry, XfxNativeRoot: plan.nativeRoot,
      XfxVendorExecutable: basename(plan.app.executable),
    }, remove: removeInfoKeys });
    if (await hashFile(join(tempContents, 'Resources', 'app.asar'), { readFile, lstat }) !== copiedAsarSha256) fail('PROFILE_APP_SOURCE_CHANGED');
    if (await hashFile(vendorExecutable, { readFile, lstat }) !== sourceExecutableSha256) fail('PROFILE_APP_SOURCE_CHANGED');
    await chmod(tempApp, 0o700);
    await signApp(tempApp, sourceAppPath, { sourceExecutable: plan.app.executable, vendorExecutable, bootstrapExecutable });
    await verifySignature(tempApp, execFile);
    await scanLinks(tempApp, tempApp, { lstat, readdir, readlink, realpath });
    const bootstrapSha256 = await hashFile(bootstrapExecutable, { readFile, lstat }, 'PROFILE_APP_UNSAFE', true);
    const copiedExecutableSha256 = await hashFile(vendorExecutable, { readFile, lstat });
    const owner = await markerFor(store.directory, plan, appPath, helper.helperSha256, helper.sourceHash, {
      sourceExecutableSha256, copiedAsarSha256, copiedExecutableSha256, bootstrapSha256, node: canonicalNode, entry: canonicalEntry,
    });
    let backup = null;
    if (previousAppPath) {
      backup = join(profileDir, `.previous-profile-app-${randomUUID()}.app`);
      await rename(previousAppPath, backup);
    }
    try {
      await rename(tempApp, appPath);
      await atomicWrite(ownerPath, `${JSON.stringify(owner)}\n`, { writeFile, rename, chmod, lstat });
    } catch (error) {
      await rm(appPath, { recursive: true, force: true }).catch(() => {});
      if (backup) await rename(backup, previousAppPath).catch(() => {});
      throw error;
    }
    if (backup) await rm(backup, { recursive: true, force: true });
    await requireOwnedFile(ownerPath, { lstat }, 'PROFILE_APP_OWNERSHIP_MISMATCH');
    const application = applicationFor(appPath, bundleId, join(appPath, 'Contents', 'MacOS', basename(plan.app.executable)));
    return { application, bootstrapExecutable: join(appPath, 'Contents', 'MacOS', 'XfxProfileLauncher'), helperExecutable: helper.helper, helperSha256: helper.helperSha256 };
  } catch (error) {
    await rm(tempApp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Validate an existing private copy without depending on the current vendor installation. */
export async function validateProfileApp(store, plan, appBundle, {
  execFile = execFileDefault, lstat = nodeLstat, realpath = nodeRealpath, readFile = nodeReadFile,
  readdir = nodeReaddir, readlink = nodeReadlink,
} = {}) {
  if (!store || !absoluteCanonical(store.directory) || !plan || !uuid.test(plan.profileId ?? '')
      || !absoluteCanonical(plan.nativeRoot ?? '') || !appBundle || !absoluteCanonical(appBundle.appPath)
      || !absoluteCanonical(appBundle.executable)) fail('INVALID_LAUNCHER_PLAN');
  const appsRoot = join(store.directory, 'desktop-instances', 'apps');
  const profileDir = join(appsRoot, plan.profileId);
  const expectedPath = appPathFor(appsRoot, plan.profileId, plan.name);
  if (appBundle.appPath !== expectedPath || await realpath(profileDir) !== profileDir || await realpath(appBundle.appPath) !== appBundle.appPath)
    fail('PROFILE_APP_OWNERSHIP_MISMATCH');
  const ownerPath = join(profileDir, markerName);
  const owner = await loadOwnedMarker(ownerPath, { lstat, readFile }, {
    kind: 'xenoflux-profile-app', store: store.directory, profileId: plan.profileId, nativeRoot: plan.nativeRoot, appPath: appBundle.appPath,
  });
  const appInfo = await lstat(appBundle.appPath), dirInfo = await lstat(profileDir);
  if (appInfo.isSymbolicLink() || !appInfo.isDirectory() || appInfo.uid !== currentUid() || !privateMode(appInfo)
      || dirInfo.isSymbolicLink() || !dirInfo.isDirectory() || dirInfo.uid !== currentUid() || !privateMode(dirInfo)) fail('PROFILE_APP_UNSAFE');
  if (appBundle.bundleId !== owner.bundleId || appBundle.executable !== join(appBundle.appPath, 'Contents', 'MacOS', owner.sourceExecutable))
    fail('PROFILE_APP_OWNERSHIP_MISMATCH');
  const contents = join(appBundle.appPath, 'Contents'), infoPath = join(contents, 'Info.plist');
  await scanLinks(appBundle.appPath, appBundle.appPath, { lstat, readdir, readlink, realpath });
  const info = await readPlist(infoPath, execFile);
  if (info.CFBundleIdentifier !== owner.bundleId || info.CFBundleExecutable !== 'XfxProfileLauncher'
      || info.CFBundleName !== `Codex · ${safeName(plan.name)}` || info.CFBundleDisplayName !== `Codex · ${safeName(plan.name)}`
      || info.XfxStore !== store.directory || info.XfxProfileId !== plan.profileId || info.XfxNativeRoot !== plan.nativeRoot
      || info.XfxNode !== owner.node || info.XfxEntryPoint !== owner.entry
      || info.XfxVendorExecutable !== owner.sourceExecutable) fail('PROFILE_APP_OWNERSHIP_MISMATCH');
  const copiedAsarSha256 = await hashFile(join(contents, 'Resources', 'app.asar'), { readFile, lstat });
  const copiedExecutableSha256 = await hashFile(appBundle.executable, { readFile, lstat });
  const bootstrapExecutable = join(contents, 'MacOS', 'XfxProfileLauncher');
  const bootstrapSha256 = await hashFile(bootstrapExecutable, { readFile, lstat }, 'PROFILE_APP_UNSAFE', true);
  if (copiedAsarSha256 !== owner.copiedAsarSha256 || copiedAsarSha256 !== owner.sourceAsarSha256
      || copiedExecutableSha256 !== owner.copiedExecutableSha256 || bootstrapSha256 !== owner.bootstrapSha256) fail('PROFILE_APP_CONTENT_CHANGED');
  await verifySignature(appBundle.appPath, execFile);
  return { application: appBundle, bootstrapExecutable, helperSha256: owner.helperSha256 };
}
