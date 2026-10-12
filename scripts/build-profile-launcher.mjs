#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'src/native/profile-launcher.swift');
const binary = join(root, 'src/native/XfxProfileLauncher');
const manifest = join(root, 'src/native/profile-launcher-prebuilt.json');
const architectures = ['arm64', 'x86_64'];
const minimumMacOS = '13.0';

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function verify(helper, sourceBytes, expected = null) {
  const helperBytes = await readFile(helper);
  const archs = run('lipo', ['-archs', helper]).split(/\s+/).sort();
  if (JSON.stringify(archs) !== JSON.stringify([...architectures].sort()))
    throw new Error(`Expected universal ${architectures.join('+')} helper; found ${archs.join(', ')}`);
  run('codesign', ['--verify', '--strict', helper]);
  const entitlements = spawnSync('codesign', ['--display', '--entitlements', '-', helper], { encoding: 'utf8' });
  if (entitlements.error) throw entitlements.error;
  if (entitlements.status !== 0 || /<key>/.test(`${entitlements.stdout}${entitlements.stderr}`))
    throw new Error('Prebuilt launcher must have no entitlements');
  if (expected) {
    const actual = { schemaVersion: 1, sourceSha256: digest(sourceBytes), helperSha256: digest(helperBytes),
      architectures, minimumMacOS };
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Prebuilt launcher manifest does not match its source and binary');
  }
  return { helperBytes, helperSha256: digest(helperBytes) };
}

async function check() {
  if (process.platform !== 'darwin') throw new Error('Native launcher checks require macOS');
  const [sourceBytes, metadata] = await Promise.all([readFile(source), readFile(manifest, 'utf8').then(JSON.parse)]);
  const info = await stat(binary);
  if ((info.mode & 0o777) !== 0o755) throw new Error('Prebuilt launcher must have mode 755');
  await verify(binary, sourceBytes, metadata);
  process.stdout.write('Prebuilt native launcher is valid.\n');
}

async function build() {
  if (process.platform !== 'darwin') throw new Error('Native launcher builds require macOS');
  const sourceBytes = await readFile(source);
  const temporary = await mkdtemp(join(tmpdir(), 'xfx-profile-launcher-build-'));
  const outputs = architectures.map(arch => join(temporary, `launcher-${arch}`));
  const universal = join(temporary, 'XfxProfileLauncher');
  const stagedManifest = join(temporary, 'profile-launcher-prebuilt.json');
  const pendingBinary = `${binary}.new-${process.pid}`;
  const pendingManifest = `${manifest}.new-${process.pid}`;
  try {
    for (let i = 0; i < architectures.length; i++) {
      run('swiftc', ['-O', '-module-cache-path', join(temporary, 'module-cache'), '-target', `${architectures[i]}-apple-macos${minimumMacOS}`, '-o', outputs[i], source]);
    }
    run('lipo', ['-create', ...outputs, '-output', universal]);
    run('codesign', ['--force', '--sign', '-', universal]);
    const { helperBytes, helperSha256 } = await verify(universal, sourceBytes);
    await chmod(universal, 0o755);
    const record = { schemaVersion: 1, sourceSha256: digest(sourceBytes), helperSha256, architectures, minimumMacOS };
    await writeFile(stagedManifest, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    if (digest(await readFile(universal)) !== helperSha256) throw new Error('Staged launcher changed during build');
    await copyFile(universal, pendingBinary);
    await chmod(pendingBinary, 0o755);
    await copyFile(stagedManifest, pendingManifest);
    // Prepare and validate both replacement files before publishing either one.
    await verify(pendingBinary, sourceBytes);
    await rename(pendingBinary, binary);
    await rename(pendingManifest, manifest);
    process.stdout.write(`Built ${binary}\n`);
  } finally {
    await Promise.all([rm(temporary, { recursive: true, force: true }), rm(pendingBinary, { force: true }), rm(pendingManifest, { force: true })]);
  }
}

try {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('Usage: build-profile-launcher.mjs [--check]');
  if (process.argv[2] === '--check') await check();
  else await build();
} catch (error) {
  process.stderr.write(`Native launcher ${process.argv[2] === '--check' ? 'check' : 'build'} failed: ${error.message}\n`);
  process.exitCode = 1;
}
