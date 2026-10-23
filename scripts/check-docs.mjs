#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function withoutFences(markdown) {
  return markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

function anchors(markdown) {
  const result = new Set(), counts = new Map();
  for (const match of withoutFences(markdown).matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1].toLowerCase().replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/ /g, '-');
    const count = counts.get(slug) ?? 0;
    result.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  for (const match of markdown.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) result.add(match[1]);
  return result;
}

// Validate local inline links in the Markdown shipped by npm, not every private
// or historical file in the checkout. Remote URLs require no network access.
export async function checkPackagedDocs(root, paths) {
  const included = new Set(paths), errors = [], contents = new Map();
  const read = async path => {
    if (!contents.has(path)) contents.set(path, await readFile(join(root, path), 'utf8'));
    return contents.get(path);
  };
  for (const source of paths.filter(path => path.endsWith('.md'))) {
    const text = withoutFences(await read(source));
    for (const match of text.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) {
      const href = match[1] ?? match[2];
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) continue;
      let target, fragment;
      try {
        const split = href.indexOf('#');
        const path = decodeURIComponent((split < 0 ? href : href.slice(0, split)).split('?')[0]);
        fragment = split < 0 ? '' : decodeURIComponent(href.slice(split + 1));
        target = path ? posix.normalize(posix.join(posix.dirname(source), path)) : source;
        if (path.startsWith('/')) target = path;
      } catch {
        errors.push(`${source}: malformed link ${href}`);
        continue;
      }
      if (!included.has(target)) errors.push(`${source}: link target is not packaged: ${href}`);
      else if (fragment && target.endsWith('.md') && !anchors(await read(target)).has(fragment))
        errors.push(`${source}: missing heading: ${href}`);
    }
  }
  return errors;
}

export async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cache = await mkdtemp(join(tmpdir(), 'xfx-docs-cache-'));
  try {
    const { stdout } = await exec('npm', ['pack', '--dry-run', '--offline', '--ignore-scripts', '--json', '--cache', cache],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const [pack] = JSON.parse(stdout);
    const paths = pack.files.map(file => file.path);
    const errors = await checkPackagedDocs(root, paths);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(`Packaged documentation links passed (${paths.filter(path => path.endsWith('.md')).length} Markdown files).`);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
