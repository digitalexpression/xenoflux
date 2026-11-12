#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { copyRuntimeDependencies, koffiPlatformPackage } from '../src/installation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencyManifestPath = /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*\/package\.json$/;

const usage = `Usage: npm run local-release -- --output DIRECTORY [--smoke]

Builds the current Xenoflux package locally, writes a SHA-256 manifest beside it,
with its complete locked Apple Silicon runtime and a standalone installer.
It never installs xfx globally or changes profile stores.

  --output DIRECTORY  New directory for the tarball and manifest.
  --smoke             Verify a detached offline install and disposable fixture lifecycle.
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
    else if (value === '--pack-guard') options.packGuard = true;
    else if (value === '--output') options.output = argument(argv[++index], value);
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

export function manifestFor({ packageName, version, tarball, sha256, sourceRevision, smoke }) {
  return { schemaVersion: 3, package: packageName, version, tarball, sha256,
    runtime: { bundled: true, platform: 'darwin', arch: 'arm64' }, sourceRevision, smoke };
}

export function preservesFrozenAuditFields(actual, frozen) {
  return Boolean(actual && Object.entries(frozen).every(([key, value]) =>
    JSON.stringify(actual[key]) === JSON.stringify(value)));
}

export function hasReadCorroboration(report) {
  return report?.comparisonEvidence?.actions?.some(action => action.kind === 'resource-read' &&
    action.corroboration === 'native-unknown-absolute-cat') === true;
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

function run(executable, args, { cwd = root, env = process.env, expectedExitCode = 0 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === expectedExitCode) resolveRun({ stdout, stderr });
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

async function packApp(destination, cache) {
  const result = await run('npm', ['pack', '--offline', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: root,
    env: { ...process.env, npm_config_cache: cache },
  });
  const entries = JSON.parse(result.stdout);
  if (!Array.isArray(entries) || entries.length !== 1 || typeof entries[0].filename !== 'string' ||
      dirname(entries[0].filename) !== '.')
    throw new Error('npm pack did not return the expected application tarball');
  return entries[0];
}

function writePackageTarball(archive, directory, members) {
  return run('/usr/bin/tar', ['-czf', archive, '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root',
    '--no-xattrs', '--no-acls', '--no-fflags', '-C', directory, ...members], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
}

export async function archiveRuntimeDependency(directory, archive, { includeNodeModules = false } = {}) {
  const members = ['.'];
  async function collect(parent) {
    for (const entry of await readdir(join(directory, parent), { withFileTypes: true })) {
      // The lockfile supplies nested dependencies as separate archives.
      if (entry.name === 'node_modules' && !includeNodeModules) continue;
      const member = `${parent}/${entry.name}`;
      if ((!entry.isFile() && !entry.isDirectory()) || /[\\\r\n]/.test(entry.name) || entry.name.startsWith('._') ||
          ['.git', '.npmrc', '.env', '.DS_Store'].includes(entry.name))
        throw new Error(`Unsafe installed runtime dependency member: ${member}`);
      members.push(member);
      if (entry.isDirectory()) await collect(member);
    }
  }
  await collect('.');
  // Older npm versions can run prepare while packing a directory, even with
  // --ignore-scripts. Use tar on the verified installed files instead.
  const list = `${archive}.members`;
  await writeFile(list, members.sort().join('\0') + '\0', { flag: 'wx', mode: 0o600 });
  try {
    await writePackageTarball(archive, directory, ['--no-recursion',
      '-s', ',^\\.$,package,', '-s', ',^\\./,package/,', '--null', '-T', list]);
  } finally { await rm(list, { force: true }); }
  return `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`;
}

async function installDetached(packed, tarball, temporary) {
  const { packages } = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const { devDependencies, ...project } = packages[''];
  const platformPackage = koffiPlatformPackage();
  const platformPath = `node_modules/${platformPackage}`;
  if (!packages[platformPath] || packages['node_modules/koffi']?.optionalDependencies?.[platformPackage] !== packages[platformPath].version)
    throw new Error(`The release lock does not specify the required native library: ${platformPackage}`);
  if (project.name !== packed.name || project.version !== packed.version)
    throw new Error('The package lock does not match the packed project');
  const tarballs = join(temporary, 'runtime-tarballs');
  const install = join(temporary, 'installed');
  await Promise.all([mkdir(tarballs, { mode: 0o700 }), mkdir(install, { mode: 0o700 })]);
  const archives = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (!path || entry.dev || (entry.optional && path !== platformPath)) continue;
    const name = path.split('node_modules/').at(-1);
    const directory = join(root, path);
    const resolved = await realpath(directory).catch(() => null);
    if (!resolved?.startsWith(join(root, 'node_modules') + sep))
      throw new Error(`Missing or external runtime dependency: ${path}; run npm ci first`);
    const installed = JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8'));
    if (installed.name !== name || installed.version !== entry.version)
      throw new Error(`Installed runtime dependency does not match the lock: ${path}; run npm ci first`);
    const archive = join(tarballs, `dependency-${archives.size}.tgz`);
    archives.set(path, { resolved: `file:${archive}`, integrity: await archiveRuntimeDependency(resolved, archive) });
  }
  const dependencies = {
    [project.name]: `file:${tarball}`,
    [platformPackage]: archives.get(platformPath).resolved,
  };
  const localPackages = {
    '': { dependencies },
    [`node_modules/${project.name}`]: { ...project, resolved: dependencies[project.name], integrity: packed.integrity },
  };
  for (const [path, entry] of Object.entries(packages)) {
    if (!path || entry.dev) continue;
    localPackages[path] = { ...entry, ...archives.get(path) };
  }
  // npm omits other optional dependencies. The FFI library is a direct local
  // dependency of this disposable install so its native code stays available.
  delete localPackages[platformPath].optional;
  await writeFile(join(install, 'package.json'), JSON.stringify({ private: true, dependencies }));
  await writeFile(join(install, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: localPackages }));
  await run('npm', ['ci', '--offline', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund',
    '--cache', join(temporary, 'empty-install-cache')], { cwd: install });
  return install;
}

export async function packageInventory(directory, { npmBinsFor = [] } = {}) {
  directory = await realpath(directory);
  const files = [];
  const targets = new Set(npmBinsFor.map(file => file.path));
  const aliases = new Map();
  for (const file of npmBinsFor.filter(file => dependencyManifestPath.test(file.path))) {
    const manifest = JSON.parse(await readFile(join(directory, file.path), 'utf8'));
    const bins = typeof manifest.bin === 'string' ? { [manifest.name.split('/').at(-1)]: manifest.bin } : manifest.bin ?? {};
    const modules = file.path.slice(0, file.path.lastIndexOf('node_modules/') + 'node_modules'.length);
    for (const [name, value] of Object.entries(bins)) {
      if (!/^[\w.-]+$/.test(name) || typeof value !== 'string') throw new Error(`Invalid bundled bin declaration: ${file.path}`);
      const alias = `${modules}/.bin/${name}`, target = join(dirname(file.path), value);
      if (!aliases.has(alias)) aliases.set(alias, new Set());
      aliases.get(alias).add(target);
    }
  }
  async function collect(parent) {
    for (const entry of await readdir(join(directory, parent), { withFileTypes: true })) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() && /(?:^|\/)node_modules\/\.bin\/[^/]+$/.test(path)) {
        const target = relative(directory, await realpath(join(directory, path)));
        if (!targets.has(target) || !aliases.get(path)?.has(target)) throw new Error(`Unexpected npm binary link: ${path}`);
        continue;
      }
      if ((!entry.isFile() && !entry.isDirectory()) || /[\\\r\n]/.test(entry.name) || entry.name.startsWith('._') ||
          ['.git', '.npmrc', '.env', '.DS_Store'].includes(entry.name))
        throw new Error(`Unsafe package member: ${path}`);
      if (entry.isDirectory()) await collect(path);
      else files.push({ path, sha256: createHash('sha256').update(await readFile(join(directory, path))).digest('hex'),
        mode: (await stat(join(directory, path))).mode & 0o777 });
    }
  }
  await collect('');
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertInstallHooks(application, inventory) {
  const allowed = 'node ./cnoke.cjs -P . -D src/koffi --prebuild --release';
  const hooks = [];
  for (const file of inventory) {
    if (file.path !== 'package.json' && !dependencyManifestPath.test(file.path)) continue;
    const manifest = JSON.parse(await readFile(join(application, file.path), 'utf8'));
    for (const event of ['preinstall', 'install', 'postinstall']) {
      if (!manifest.scripts?.[event]) continue;
      if (manifest.name !== 'koffi' || manifest.version !== '3.3.4' || event !== 'install' || manifest.scripts[event] !== allowed)
        throw new Error(`Unreviewed bundled install hook: ${manifest.name}@${manifest.version}:${event}`);
      hooks.push(`${manifest.name}@${manifest.version}:${event}`);
    }
  }
  return hooks;
}

export async function bundledManifest(project, application) {
  const manifest = { ...project, dependencies: { ...project.dependencies } };
  delete manifest.private;
  delete manifest.devDependencies;
  manifest.scripts = { ...manifest.scripts };
  delete manifest.scripts.prepack;
  // npm bundles dependency edges, not the required peer closure of those edges.
  for (const name of Object.keys(project.dependencies)) {
    const dependency = JSON.parse(await readFile(join(application, 'node_modules', name, 'package.json'), 'utf8'));
    for (const peer of Object.keys(dependency.peerDependencies ?? {})) {
      if (dependency.peerDependenciesMeta?.[peer]?.optional || manifest.dependencies[peer]) continue;
      const installed = JSON.parse(await readFile(join(application, 'node_modules', peer, 'package.json'), 'utf8'));
      if (installed.name !== peer) throw new Error(`Invalid bundled peer: ${peer}`);
      manifest.dependencies[peer] = installed.version;
    }
  }
  manifest.bundleDependencies = Object.keys(manifest.dependencies);
  manifest.os = ['darwin'];
  manifest.cpu = ['arm64'];
  return manifest;
}

export async function buildBundledPackage(packed, tarball, temporary, output) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Bundled releases require darwin/arm64');
  const stagedInstall = await installDetached(packed, tarball, temporary);
  const installedRoot = join(stagedInstall, 'node_modules', packed.name);
  const staging = join(temporary, 'bundled-package');
  const application = join(staging, 'package');
  await cp(installedRoot, application, { recursive: true, force: false, errorOnExist: true });
  await copyRuntimeDependencies(installedRoot, application);
  const project = JSON.parse(await readFile(join(application, 'package.json'), 'utf8'));
  await writeFile(join(application, 'package.json'), JSON.stringify(await bundledManifest(project, application), null, 2) + '\n');
  const inventory = await packageInventory(application);
  await assertInstallHooks(application, inventory);
  // Archive the verified tree directly: npm packlist can omit upstream changelogs.
  const archive = join(output, packed.filename);
  await archiveRuntimeDependency(application, archive, { includeNodeModules: true });
  const verification = join(temporary, 'archive-verification');
  await mkdir(verification);
  await run('/usr/bin/tar', ['-xzf', archive, '-C', verification]);
  if (JSON.stringify(await packageInventory(join(verification, 'package'))) !== JSON.stringify(inventory))
    throw new Error('Bundled archive did not preserve the complete package inventory');
  const install = join(temporary, 'bundled-install');
  await mkdir(install);
  await writeFile(join(install, 'package.json'), JSON.stringify({ private: true }));
  await run('npm', ['install', archive, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', join(temporary, 'bundled-install-cache')], { cwd: install });
  const installed = join(install, 'node_modules', packed.name);
  if (JSON.stringify(await packageInventory(installed, { npmBinsFor: inventory })) !== JSON.stringify(inventory))
    throw new Error('Detached npm install did not preserve the complete bundled inventory');
  return { install, inventory, archive };
}

async function writeInstaller(directory) {
  const installer = join(directory, 'install.mjs');
  await writeFile(installer, await readFile(join(root, 'scripts', 'install-template.mjs')), { mode: 0o700 });
  await chmod(installer, 0o700);
  return installer;
}

/** The packaged app serves its bundled assets on loopback and refuses unauthenticated API calls. */
async function smokeLocalApp(installed, store, cwd, env = process.env) {
  const child = spawn(installed, ['--store', store, 'ui', '--demo', '--no-open'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const launch = await new Promise((resolveUrl, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Installed xfx ui did not report its address')), 15000);
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = /Open this link in your browser: (http:\/\/127\.0\.0\.1:\d+)\/#launch=[\w-]+/.exec(output);
        if (match) { clearTimeout(timer); resolveUrl(match[1]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Installed xfx ui exited early (${code})`)); });
    });
    const page = await fetch(`${launch}/`);
    const html = await page.text();
    if (page.status !== 200 || !/default-src 'self'/.test(page.headers.get('content-security-policy') ?? ''))
      throw new Error('Installed local app did not serve its page with the expected policy');
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    if (!script || (await fetch(`${launch}${script}`)).status !== 200) throw new Error('Installed local app is missing its bundled script');
    const stylesheet = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
    if (!stylesheet || (await fetch(`${launch}${stylesheet}`)).status !== 200) throw new Error('Installed local app is missing its bundled stylesheet');
    const api = await fetch(`${launch}/api/info`, { headers: { 'x-xenoflux-request': '1' } });
    if (api.status !== 401) throw new Error('Installed local app answered an API call without a session');
  } finally {
    child.kill('SIGTERM');
    await new Promise(done => { if (child.exitCode !== null) done(); else child.once('exit', done); });
  }
}

