// Host-side acceptance command. Never materialized in a model task repository.
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const markers = new Set(['.xfx-audit-owner.json', '.xfx-audit-active']);
export async function workspaceFiles(directory) {
  const files = {};
  async function walk(parent, relative = '') {
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && (entry.name === '.git' || markers.has(entry.name))) continue;
      const path = join(parent, entry.name), info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('fixture-unsafe-entry');
      if (info.isDirectory()) await walk(path, name);
      else files[name] = hash(await readFile(path));
    }
  }
  await walk(directory); return files;
}
export async function checkCandidate(manifestPath, taskId, workspace) {
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
  const task = manifest.tasks.find(task => task.id === taskId);
  if (!task || manifest.mode !== 'offline-preparation') throw new Error('fixture-manifest-invalid');
  const actual = await workspaceFiles(workspace), editable = new Set(task.editableFiles);
  if (Object.keys(actual).some(name => !Object.hasOwn(task.workspaceFiles, name))
    || Object.keys(task.workspaceFiles).some(name => !Object.hasOwn(actual, name)
      || !editable.has(name) && actual[name] !== task.workspaceFiles[name])) throw new Error('fixture-scope-changed');
  if (hash(await readFile(task.oracle.path)) !== task.oracle.sha256) throw new Error('fixture-oracle-changed');
  if (hash(await readFile(manifest.checker.path)) !== manifest.checker.sha256) throw new Error('fixture-checker-changed');
  const home = await mkdtemp(join(tmpdir(), 'xfx-evaluation-check-'));
  try {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: join(home, 'empty-native'),
      TMPDIR: home, TMP: home, TEMP: home, EVAL_WORKSPACE: await realpath(workspace) };
    const suites = [['visible', join(workspace, 'test/visible.test.js')], ['acceptance', task.oracle.path]].map(([name, path]) => {
      const result = spawnSync(process.execPath, ['--test', path], { cwd: workspace, env,
        encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      return { name, passed: result.status === 0 && !result.error, exitCode: result.status,
        stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    });
    const after = await workspaceFiles(workspace);
    if (Object.keys(actual).length !== Object.keys(after).length || Object.keys(actual).some(name => after[name] !== actual[name])
      || hash(await readFile(manifestPath)) !== hash(manifestBytes)
      || hash(await readFile(task.oracle.path)) !== task.oracle.sha256
      || hash(await readFile(manifest.checker.path)) !== manifest.checker.sha256) throw new Error('fixture-check-mutated-input');
    return { passed: suites.every(suite => suite.passed), suites,
      stdout: suites.map(suite => `${suite.name}:\n${suite.stdout}`).join('\n'), stderr: suites.map(suite => suite.stderr).join('\n') };
  } finally { await rm(home, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('fixture-arguments-invalid');
    const result = await checkCandidate(process.argv[2], process.argv[3], process.cwd());
    process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.passed ? 0 : 1;
  } catch { process.stderr.write('Evaluation acceptance rejected: scope, oracle or input unavailable.\n'); process.exitCode = 1; }
}
