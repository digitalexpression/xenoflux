#!/usr/bin/env node
import { readdir, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['bin', 'src', 'scripts', 'test-support'];

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) files.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in checked source: ${path}`);
  }
  return files;
}
function check(path) {
  return new Promise((resolveCheck, reject) => {
    const child = spawn(process.execPath, ['--check', path], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveCheck() : reject(new Error(`Syntax check failed: ${path}`)));
  });
}

const files = (await Promise.all(roots.map(async name => {
  const path = join(root, name), info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected ordinary source directory: ${name}`);
  return javascriptFiles(path);
}))).flat().sort();
await Promise.all(files.map(check));
