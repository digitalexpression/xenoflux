#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function commit(ref) {
  try { return git('rev-parse', '--verify', `${ref}^{commit}`).trim(); }
  catch { throw new Error(`Missing commit ${ref}. Fetch the remote before checking public history.`); }
}

function check() {
  const args = process.argv.slice(2);
  const ranges = [];
  if (args[0] === '--pre-push' && args.length === 2) {
    for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
      const fields = line.split(/\s+/);
      if (fields.length !== 4) throw new Error('Invalid pre-push ref update.');
      const [, local, , remote] = fields;
      if (/^0+$/.test(local)) continue;
      ranges.push([commit(/^0+$/.test(remote) ? `refs/remotes/${args[1]}/main` : remote), commit(local)]);
    }
  } else if (!args.length || (args[0] === '--base' && args.length === 2)) {
    ranges.push([commit(args[1] || 'refs/remotes/origin/main'), commit('HEAD')]);
  } else {
    throw new Error('Usage: check-public-history.mjs [--base <revision> | --pre-push <remote>]');
  }

  if (!ranges.length) return;
  const paths = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
  for (const [base, tip] of ranges) {
    for (const path of git('ls-tree', '-r', '-z', '--name-only', tip).split('\0').filter(Boolean)) paths.add(path);
    for (const path of git('log', '--format=', '--name-only', '--diff-merges=separate', '--no-renames', '-z', `${base}..${tip}`).split('\0').filter(Boolean)) paths.add(path);
  }
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    input: [...paths].join('\0') + '\0', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (ignored.error) throw ignored.error;
  if (ignored.status !== 0 && ignored.status !== 1) throw new Error(ignored.stderr.trim());
  const forbidden = ignored.stdout.split('\0').filter(Boolean);
  if (forbidden.length) throw new Error(`Ignored paths are tracked or present in outgoing history:\n${forbidden.map(path => `  ${path}`).join('\n')}\nRemove them from every outgoing commit before pushing.`);
}

try {
  check();
  console.log('Public history path check passed. Review commit messages and file contents before pushing.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
