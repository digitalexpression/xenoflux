import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, chmod, symlink, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { authorizeAuditWorkspaceParent, cleanupAuditWorkspace, createAuditWorkspace, inspectAuditRepository, setAuditWorkspaceActive, snapshotAuditWorkspace } from '../src/audit-workspace.js';
import { compareAuditWorkspaceDelta } from '../src/audit-runner.js';

function command(bin, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@invalid' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; child.stdout.on('data', x => out.push(x)); child.stderr.on('data', x => err.push(x));
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(Buffer.concat(out).toString().trim()) : reject(new Error(Buffer.concat(err).toString())));
    child.stdin.end(input);
  });
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-audit-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, 'audits'); await mkdir(base, { mode: 0o700 });
  const runDirectory = join(base, 'run-1'); await mkdir(runDirectory, { mode: 0o700 });
  const owner = { experimentId: 'experiment-1', runId: 'run-1' };
  await authorizeAuditWorkspaceParent({ parentDirectory: runDirectory, baseDirectory: base, owner });
  const repository = join(root, 'source'); await mkdir(repository);
  await command('git', ['init', '--quiet', repository], root);
  await command('git', ['-C', repository, 'config', 'user.name', 'Fixture'], root);
  await command('git', ['-C', repository, 'config', 'user.email', 'fixture@invalid'], root);
  await writeFile(join(repository, 'README.md'), 'base\n');
  await writeFile(join(repository, 'program.sh'), '#!/bin/sh\necho base\n', { mode: 0o755 });
  await writeFile(join(repository, 'payload.bin'), Buffer.from([0, 255, 1, 2]));
  await writeFile(join(repository, 'delete.me'), 'remove me\n');
  await command('git', ['-C', repository, 'add', '-A'], root);
  await command('git', ['-C', repository, 'commit', '-qm', 'base'], root);
  const commit = await command('git', ['-C', repository, 'rev-parse', 'HEAD'], root);
  await writeFile(join(repository, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(repository, 'ignored.txt'), 'ignored secret\n');
  await command('git', ['-C', repository, 'add', '.gitignore'], root);
  await command('git', ['-C', repository, 'commit', '-qm', 'ignore rule'], root);
  const resolvedCommit = await command('git', ['-C', repository, 'rev-parse', 'HEAD'], root);
  return { root, base, runDirectory, owner, repository, baseCommit: commit, commit: resolvedCommit, workspace: join(runDirectory, 'workspace') };
}

test('inspect pins the selected commit and records dirty source state without using it as input', async t => {
  const f = await fixture(t);
  const result = await inspectAuditRepository(f.repository, f.commit);
  assert.equal(result.clean, true); assert.equal(result.repository, await realpath(f.repository)); assert.equal(result.commit, f.commit);
  assert.equal(result.sourceHead, f.commit); assert.equal(result.selectedRevision, f.commit); assert.equal(result.sourceDirty, false);
  assert.equal(result.files, 5); // README, executable, binary, deletion fixture, .gitignore
  await writeFile(join(f.repository, 'untracked.txt'), 'dirty');
  const untracked = await inspectAuditRepository(f.repository, f.commit);
  assert.equal(untracked.clean, false); assert.equal(untracked.sourceDirty, true); assert.equal(untracked.commit, f.commit);
  await writeFile(join(f.repository, 'README.md'), 'edited');
  const tracked = await inspectAuditRepository(f.repository, f.commit);
  assert.equal(tracked.clean, false); assert.equal(tracked.commit, f.commit);
});