async function smokeSdkLibraries(application, modules, externalCopilot, env = process.env) {
  for (const sdk of ['@anthropic-ai/claude-agent-sdk', '@github/copilot-sdk']) {
    const manifest = JSON.parse(await readFile(join(modules, sdk, 'package.json'), 'utf8'));
    for (const cli of Object.keys(manifest.optionalDependencies ?? {})) {
      if (await exists(join(modules, cli))) throw new Error(`Offline bundle included an optional SDK CLI: ${cli}`);
    }
  }
  await run(process.execPath, ['--input-type=module', '--eval', `
    import { query } from '@anthropic-ai/claude-agent-sdk';
    import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
    import koffi from 'koffi';
    const executable = process.argv[1];
    if (typeof query !== 'function' || typeof CopilotClient !== 'function' || typeof koffi.load !== 'function' ||
        RuntimeConnection.forStdio({ path: executable }).path !== executable)
      throw new Error('Detached SDK libraries did not load with an external CLI path');
  `, externalCopilot], { cwd: application, env: { ...env, NODE_PATH: '' } });
}

async function smokeGlobalInstalls(tarball, inventory, temporary) {
  const results = [];
  for (const mode of ['normal', 'omit-optional']) {
    const directory = join(temporary, `global-${mode}`);
    const home = join(directory, 'home'), prefix = join(directory, 'prefix'), store = join(directory, 'controller');
    await mkdir(home, { recursive: true });
    const userconfig = join(directory, 'npmrc'), globalconfig = join(directory, 'global-npmrc');
    await Promise.all([writeFile(userconfig, ''), writeFile(globalconfig, '')]);
    const env = { HOME: home, PATH: process.env.PATH, TMPDIR: tmpdir(), XFX_HOME: store,
      npm_config_cache: join(directory, 'empty-cache'), npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig };
    const options = { cwd: directory, env };
    try {
      // Default lifecycle behavior is deliberate: the reviewed Koffi hook must work with the bundled prebuild.
      const installed = await run('npm', ['install', '--global', tarball, '--prefix', prefix,
        '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--foreground-scripts', '--loglevel=http',
        ...(mode === 'omit-optional' ? ['--omit=optional'] : [])], options);
      process.stderr.write(`Global ${mode} npm install:\n${installed.stdout}${installed.stderr}`);
      if (/rebuilding from source|Cannot download API headers/.test(installed.stdout + installed.stderr))
        throw new Error('Bundled native install unexpectedly attempted a source rebuild');
      const application = join(prefix, 'lib', 'node_modules', 'xenoflux');
      if (JSON.stringify(await packageInventory(application, { npmBinsFor: inventory })) !== JSON.stringify(inventory))
        throw new Error(`Global ${mode} install changed the bundled file inventory`);
      await smokeSdkLibraries(application, join(application, 'node_modules'), join(directory, 'external', 'copilot'), env);
      const entry = join(prefix, 'bin', 'xfx');
      const help = await run(entry, ['--help'], options);
      if (!help.stdout.startsWith('xfx — Xenoflux')) throw new Error(`Global ${mode} entry did not run`);
      const listed = await run(entry, ['--store', store, '--json', 'profile', 'list'], options);
      if (listed.stdout.trim() !== '[]') throw new Error(`Global ${mode} install did not use an empty disposable store`);
      await smokeLocalApp(entry, join(directory, 'ui-store'), directory, env);
      results.push({ mode, status: 'passed', lifecycleScripts: 'enabled', registryAccess: 'enabled', freshCache: true });
    } finally {
      await run('npm', ['uninstall', '--global', 'xenoflux', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund'], options);
      if (await exists(join(prefix, 'bin', 'xfx'))) throw new Error(`Global ${mode} uninstall left its entry`);
    }
  }
  return results;
}

async function smokeInstall(install) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'xfx-release-smoke-')));
  try {
    const installed = join(install, 'node_modules', '.bin', 'xfx');
    const installedRoot = await realpath(join(install, 'node_modules', 'xenoflux'));
    if (installedRoot === root || installedRoot.startsWith(root + sep))
      throw new Error('Detached smoke resolved the installed package into the checkout');
    const externalCopilot = join(temporary, 'external', 'copilot');
    await smokeSdkLibraries(installedRoot, join(installedRoot, 'node_modules'), externalCopilot);
    const result = await run(installed, ['--help'], { cwd: install });
    if (!result.stdout.startsWith('xfx — Xenoflux')) throw new Error('Installed xfx did not print its help header');
    await smokeLocalApp(installed, join(temporary, 'ui store'), install);
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
    // Exercise the shipped audit CLI with frozen disposable evidence. Partial
    // coverage must retain exit 2 through show, comparison and export/reopen.
    const frozen = join(temporary, 'audit-run.json');
    const auditFixture = { schemaVersion: 1, kind: 'audit-run', id: 'detached-smoke', status: 'partial',
      profile: { profileId: 'smoke', profileName: 'smoke' }, source: { kind: 'native-rollout' },
      agents: [], turns: [], events: [], skills: [{ id: 'smoke-skill', name: 'smoke-skill', path: '/recorded/skills/smoke/SKILL.md',
        observations: [{ kind: 'definition-read-observed', agentId: 'smoke', sourceLine: 1,
          evidence: { readCorroboration: 'native-unknown-absolute-cat' } }] }],
      coverage: { skills: 'partial' }, warnings: [] };
    await writeFile(frozen, JSON.stringify(auditFixture), { mode: 0o600 });
    const audit = async args => JSON.parse((await run(installed, ['--json', '--store', store, 'audit', ...args], {
      cwd: install, expectedExitCode: 2,
    })).stdout);
    const shown = await audit(['show', frozen]);
    if (!preservesFrozenAuditFields(shown, auditFixture) || !hasReadCorroboration(shown))
      throw new Error('Installed audit show changed frozen evidence or lost its derived read corroboration');
    const comparison = await audit(['diff', frozen, frozen]);
    if (comparison.kind !== 'audit-comparison' || comparison.comparison.skills[0]?.left?.observations[0]?.evidence?.readCorroboration !== 'native-unknown-absolute-cat')
      throw new Error('Installed audit comparison lost read corroboration');
    const exported = await audit(['export', frozen, '--format', 'markdown', '--output', join(temporary, 'audit.md')]);
    const reopened = await audit(['show', exported.evidencePath]);
    if (!preservesFrozenAuditFields(reopened, auditFixture) || !hasReadCorroboration(reopened) ||
      JSON.stringify(reopened.comparisonEvidence) !== JSON.stringify(shown.comparisonEvidence))
      throw new Error('Installed audit export/reopen changed frozen evidence or lost its derived read corroboration');
    // Exercise shipped desktop preparation and copy against disposable homes.
    const { Store } = await import(pathToFileURL(join(installedRoot, 'src', 'profiles.js')).href);
    const { desktopInstancePlan } = await import(pathToFileURL(join(installedRoot, 'src', 'desktop-instances.js')).href);
    const { prepareProfileApp } = await import(pathToFileURL(join(installedRoot, 'src', 'profile-launcher.js')).href);
    const instanceList = JSON.parse((await run(installed, ['--json', '--store', store, 'desktop', 'list'])).stdout);
    if (instanceList.instances.length || instanceList.observation !== 'last-recorded')
      throw new Error('Installed xfx did not read its empty desktop instance inventory');
    const vendorApp = join(temporary, 'Codex.app'), vendorContents = join(vendorApp, 'Contents');
    const vendorExecutable = join(vendorContents, 'MacOS', 'Codex');
    const vendorAsar = join(vendorContents, 'Resources', 'app.asar');
    await mkdir(join(vendorContents, 'MacOS'), { recursive: true, mode: 0o700 });
    await mkdir(join(vendorContents, 'Resources'), { recursive: true, mode: 0o700 });
    await writeFile(vendorExecutable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    await writeFile(vendorAsar, 'detached vendor archive fixture', { mode: 0o600 });
    await writeFile(join(vendorContents, 'Info.plist'), JSON.stringify({ CFBundleName: 'Codex',
      CFBundleDisplayName: 'Codex', CFBundleIdentifier: 'com.openai.codex', CFBundleExecutable: 'Codex',
      CFBundlePackageType: 'APPL' }), { mode: 0o600 });
    const vendor = { appPath: await realpath(vendorApp), bundleId: 'com.openai.codex', executable: vendorExecutable,
      asarSha256: createHash('sha256').update(await readFile(vendorAsar)).digest('hex') };
    const desktopPlan = await desktopInstancePlan(new Store(store), 'smoke', { runtime: { inspectApp: async () => vendor } });
    if (desktopPlan.userHome !== join(native.root, 'user-home') || desktopPlan.home !== native.home)
      throw new Error('Installed desktop plan did not retain its profile routing');
    const profileApp = await prepareProfileApp(new Store(store), desktopPlan, { nodeExecutable: process.execPath,
      entryPoint: join(installedRoot, 'bin', 'xfx.js'), verifyOriginal: async sourcePath => ({ ...vendor, appPath: sourcePath }),
      copyApp: (sourcePath, destination) => cp(sourcePath, destination, { recursive: true, verbatimSymlinks: true }),
      updatePlist: async (path, { set, remove }) => {
        const plist = JSON.parse(await readFile(path, 'utf8'));
        for (const key of remove) delete plist[key];
        Object.assign(plist, set);
        await writeFile(path, JSON.stringify(plist), { mode: 0o600 });
      }, signApp: async () => {}, execFile: async (command, args) => {
        if (command === '/usr/bin/plutil') return { stdout: await readFile(args.at(-1), 'utf8') };
        if (command === '/usr/bin/codesign') return { stdout: '' };
        throw new Error(`unexpected profile-app command: ${command}`);
      } });
    if (profileApp.application.bundleId !== `com.xenoflux.profile.${desktopPlan.profileId.toLowerCase()}`
      || !(await readFile(join(profileApp.application.appPath, 'Contents', 'Info.plist'), 'utf8')).includes('Codex · smoke'))
      throw new Error('Installed xfx did not prepare its profile-specific application bundle');
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
        return 'v22.15.0';
      },
      execute: async () => ({ stdout: 'v22.15.0\n' }),
      runService: async () => { serviceCalls += 1; throw new Error('Smoke must not invoke launchctl'); },
      serviceLoaded: async () => false,
      prepareLogs: async () => { prepared += 1; },
      restoreLogs: async () => { restoredLogs += 1; },
    });
    const installation = await manager.install({ env: { HOME: userHome, PATH: process.env.PATH },
      backgroundPath: '/missing/node:/usr/bin:/bin' });
    if (installation.ramStartup.enabled || prepared !== 0 || serviceCalls !== 0)
      throw new Error('Detached install attempted native RAM-log setup without a background Node');
    await smokeSdkLibraries(installation.app, join(installation.app, 'node_modules'), externalCopilot);
    for (const notice of ['LICENSE', join('node_modules', 'smol-toml', 'LICENSE')]) {
      if (!(await readFile(join(root, notice))).equals(await readFile(join(installation.app, notice))))
        throw new Error(`Detached installation changed or omitted its license notice: ${notice}`);
    }
    const entry = join(userHome, '.local', 'bin', 'xfx');
    const entryResult = await run(entry, ['--help'], { cwd: install, env: { ...process.env, HOME: userHome } });
    if (!entryResult.stdout.startsWith('xfx — Xenoflux')) throw new Error('Installed shell entry did not run the staged application');
    await smokeLocalApp(entry, join(temporary, 'managed ui store'), temporary, { ...process.env, HOME: userHome });
    await manager.uninstall({ env: { HOME: userHome, PATH: process.env.PATH } });
    if (restoredLogs < 1 || (await readFile(join(controller, 'preserved.json'), 'utf8')) !== '{}\n')
      throw new Error('Detached uninstall did not preserve controller state');
    return { status: 'passed', mode: 'detached-offline-npm-and-managed-ui-fixtures-and-installation-lifecycle' };
  } finally { await rm(temporary, { force: true, recursive: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { process.stdout.write(usage); return; }
  if (options.packGuard) throw new Error('Direct checkout packing is disabled. Use npm run local-release -- --output NEW_ABSOLUTE_DIRECTORY; publish only its verified bundled tarball.');
  if (!options.output) throw new Error('--output is required');
  const sourceRevision = await revision();
  await assertPackageInputsTracked();
  const output = await newDirectory(options.output, 'Output directory');
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'xfx-local-release-')));
  try {
    const cache = join(temporary, 'pack-cache');
    const sourcePack = join(temporary, 'source-pack');
    await mkdir(sourcePack);
    const packed = await packApp(sourcePack, cache);
    const { install, archive: tarball, inventory } = await buildBundledPackage(packed, join(sourcePack, packed.filename), temporary, output);
    const sha256 = createHash('sha256').update(await readFile(tarball)).digest('hex');
    const installer = await writeInstaller(output);
    const smoke = options.smoke ? { ...await smokeInstall(install),
      globalInstalls: await smokeGlobalInstalls(tarball, inventory, temporary) } : { status: 'not-run' };
    if (await revision() !== sourceRevision) throw new Error('Source revision changed while packaging; discard this output and rebuild');
    await assertPackageInputsTracked();
    const manifest = manifestFor({ packageName: packed.name, version: packed.version, tarball: packed.filename,
      sha256,
      sourceRevision, smoke });
    const manifestPath = join(output, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ status: 'built', output, tarball, manifest: manifestPath, installer, smoke }, null, 2) + '\n');
  } finally { await rm(temporary, { force: true, recursive: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
