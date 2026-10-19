// Private committed-tree workspaces for controlled audit experiments.
// This module never launches Codex and never writes to the source repository.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const PARENT_MARKER = '.xfx-audit-parent.json';
const OWNER_MARKER = '.xfx-audit-owner.json';
const ACTIVE_MARKER = '.xfx-audit-active';
const MAX_TREE_ENTRIES = 50000;
const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_PATCH_BYTES = 64 * 1024 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_BLOB_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_MS = 120_000;

function run(command, args, { cwd, input, maxBuffer = 8 * 1024 * 1024, env = {}, timeoutMs = MAX_COMMAND_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const minimal = Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const child = spawn(command, args, { cwd, detached: true, env: { ...minimal, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = []; let outSize = 0, timedOut = false, overflow = false, settled = false;
    const killGroup = signal => { if (!child.pid) return; try { process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 500).unref(); }, timeoutMs);
    timer.unref();
    child.stdout.on('data', chunk => { outSize += chunk.length; if (outSize > maxBuffer) { overflow = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 500).unref(); } else stdout.push(chunk); });
    child.stderr.on('data', () => {});
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (timedOut) return reject(new Error('Audit Git command exceeded its time limit'));
      if (overflow) return reject(new Error('Audit Git command exceeded its output limit'));
      if (code !== 0) return reject(new Error(`Command failed (${basename(command)} ${args[0] ?? ''}, exit ${code})`));
      resolvePromise(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

function git(repository, ...args) {
  const last = args.at(-1);
  const options = last && typeof last === 'object' && !Array.isArray(last) ? args.pop() : {};
  return run('git', ['-C', repository, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], options);
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function inside(parent, path) { const rel = relative(parent, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino) }; }
function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`Audit workspace requires a valid ${label}`);
  return value;
}
function ownerIds(owner) {
  if (!owner || typeof owner !== 'object') throw new Error('Audit workspace requires experimentId and runId ownership');
  return { experimentId: safeId(owner.experimentId, 'experimentId'), runId: safeId(owner.runId, 'runId') };
}
async function canonicalDirectory(path, label) {
  const requestedInfo = await lstat(path);
  if (requestedInfo.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const canonical = await realpath(path), info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a canonical directory`);
  return { canonical, info };
}
async function readJson(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024) throw new Error('Audit workspace authority marker is unsafe');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function digestRegularFile(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Audit workspace file is unsafe or exceeds snapshot limits');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Audit workspace file changed during snapshot');
    const digest = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, opened.size - offset), offset);
      if (!bytesRead) throw new Error('Audit workspace file changed during snapshot');
      digest.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
      throw new Error('Audit workspace file changed during snapshot');
    return { sha256: digest.digest('hex'), size: offset };
  } finally { await handle.close(); }
}
async function gitConfigHash(directory) {
  return (await digestRegularFile(join(directory, '.git', 'config'), 1024 * 1024)).sha256;
}
async function* blobBatches(repository, entries, { maxBytes = MAX_BLOB_BATCH_BYTES, maxEntries = 512, maxBuffer = MAX_BLOB_BATCH_BYTES + 1024 * 1024 } = {}) {
  for (let start = 0; start < entries.length;) {
    let end = start, bytes = 0;
    while (end < entries.length && end - start < maxEntries && (end === start || bytes + entries[end].size <= maxBytes)) {
      bytes += entries[end].size; end++;
    }
    const selected = entries.slice(start, end);
    const outputLimit = Math.max(maxBuffer, bytes + selected.length * 128 + 1);
    const output = await git(repository, 'cat-file', '--batch', { input: Buffer.from(`${selected.map(entry => entry.oid).join('\n')}\n`), maxBuffer: outputLimit });
    const blobs = []; let offset = 0;
    for (const entry of selected) {
      const lineEnd = output.indexOf(0x0a, offset);
      if (lineEnd < 0) throw new Error('Audit repository returned incomplete blob data');
      const [oid, type, sizeText] = output.subarray(offset, lineEnd).toString('ascii').split(' ');
      const size = Number(sizeText), contentStart = lineEnd + 1, contentEnd = contentStart + size;
      if (oid !== entry.oid || type !== 'blob' || size !== entry.size || contentEnd >= output.length || output[contentEnd] !== 0x0a)
        throw new Error('Audit repository returned inconsistent blob data');
      blobs.push({ entry, bytes: output.subarray(contentStart, contentEnd) }); offset = contentEnd + 1;
    }
    yield blobs;
    start = end;
  }
}
async function writeExclusive(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}
async function getRepository(repository) {
  if (typeof repository !== 'string' || !repository.trim()) throw new Error('Choose a Git repository path');
  let input;
  try { input = await realpath(repository); } catch { throw new Error('Audit repository does not exist'); }
  const top = (await git(input, 'rev-parse', '--show-toplevel')).toString('utf8').trim();
  const canonical = await realpath(top);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Audit repository root is unsafe');
  return canonical;
}

async function inspectTree(repository, commit) {
  const output = await git(repository, 'ls-tree', '-rlz', '-r', '--full-tree', commit, { maxBuffer: 16 * 1024 * 1024 });
  const entries = []; let totalBytes = 0;
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'), header = record.slice(0, tab).trim().split(/\s+/), path = record.slice(tab + 1);
    const [mode, type, oid, sizeText] = header;
    if (!path || path.startsWith('/') || path.split('/').some(part => part === '..' || part.toLowerCase() === '.git') || path.includes('\0')) throw new Error('Audit repository contains an unsafe Git path');
    if (mode === '160000' || type === 'commit') throw new Error('Audit repository contains an unsupported submodule');
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode)) throw new Error('Audit repository contains an unsupported Git object mode');
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Audit repository tree has invalid file metadata');
    if (size > MAX_BLOB_BYTES) throw Object.assign(new Error('Audit repository contains a file above the 64 MiB workspace limit'), { code: 'repository-limit' });
    totalBytes += size;
    if (entries.length >= MAX_TREE_ENTRIES || totalBytes > MAX_TREE_BYTES)
      throw Object.assign(new Error('Audit repository tree exceeds workspace limits'), { code: 'repository-limit' });
    entries.push({ path, mode, oid, size });
  }
  // LFS pointer blobs are not the source content. Refuse rather than silently
  // materialize pointer text. Batch small blobs to keep the check bounded and
  // avoid one subprocess per source file.
  const smallBlobs = entries.filter(entry => entry.size <= 1024);
  if (smallBlobs.length) {
    for await (const blobs of blobBatches(repository, smallBlobs, { maxBytes: 48 * 1024 * 1024, maxEntries: MAX_TREE_ENTRIES, maxBuffer: 64 * 1024 * 1024 }))
      for (const { bytes } of blobs) if (bytes.subarray(0, 64).toString('utf8').startsWith('version https://git-lfs.github.com/spec/v1\noid sha256:'))
        throw new Error('Audit repository contains an unsupported Git LFS pointer');
  }
  return { entries, bytes: totalBytes, tree: (await git(repository, 'rev-parse', `${commit}^{tree}`)).toString('utf8').trim() };
}

/** Resolve a committed source snapshot without changing the source repository.
 * The worktree status is recorded as context only; execution input always comes
 * from the resolved commit object, never from the working tree or index.
 */
export async function inspectAuditRepository(repository, revision = 'HEAD') {
  const canonical = await getRepository(repository);
  if (typeof revision !== 'string' || !revision.trim() || /[\0\r\n]/.test(revision)) throw new Error('Choose an explicit Git revision');
  let commit, sourceHead;
  try {
    // Resolve both names to immutable object IDs. In particular, callers must
    // pass `commit` onward instead of resolving a moving branch a second time.
    commit = (await git(canonical, 'rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`)).toString('utf8').trim();
    sourceHead = (await git(canonical, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}')).toString('utf8').trim();
  }
  catch { throw new Error('Audit revision must resolve to a Git commit'); }
  const status = await git(canonical, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', { maxBuffer: 16 * 1024 * 1024 });
  const clean = status.length === 0;
  let tree;
  try { tree = await inspectTree(canonical, commit); }
  catch (error) {
    if (!error.code && /output limit|workspace limits|file count limit/.test(error.message)) error.code = 'repository-limit';
    throw error;
  }
  // `git archive` and checkout filters are intentionally avoided. Tree capture
  // uses Git blobs directly and therefore never reads ignored/untracked files.
  return { repository: canonical, selectedRevision: revision, commit, tree: tree.tree,
    sourceHead, clean, sourceDirty: !clean, files: tree.entries.length, bytes: tree.bytes,
    sourceIdentity: { dev: String((await lstat(canonical)).dev), gitDirectory: (await git(canonical, 'rev-parse', '--absolute-git-dir')).toString('utf8').trim() } };
}

/** Authorize an existing private run directory while preserving its contents. */
export async function authorizeAuditWorkspaceParent({ parentDirectory, baseDirectory, owner } = {}) {
  const ids = ownerIds(owner);
  if (typeof baseDirectory !== 'string' || !baseDirectory.trim()) throw new Error('Audit workspace requires a canonical authority baseDirectory');
  const base = await canonicalDirectory(baseDirectory, 'Authority base');
  const parent = await canonicalDirectory(parentDirectory, 'Audit run directory');
  if (!inside(base.canonical, parent.canonical)) throw new Error('Audit run directory must be inside its authority base');
  if ((parent.info.mode & 0o077) !== 0) throw new Error('Audit run directory must be private (mode 0700)');
  const marker = { schemaVersion: 1, kind: 'xfx-audit-workspace-parent', ...ids, baseDirectory: base.canonical,
    parentDirectory: parent.canonical, parentIdentity: identity(parent.info), authorityId: randomUUID() };
  await writeExclusive(join(parent.canonical, PARENT_MARKER), marker);
  return marker;
}

async function authority(directory, owner) {
  const ids = ownerIds(owner);
  const workspace = await canonicalDirectory(directory, 'Audit workspace');
  const parent = await canonicalDirectory(dirname(workspace.canonical), 'Audit workspace parent');
  const parentRecord = await readJson(join(parent.canonical, PARENT_MARKER));
  if (parentRecord.schemaVersion !== 1 || parentRecord.kind !== 'xfx-audit-workspace-parent'
    || parentRecord.experimentId !== ids.experimentId || parentRecord.runId !== ids.runId
    || parentRecord.parentDirectory !== parent.canonical || !inside(parentRecord.baseDirectory, parent.canonical)
    || parentRecord.parentIdentity?.dev !== String(parent.info.dev) || parentRecord.parentIdentity?.ino !== String(parent.info.ino))
    throw new Error('Audit workspace parent authority does not match this run');
  const markerPath = join(parent.canonical, `${basename(workspace.canonical)}.xfx-audit-authority.json`);
  const outside = await readJson(markerPath);
  const gitDirectory = join(workspace.canonical, '.git');
  const gitStat = await lstat(gitDirectory);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error('Audit workspace Git directory is unsafe');
  const insideMarker = await readJson(join(gitDirectory, OWNER_MARKER));
  const currentConfigHash = await gitConfigHash(workspace.canonical);
  for (const candidate of [outside, insideMarker]) {
    if (candidate.schemaVersion !== 1 || candidate.kind !== 'xfx-audit-workspace' || candidate.experimentId !== ids.experimentId
      || candidate.runId !== ids.runId || candidate.directory !== workspace.canonical || candidate.parentAuthorityId !== parentRecord.authorityId
      || candidate.workspaceIdentity?.dev !== String(workspace.info.dev) || candidate.workspaceIdentity?.ino !== String(workspace.info.ino)
      || candidate.gitIdentity?.dev !== String(gitStat.dev) || candidate.gitIdentity?.ino !== String(gitStat.ino)
      || candidate.gitConfigSha256 !== currentConfigHash)
      throw new Error('Audit workspace ownership marker does not match this run');
  }
  if (outside.privateCommit !== insideMarker.privateCommit || outside.sourceTree !== insideMarker.sourceTree
    || outside.sourceCommit !== insideMarker.sourceCommit || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(insideMarker.privateCommit ?? ''))
    throw new Error('Audit workspace source snapshot authority does not match');
  const pinnedCommit = (await git(workspace.canonical, 'rev-parse', '--verify', '--end-of-options', `${insideMarker.privateCommit}^{commit}`)).toString('utf8').trim();
  const pinnedTree = (await git(workspace.canonical, 'rev-parse', '--verify', '--end-of-options', `${insideMarker.privateCommit}^{tree}`)).toString('utf8').trim();
  if (pinnedCommit !== insideMarker.privateCommit || pinnedTree !== insideMarker.sourceTree)
    throw new Error('Audit workspace source snapshot is unavailable or inconsistent');
  return { ids, workspace: workspace.canonical, workspaceInfo: workspace.info, parent: parent.canonical, parentRecord, outside, insideMarker,
    baselineCommit: insideMarker.privateCommit };
}

async function materialize(repository, commit, entries, directory) {
  for await (const blobs of blobBatches(repository, entries)) {
    for (const { entry, bytes } of blobs) {
      const target = resolve(directory, ...entry.path.split('/'));
      if (!inside(directory, target)) throw new Error('Audit commit contains a path outside the workspace');
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      if (entry.mode === '120000') {
        const link = bytes.toString('utf8');
        if (!link || isAbsolute(link) || !inside(directory, resolve(dirname(target), link))) throw new Error('Audit commit contains an escaping symlink');
        await symlink(link, target);
      } else {
        await writeFile(target, bytes, { mode: entry.mode === '100755' ? 0o700 : 0o600, flag: 'wx' });
      }
    }
  }
}

/** Create a detached private repository containing exactly the selected tree. */
export async function createAuditWorkspace({ repository, commit, directory, owner } = {}) {
  const ids = ownerIds(owner);
  const source = await inspectAuditRepository(repository, commit);
  if (source.commit !== commit) throw new Error('Workspace commit must be the resolved full commit ID');
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Choose a workspace directory');
  const requested = resolve(directory), parent = await canonicalDirectory(dirname(requested), 'Audit run directory');
  if (basename(requested) !== 'workspace') throw new Error('Audit workspace must be the workspace child of its authorized run directory');
  const resolved = join(parent.canonical, 'workspace');
  if (parent.info.mode & 0o077) throw new Error('Audit run directory must be private (mode 0700)');
  const parentRecord = await readJson(join(parent.canonical, PARENT_MARKER));
  if (parentRecord.experimentId !== ids.experimentId || parentRecord.runId !== ids.runId || parentRecord.parentDirectory !== parent.canonical
      || !inside(parentRecord.baseDirectory, parent.canonical) || parentRecord.parentIdentity?.dev !== String(parent.info.dev)
      || parentRecord.parentIdentity?.ino !== String(parent.info.ino)) throw new Error('Audit run directory is not authorized for this run');
  let exists = true; try { await lstat(resolved); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (exists) throw new Error('Audit workspace already exists');
  await mkdir(resolved, { mode: 0o700 });
  const createdIdentity = identity(await lstat(resolved));
  try {
    await materialize(source.repository, source.commit, (await inspectTree(source.repository, source.commit)).entries, resolved);
    await run('git', ['init', '--quiet', '--template=', resolved]);
    const stagedIndex = join(parent.canonical, `.xfx-audit-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: stagedIndex, GIT_AUTHOR_NAME: 'xfx-audit', GIT_AUTHOR_EMAIL: 'xfx-audit@invalid', GIT_COMMITTER_NAME: 'xfx-audit', GIT_COMMITTER_EMAIL: 'xfx-audit@invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
    try {
      // Every path in this private tree came from the selected commit. Force
      // staging so committed files that match committed ignore rules remain
      // tracked in the private snapshot.
      await git(resolved, 'add', '--force', '-A', '--', { env, maxBuffer: 16 * 1024 * 1024 });
      const tree = (await git(resolved, 'write-tree', { env })).toString('utf8').trim();
      if (tree !== source.tree) throw new Error('Private workspace tree differs from selected source commit');
      const created = (await git(resolved, 'commit-tree', tree, '-m', 'xfx audit source snapshot', { env })).toString('utf8').trim();
      await git(resolved, 'update-ref', 'refs/heads/audit-source', created);
      await git(resolved, 'symbolic-ref', 'HEAD', 'refs/heads/audit-source');
      // The temporary index above is only used to build the immutable source
      // commit. Populate the workspace's own index from that commit so normal
      // Git commands see the materialized files as tracked baseline content.
      await git(resolved, 'read-tree', 'HEAD');
      await chmod(join(resolved, '.git'), 0o700);
    } finally { await rm(stagedIndex, { force: true }); await rm(`${stagedIndex}.lock`, { force: true }); }
    const wsStat = await lstat(resolved), gitStat = await lstat(join(resolved, '.git'));
    const marker = { schemaVersion: 1, kind: 'xfx-audit-workspace', ...ids, directory: resolved, repository: source.repository,
      sourceCommit: source.commit, sourceTree: source.tree, privateCommit: (await git(resolved, 'rev-parse', 'HEAD')).toString('utf8').trim(),
      workspaceIdentity: identity(wsStat), gitIdentity: identity(gitStat), gitConfigSha256: await gitConfigHash(resolved), parentAuthorityId: parentRecord.authorityId, createdAt: new Date().toISOString() };
    await writeExclusive(join(join(resolved, '.git'), OWNER_MARKER), marker);
    await writeExclusive(join(parent.canonical, `${basename(resolved)}.xfx-audit-authority.json`), marker);
    await writeExclusive(join(join(resolved, '.git'), ACTIVE_MARKER), { schemaVersion: 1, active: true });
    return { ...marker, active: true };
  } catch (error) {
    const current = await lstat(resolved).catch(() => null);
    if (current && current.isDirectory() && !current.isSymbolicLink() && current.dev === Number(createdIdentity.dev) && current.ino === Number(createdIdentity.ino))
      await rm(resolved, { recursive: true, force: true });
    throw error;
  }
}

async function collectDiff(directory, outputDirectory, baselineCommit) {
  const tempIndex = join(outputDirectory, `.xfx-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: tempIndex };
  try {
    const special = await run('find', [directory, '-path', join(directory, '.git'), '-prune', '-o', '(', '-type', 'p', '-o', '-type', 's', '-o', '-type', 'b', '-o', '-type', 'c', ')', '-print0'], { maxBuffer: 1024 * 1024 });
    if (special.length) throw new Error('Audit workspace contains an unsupported special filesystem entry');
    await git(directory, 'read-tree', baselineCommit, { env });
    await git(directory, 'add', '-A', '--', { env, maxBuffer: 16 * 1024 * 1024 });
    const patch = await git(directory, 'diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-renames', baselineCommit, '--', { env, maxBuffer: MAX_PATCH_BYTES });
    const raw = await git(directory, 'diff', '--cached', '--raw', '--no-abbrev', '-z', '--no-renames', baselineCommit, '--', { env, maxBuffer: 16 * 1024 * 1024 });
    const paths = raw.toString('utf8').split('\0').filter(Boolean);
    const records = [];
    for (let i = 0; i < paths.length;) {
      const header = paths[i++];
      if (!header.startsWith(':')) continue;
      const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(header);
      const path = paths[i++]; if (!path) break;
      const stat = await lstat(join(directory, ...path.split('/'))).catch(() => null);
      records.push({ path, status: match?.[5] ?? 'U', oldMode: match?.[1] ?? null, newMode: match?.[2] ?? null,
        oldOid: match?.[3] ?? null, newOid: match?.[4] ?? null,
        binary: false, size: stat?.isFile() ? stat.size : null, symlink: stat?.isSymbolicLink() ?? false });
    }
    const numstat = (await git(directory, 'diff', '--cached', '--numstat', '-z', '--no-renames', baselineCommit, '--', { env, maxBuffer: 16 * 1024 * 1024 })).toString('utf8').split('\0');
    for (let i = 0; i < numstat.length;) {
      const line = numstat[i++]; if (!line) continue;
      const [added, deleted, path] = line.split('\t'); const record = records.find(item => item.path === path);
      if (record) record.binary = added === '-' && deleted === '-';
    }
    const ignored = (await git(directory, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', { maxBuffer: 16 * 1024 * 1024 })).toString('utf8').split('\0').filter(Boolean);
    if (ignored.length + records.length > MAX_TREE_ENTRIES) throw new Error('Audit workspace diff exceeds the file count limit');
    let ignoredBytes = 0;
    for (const path of ignored) {
      const info = await lstat(join(directory, ...path.split('/'))).catch(() => null);
      if (!info || (!info.isSymbolicLink() && !info.isFile())) throw new Error('Audit workspace contains an unsupported ignored filesystem entry');
      let contentSha256 = null, size = null;
      if (info?.isSymbolicLink()) {
        const target = await readlink(join(directory, ...path.split('/'))), after = await lstat(join(directory, ...path.split('/')));
        if (after.dev !== info.dev || after.ino !== info.ino || !after.isSymbolicLink()) throw new Error('Ignored symlink changed during snapshot');
        const bytes = Buffer.from(target); size = bytes.length; contentSha256 = hash(bytes);
      } else if (info?.isFile()) {
        const digest = await digestRegularFile(join(directory, ...path.split('/')), MAX_TREE_BYTES - ignoredBytes);
        size = digest.size; contentSha256 = digest.sha256;
      }
      ignoredBytes += size ?? 0;
      if (ignoredBytes > MAX_TREE_BYTES) throw new Error('Ignored workspace files exceed snapshot size limit');
      records.push({ path, status: 'I', oldMode: null, newMode: info?.isSymbolicLink() ? '120000' : info?.isFile() ? (info.mode & 0o111 ? '100755' : '100644') : null,
        oldOid: null, newOid: null,
        binary: null, size, sha256: contentSha256, symlink: info?.isSymbolicLink() ?? false, ignored: true, contentCaptured: false });
    }
    records.sort((left, right) => left.path.localeCompare(right.path));
    return { patch, records };
  } finally { await rm(tempIndex, { force: true }); await rm(`${tempIndex}.lock`, { force: true }); }
}

function labelName(label) {
  const clean = typeof label === 'string' ? label.trim().replace(/[^A-Za-z0-9._-]+/g, '-') : '';
  if (!clean || clean === '.' || clean === '..' || clean.length > 80) throw new Error('Snapshot requires a short plain label');
  return clean;
}
async function ensureOutput(outputDirectory, workspace) {
  const output = await canonicalDirectory(outputDirectory, 'Snapshot output directory');
  if (inside(workspace, output.canonical) || output.canonical === workspace) throw new Error('Snapshot output must be outside the workspace');
  return output.canonical;
}

/** Capture a point-in-time diff without changing the workspace index. */
export async function snapshotAuditWorkspace({ directory, outputDirectory, label, owner } = {}) {
  const name = labelName(label), authorityInfo = await authority(directory, owner), workspace = await canonicalDirectory(authorityInfo.workspace, 'Audit workspace');
  const output = await ensureOutput(outputDirectory, workspace.canonical);
  const diff = await collectDiff(workspace.canonical, output, authorityInfo.baselineCommit);
  await authority(workspace.canonical, owner);
  const patchHash = hash(diff.patch), fingerprint = hash(Buffer.from(JSON.stringify({ patchHash, records: diff.records })));
  const patchPath = join(output, `${name}.patch`), metadataPath = join(output, `${name}.json`);
  const metadata = { schemaVersion: 1, kind: 'audit-workspace-snapshot', label: name, directory: workspace.canonical,
    capturedAt: new Date().toISOString(), status: diff.records.length ? 'changed' : 'clean', fingerprint, patchSha256: patchHash,
    patchBytes: diff.patch.length, files: diff.records, ignoredContentsEmbedded: false, ignoredContentFingerprint: 'sha256-per-path' };
  let patchCreated = false;
  try { await writeExclusive(patchPath, diff.patch); patchCreated = true; await chmod(patchPath, 0o600); await writeExclusive(metadataPath, metadata); }
  catch { if (patchCreated) await rm(patchPath, { force: true }); throw new Error('Snapshot could not be written without overwriting existing files'); }
  return { ...metadata, patchPath, metadataPath };
}

/** Mark the runner's lifecycle state for safe cleanup checks. */
export async function setAuditWorkspaceActive({ directory, owner, active } = {}) {
  const info = await authority(directory, owner);
  if (typeof active !== 'boolean') throw new Error('Workspace active state must be boolean');
  const path = join(info.workspace, '.git', ACTIVE_MARKER);
  if (active) await writeExclusive(path, { schemaVersion: 1, active: true });
  else { const marker = await readJson(path); if (marker.active !== true) throw new Error('Workspace active marker is invalid'); await rm(path); }
  return { directory: info.workspace, active };
}

/** Preview by default. Removal requires matching authority, inactive state and exact diff fingerprint. */
export async function cleanupAuditWorkspace(directory, { owner, expectedFingerprint, apply = false } = {}) {
  const info = await authority(directory, owner);
  const activePath = join(info.workspace, '.git', ACTIVE_MARKER);
  try { const marker = await readJson(activePath); if (marker.active) throw new Error('Audit workspace is active and cannot be removed'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await lstat(join(info.workspace, '.git', 'index.lock')); throw new Error('Audit workspace has an active Git lock'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const diff = await collectDiff(info.workspace, info.parent, info.baselineCommit);
  const fingerprint = hash(Buffer.from(JSON.stringify({ patchHash: hash(diff.patch), records: diff.records })));
  if (typeof expectedFingerprint === 'string' && expectedFingerprint !== fingerprint) throw new Error('Workspace changed since the expected fingerprint; cleanup refused');
  if (apply && (typeof expectedFingerprint !== 'string' || expectedFingerprint !== fingerprint)) throw new Error('Workspace changed since the expected fingerprint; cleanup refused');
  if (!apply) return { directory: info.workspace, wouldRemove: true, applyRequired: true, fingerprint, files: diff.records.length };
  const fresh = await authority(info.workspace, owner);
  if (fresh.workspaceInfo.dev !== info.workspaceInfo.dev || fresh.workspaceInfo.ino !== info.workspaceInfo.ino) throw new Error('Audit workspace identity changed; cleanup refused');
  await rm(info.workspace, { recursive: true, force: false });
  await rm(join(info.parent, `${basename(info.workspace)}.xfx-audit-authority.json`), { force: false });
  return { directory: info.workspace, removed: true, fingerprint };
}