test('inspects an explicitly selected non-HEAD commit while preserving dirty tracked and untracked work', async t => {
  const f = await fixture(t);
  await command('git', ['-C', f.repository, 'branch', 'baseline', f.baseCommit], f.root);
  await writeFile(join(f.repository, 'README.md'), 'uncommitted change\n');
  await writeFile(join(f.repository, 'untracked-secret.txt'), 'must not enter workspace');
  const result = await inspectAuditRepository(f.repository, 'baseline');
  assert.equal(result.selectedRevision, 'baseline');
  assert.equal(result.commit, f.baseCommit);
  assert.notEqual(result.sourceHead, result.commit);
  assert.equal(result.clean, false);
  assert.equal(result.sourceDirty, true);
  assert.equal(result.tree, (await command('git', ['-C', f.repository, 'rev-parse', `${f.baseCommit}^{tree}`], f.root)));
  assert.equal(await readFile(join(f.repository, 'README.md'), 'utf8'), 'uncommitted change\n');
  assert.equal(await readFile(join(f.repository, 'untracked-secret.txt'), 'utf8'), 'must not enter workspace');
});

test('materializes the inspected immutable commit after source worktree and HEAD change', async t => {
  const f = await fixture(t), pinned = await inspectAuditRepository(f.repository, f.commit);
  await writeFile(join(f.repository, 'README.md'), 'later dirty edit\n');
  await writeFile(join(f.repository, 'untracked-later.txt'), 'later untracked');
  await command('git', ['-C', f.repository, 'checkout', '--quiet', '--detach', f.commit], f.root);
  await writeFile(join(f.repository, 'README.md'), 'new head content\n');
  await command('git', ['-C', f.repository, 'add', 'README.md'], f.root);
  await command('git', ['-C', f.repository, 'commit', '-qm', 'new source head'], f.root);
  const created = await createAuditWorkspace({ repository: f.repository, commit: pinned.commit, directory: f.workspace, owner: f.owner });
  assert.equal(created.sourceCommit, pinned.commit);
  assert.equal(created.sourceTree, pinned.tree);
  assert.equal(await readFile(join(f.workspace, 'README.md'), 'utf8'), 'base\n');
  assert.equal(await readFile(join(f.repository, 'README.md'), 'utf8'), 'new head content\n');
  assert.equal(await readFile(join(f.repository, 'untracked-later.txt'), 'utf8'), 'later untracked');
});

test('creates private independent workspace from committed tree and preserves source state', async t => {
  const f = await fixture(t), before = await command('git', ['-C', f.repository, 'status', '--porcelain=v1', '-z'], f.root);
  const created = await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });
  assert.equal(created.sourceCommit, f.commit);
  assert.equal(await readFile(join(f.workspace, 'README.md'), 'utf8'), 'base\n');
  assert.equal(await readFile(join(f.workspace, 'payload.bin'), 'hex'), '00ff0102');
  assert.equal((await stat(join(f.workspace, 'program.sh'))).mode & 0o111 ? 1 : 0, 1);
  await assert.rejects(stat(join(f.workspace, 'ignored.txt')), { code: 'ENOENT' });
  assert.equal(await command('git', ['-C', f.workspace, 'remote'], f.root), '');
  assert.equal(await command('git', ['-C', f.repository, 'status', '--porcelain=v1', '-z'], f.root), before);
  assert.equal(await lstat(join(f.workspace, '.git', 'config')).then(x => x.mode & 0o777), 0o644);
});

test('initializes the private Git index so ordinary status and diff show only task changes', async t => {
  const f = await fixture(t), sourceStatus = await command('git', ['-C', f.repository, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], f.root);
  await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });

  assert.equal(await command('git', ['-C', f.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], f.root), '');
  assert.equal(await command('git', ['-C', f.workspace, 'diff', '--name-only'], f.root), '');
  assert.deepEqual(new Set((await command('git', ['-C', f.workspace, 'ls-files', '-z'], f.root)).split('\0').filter(Boolean)),
    new Set(['README.md', 'program.sh', 'payload.bin', 'delete.me', '.gitignore']));

  await writeFile(join(f.workspace, 'README.md'), 'task edit\n');
  await writeFile(join(f.workspace, 'task-output.txt'), 'new task file\n');
  const status = await command('git', ['-C', f.workspace, 'status', '--porcelain=v1', '--untracked-files=all'], f.root);
  assert.match(status, /M README\.md/);
  assert.match(status, /\?\? task-output\.txt/);
  assert.deepEqual(new Set((await command('git', ['-C', f.workspace, 'diff', '--name-only'], f.root)).split('\n').filter(Boolean)), new Set(['README.md']));
  assert.equal(await command('git', ['-C', f.repository, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], f.root), sourceStatus);
});

