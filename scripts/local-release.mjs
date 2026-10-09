#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createPairedPathFixture } from '../test-support/paired-path-fixture.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const usage = `Usage: npm run local-release -- --output DIRECTORY [--smoke] [--helpers DIRECTORY]

Builds the current Xenoflux package locally, writes a SHA-256 manifest beside it,
and optionally verifies a detached offline installation using the checked-out
smol-toml dependency. It never installs xfx globally or changes profile stores.

  --output DIRECTORY  New directory for the tarball and manifest.
  --smoke             Verify a detached offline install and disposable fixture lifecycle.
  --helpers DIRECTORY New directory for external-terminal helper templates.
`;

function argument(value, name) {
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

export function parseArguments(argv) {
  const options = { smoke: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--help' || value === '-h') options.help = true;
    else if (value === '--smoke') options.smoke = true;
    else if (value === '--output' || value === '--helpers') options[value.slice(2)] = argument(argv[++index], value);
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

export function helperTemplates() {
  const preamble = `#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  printf '%s\\n' "Usage: $0 STORE_DIRECTORY" >&2
  exit 64
fi

`;
  const executable = 'xfx_executable=${XFX_EXECUTABLE:-xfx}\n';
  return {
    'xfx-desktop-switch.command': `${preamble}${executable}exec "$xfx_executable" --store "$1" desktop pick
`,
    'xfx-desktop-recover.command': `${preamble}${executable}exec "$xfx_executable" --store "$1" desktop recover --no-open
