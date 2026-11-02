#!/usr/bin/env node
// Opt-in native UI acceptance. A manifest is an approval binding, not approval itself.
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { parse as parseToml } from 'smol-toml';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { assertNoConcurrentDesktops } from '../src/desktop-instance-guard.js';
import { Store } from '../src/profiles.js';

const script = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const help = `Usage:\n  node scripts/native-profile-ui-acceptance.mjs --help\n  node scripts/native-profile-ui-acceptance.mjs --check-grant MANIFEST.json\n  node scripts/native-profile-ui-acceptance.mjs --run-approved MANIFEST.json\n\nThe manifest binds the candidate, script closure, executables, fresh root and one attempt. --run-approved is a technical gate, not user approval.`;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

export async function validateManifest(path, { checkRoot = true, scriptFile = script, synthetic = false, allowProposed = false } = {}) {
  const manifestPath = await realpath(path), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!(manifest.status === 'approved' || allowProposed && manifest.status === 'proposed')
    || manifest.approval?.scope !== 'native-profile-ui-acceptance') fail('Manifest does not contain an explicit approval for this operation.');
  if (!manifest.candidate?.repo || !/^[0-9a-f]{40}$/.test(manifest.candidate.commit ?? '') || !/^[0-9a-f]{40}$/.test(manifest.candidate.tree ?? '')) fail('Candidate binding is incomplete.');
  const repo = await realpath(manifest.candidate.repo);
  if (manifest.candidate.head !== manifest.candidate.commit || manifest.candidate.tree !== await git(repo, ['rev-parse', 'HEAD^{tree}']) || manifest.candidate.commit !== await git(repo, ['rev-parse', 'HEAD'])) fail('Candidate checkout drifted from the manifest.');
  if ((await git(repo, ['status', '--porcelain'])).trim()) fail('Candidate checkout is not clean.');
  const checkedScript = await realpath(scriptFile);
  const files = { ...manifest.closure, [checkedScript]: manifest.scriptSha256 };
  if (!synthetic) {
    const required = ['bin/xfx.js', 'src/ui-engine.js', 'src/ui-server.js', 'src/native-copy.js', 'src/advanced-copy.js',
      'src/desktop-runtime.js', 'src/home-create.js', 'src/profile-command.js', 'web/src/main.tsx', 'web/src/routes.tsx',
      'web/src/pages/Profiles.tsx', 'web/src/pages/CopyPreview.tsx', 'web/src/api/client.ts'];
    const bound = new Set(Object.keys(manifest.closure ?? {}).map(name => name));
    if (!bound.size || required.some(name => !bound.has(join(repo, name)))) fail('Manifest source closure is empty or missing required CLI, copy, profile, or UI sources.');
    const resolveLocal = async (from, specifier) => {
      const base = specifier.startsWith('@/') ? join(repo, 'web/src', specifier.slice(2)) : join(dirname(from), specifier);
      for (const candidate of [base, ...['.js', '.mjs', '.ts', '.tsx', '.jsx', '.css', '.json'].map(ext => base + ext), ...['index.js', 'index.ts', 'index.tsx'].map(name => join(base, name))]) {
        try { const resolved = await realpath(candidate); if ((await stat(resolved)).isFile()) return resolved; }
        catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      }
      return null;
    };
    for (const name of bound) {
      const ext = name.slice(name.lastIndexOf('.'));
      if (!['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) continue;
      const source = await readFile(name, 'utf8');
      const specifiers = [...source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)].map(match => match[1] ?? match[2]);
      for (const specifier of specifiers.filter(value => value.startsWith('.') || value.startsWith('@/'))) {
        const dependency = await resolveLocal(name, specifier);
        if (!dependency || !bound.has(dependency)) fail(`Manifest source closure omits ${specifier} imported by ${name}.`);
      }
    }
    const dist = join(repo, 'dist/ui');
    async function walk(path) {
      const entries = await import('node:fs/promises').then(fs => fs.readdir(path, { withFileTypes: true }));
      for (const entry of entries) {
        const name = join(path, entry.name);
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile() && !bound.has(await realpath(name))) fail(`Manifest source closure omits built UI asset ${name}.`);
        else if (!entry.isFile()) fail(`Unsupported built UI entry: ${name}`);
      }
    }
    await walk(dist);
  }
  if (!manifest.scriptSha256 || files[checkedScript] !== hash(await readFile(checkedScript))) fail('Acceptance script hash changed.');
  for (const [name, expected] of Object.entries(files)) {
    if (!isAbsolute(name) || !/^[0-9a-f]{64}$/.test(expected)) fail(`Invalid source hash binding: ${name}`);
    const resolved = await realpath(name);
    if (!(resolved === repo || resolved.startsWith(repo + sep))) fail(`Bound file is outside candidate checkout: ${name}`);
    if (hash(await readFile(resolved)) !== expected) fail(`Bound source changed: ${name}`);
  }
  if (!synthetic) {
    for (const [label, identity] of Object.entries(manifest.executables ?? {})) {
      if (!isAbsolute(identity?.path ?? '') || !isAbsolute(identity?.resolvedPath ?? '') || !/^[0-9a-f]{64}$/.test(identity.sha256)) fail(`Invalid ${label} executable binding.`);
      const resolved = await realpath(identity.path);
      if (resolved !== identity.resolvedPath || hash(await readFile(resolved)) !== identity.sha256) fail(`${label} executable path or hash changed.`);
    }
    for (const label of ['node', 'codexCommand', 'nativeCodex']) await access(manifest.executables[label].resolvedPath, constants.X_OK);
    const { node, codex, codexCommand, nativeCodex, codexPackage, codexWrapperPackage } = manifest.executables ?? {};
    if (!node || !codex || !codexCommand || !nativeCodex || !codexPackage || !codexWrapperPackage) fail('Node, Codex command, wrapper, nested native binary and both package identities are required.');
    const packageJson = JSON.parse(await readFile(codexPackage.resolvedPath, 'utf8'));
    const wrapperPackage = JSON.parse(await readFile(codexWrapperPackage.resolvedPath, 'utf8'));
    const packageRoot = dirname(codexPackage.resolvedPath), wrapperPath = codex.resolvedPath;
    if (!wrapperPath.includes('/node_modules/@openai/codex/bin/')) fail('Codex wrapper and platform package do not match the expected installation layout.');
    const wrapperRoot = wrapperPath.split('/bin/')[0];
    const platformName = '@openai/codex-darwin-arm64';
    const declaredPlatform = wrapperPackage.optionalDependencies?.[platformName];
    const platformMatches = packageJson.name === platformName ? declaredPlatform === packageJson.version
      : packageJson.name === '@openai/codex' && declaredPlatform === `npm:@openai/codex@${packageJson.version}`;
    const expectedNative = join(packageRoot, 'vendor/aarch64-apple-darwin/bin/codex');
    if (wrapperPackage.name !== '@openai/codex' || codexWrapperPackage.resolvedPath !== join(wrapperRoot, 'package.json')
      || !platformMatches || !packageJson.os?.includes('darwin') || !packageJson.cpu?.includes('arm64')
      || packageRoot !== join(wrapperRoot, 'node_modules', platformName)
      || nativeCodex.resolvedPath !== expectedNative
      || codexCommand.resolvedPath !== wrapperPath || !codexCommand.path.endsWith('/codex')) fail('Codex command symlink, wrapper, platform package and native executable are not a matching arm64 chain.');
    await verifyBrowserBindings(repo, manifest.browser);
  }
  if (!manifest.root || !isAbsolute(manifest.root)) fail('An exact absolute owned root is required.');
  const parent = dirname(manifest.root);
  if (await realpath(parent) !== parent) fail('Fixture root parent must be canonical and already exist.');
  if (!Number.isSafeInteger(manifest.mutationWindowMs) || manifest.mutationWindowMs !== 20 * 60 * 1000) fail('Mutation window must be exactly 20 minutes.');
  if (manifest.limits?.attempts !== 1 || manifest.limits?.profiles !== 2 || manifest.limits?.modelRuns !== 0 || manifest.limits?.versionProbes !== 2) fail('Manifest limits do not match the fixed acceptance case.');
  if (checkRoot) {
    try { await lstat(manifest.root); fail('The exact fixture root already exists; it cannot be adopted or cleaned.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { manifest, manifestPath, repo };
}

async function git(cwd, args) {
  const child = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) fail(`git ${args.join(' ')} failed: ${err.trim()}`);
  return out.trim();
}

async function findPackage(entry, expectedName) {
  for (let directory = dirname(entry), depth = 0; depth < 8; directory = dirname(directory), depth++) {
    const path = join(directory, 'package.json');
    try {
      if (JSON.parse(await readFile(path, 'utf8')).name === expectedName) return path;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fail(`Could not identify installed package ${expectedName}.`);
}

async function verifyBrowserBindings(repo, binding) {
  const actual = {
    executable: chromium.executablePath(),
    playwrightTestEntry: fileURLToPath(import.meta.resolve('@playwright/test')),
    playwrightEntry: fileURLToPath(import.meta.resolve('playwright')),
    playwrightCoreEntry: require.resolve('playwright-core'),
    packageLock: join(repo, 'package-lock.json'),
  };
  actual.playwrightTestPackage = await findPackage(actual.playwrightTestEntry, '@playwright/test');
  actual.playwrightPackage = await findPackage(actual.playwrightEntry, 'playwright');
  actual.playwrightCorePackage = await findPackage(actual.playwrightCoreEntry, 'playwright-core');
  for (const [label, expectedPath] of Object.entries(actual)) {
    const identity = binding?.[label];
    if (!identity?.path || !identity?.resolvedPath || !/^[0-9a-f]{64}$/.test(identity.sha256)) fail(`Invalid browser ${label} binding.`);
    const resolved = await realpath(identity.path);
    if (identity.path !== expectedPath || identity.resolvedPath !== resolved || hash(await readFile(resolved)) !== identity.sha256) fail(`Browser ${label} path or hash differs from approval.`);
  }
  await access(binding.executable.resolvedPath, constants.X_OK);
  const lock = JSON.parse(await readFile(actual.packageLock, 'utf8'));
  const testPackage = JSON.parse(await readFile(binding.playwrightTestPackage.resolvedPath, 'utf8'));
  const playwrightPackage = JSON.parse(await readFile(binding.playwrightPackage.resolvedPath, 'utf8'));
  const corePackage = JSON.parse(await readFile(binding.playwrightCorePackage.resolvedPath, 'utf8'));
  if (lock.packages?.['node_modules/@playwright/test']?.version !== testPackage.version
    || lock.packages?.['node_modules/playwright']?.version !== playwrightPackage.version
    || lock.packages?.['node_modules/playwright-core']?.version !== corePackage.version) fail('Installed Playwright packages do not match the bound lockfile.');
}

async function admission(m) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('Acceptance requires the approved macOS arm64 host.');
  const node = await realpath(process.execPath);
  if (node !== m.executables.node.resolvedPath) fail('Running Node executable differs from approval.');
  // macOS ancestry is checked with ps; require Terminal as an ancestor before any write.
  const ps = spawn('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = ''; ps.stdout.on('data', b => stdout += b);
  const status = await new Promise((resolve, reject) => { ps.once('error', reject); ps.once('close', resolve); });
  if (status !== 0) fail('Could not inspect host process ancestry.');
  const rows = new Map(stdout.split('\n').map(line => { const x = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/); return x && [Number(x[1]), { parent: Number(x[2]), name: x[3] }]; }).filter(Boolean));
  let current = process.pid, terminal = false;
  for (let i = 0; current && i < 64; i++) { const row = rows.get(current); if (!row) break; terminal ||= /Terminal\.app\/Contents\/MacOS\/Terminal$|^Terminal$/.test(row.name); current = row.parent; }
  if (!terminal) fail('Run this harness from independently opened Terminal.app.');
  const runtime = createDesktopRuntime({ closeClients: false });
  await runtime.assertExternal();
  await assertNoConcurrentDesktops();
  await runtime.assertIdle({ cliExecutables: [m.executables.codex.path, m.executables.nativeCodex.path], resourcePaths: [] });
}

export async function ensureOpen(deadline) { if (Date.now() >= deadline) fail('Mutation admission expired; do not begin another mutation.'); }
export async function runAdmittedMutation(deadline, readOnlyAdmission, mutation = async () => {}) {
  await ensureOpen(deadline);
  await readOnlyAdmission();
  await ensureOpen(deadline);
  return mutation();
}
export function createMutationTracker() {
  const requests = new Set();
  let ambiguous = false;
  return {
    requests,
    track(request) { requests.add(request); },
    complete(request) { requests.delete(request); },
    fail(request) { if (requests.has(request)) ambiguous = true; },
    get ambiguous() { return ambiguous || requests.size > 0; },
  };
}
export function acceptanceCanPass({ functionalPass, screenshotComplete, traceComplete, browserClosed, artifactErrors, serverStopped, mutationAmbiguous }) {
  return functionalPass === true && screenshotComplete === true && traceComplete === true && browserClosed === true
    && artifactErrors?.length === 0 && serverStopped === true && mutationAmbiguous === false;
}
async function seed(home, relativePath, content, deadline, admitMutation, mode = 0o600) {
  const path = join(home, relativePath), dir = dirname(path);
  await runAdmittedMutation(deadline, admitMutation);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await runAdmittedMutation(deadline, admitMutation);
  await writeFile(path, content, { flag: 'wx', mode });
}
async function replaceGeneratedConfig(home, content, deadline, admitMutation) {
  const path = join(home, 'config.toml');
  const info = await lstat(path), existing = await readFile(path, 'utf8');
  const generated = 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\n';
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()
    || (info.mode & 0o777) !== 0o600 || existing !== generated) fail('Generated config differs from the expected new-profile baseline; preserving it.');
  const temporary = join(home, `.config.toml.native-ui-${process.pid}.tmp`);
  await runAdmittedMutation(deadline, admitMutation);
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  await runAdmittedMutation(deadline, admitMutation);
  await rename(temporary, path);
}
async function ownedProfileHome(root, nativeRoot) {
  const canonical = await realpath(nativeRoot);
  const profilesBase = await realpath(join(root, 'profiles'));
  if (!canonical.startsWith(profilesBase + sep)) fail('Profile native home escaped the owned profiles directory.');
  for (const directory of [canonical, join(canonical, 'codex-home')]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) fail(`Unsafe profile fixture directory: ${directory}`);
    if (await realpath(directory) !== directory) fail(`Non-canonical profile fixture directory: ${directory}`);
  }
  return join(canonical, 'codex-home');
}
const sourceSkill = '---\nname: xfx-copy-fixture\ndescription: Synthetic copy acceptance skill.\n---\n\nSource package for the UI acceptance.\n';
const targetSkill = '---\nname: xfx-copy-fixture\ndescription: Old synthetic target package.\n---\n\nMust be replaced, then restored.\n';
const unrelatedSkill = '---\nname: xfx-copy-unrelated\ndescription: Preserve this target package.\n---\n\nUnrelated synthetic skill.\n';