test('keeps committed ignored paths tracked in the private workspace index', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, 'ignored.txt'), 'committed despite ignore\n');
  await command('git', ['-C', f.repository, 'add', '--force', 'ignored.txt'], f.root);
  await command('git', ['-C', f.repository, 'commit', '-qm', 'track ignored fixture'], f.root);
  const commit = await command('git', ['-C', f.repository, 'rev-parse', 'HEAD'], f.root);

  await createAuditWorkspace({ repository: f.repository, commit, directory: f.workspace, owner: f.owner });
  assert.equal(await readFile(join(f.workspace, 'ignored.txt'), 'utf8'), 'committed despite ignore\n');
  assert.match(await command('git', ['-C', f.workspace, 'ls-files', '--error-unmatch', 'ignored.txt'], f.root), /ignored\.txt/);
  assert.equal(await command('git', ['-C', f.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], f.root), '');
  assert.equal(await command('git', ['-C', f.workspace, 'diff', '--name-only'], f.root), '');
});

test('anchors snapshots and cleanup fingerprints to the owned source commit after task commits', async t => {
  const f = await fixture(t);
  const created = await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });
  const clean = await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'before-commit', owner: f.owner });
  await writeFile(join(f.workspace, 'README.md'), 'committed task edit\n');
  await command('git', ['-C', f.workspace, 'add', 'README.md'], f.root);
  await command('git', ['-C', f.workspace, 'commit', '-qm', 'task commit'], f.root);

  const taskEnd = await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'after-commit', owner: f.owner });
  assert.equal(taskEnd.status, 'changed');
  assert.equal(compareAuditWorkspaceDelta(clean, taskEnd).changedFileCount, 1);
  const readme = taskEnd.files.find(row => row.path === 'README.md');
  assert.equal(readme.oldOid, await command('git', ['-C', f.workspace, 'rev-parse', `${created.privateCommit}:README.md`], f.root));
  assert.equal(readme.newOid, await command('git', ['-C', f.workspace, 'rev-parse', 'HEAD:README.md'], f.root));

  await setAuditWorkspaceActive({ directory: f.workspace, owner: f.owner, active: false });
  await assert.rejects(cleanupAuditWorkspace(f.workspace, { owner: f.owner, expectedFingerprint: clean.fingerprint }), /changed since/);
  const preview = await cleanupAuditWorkspace(f.workspace, { owner: f.owner, expectedFingerprint: taskEnd.fingerprint });
  assert.equal(preview.wouldRemove, true);
  assert.equal(preview.files, 1);
});

test('snapshot captures edits, deletion, executable mode, binary data and untracked files privately', async t => {
  const f = await fixture(t); await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });
  await writeFile(join(f.workspace, 'README.md'), 'changed\n');
  await rm(join(f.workspace, 'delete.me'));
  await chmod(join(f.workspace, 'program.sh'), 0o600);
  await writeFile(join(f.workspace, 'payload.bin'), Buffer.from([9, 8, 0, 255]));
  await writeFile(join(f.workspace, 'new.txt'), 'new\n');
  await writeFile(join(f.workspace, 'ignored.txt'), 'private ignored output');
  const snap = await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'task-end', owner: f.owner });
  assert.equal((await stat(snap.patchPath)).mode & 0o777, 0o600);
  const patch = await readFile(snap.patchPath, 'utf8');
  assert.match(patch, /README\.md/); assert.match(patch, /new\.txt/); assert.match(patch, /payload\.bin/);
  assert.deepEqual(new Set(snap.files.map(row => row.path)), new Set(['README.md', 'delete.me', 'program.sh', 'payload.bin', 'new.txt', 'ignored.txt']));
  assert.equal(snap.files.find(row => row.path === 'ignored.txt').contentCaptured, false);
  assert.equal(snap.files.find(row => row.path === 'ignored.txt').oldOid, null);
  assert.equal(snap.files.find(row => row.path === 'README.md').oldOid, await command('git', ['-C', f.workspace, 'rev-parse', 'HEAD:README.md'], f.root));
  assert.equal(snap.files.find(row => row.path === 'README.md').newOid, await command('git', ['-C', f.workspace, 'hash-object', 'README.md'], f.root));
  assert.equal(snap.files.find(row => row.path === 'new.txt').oldOid, '0'.repeat(40));
  assert.equal(snap.files.find(row => row.path === 'delete.me').newOid, '0'.repeat(40));
  assert.equal(snap.files.find(row => row.path === 'payload.bin').binary, true);
  assert.equal(snap.files.find(row => row.path === 'delete.me').status, 'D');
  assert.equal(snap.fingerprint, (await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'check', owner: f.owner })).fingerprint);
});