`,
  };
}

export function manifestFor({ packageName, version, tarball, sha256, dependencies, sourceRevision, smoke }) {
  return { schemaVersion: 1, package: packageName, version, tarball, sha256, dependencies, sourceRevision, smoke };
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function newDirectory(path, description) {
  if (!isAbsolute(path)) throw new Error(`${description} must be an absolute path`);
  if (await exists(path)) throw new Error(`${description} already exists: ${path}`);
  await mkdir(path, { mode: 0o700, recursive: true });
  return realpath(path);
}

function run(executable, args, { cwd = root, env = process.env } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${executable} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function revision() {
  let head;
  try { head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim(); }
  catch { throw new Error('A local release candidate requires a committed source revision'); }
  const dirty = (await run('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (dirty) throw new Error('Refusing to build from tracked source changes; commit or revert them first');
  return head;
}

async function assertPackageInputsTracked() {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || manifest.files.some(path => typeof path !== 'string' || !path))
    throw new Error('package.json must declare package files');
  const inputs = [...new Set([...manifest.files, 'package.json', 'package-lock.json', 'scripts/install-template.mjs'])];
  const unsafe = (await run('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...inputs])).stdout.split('\0').filter(Boolean);
  if (unsafe.length) throw new Error(`Refusing to package untracked runtime input: ${unsafe.join(', ')}`);
}

async function pack(directory, destination, cache) {
  // Run from this project so a dependency's development-only tool requirements
  // do not apply to repacking its already installed runtime files.
  const result = await run('npm', ['pack', directory, '--offline', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache },
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0].filename !== 'string')
    throw new Error('npm pack did not return exactly one tarball');
  return entries[0];
}

async function writeHelpers(directory) {
  const target = await newDirectory(resolve(directory), 'Helper directory');
  for (const [name, contents] of Object.entries(helperTemplates())) {
    const path = join(target, name);
    await writeFile(path, contents, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  return target;
}

async function writeInstaller(directory) {
  const installer = join(directory, 'install.mjs');
  await writeFile(installer, await readFile(join(root, 'scripts', 'install-template.mjs')), { mode: 0o700 });
  await chmod(installer, 0o700);
  return installer;
}

async function smokeInstall(tarball, dependencyTarball, cache) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'xfx-local-release-')));
  try {
    const install = join(temporary, 'installed');
    await mkdir(install, { mode: 0o700 });
    await writeFile(join(install, 'package.json'), '{"private":true}\n', { mode: 0o600 });
    await run('npm', ['install', '--offline', '--ignore-scripts', '--no-package-lock', tarball, dependencyTarball], {
      cwd: install,
      env: { ...process.env, npm_config_cache: cache, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    const installed = join(install, 'node_modules', '.bin', 'xfx');
    const installedRoot = await realpath(join(install, 'node_modules', 'xenoflux'));
    if (installedRoot === root || installedRoot.startsWith(root + sep))
      throw new Error('Detached smoke resolved the installed package into the checkout');
    const result = await run(installed, ['--help'], { cwd: install });
    if (!result.stdout.startsWith('xfx — Xenoflux')) throw new Error('Installed xfx did not print its help header');
    const store = join(temporary, 'smoke store');
    const preview = JSON.parse((await run(installed, ['--json', '--store', store, 'profile', 'create', 'smoke'])).stdout);
    if (preview.status !== 'preview' || await exists(store)) throw new Error('Installed profile preview changed its store');
    const codex = join(temporary, 'codex-fixture');
    await writeFile(codex, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const native = await prepareNativeHome({ directory: join(temporary, 'native profile'), executable: codex, codexVersion: '0.0.0' });
    await run(installed, ['--store', store, 'profile', 'register', 'smoke', native.root, '--codex', codex, '--codex-version', '0.0.0']);
    const listed = JSON.parse((await run(installed, ['--json', '--store', store, 'profile', 'list'])).stdout);
    if (listed.length !== 1 || listed[0].name !== 'smoke') throw new Error('Installed xfx did not persist its detached store');
    const readonlyHome = join(temporary, 'readonly user');
    await mkdir(join(readonlyHome, '.codex'), { recursive: true, mode: 0o700 });
    await writeFile(join(readonlyHome, '.codex', 'AGENTS.md'), 'Detached comparison fixture.\n', { mode: 0o600 });
    const comparison = JSON.parse((await run(installed, ['--store', store, 'compare', 'Default', 'Default', '--include', 'instructions'], {
      cwd: install, env: { ...process.env, HOME: readonlyHome },
    })).stdout);
    if (comparison.state !== 'native-settings-comparison' || comparison.summary.changed !== 0)
      throw new Error('Installed xfx did not complete its detached read-only native settings comparison');
    // Exercise the shipped copy engine against disposable native homes only.
    const { Store } = await import(pathToFileURL(join(installedRoot, 'src', 'profiles.js')).href);
    const { inspectProfile } = await import(pathToFileURL(join(installedRoot, 'src', 'profile-inventory.js')).href);
    const { planCopy, applyCopy, planUndo, undoCopy } = await import(pathToFileURL(join(installedRoot, 'src', 'native-copy.js')).href);
    const sourceSkill = join(readonlyHome, '.codex', 'skills', 'smoke-skill');
    const targetSkill = join(native.home, 'skills', 'smoke-skill');
    await mkdir(sourceSkill, { recursive: true, mode: 0o700 });
    await mkdir(join(targetSkill, 'obsolete-empty'), { recursive: true, mode: 0o700 });
    const skill = '---\nname: smoke-skill\ndescription: Disposable package verification.\n---\nRead the bundled marker.\n';
    await writeFile(join(readonlyHome, '.codex', 'config.toml'), 'model = "smoke-source"\n', { mode: 0o600 });
    await writeFile(join(sourceSkill, 'SKILL.md'), skill, { mode: 0o600 });
    await writeFile(join(sourceSkill, 'marker.txt'), 'smoke-marker\n', { mode: 0o600 });
    await writeFile(join(targetSkill, 'SKILL.md'), 'Original skill.\n', { mode: 0o600 });
    await writeFile(join(targetSkill, 'obsolete-script'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const originalConfig = await readFile(join(native.home, 'config.toml'), 'utf8');
    const copyStore = new Store(store);
    const inventory = await inspectProfile(copyStore, 'Default', { defaultUserHome: readonlyHome, copyOnly: true });
    const selection = inventory.items.filter(item => item.copyable &&
      ((item.category === 'config' && item.label === 'model') ||
       (item.category === 'skill' && item.label === 'smoke-skill'))).map(item => item.id);
    if (selection.length !== 2) throw new Error('Installed xfx did not discover its selected copy fixtures');
    const copyOptions = { defaultUserHome: readonlyHome, selection, lockPath: join(temporary, 'copy.lock'),
      runtime: { assertIdle: async () => {} } };
    const copyPreview = await planCopy(copyStore, 'Default', 'smoke', copyOptions);
    const copied = await applyCopy(copyStore, 'Default', 'smoke', { ...copyOptions, expectedHash: copyPreview.hash });
    if (copied.status !== 'applied' || await exists(join(targetSkill, 'obsolete-script')) ||
      await exists(join(targetSkill, 'obsolete-empty')) ||
      (await readFile(join(targetSkill, 'SKILL.md'), 'utf8')) !== skill ||
      (await readFile(join(targetSkill, 'marker.txt'), 'utf8')) !== 'smoke-marker\n' ||
      !(await readFile(join(native.home, 'config.toml'), 'utf8')).includes('smoke-source'))
      throw new Error('Installed xfx did not apply an exact selected package/config update');
    const undoPreview = await planUndo(copyStore, copied.id);
    await undoCopy(copyStore, copied.id, { ...copyOptions, expectedHash: undoPreview.hash });
    if ((await readFile(join(native.home, 'config.toml'), 'utf8')) !== originalConfig ||
      (await readFile(join(targetSkill, 'SKILL.md'), 'utf8')) !== 'Original skill.\n' ||
      (await readFile(join(targetSkill, 'obsolete-script'), 'utf8')) !== '#!/bin/sh\nexit 0\n' ||
      ((await stat(join(targetSkill, 'obsolete-script'))).mode & 0o777) !== 0o700 ||
      !(await stat(join(targetSkill, 'obsolete-empty'))).isDirectory() ||
      await exists(join(targetSkill, 'marker.txt')))
      throw new Error('Installed xfx did not restore its exact pre-copy package/config state');
    const fixture = join(temporary, 'paired fixture');
    const { PairedPathTransaction } = await import(pathToFileURL(join(installedRoot, 'src', 'paired-path-transaction.js')).href);
    const lab = createPairedPathFixture(fixture, PairedPathTransaction);
    const initial = await lab.init();
    const original = await Promise.all(initial.components.map(async component => {
      const info = await stat(component.alias);
      return { device: info.dev, inode: info.ino };
    }));
    const switched = await lab.switchTo('A');
    if (switched.selected !== 'A') throw new Error('Installed xfx did not switch its paired fixture');
    const recovered = await lab.recover();
    if (recovered.selected !== 'A' || recovered.recovered !== false) throw new Error('Installed xfx did not preserve a committed paired selection during recovery');
    const restored = await lab.restore();
    if (restored.selected !== 'Default') throw new Error('Installed xfx did not restore its paired fixture');
    const restoredIds = await Promise.all(restored.components.map(async component => {
      const info = await stat(component.alias);
      return { device: info.dev, inode: info.ino };
    }));
    if (JSON.stringify(original) !== JSON.stringify(restoredIds))
      throw new Error('Installed xfx did not preserve paired fixture identities');
    const { createInstallation } = await import(pathToFileURL(join(installedRoot, 'src', 'installation.js')).href);
    const userHome = join(temporary, 'installation user');
    const controller = join(userHome, '.xfx', 'controller');
    await mkdir(controller, { recursive: true, mode: 0o700 });
    await writeFile(join(controller, 'preserved.json'), '{}\n', { mode: 0o600 });
    let prepared = 0, restoredLogs = 0, serviceCalls = 0;
    const manager = createInstallation({ home: userHome, source: installedRoot,
      check: async ({ env }) => {
        if (env.PATH === '/missing/node:/usr/bin:/bin')
          throw new Error('background Node is unavailable');
        return 'v22.13.0';
      },
      execute: async () => ({ stdout: 'v22.13.0\n' }),
      runService: async () => { serviceCalls += 1; throw new Error('Smoke must not invoke launchctl'); },
      serviceLoaded: async () => false,
      prepareLogs: async () => { prepared += 1; },
      restoreLogs: async () => { restoredLogs += 1; },
    });
    const installation = await manager.install({ env: { HOME: userHome, PATH: process.env.PATH },
      backgroundPath: '/missing/node:/usr/bin:/bin' });
    if (installation.ramStartup.enabled || prepared !== 0 || serviceCalls !== 0)
      throw new Error('Detached install attempted native RAM-log setup without a background Node');
    for (const notice of ['LICENSE', join('node_modules', 'smol-toml', 'LICENSE')]) {
      if (!(await readFile(join(root, notice))).equals(await readFile(join(installation.app, notice))))
        throw new Error(`Detached installation changed or omitted its license notice: ${notice}`);
    }
    const entry = join(userHome, '.local', 'bin', 'xfx');
    const entryResult = await run(entry, ['--help'], { cwd: install, env: { ...process.env, HOME: userHome } });
    if (!entryResult.stdout.startsWith('xfx — Xenoflux')) throw new Error('Installed shell entry did not run the staged application');
    await manager.uninstall({ env: { HOME: userHome, PATH: process.env.PATH } });
    if (restoredLogs < 1 || (await readFile(join(controller, 'preserved.json'), 'utf8')) !== '{}\n')
      throw new Error('Detached uninstall did not preserve controller state');
    return { status: 'passed', mode: 'detached-offline-installed-package-fixtures-and-installation-lifecycle' };
  } finally { await rm(temporary, { force: true, recursive: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { process.stdout.write(usage); return; }
  if (!options.output) throw new Error('--output is required');
  const sourceRevision = await revision();
  await assertPackageInputsTracked();
  const sourceDependency = join(root, 'node_modules', 'smol-toml');
  const dependencyInfo = await stat(sourceDependency).catch(() => null);
  if (!dependencyInfo?.isDirectory()) throw new Error('Local release requires installed node_modules/smol-toml; run npm ci first');
  const output = await newDirectory(options.output, 'Output directory');
  const cache = await mkdtemp(join(tmpdir(), 'xfx-npm-cache-'));
  try {
    const packed = await pack(root, output, cache);
    const tarball = join(output, packed.filename);
    const dependency = await pack(sourceDependency, output, cache);
    const dependencyTarball = join(output, dependency.filename);
    const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
    const dependencySha256 = createHash('sha256').update(await readFile(dependencyTarball)).digest('hex');
    const installer = await writeInstaller(output);
    const smoke = options.smoke ? await smokeInstall(tarball, dependencyTarball, cache) : { status: 'not-run' };
    if (await revision() !== sourceRevision) throw new Error('Source revision changed while packaging; discard this output and rebuild');
    await assertPackageInputsTracked();
    const manifest = manifestFor({ packageName: packed.name, version: packed.version, tarball: packed.filename,
      sha256, dependencies: [{ name: dependency.name, version: dependency.version, tarball: dependency.filename, sha256: dependencySha256 }],
      sourceRevision, smoke });
    const manifestPath = join(output, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const helpers = options.helpers ? await writeHelpers(options.helpers) : null;
    process.stdout.write(JSON.stringify({ status: 'built', output, tarball, manifest: manifestPath, installer, helpers, smoke }, null, 2) + '\n');
  } finally { await rm(cache, { force: true, recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
