#!/usr/bin/env node
// The packaged app is the tracked dist/ui build. Rebuild from web/ into a
// temporary folder and require byte-identical output, so a package never
// ships UI assets that differ from the reviewed source.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tracked = join(root, 'dist', 'ui');

async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await files(path));
    else out.push(path);
  }
  return out;
}

const temporary = await mkdtemp(join(tmpdir(), 'xfx-ui-build-'));
try {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join(root, 'web', 'vite.config.ts'), '--outDir', temporary, '--emptyOutDir', '--logLevel', 'warn'],
      { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', code => code === 0 ? done() : reject(new Error(`vite build exited ${code}`)));
  });
  const [built, kept] = await Promise.all([files(temporary), files(tracked).catch(() => [])]);
  const names = list => list.map(path => relative(list === built ? temporary : tracked, path)).sort();
  const builtNames = names(built), keptNames = names(kept);
  const problems = [];
  for (const name of new Set([...builtNames, ...keptNames])) {
    if (!keptNames.includes(name)) problems.push(`missing from dist/ui: ${name}`);
    else if (!builtNames.includes(name)) problems.push(`stale in dist/ui: ${name}`);
    else if (!(await readFile(join(temporary, name))).equals(await readFile(join(tracked, name)))) problems.push(`differs: ${name}`);
  }
  if (problems.length) {
    process.stderr.write(`dist/ui doesn't match web/ source; run npm run build:ui.\n${problems.map(p => `  ${p}`).join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`dist/ui matches the web/ source (${builtNames.length} files).\n`);
} finally { await rm(temporary, { recursive: true, force: true }); }
