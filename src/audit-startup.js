// Per-process macOS write protection for saved Codex profile definitions.
// This deliberately keeps the native process on its real profile paths: reads
// remain available, while startup refreshes cannot alter selected saved files.
import { mkdir, lstat, realpath, writeFile, readdir, access, open } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve, isAbsolute, sep } from 'node:path';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PROTECTED = ['auth.json', 'config.toml', 'AGENTS.md', 'AGENTS.override.md', 'instructions.md', 'agents', 'rules', 'skills'];
// Native-owned runtime/cache entries observed during offline startup. These are
// exact names, not prefixes: random atomic auth/config siblings stay denied.
const RUNTIME_ROOT_ENTRIES = ['sessions', 'archived_sessions', 'rollouts', 'tmp', '.tmp',
  'shell_snapshots', 'thread-writer-locks', 'installation_id', '.sandbox_migration'];
const PACKAGED_CODEX_WRAPPER = [
  '#!/bin/sh', 'set -eu', 'entry="$0"', 'while [ -L "$entry" ]; do',
  '  parent=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)', '  entry=$(readlink "$entry")',
  '  case "$entry" in /*) ;; *) entry="$parent/$entry" ;; esac', 'done',
  'bin_dir=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)',
  'exec "$bin_dir/../CodexCLI.app/Contents/MacOS/codex" "$@"',
].join('\n') + '\n';

function quote(value) {
  // SBPL accepts quoted strings with backslash escaping.
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

const regexPath = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function canonicalFuturePath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return join(realpathSync.native(cursor), ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

async function assertPrivateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)
    || await realpath(directory) !== directory) throw new Error('Audit startup policy directory must be private and canonical');
}

async function supportedCodexCommandImages(executable) {
  const invocation = await realpath(executable);
  const bin = dirname(invocation), cliRoot = dirname(bin), resources = dirname(cliRoot);
  const contents = dirname(resources), app = dirname(contents);
  const packagedLayout = basename(invocation) === 'codex' && basename(bin) === 'bin' && basename(cliRoot) === 'codex-cli'
    && basename(resources) === 'Resources' && basename(contents) === 'Contents' && basename(app).endsWith('.app');
  if (!packagedLayout) return { processImages: [invocation], wrappers: [], launchImage: executable };

  let handle;
  try { handle = await open(invocation, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error('Packaged Codex CLI wrapper cannot be verified for command sandboxing'); }
  let source;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Packaged Codex CLI wrapper cannot be verified for command sandboxing');
    source = await handle.readFile({ encoding: 'utf8' });
  } finally { await handle.close(); }
  if (source !== PACKAGED_CODEX_WRAPPER) throw new Error('Packaged Codex CLI wrapper cannot be verified for command sandboxing');

  const candidate = join(cliRoot, 'CodexCLI.app', 'Contents', 'MacOS', 'codex');
  let native;
  try { native = await realpath(candidate); } catch { throw new Error('Packaged Codex CLI process image is unavailable'); }
  if (native !== candidate) throw new Error('Packaged Codex CLI process image is unavailable');
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Packaged Codex CLI process image is unavailable');
  let imageHandle;
  try { imageHandle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error('Packaged Codex CLI process image is unavailable'); }
  try {
    const opened = await imageHandle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error('Packaged Codex CLI process image is unavailable');
    const magic = Buffer.alloc(4);
    const { bytesRead } = await imageHandle.read(magic, 0, magic.length, 0);
    // Accept only 64-bit native Mach-O images or universal Mach-O containers.
    const validMachO = bytesRead === 4 && ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']
      .includes(magic.toString('hex'));
    if (!validMachO) throw new Error('Packaged Codex CLI process image is unavailable');
  } finally { await imageHandle.close(); }
  await access(candidate, constants.X_OK);
  return { processImages: [native], wrappers: [invocation], launchImage: native };
}

/**
 * Prepare a fail-closed sandbox-exec invocation. The supplied directory
 * must be a fresh private directory owned by this process; it is never reused.
 * Returns the wrapped invocation and private policy metadata.
 */