test('compares real post-setup snapshots by tracked blob and ignored-file identity', async t => {
  const f = await fixture(t);
  await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });

  // Setup creates a dirty tracked baseline with the same byte length as HEAD.
  await writeFile(join(f.workspace, 'README.md'), 'setup\n');
  await writeFile(join(f.workspace, '.gitignore'), 'ignored-*.txt\n');
  await writeFile(join(f.workspace, 'ignored-unchanged.txt'), 'same\n');
  await writeFile(join(f.workspace, 'ignored-modified.txt'), 'setup\n');
  await writeFile(join(f.workspace, 'ignored-deleted.txt'), 'remove\n');
  const before = await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'post-setup', owner: f.owner });

  // The task makes another same-length tracked edit and changes ignored file
  // content/mode, deletes one ignored file, and adds a new ignored file.
  await writeFile(join(f.workspace, 'README.md'), 'task!\n');
  await writeFile(join(f.workspace, 'ignored-modified.txt'), 'task!\n');
  await chmod(join(f.workspace, 'ignored-modified.txt'), 0o700);
  await rm(join(f.workspace, 'ignored-deleted.txt'));
  await writeFile(join(f.workspace, 'ignored-added.txt'), 'new\n');
  const taskEnd = await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'task-end', owner: f.owner });

  const delta = compareAuditWorkspaceDelta(before, taskEnd);
  assert.equal(delta.changeCountStatus, 'known');
  assert.equal(delta.changedFileCount, 4);

  const setupReadme = before.files.find(row => row.path === 'README.md');
  const taskReadme = taskEnd.files.find(row => row.path === 'README.md');
  assert.equal(setupReadme.size, taskReadme.size);
  assert.notEqual(setupReadme.newOid, taskReadme.newOid);
  assert.equal(taskReadme.oldOid, (await command('git', ['-C', f.workspace, 'rev-parse', 'HEAD:README.md'], f.root)));

  const unchangedBefore = before.files.find(row => row.path === 'ignored-unchanged.txt');
  const unchangedAfter = taskEnd.files.find(row => row.path === 'ignored-unchanged.txt');
  assert.equal(unchangedBefore.sha256, unchangedAfter.sha256);
  assert.equal(unchangedBefore.newMode, unchangedAfter.newMode);
  const modifiedBefore = before.files.find(row => row.path === 'ignored-modified.txt');
  const modifiedAfter = taskEnd.files.find(row => row.path === 'ignored-modified.txt');
  assert.notEqual(modifiedBefore.sha256, modifiedAfter.sha256);
  assert.notEqual(modifiedBefore.newMode, modifiedAfter.newMode);
  assert.equal(modifiedAfter.newMode, '100755');
  assert.equal(taskEnd.files.some(row => row.path === 'ignored-deleted.txt'), false);
  assert.equal(taskEnd.files.find(row => row.path === 'ignored-added.txt').sha256,
    createHash('sha256').update('new\n').digest('hex'));
});

