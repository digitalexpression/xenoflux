#!/usr/bin/env node
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const contextFiles = new Set(['instructions.md', 'current-work.md', 'evidence-index.md', 'knowledge.md']);
const workflowFiles = new Set(['release.md', 'locate-evidence.py']);

export async function checkMaintainerStorage(root) {
  const directory = join(root, 'private/maintainer');
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) return ['private/maintainer must be an ordinary directory'];
  const errors = [];
  const reject = path => errors.push(`${path}: keep active task artifacts in private/work/<task>/ and completed records in private/archive/`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === '.DS_Store') continue;
    if (entry.isFile() && contextFiles.has(entry.name)) continue;
    if (entry.isDirectory() && entry.name === 'workflows') {
      for (const workflow of await readdir(join(directory, entry.name), { withFileTypes: true })) {
        if (workflow.isFile() && workflow.name === '.DS_Store') continue;
        if (workflow.isFile() && workflowFiles.has(workflow.name)) continue;
        reject(`private/maintainer/workflows/${workflow.name}`);
      }
    } else reject(`private/maintainer/${entry.name}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  checkMaintainerStorage(root).then(errors => {
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    else console.log('Maintainer storage boundary passed.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
