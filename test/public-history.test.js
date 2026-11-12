import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-public-history.mjs', import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'xfx-public-history-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(cwd, '.gitignore'), '/local/\n');
  git('add', '.gitignore'); git('commit', '-m', 'Public baseline');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return {
    cwd, env, git,
    check: (args = [], input) => spawnSync(process.execPath, [script, ...args], { cwd, env, input, encoding: 'utf8' }),
    privateFile: () => { mkdirSync(join(cwd, 'local'), { recursive: true }); writeFileSync(join(cwd, 'local/notes.md'), 'Private fixture'); },
  };
}

test('public history check permits clean work and ignored untracked context', t => {
  const f = fixture(t); f.privateFile();
  writeFileSync(join(f.cwd, 'README.md'), 'Public change');
  f.git('add', 'README.md'); f.git('commit', '-m', 'Describe public behavior');
  assert.equal(f.check().status, 0);
});

test('public history check rejects a force-staged private file', t => {
  const f = fixture(t); f.privateFile(); f.git('add', '-f', 'local/notes.md');
  const result = f.check();
  assert.equal(result.status, 1); assert.match(result.stderr, /local\/notes\.md/);
});

test('pre-push rejects private files committed then deleted on a new branch', t => {
  const f = fixture(t); f.privateFile(); f.git('add', '-f', 'local/notes.md'); f.git('commit', '-m', 'Private checkpoint');
  f.git('rm', 'local/notes.md'); f.git('commit', '-m', 'Remove notes');
  const result = f.check(['--pre-push', 'origin'], `refs/heads/topic ${f.git('rev-parse', 'HEAD')} refs/heads/topic ${'0'.repeat(40)}\n`);
  assert.equal(result.status, 1); assert.match(result.stderr, /local\/notes\.md/);
});

test('pre-push allows ref deletion without a baseline', t => {
  const f = fixture(t); f.git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.equal(f.check(['--pre-push', 'origin'], `refs/heads/topic ${'0'.repeat(40)} refs/heads/topic ${'a'.repeat(40)}\n`).status, 0);
});

test('pre-push checks existing ref updates and fails closed for unavailable remote tips', t => {
  const f = fixture(t); const base = f.git('rev-parse', 'HEAD');
  f.privateFile(); f.git('add', '-f', 'local/notes.md'); f.git('commit', '-m', 'Private checkpoint');
  const tip = f.git('rev-parse', 'HEAD');
  const result = f.check(['--pre-push', 'origin'], `refs/heads/topic ${tip} refs/heads/topic ${base}\n`);
  assert.equal(result.status, 1); assert.match(result.stderr, /local\/notes\.md/);
  const missing = f.check(['--pre-push', 'origin'], `refs/heads/topic ${tip} refs/heads/topic ${'a'.repeat(40)}\n`);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /Fetch the remote/);
});

test('installed hook blocks an actual local push before private history reaches the remote', t => {
  const f = fixture(t);
  const remote = join(f.cwd, 'remote.git');
  f.git('init', '--bare', remote); f.git('remote', 'add', 'origin', remote);
  copyFileSync(script, join(f.cwd, '.git/hooks/check-public-history.mjs'));
  const hook = join(f.cwd, '.git/hooks/pre-push');
  writeFileSync(hook, '#!/bin/sh\nset -eu\nexec node "$(git rev-parse --path-format=absolute --git-common-dir)/hooks/check-public-history.mjs" --pre-push "$1"\n');
  chmodSync(hook, 0o755);
  const push = ref => spawnSync('git', ['push', 'origin', ref], { cwd: f.cwd, env: f.env, encoding: 'utf8' });
  const clean = push('HEAD:refs/heads/main');
  assert.equal(clean.status, 0, clean.stderr);
  f.git('switch', '-c', 'topic');
  f.privateFile(); f.git('add', '-f', 'local/notes.md'); f.git('commit', '-m', 'Private checkpoint');
  f.git('rm', 'local/notes.md'); f.git('commit', '-m', 'Remove notes');
  const blocked = push('HEAD:refs/heads/topic');
  assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /local\/notes\.md/);
  assert.equal(f.git('ls-remote', '--heads', 'origin', 'refs/heads/topic'), '');
});