test('cleanup is preview-only until inactive and matching expected fingerprint', async t => {
  const f = await fixture(t); await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });
  await writeFile(join(f.workspace, 'ignored.txt'), 'first!');
  const snap = await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'end', owner: f.owner });
  await assert.rejects(cleanupAuditWorkspace(f.workspace, { owner: f.owner, expectedFingerprint: snap.fingerprint, apply: true }), /active/);
  await setAuditWorkspaceActive({ directory: f.workspace, owner: f.owner, active: false });
  const preview = await cleanupAuditWorkspace(f.workspace, { owner: f.owner });
  assert.equal(preview.wouldRemove, true);
  await writeFile(join(f.workspace, 'ignored.txt'), 'second');
  await assert.rejects(cleanupAuditWorkspace(f.workspace, { owner: f.owner, expectedFingerprint: snap.fingerprint }), /changed since/);
  await assert.rejects(cleanupAuditWorkspace(f.workspace, { owner: f.owner, expectedFingerprint: snap.fingerprint, apply: true }), /changed since/);
  await writeFile(join(f.workspace, 'later'), 'changed');
  await assert.rejects(cleanupAuditWorkspace(f.workspace, { owner: f.owner, expectedFingerprint: snap.fingerprint, apply: true }), /changed since/);
  const final = await snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'final', owner: f.owner });
  const removed = await cleanupAuditWorkspace(f.workspace, { owner: f.owner, expectedFingerprint: final.fingerprint, apply: true });
  assert.equal(removed.removed, true);
  await assert.rejects(stat(f.workspace), { code: 'ENOENT' });
});

test('snapshot refuses a changed local Git config before configured filters can run', async t => {
  const f = await fixture(t); await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });
  await writeFile(join(f.workspace, '.git', 'config'), '\n[filter "untrusted"]\n clean = "touch /tmp/xfx-audit-filter-ran"\n', { flag: 'a' });
  await assert.rejects(snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'blocked', owner: f.owner }), /ownership marker/);
});

test('snapshot refuses ignored special filesystem entries without a content identity', async t => {
  const f = await fixture(t); await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });
  await command('mkfifo', ['ignored.txt'], f.workspace);
  await assert.rejects(snapshotAuditWorkspace({ directory: f.workspace, outputDirectory: f.runDirectory, label: 'fifo', owner: f.owner }), /unsupported special filesystem entry/);
});

test('cleanup rejects tampered ownership markers, symlink paths, and unauthorized parents', async t => {
  const f = await fixture(t); await createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: f.workspace, owner: f.owner });
  await setAuditWorkspaceActive({ directory: f.workspace, owner: f.owner, active: false });
  await writeFile(join(f.workspace, '.git', '.xfx-audit-owner.json'), '{}');
  await assert.rejects(cleanupAuditWorkspace(f.workspace, { owner: f.owner }), /ownership marker/);
  const linked = join(f.runDirectory, 'linked'); await symlink(f.workspace, linked);
  await assert.rejects(cleanupAuditWorkspace(linked, { owner: f.owner }), /symbolic link/);
  await assert.rejects(createAuditWorkspace({ repository: f.repository, commit: f.commit, directory: join(f.root, 'elsewhere'), owner: f.owner }), /workspace child/);
});

test('rejects Git LFS pointers and submodule entries with explicit reasons', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repository, 'lfs.dat'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 4\n');
  await command('git', ['-C', f.repository, 'add', 'lfs.dat'], f.root); await command('git', ['-C', f.repository, 'commit', '-qm', 'lfs pointer'], f.root);
  await assert.rejects(inspectAuditRepository(f.repository), /unsupported Git LFS pointer/);
  await command('git', ['-C', f.repository, 'rm', 'lfs.dat'], f.root); await command('git', ['-C', f.repository, 'commit', '-qm', 'remove pointer'], f.root);
  const treeish = await command('git', ['-C', f.repository, 'rev-parse', 'HEAD'], f.root);
  await command('git', ['-C', f.repository, 'update-index', '--add', '--cacheinfo', `160000,${treeish},vendor/sub`], f.root);
  await command('git', ['-C', f.repository, 'commit', '-qm', 'submodule entry'], f.root);
  await assert.rejects(inspectAuditRepository(f.repository), /unsupported submodule/);
});
