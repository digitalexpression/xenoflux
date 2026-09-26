// Read-only comparison of the native settings surface supported by copy/undo.
import { mkdir, writeFile, lstat, mkdtemp } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawn } from 'node:child_process';
import { redactText, redactValue } from './redact.js';
import {
  COPY_COMPONENTS, selectNativeSettingsComponents, resolveNativeSettingsHome, nativeSettingsAgentFiles,
  readNativeSettingsFile, projectNativeSettingsConfig,
} from './native-copy.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const viewerEnvironmentKeys = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'];
const fileKey = file => `${file.component}\0${file.path}`;
const safeError = () => 'unreadable';
function viewerEnvironment() {
  return Object.fromEntries(viewerEnvironmentKeys.filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
}
function publicEntry(component, path, content, inputHash) {
  const redacted = component === 'config' ? redactValue(content) : redactText(content, path);
  const shown = component === 'config' ? `${JSON.stringify(redacted, null, 2)}\n` : redacted;
  return { component, path, status: 'present', content: shown, sha256: digest(shown), _inputHash: inputHash };
}
async function fileEntry(home, component, path, transform = value => value) {
  try {
    const read = await readNativeSettingsFile(home, path);
    if (!read) return { component, path, status: 'missing', _inputHash: 'missing' };
    return publicEntry(component, path, transform(read.content), digest(read.content));
  } catch { return { component, path, status: 'unreadable', reason: safeError(), _inputHash: 'unreadable' }; }
}
async function capture(endpoint, components) {
  const files = [];
  if (components.includes('config') || components.includes('agents'))
    files.push(await fileEntry(endpoint.home, 'config', 'config.toml', content => projectNativeSettingsConfig(content, components)));
  if (components.includes('instructions')) {
    files.push(await fileEntry(endpoint.home, 'instructions', 'AGENTS.md'));
    files.push(await fileEntry(endpoint.home, 'instructions', 'AGENTS.override.md'));
  }
  if (components.includes('agents')) {
    try {
      const paths = await nativeSettingsAgentFiles(endpoint.home);
      for (const path of paths) files.push(await fileEntry(endpoint.home, 'agents', path));
    } catch { files.push({ component: 'agents', path: 'agents/', status: 'unreadable', reason: safeError(), _inputHash: 'unreadable' }); }
  }
  return { name: endpoint.name, files: files.sort((a, b) => fileKey(a).localeCompare(fileKey(b))), identity: endpoint.identity };
}
function publicFile({ _inputHash, ...file }) { return file; }
function publicHome(home) { return { name: redactValue(home.name), files: home.files.map(publicFile) }; }
function compareFiles(left, right) {
  const a = new Map(left.files.map(file => [fileKey(file), file]));
  const b = new Map(right.files.map(file => [fileKey(file), file]));
  const added = [], removed = [], changed = [], unchanged = [], unavailable = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const before = a.get(key), after = b.get(key);
    if (!before) { added.push(after); continue; }
    if (!after) { removed.push(before); continue; }
    if (before.status === 'missing' && after.status === 'missing') {
      unchanged.push({ component: after.component, path: after.path, status: 'missing' });
    } else if (before.status === 'missing' && after.status === 'present') {
      added.push(after);
    } else if (before.status === 'present' && after.status === 'missing') {
      removed.push(before);
    } else if (before.status !== 'present' || after.status !== 'present') {
      unavailable.push({ component: after.component, path: after.path, left: before.status, right: after.status });
    }
    else if (before.sha256 === after.sha256) unchanged.push(after);
    else changed.push({ component: after.component, path: after.path, left: before, right: after });
  }
  return { added, removed, changed, unchanged, unavailable };
}
function publicDifferences(files) {
  return {
    added: files.added.map(publicFile), removed: files.removed.map(publicFile),
    changed: files.changed.map(file => ({ ...file, left: publicFile(file.left), right: publicFile(file.right) })),
    unchanged: files.unchanged.map(publicFile), unavailable: files.unavailable,
  };
}
function unchangedInput(first, second) {
  return isDeepStrictEqual(first.identity, second.identity)
    && isDeepStrictEqual(first.files.map(f => [fileKey(f), f._inputHash]), second.files.map(f => [fileKey(f), f._inputHash]));
}