export async function prepareAuditStartup({ profile, directory, executable = profile?.executable, args = [], commandSandbox = false }) {
  if (process.platform !== 'darwin') throw new Error('Audit startup write protection requires macOS sandbox-exec');
  // Direct CLI callers use one explicit shape: no resume/review subcommand,
  // config overlays or sandbox-bypass flags can replace the inner task policy.
  const directExec = Array.isArray(args) && args.length === 8 && args[0] === 'exec'
    && args[1] === '--json' && args[2] === '--sandbox' && ['read-only', 'workspace-write'].includes(args[3])
    && args[4] === '--cd' && typeof args[5] === 'string' && isAbsolute(args[5]) && args[6] === '--';
  if (typeof profile?.home !== 'string' || typeof directory !== 'string' || typeof executable !== 'string'
    || !isAbsolute(profile.home) || !isAbsolute(directory) || !isAbsolute(executable)
    || [profile.home, directory, executable, profile.userHome ?? ''].some(value => /[\x00-\x1f\x7f]/.test(value))
    || (profile.userHome !== undefined && (typeof profile.userHome !== 'string' || !isAbsolute(profile.userHome)))
    || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || typeof commandSandbox !== 'boolean'
    || commandSandbox && (args[0] === 'exec' ? !directExec : args.at(-1) !== 'app-server'))
    throw new Error('Invalid audit startup protection options');
  let home;
  try { home = await realpath(profile.home); } catch { throw new Error('Audit profile home must exist and resolve canonically'); }
  const homeInfo = await lstat(home);
  if (!homeInfo.isDirectory()) throw new Error('Audit profile home must be a directory');
  await access(SANDBOX_EXEC, constants.X_OK);
  const policyDirectory = resolve(directory);
  await mkdir(policyDirectory, { mode: 0o700 }); // exclusive: an existing directory is a hard failure
  try {
    await assertPrivateDirectory(policyDirectory);
    const profileProtected = PROTECTED.map(item => join(home, item));
    const userProtected = typeof profile.userHome === 'string' && profile.userHome
      ? [...PROTECTED.filter(item => item !== 'auth.json').map(item => join(profile.userHome, item)),
        join(profile.userHome, '.agents', 'skills')] : [];
    const protectedPaths = new Set([...profileProtected, ...userProtected].flatMap(lexical => {
      return [lexical, canonicalFuturePath(lexical)];
    }));
    // A saved skill may be a link into a separately owned installed package.
    // Protect that target in place too, without copying or reading its bytes.
    let entries = 0;
    const visited = new Set();
    async function protectLinks(target, depth = 0) {
      if (++entries > 2048 || depth > 12) throw new Error('Audit startup settings exceed protection bounds');
      let info;
      try { info = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (info.isSymbolicLink()) {
        const canonical = await realpath(target);
        const packageRoot = basename(canonical) === 'SKILL.md' ? dirname(canonical) : canonical;
        protectedPaths.add(packageRoot);
        await protectLinks(packageRoot, depth + 1);
      } else if (info.isDirectory()) {
        const canonical = await realpath(target);
        if (visited.has(canonical)) return;
        visited.add(canonical);
        for (const name of await readdir(target)) await protectLinks(join(target, name), depth + 1);
      } else if (!info.isFile() || info.nlink !== 1) throw new Error('Audit startup settings cannot be protected safely');
    }
    for (const target of [...profileProtected, ...userProtected]) await protectLinks(target);
    if (commandSandbox && directExec && args[3] === 'workspace-write') {
      const workspace = await realpath(args[5]);
      const contains = (parent, child) => parent === child || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
      if ([...protectedPaths].some(path => contains(workspace, path) || contains(path, workspace)))
        throw new Error('Direct audit workspace overlaps protected profile settings');
    }
    const transition = [];
    const commandImages = commandSandbox ? await supportedCodexCommandImages(executable) : null;
    if (commandSandbox) {
      const processImages = commandImages.processImages;
      const wrappers = commandImages.wrappers;
      const protectedImages = [...new Set([await realpath(executable), ...processImages])];
      // Only this trusted image may hand a command to Apple's sandbox launcher.
      // Prevent a startup helper from re-entering that image to obtain the
      // exception. Initial sandbox-exec -> native is the sole allowed entry.
      // Task children receive Codex's independent workspace/network sandbox;
      // they do not inherit this transition permission.
      for (const image of protectedImages) transition.push(`(deny file-write* (literal ${quote(image)}))`);
      for (const native of processImages) {
        transition.push(
          `(with-filter (process-path ${quote(native)}) (allow process-exec (literal ${quote(SANDBOX_EXEC)}) (with no-sandbox)))`,
          `(deny process-exec (require-all (literal ${quote(native)}) (require-not (process-path ${quote(SANDBOX_EXEC)}))))`);
      }
      for (const image of protectedImages) {
        for (let parent = dirname(image); ; parent = dirname(parent)) {
          transition.push(`(deny file-write-unlink (literal ${quote(parent)}))`);
          if (parent === dirname(parent)) break;
        }
      }
    }
    // Native atomic auth/config saves can create a randomly named sibling before
    // replacing the destination. Deny new root-level siblings as well as the
    // saved files; only explicitly identified native runtime entries are writable.
    const rootFiles = `(deny file-write* (require-all (regex ${quote(`^${regexPath(home)}/[^/]+$`)}) (require-not (require-any ${RUNTIME_ROOT_ENTRIES.map(name => `(literal ${quote(join(home, name))})`).join(' ')}))))`;
    const ancestors = new Set();
    for (const path of [home, ...protectedPaths]) {
      for (let parent = path; ; parent = dirname(parent)) {
        ancestors.add(parent);
        if (parent === dirname(parent)) break;
      }
    }
    const policy = ['(version 1)', '(allow default)', ...[...protectedPaths].map(path => `(deny file-write* (subpath ${quote(path)}))`), rootFiles,
      ...[...ancestors].map(path => `(deny file-write-unlink (literal ${quote(path)}))`),
      ...transition].join('\n') + '\n';
    const policyPath = join(policyDirectory, 'startup.sb');
    await writeFile(policyPath, policy, { flag: 'wx', mode: 0o600 });
    const policyInfo = await lstat(policyPath);
    if (!policyInfo.isFile() || policyInfo.isSymbolicLink() || policyInfo.uid !== process.getuid() || (policyInfo.mode & 0o077))
      throw new Error('Audit startup policy file is not private and canonical');
    return { executable: SANDBOX_EXEC, args: ['-f', policyPath, commandImages?.launchImage ?? executable, ...args],
      metadata: { mechanism: 'macos-sandbox-exec', policyPath, protectedPaths: [...protectedPaths],
        commandSandboxTransition: commandSandbox ? 'native-image-only-with-reentry-denied' : 'disabled' } };
  } catch (error) {
    // Keep the fresh runtime for inspection/recovery; callers must block launch.
    throw error;
  }
}