export async function runAcceptance({ manifest, repo, testFixture = null }) {
  if (!testFixture) await admission(manifest);
  const root = manifest.root, deadline = Date.now() + manifest.mutationWindowMs;
  let mutationAdmissionChecks = 0;
  const readOnlyAdmission = async () => {
    if (testFixture) await testFixture.admitMutation(); else await admission(manifest);
    mutationAdmissionChecks++;
  };
  const admitMutation = () => runAdmittedMutation(deadline, readOnlyAdmission);
  if (!testFixture) await mkdir(root, { mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o777) !== 0o700) fail('Created fixture root is not a private directory owned by this user.');
  if (!testFixture) await mkdir(join(root, 'controller'), { mode: 0o700 });
  await mkdir(join(root, 'receipts'), { mode: 0o700 });
  const receipt = join(root, 'receipts');
  const record = async (name, value) => writeFile(join(receipt, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await record('attempt-start.json', { root, startedAt: new Date().toISOString(), deadlineEpochMs: deadline, attempts: 1 });
  const store = testFixture?.store ?? new Store(join(root, 'controller'));
  const cli = join(repo, 'bin/xfx.js');
  await mkdir(join(root, 'tmp'), { mode: 0o700 });
  const child = testFixture ? null : spawn(manifest.executables.node.path, [cli, '--store', join(root, 'controller'), 'ui', '--port', '0', '--no-open'], {
    cwd: repo, env: { PATH: `${dirname(manifest.executables.codexCommand.path)}:${dirname(manifest.executables.node.path)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, XFX_HOME: root, TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  child?.stdout.on('data', b => output += b); child?.stderr.on('data', b => errors += b);
  let browser, context;
  const mutationTracker = createMutationTracker();
  let modelRunRequests = 0, profileCreationRequests = 0;
  let runFailure = null, functionalResult = null, traceStarted = false, traceComplete = false, screenshotComplete = false;
  let browserClosed = false;
  const artifactErrors = [], admissionFailures = [], phases = [];
  try {
    let url = testFixture?.url ?? await waitFor(() => output.match(/Open this link in your browser: (https?:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1], child, 15000);
    if (!url.includes('#launch=')) fail('UI launch URL did not include its one-use launch token.');
    const launchUrl = new URL(url); launchUrl.pathname = '/profiles';
    const browserArtifacts = join(root, 'browser-artifacts');
    await mkdir(browserArtifacts, { mode: 0o700 });
    context = await chromium.launchPersistentContext(join(root, 'browser-profile'), { headless: true,
      artifactsDir: browserArtifacts, tracesDir: browserArtifacts, acceptDownloads: false,
      executablePath: testFixture ? chromium.executablePath() : manifest.browser.executable.path,
      env: { PATH: `${dirname(manifest.executables?.node?.path ?? process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'config') },
    });
    browser = context.browser();
    const page = context.pages()[0] ?? await context.newPage();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    traceStarted = true;
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const isProfileMutation = request.method() === 'POST' && (url.pathname.startsWith('/api/profiles/') || url.pathname.startsWith('/api/copies/'));
      if (request.method() === 'POST' && url.pathname.startsWith('/api/runs')) modelRunRequests++;
      if (isProfileMutation) {
        try { await admitMutation(); }
        catch (error) { admissionFailures.push(String(error?.message ?? error)); await route.abort(); return; }
      }
      if (request.method() === 'POST' && url.pathname === '/api/profiles/new') profileCreationRequests++;
      if (isProfileMutation) mutationTracker.track(request);
      try { await route.continue(); }
      catch (error) { mutationTracker.fail(request); throw error; }
    });
    page.on('requestfinished', request => mutationTracker.complete(request));
    page.on('requestfailed', request => mutationTracker.fail(request));
    page.on('console', msg => phases.push({ type: `console:${msg.type()}`, text: msg.text() }));
    page.on('pageerror', error => phases.push({ type: 'pageerror', text: error.message }));
    await page.goto(launchUrl.toString());
    if (new URL(page.url()).pathname !== '/profiles') fail('UI did not route directly to Profiles with the launch token.');
    await page.getByRole('heading', { name: 'Profiles', exact: true }).waitFor();
    await ensureOpen(deadline);
    await page.getByRole('button', { name: 'Create profile…' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('XFX UI Copy Source');
    await ensureOpen(deadline);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await page.getByRole('heading', { name: 'XFX UI Copy Source', exact: true }).waitFor();
    let profiles = (await store.read()).profiles;
    if (profiles.length !== 1) fail(`Expected one created profile after source creation, found ${profiles.length}.`);
    let source = profiles.find(p => p.name === 'XFX UI Copy Source');
    if (!source?.native?.root) fail('Source profile did not receive an isolated native home.');
    const sourceHome = await ownedProfileHome(root, source.native.root);
    await ensureOpen(deadline);
    await seed(sourceHome, 'AGENTS.md', 'Synthetic Xenoflux instruction fixture.\n', deadline, admitMutation);
    await ensureOpen(deadline);
    await replaceGeneratedConfig(sourceHome, 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\nmodel_verbosity = "high"\n', deadline, admitMutation);
    await ensureOpen(deadline);
    await seed(sourceHome, 'skills/xfx-copy-fixture/SKILL.md', sourceSkill, deadline, admitMutation);
    await ensureOpen(deadline);
    await seed(sourceHome, 'skills/xfx-copy-fixture/source-only.txt', 'synthetic source asset\n', deadline, admitMutation);
    await record('phase-source-seeded.json', { profile: source.name, paths: ['AGENTS.md', 'config.toml', 'skills/xfx-copy-fixture/SKILL.md', 'skills/xfx-copy-fixture/source-only.txt'] });
    await ensureOpen(deadline);
    await page.getByRole('button', { name: 'Create profile…' }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('XFX UI Copy Target');
    await page.getByRole('radio', { name: /Selected parts of another profile/ }).check();
    await page.getByLabel('Copy parts from').selectOption({ label: 'XFX UI Copy Source' });
    await page.getByRole('button', { name: 'Choose parts and preview' }).click();
    await page.getByRole('heading', { name: /Create XFX UI Copy Target from parts/ }).waitFor();
    await page.locator('label.row-select').filter({ hasText: 'AGENTS.md' }).getByRole('checkbox').check();
    await ensureOpen(deadline);
    await page.getByRole('button', { name: 'Create XFX UI Copy Target with 1 item' }).click();
    await page.getByRole('heading', { name: /XFX UI Copy Target created/ }).waitFor();
    profiles = (await store.read()).profiles;
    if (profiles.length !== 2 || profiles.map(profile => profile.name).sort().join(',') !== 'XFX UI Copy Source,XFX UI Copy Target') fail('Profile store does not contain exactly the two synthetic acceptance profiles.');
    const target = profiles.find(p => p.name === 'XFX UI Copy Target');
    const targetHome = await ownedProfileHome(root, target.native.root);
    if ((await readFile(join(targetHome, 'AGENTS.md'), 'utf8')) !== 'Synthetic Xenoflux instruction fixture.\n') fail('Selected instructions were not copied.');
    if ((await readFile(join(targetHome, 'config.toml'), 'utf8')) !== 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\n') fail('Source config settings leaked into the target during selected creation.');
    for (const absent of ['skills/xfx-copy-fixture/SKILL.md']) {
      try { await lstat(join(targetHome, absent)); fail(`Unselected source content appeared: ${absent}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await page.getByRole('link', { name: 'Back to Profiles' }).click();
    await ensureOpen(deadline);
    await replaceGeneratedConfig(targetHome, 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\npersonality = "friendly"\n', deadline, admitMutation);
    await ensureOpen(deadline);
    await seed(targetHome, 'skills/xfx-copy-fixture/SKILL.md', targetSkill, deadline, admitMutation);
    await ensureOpen(deadline);
    await seed(targetHome, 'skills/xfx-copy-fixture/destination-only.txt', 'synthetic destination-only file\n', deadline, admitMutation);
    await ensureOpen(deadline);
    await seed(targetHome, 'skills/xfx-copy-unrelated/SKILL.md', unrelatedSkill, deadline, admitMutation);
    await ensureOpen(deadline);
    await seed(targetHome, 'skills/xfx-copy-unrelated/keep.txt', 'unselected destination content\n', deadline, admitMutation);
    await record('fixture-ready.json', { profiles: profiles.map(p => p.name), sourceRoot: source.native.root, targetRoot: target.native.root });
    const snapshot = async () => {
      const entries = [];
      async function walk(dir, base = '') {
        const { readdir, lstat, readFile } = await import('node:fs/promises');
        for (const name of (await readdir(dir)).sort()) {
          const path = join(dir, name), rel = join(base, name), info = await lstat(path);
          if (info.isSymbolicLink()) fail(`Unexpected link in target snapshot: ${rel}`);
          if (info.isDirectory()) { entries.push([rel, 'directory', info.mode & 0o777]); await walk(path, rel); }
          else if (info.isFile()) entries.push([rel, 'file', info.mode & 0o777, hash(await readFile(path))]);
          else fail(`Unexpected target artifact: ${rel}`);
        }
      }
      await walk(targetHome);
      return JSON.stringify(entries);
    };
    const sourceBefore = await snapshotAt(sourceHome);
    const unrelatedBefore = await snapshotAt(join(targetHome, 'skills/xfx-copy-unrelated'));
    const journalSnapshot = async () => {
      const { readdir, lstat, readFile } = await import('node:fs/promises'), path = join(root, 'controller/native-copies'), entries = [];
      async function walk(dir, base = '') {
        for (const name of (await readdir(dir)).sort()) {
          const full = join(dir, name), relativePath = join(base, name), info = await lstat(full);
          if (info.isSymbolicLink()) fail(`Unexpected link in copy journal: ${relativePath}`);
          if (info.isDirectory()) { entries.push([relativePath, 'directory', info.mode & 0o777]); await walk(full, relativePath); }
          else if (info.isFile()) entries.push([relativePath, 'file', info.mode & 0o777, hash(await readFile(full))]);
          else fail(`Unexpected copy journal artifact: ${relativePath}`);
        }
      }
      try { await walk(path); return JSON.stringify(entries); }
      catch (error) { if (error.code === 'ENOENT') return '[]'; throw error; }
    };
    const before = await snapshot();
    const journalsBefore = await journalSnapshot();
    await page.getByRole('button', { name: 'More actions for XFX UI Copy Target' }).click();
    await page.getByRole('menuitem', { name: /Copy settings from another profile/ }).click();
    await page.getByLabel('Copy from').selectOption({ label: 'XFX UI Copy Source' });
    await page.getByRole('button', { name: 'Choose items' }).click();
    await page.getByRole('link', { name: 'Cancel', exact: true }).click();
    const afterCancel = await snapshot();
    if (before !== afterCancel || journalsBefore !== await journalSnapshot()) fail('Cancel changed target files, modes, directories or copy journals.');
    await record('phase-cancel-verified.json', { unchanged: true, targetSnapshotSha256: hash(before) });
    await page.getByRole('button', { name: 'More actions for XFX UI Copy Target' }).click();
    await page.getByRole('menuitem', { name: /Copy settings from another profile/ }).click();
    await page.getByLabel('Copy from').selectOption({ label: 'XFX UI Copy Source' });
    await page.getByRole('button', { name: 'Choose items' }).click();
    await page.locator('label.row-select').filter({ hasText: 'model_verbosity' }).getByRole('checkbox').check();
    const skillRow = page.locator('label.row-select').filter({ hasText: 'xfx-copy-fixture' });
    await expect(skillRow).toContainText('exact replacement');
    await skillRow.getByRole('button', { name: 'Inspect file changes' }).click();
    await expect(skillRow).toContainText('destination-only.txt');
    await expect(skillRow).toContainText('remove');
    await expect(skillRow.getByText('skills/xfx-copy-fixture/destination-only.txt', { exact: true })).toBeVisible();
    await expect(skillRow.getByText('skills/xfx-copy-fixture/source-only.txt', { exact: true })).toBeVisible();
    await expect(skillRow.locator('pre').filter({ hasText: 'Must be replaced, then restored.' })).toBeVisible();
    await expect(skillRow.locator('pre').filter({ hasText: 'Source package for the UI acceptance.' })).toBeVisible();
    await expect(skillRow.getByText('0600 → —', { exact: false })).toBeVisible();
    await expect(skillRow.getByText('— → 0600', { exact: false })).toBeVisible();
    await skillRow.getByRole('checkbox').check();
    await ensureOpen(deadline);
    await page.getByRole('button', { name: 'Apply 2 changes to XFX UI Copy Target' }).click();
    await page.getByRole('heading', { name: /Copied into XFX UI Copy Target/ }).waitFor();
    const appliedConfig = await readFile(join(targetHome, 'config.toml'), 'utf8');
    const parsedConfig = parseToml(appliedConfig);
    const actualSettings = Object.entries(parsedConfig).sort(([a], [b]) => a.localeCompare(b));
    const expectedSettings = [['allow_symlinked_codex_home', true], ['cli_auth_credentials_store', 'file'], ['model_verbosity', 'high'], ['personality', 'friendly']].sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(actualSettings) !== JSON.stringify(expectedSettings)) fail('Applied config is not exactly the selected source setting plus preserved destination personality and native keys.');
    const packageNames = await import('node:fs/promises').then(fs => fs.readdir(join(targetHome, 'skills/xfx-copy-fixture')));
    const sourcePackage = await snapshotAt(join(sourceHome, 'skills/xfx-copy-fixture'));
    const targetPackage = await snapshotAt(join(targetHome, 'skills/xfx-copy-fixture'));
    if (packageNames.sort().join(',') !== 'SKILL.md,source-only.txt' || targetPackage !== sourcePackage) fail('Selected skill package was not replaced exactly, including file modes.');
    if (await snapshotAt(join(targetHome, 'skills/xfx-copy-unrelated')) !== unrelatedBefore) fail('Unrelated skill files or modes changed.');
    const configStat = await lstat(join(targetHome, 'config.toml'));
    if ((configStat.mode & 0o777) !== 0o600 || await snapshotAt(sourceHome) !== sourceBefore) fail('Copy changed source content or config mode.');
    for (const home of [sourceHome, targetHome]) for (const forbidden of ['auth.json', 'credentials.json']) {
      try { await lstat(join(home, forbidden)); fail(`Unexpected credential file in isolated profile: ${forbidden}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await record('phase-applied-verified.json', { selectedSetting: 'model_verbosity', selectedSkill: 'xfx-copy-fixture', exactPackage: packageNames.sort(), sourceUnchanged: true, credentialsAbsent: true });
    await ensureOpen(deadline);
    await page.getByRole('button', { name: 'Undo this copy' }).click();
    await page.getByRole('heading', { name: 'Undone', exact: true }).waitFor();
    const undone = await snapshot();
    if (before !== undone) fail('Undo did not restore prior target files, modes and directories.');
    if (await snapshotAt(sourceHome) !== sourceBefore) fail('Undo changed source profile content or modes.');
    const { readdir: journalNames, lstat: journalStat, readFile: journalRead } = await import('node:fs/promises');
    const journalRoot = join(root, 'controller/native-copies'), journals = [];
    async function collectJournals(dir) {
      for (const name of await journalNames(dir)) {
        const path = join(dir, name), info = await journalStat(path);
        if (info.isSymbolicLink()) fail('Unexpected link in copy journal history.');
        if (info.isDirectory()) await collectJournals(path);
        else if (name === 'journal.json') journals.push(JSON.parse(await journalRead(path, 'utf8')));
      }
    }
    await collectJournals(journalRoot);
    const updates = journals.filter(journal => journal.kind === 'native-settings-copy' && journal.packages?.length === 1);
    const creation = journals.filter(journal => journal.kind === 'native-settings-copy' && journal.files?.some(file => file.path === 'AGENTS.md') && !journal.packages?.length);
    let pendingExists = false; try { await lstat(join(journalRoot, 'pending.json')); pendingExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (journals.length !== 2 || updates.length !== 1 || updates[0].phase !== 'undone' || creation.length !== 1 || creation[0].phase !== 'applied' || pendingExists) fail('Copy journal history or pending state is incomplete or ambiguous.');
    await record('phase-undone-verified.json', { restored: true, targetSnapshotSha256: hash(undone) });
    const profileCount = (await store.read()).profiles.length;
    if (profileCount !== 2 || profileCreationRequests !== 2 || modelRunRequests !== 0) fail(`Unexpected fixture counts: ${profileCount} profiles, ${profileCreationRequests} creation requests, ${modelRunRequests} model run requests.`);
    const versionProbeUpperBound = profileCreationRequests;
    const versionProbesObserved = testFixture ? await testFixture.countVersionProbes() : undefined;
    if (versionProbeUpperBound > (manifest.limits?.versionProbes ?? 2) || (versionProbesObserved !== undefined && versionProbesObserved > versionProbeUpperBound)) fail('Version probe count exceeded the approved cap or did not match the create actions.');
    functionalResult = { profileCount, profileCreationRequests, modelRunRequests, versionProbeUpperBound,
      ...(versionProbesObserved === undefined ? {} : { versionProbesObserved }), undoJournals: journals.length };
    await record('functional-pass.json', { ...functionalResult, verifiedAt: new Date().toISOString(), phases });
    await page.screenshot({ path: join(receipt, 'undone.png'), fullPage: true });
    screenshotComplete = true;
  } catch (error) {
    runFailure = error;
    if (context?.pages()[0]) {
      try { await context.pages()[0].screenshot({ path: join(receipt, 'failure.png'), fullPage: true }); }
      catch (screenshotError) { artifactErrors.push(`failure screenshot: ${screenshotError.message}`); }
    }
  }

  if (context && traceStarted) {
    try { await context.tracing.stop({ path: join(receipt, 'trace.zip') }); traceComplete = true; }
    catch (error) { artifactErrors.push(`trace: ${error.message}`); }
  }
  if (context) {
    try { await context.close(); }
    catch (error) { artifactErrors.push(`browser context close: ${error.message}`); }
  }
  if (browser) {
    try { await browser.close(); browserClosed = true; }
    catch (error) { artifactErrors.push(`browser close: ${error.message}`); }
  }

  const mutationAmbiguous = mutationTracker.ambiguous;
  let serverStopped = false, serverShutdown = 'not-stopped';
  if (mutationAmbiguous) {
    serverShutdown = 'retained-ambiguous-mutation';
  } else if (child) {
    if (child.exitCode !== null || child.signalCode !== null) {
      serverStopped = child.signalCode !== null || child.exitCode === 0;
      serverShutdown = serverStopped ? 'already-exited' : `unexpected-exit:${child.exitCode}`;
    } else {
      try {
        const close = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
        child.kill('SIGTERM');
        const outcome = await Promise.race([close, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
        if (outcome) { serverStopped = outcome.signal !== null || outcome.code === 0; serverShutdown = serverStopped ? (outcome.signal ? `signal:${outcome.signal}` : `exit:${outcome.code}`) : `unexpected-exit:${outcome.code}`; }
        else serverShutdown = 'shutdown-timeout';
      } catch (error) { serverShutdown = `shutdown-error:${error.message}`; }
    }
  } else if (testFixture) {
    try {
      const stopped = await Promise.race([testFixture.stopServer(), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
      serverStopped = stopped === true; serverShutdown = serverStopped ? 'fixture-stopped' : 'shutdown-timeout';
    } catch (error) { serverShutdown = `shutdown-error:${error.message}`; }
  }
  if (!serverStopped && !mutationAmbiguous) {
    try { await record('server-retained.json', { pid: child?.pid ?? null, reason: serverShutdown }); }
    catch (error) { artifactErrors.push(`server-retained receipt: ${error.message}`); }
  } else if (mutationAmbiguous) {
    try { await record('server-retained.json', { pid: child?.pid ?? null, reason: 'profile mutation request failed or remains outstanding; server was preserved' }); }
    catch (error) { artifactErrors.push(`server-retained receipt: ${error.message}`); }
  }
  try {
    const fixtureLog = testFixture?.serverLogs?.join('\n') ?? '';
    await writeFile(join(receipt, 'server-output.log'), output + '\n' + errors + '\n' + fixtureLog, { flag: 'wx', mode: 0o600 });
  } catch (error) { artifactErrors.push(`server output receipt: ${error.message}`); }

  const functionalPass = functionalResult !== null;
  const artifactsComplete = screenshotComplete && traceComplete && browserClosed && artifactErrors.length === 0;
  const passed = acceptanceCanPass({ functionalPass, screenshotComplete, traceComplete, browserClosed, artifactErrors, serverStopped, mutationAmbiguous });
  const result = { result: passed ? 'passed' : functionalPass ? 'incomplete' : 'failed', completedAt: new Date().toISOString(),
    functionalPass, artifactsComplete, screenshotComplete, traceComplete, browserClosed, serverStopped, serverShutdown,
    mutationAmbiguous, admissionChecks: mutationAdmissionChecks,
    admissionFailures, artifactErrors, failure: runFailure?.message ?? null, ...(functionalResult ?? {}) };
  if (!passed && runFailure) {
    try { await record('failure.json', { message: runFailure.message, at: new Date().toISOString(), output, errors, artifactErrors, admissionFailures }); }
    catch (error) { artifactErrors.push(`failure receipt: ${error.message}`); }
  }
  await record('acceptance.json', result);
  if (!passed) throw runFailure ?? new Error(`Native UI acceptance incomplete: ${JSON.stringify(result)}`);
}

async function snapshotAt(home) {
  const entries = [];
  async function walk(dir, base = '') {
    const { readdir, lstat, readFile } = await import('node:fs/promises');
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), rel = join(base, name), info = await lstat(path);
      if (info.isSymbolicLink()) fail(`Unexpected link in profile snapshot: ${rel}`);
      if (info.isDirectory()) { entries.push([rel, 'directory', info.mode & 0o777]); await walk(path, rel); }
      else if (info.isFile()) entries.push([rel, 'file', info.mode & 0o777, hash(await readFile(path))]);
      else fail(`Unexpected profile artifact: ${rel}`);
    }
  }
  await walk(home);
  return JSON.stringify(entries);
}

async function waitFor(read, child, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = read(); if (value) return value; if (child.exitCode !== null) fail('UI server exited before becoming ready.'); await new Promise(resolve => setTimeout(resolve, 100)); }
  fail('UI server readiness timed out.');
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help' || args.length === 0) { process.stdout.write(help + '\n'); return; }
  if (args.length !== 2 || !['--check-grant', '--run-approved'].includes(args[0])) fail(help);
  const result = await validateManifest(args[1], { allowProposed: args[0] === '--check-grant' });
  if (args[0] === '--check-grant') { process.stdout.write(JSON.stringify({ status: 'manifest-valid', approvalStatus: result.manifest.status, root: result.manifest.root, candidate: result.manifest.candidate.commit, writes: false }, null, 2) + '\n'); return; }
  await runAcceptance(result);
}
if (process.argv[1] && await realpath(process.argv[1]) === script) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