/** Compare actual, redacted settings. This does not verify effective config discovery. */
export async function compareHomes(store, left, right, { include, defaultUserHome, afterFirstCapture } = {}) {
  const components = selectNativeSettingsComponents(include ?? COPY_COMPONENTS);
  const [leftEndpoint, rightEndpoint] = await Promise.all([
    resolveNativeSettingsHome(store, left, { defaultUserHome }), resolveNativeSettingsHome(store, right, { defaultUserHome }),
  ]);
  const [leftFirst, rightFirst] = await Promise.all([capture(leftEndpoint, components), capture(rightEndpoint, components)]);
  // This hook exists for deterministic embedding tests that need to model a
  // writer racing the two bounded reads. It receives no home or file content.
  if (afterFirstCapture !== undefined) {
    if (typeof afterFirstCapture !== 'function') throw new Error('afterFirstCapture must be a function');
    await afterFirstCapture();
  }
  const [leftEndpointSecond, rightEndpointSecond] = await Promise.all([
    resolveNativeSettingsHome(store, left, { defaultUserHome }), resolveNativeSettingsHome(store, right, { defaultUserHome }),
  ]);
  const [leftSecond, rightSecond] = await Promise.all([capture(leftEndpointSecond, components), capture(rightEndpointSecond, components)]);
  if (!unchangedInput(leftFirst, leftSecond) || !unchangedInput(rightFirst, rightSecond))
    throw new Error('Native settings changed while being compared; no comparison was returned');
  const files = publicDifferences(compareFiles(leftFirst, rightFirst));
  return {
    state: 'native-settings-comparison', effectiveConfigurationVerified: false,
    scope: {
      included: components,
      excluded: ['sign-in and credentials', 'history and memories', 'desktop state', 'skills and plugins', 'MCP servers, hooks and notifications', 'repository files', 'storage routing'],
      note: 'Compares only native config, instruction, and agent settings supported by settings copy/undo; a file absent on both sides is unchanged. It does not claim effective configuration.',
    },
    left: publicHome(leftFirst), right: publicHome(rightFirst), files,
    summary: Object.fromEntries(['added', 'removed', 'changed', 'unchanged', 'unavailable'].map(key => [key, files[key].length])),
  };
}

function safeSegment(value) {
  const name = basename(value);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name) ? name : `item-${digest(String(value)).slice(0, 20)}`;
}
async function writeTree(root, home) {
  const manifest = { name: home.name, files: [] };
  for (const file of home.files) {
    const record = { component: file.component, path: file.path, status: file.status, ...(file.reason ? { reason: file.reason } : {}) };
    if (file.status === 'present') {
      const relative = join('content', safeSegment(file.component), safeSegment(file.path === 'agents/' ? 'agents' : file.path));
      const output = join(root, relative);
      await mkdir(join(output, '..'), { recursive: true, mode: 0o700 });
      await writeFile(output, file.content, { flag: 'wx', mode: 0o600 });
      record.storedPath = relative; record.sha256 = file.sha256;
    }
    manifest.files.push(record);
  }
  await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
function runViewer(executable, args, observationMs = 500) {
  return new Promise(resolve => {
    let done = false;
    const finish = result => { if (!done) { done = true; resolve(result); } };
    let child;
    try { child = spawn(executable, args, { shell: false, stdio: 'ignore', env: viewerEnvironment() }); }
    catch { finish({ status: 'fallback', reason: 'Viewer unavailable' }); return; }
    const timer = setTimeout(() => { child.unref(); finish({ status: 'launched', observation: 'exit-unobserved' }); }, observationMs);
    child.once('error', () => { clearTimeout(timer); finish({ status: 'fallback', reason: 'Viewer unavailable' }); });
    child.once('exit', code => { clearTimeout(timer); finish(code === 0 ? { status: 'launched', observation: 'exited' } : { status: 'fallback', reason: 'Viewer exited unsuccessfully; inspect the retained comparison directory.' }); });
  });
}

/** Write detached redacted comparison trees and optionally open a local viewer. */
export async function openNativeComparison(store, left, right, { include, defaultUserHome, viewer, directory } = {}) {
  const outputParent = directory === undefined ? await mkdtemp(join(tmpdir(), 'xfx-native-settings-comparison-')) : directory;
  if (typeof outputParent !== 'string' || !outputParent) throw new Error('Comparison directory must be a nonempty string');
  const parent = await lstat(outputParent);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Comparison directory must be an ordinary existing directory');
  const comparison = await compareHomes(store, left, right, { include, defaultUserHome });
  const root = directory === undefined ? outputParent : join(outputParent, `native-settings-comparison-${randomUUID()}`);
  if (directory !== undefined) await mkdir(root, { mode: 0o700 });
  const leftDirectory = join(root, 'left'), rightDirectory = join(root, 'right');
  await mkdir(leftDirectory, { mode: 0o700 }); await mkdir(rightDirectory, { mode: 0o700 });
  await Promise.all([writeTree(leftDirectory, comparison.left), writeTree(rightDirectory, comparison.right)]);
  let viewerResult = { status: 'not-requested', reason: 'No viewer was selected; inspect the retained comparison directory.' };
  if (viewer !== undefined && viewer !== null) {
    if (!viewer || typeof viewer.executable !== 'string' || !viewer.executable.trim()) throw new Error('Viewer executable must be a nonempty string');
    const templates = viewer.args === undefined ? ['{left}', '{right}'] : viewer.args;
    if (!Array.isArray(templates) || templates.some(arg => typeof arg !== 'string')) throw new Error('Viewer arguments must be an array of strings');
    const replacements = { '{left}': leftDirectory, '{right}': rightDirectory, '{leftLabel}': comparison.left.name, '{rightLabel}': comparison.right.name };
    viewerResult = await runViewer(viewer.executable, templates.map(arg => replacements[arg] ?? arg));
  }
  return { directory: root, left: leftDirectory, right: rightDirectory, viewer: viewerResult, comparison, retention: 'Comparison snapshots are retained for user cleanup.' };
}
