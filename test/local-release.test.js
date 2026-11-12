import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveRuntimeDependency, assertInstallHooks, buildBundledPackage, bundledManifest, hasReadCorroboration, manifestFor, packageInventory, parseArguments, preservesFrozenAuditFields } from '../scripts/local-release.mjs';

test('local release arguments and manifests retain only reviewable artifact facts', () => {
  assert.deepEqual(parseArguments(['--output', '/tmp/release', '--smoke']), {
    output: '/tmp/release', smoke: true,
  });
  assert.throws(() => parseArguments(['--output']), /Missing value/);
  assert.throws(() => parseArguments(['--helpers', '/tmp/helpers']), /Unknown option/);
  assert.deepEqual(manifestFor({ packageName: 'xenoflux', version: '0.1.1-rc.1', tarball: 'xenoflux.tgz',
    sha256: 'abc', sourceRevision: '5ab3e9f', smoke: { status: 'passed' } }), {
    schemaVersion: 3, package: 'xenoflux', version: '0.1.1-rc.1', tarball: 'xenoflux.tgz',
    sha256: 'abc', runtime: { bundled: true, platform: 'darwin', arch: 'arm64' },
    sourceRevision: '5ab3e9f', smoke: { status: 'passed' },
  });
});

test('detached audit smoke accepts derived projections while preserving frozen input and corroboration', () => {
  const frozen = { id: 'smoke', status: 'partial', skills: [{ id: 'skill', read: true }] };
  const projection = { ...frozen, comparisonEvidence: { actions: [
    { kind: 'resource-read', corroboration: 'native-unknown-absolute-cat' },
  ] }, checks: [] };
  assert.equal(preservesFrozenAuditFields(projection, frozen), true);
  assert.equal(hasReadCorroboration(projection), true);
  assert.equal(preservesFrozenAuditFields({ ...projection, skills: [] }, frozen), false);
  assert.equal(hasReadCorroboration({ ...projection, comparisonEvidence: { actions: [] } }), false);
});

test('npm package includes reviewed docs and excludes private receipts and unreviewed documentation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-package-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'xfx-package-boundary-fixture', version: '1.0.0', files: manifest.files }));
  const publicPaths = ['bin/xfx.js', 'src/fixture.js', 'README.md', 'LICENSE', 'docs/user/AUDIT.md',
    'docs/developer/README.md', 'docs/developer/AUDIT-ACCEPTANCE.md',
    'docs/developer/DESKTOP-IMPLEMENTATION.md', 'docs/developer/PROFILE-COPY-POLICY.md',
    'docs/developer/AUDIT-GOAL.md', 'docs/developer/ROADMAP.md', 'docs/developer/REVIEW-TASK-IMPLEMENTATION.md'];
  const privatePaths = [
    'docs/developer/CLIENT-SUPPORT-PLAN.md', 'docs/developer/LOCAL-RELEASE.md',
    'docs/developer/history/README.md', 'docs/developer/history/DESKTOP-HISTORY.md',
    'docs/developer/history/RELEASE-3.1.1.md', 'docs/developer/history/evidence/audit-2.0.0-summary.json',
    '.agents/skills/shadcn/SKILL.md', '.agents/skills/shadcn/assets/shadcn.png',
    'docs/developer/evidence/audit-private-canary.json', 'docs/developer/HANDOVER-macos-audit-release.md',
    'docs/developer/UNREVIEWED.md', 'docs/user/PRIVATE-NOTES.md',
    'docs/developer/history/private/canary.md', 'docs/developer/history/UNREVIEWED.md',
    'docs/developer/history/evidence/private-canary.json',
    'docs/knowledge/private-canary.md', 'docs/knowledge/private-sources.json',
    'docs/examples/private-canary.json', 'release-artifacts/private-canary.json', 'output/design/private-canary.md'];
  for (const path of [...publicPaths, ...privatePaths]) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), 'Synthetic publication boundary fixture.\n');
  }
  const result = await run('npm', ['pack', '--dry-run', '--offline', '--ignore-scripts', '--json', '--cache', join(directory, 'cache')], { cwd: directory });
  assert.equal(result.code, 0, result.stderr);
  const included = new Set(JSON.parse(result.stdout)[0].files.map(file => file.path));
  for (const path of publicPaths) assert.ok(included.has(path), `Missing reviewed input: ${path}`);
  for (const path of privatePaths) assert.equal(included.has(path), false, `Private/unreviewed input packaged: ${path}`);
});

function run(file, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolveRun({ code, stdout, stderr }));
  });
}

async function digest(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }

test('runtime dependency archives preserve package files without running lifecycle scripts', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx dependency archive '));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, 'installed-dependency');
  const staged = join(root, 'staged');
  const archive = join(root, 'dependency.tgz');
  await mkdir(join(source, 'node_modules', 'separately-locked'), { recursive: true });
  await mkdir(staged);
  const canary = "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'hook'); process.exit(97)\"";
  const manifest = JSON.stringify({
    name: 'xfx-dependency-canary', version: '1.0.0', bin: { canary: 'bin.js' },
    scripts: { prepack: canary, prepare: canary, postpack: canary, install: canary },
  }) + '\n';
  await writeFile(join(source, 'package.json'), manifest);
  await writeFile(join(source, 'LICENSE'), 'Canary license bytes.\n');
  await writeFile(join(source, 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  await writeFile(join(source, 'node_modules', 'separately-locked', 'package.json'), '{"name":"separately-locked"}\n');
  const integrity = await archiveRuntimeDependency(source, archive);
  assert.equal(integrity, `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`);
  const extracted = await run('/usr/bin/tar', ['-xzf', archive, '-C', staged]);
  assert.equal(extracted.code, 0, extracted.stderr);
  const packaged = join(staged, 'package');
  assert.equal(await readFile(join(packaged, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(join(packaged, 'LICENSE'), 'utf8'), 'Canary license bytes.\n');
  assert.equal((await stat(join(packaged, 'bin.js'))).mode & 0o111, 0o111);
  await assert.rejects(access(join(packaged, 'node_modules')), { code: 'ENOENT' });

  await writeFile(join(staged, 'package.json'), '{"private":true}\n');
  const installed = await run('npm', ['install', '--offline', '--ignore-scripts', '--no-package-lock',
    '--no-audit', '--no-fund', '--cache', join(root, 'empty-cache'), archive], { cwd: staged });
  assert.equal(installed.code, 0, installed.stderr);
  for (const location of [source, packaged, join(staged, 'node_modules', 'xfx-dependency-canary')])
    await assert.rejects(access(join(location, 'lifecycle-ran')), { code: 'ENOENT' });
});

test('self-contained npm bundle preserves locked SDK files, peers and Koffi without SDK CLIs', { skip: process.platform !== 'darwin' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx offline runtime '));
  t.after(() => rm(root, { force: true, recursive: true }));
  const fixture = join(root, 'project');
  const release = join(root, 'release');
  await mkdir(join(fixture, 'bin'), { recursive: true });
  await mkdir(release);
  await writeFile(join(fixture, 'package.json'), await readFile(join(process.cwd(), 'package.json')));
  await writeFile(join(fixture, 'bin', 'xfx.js'), `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { RuntimeConnection } from '@github/copilot-sdk';
import koffi from 'koffi';
const external = process.argv.at(-1);
assert.equal(typeof query, 'function');
assert.equal(typeof koffi.load, 'function');
assert.ok(isAbsolute(external));
assert.equal(RuntimeConnection.forStdio({ path: external }).path, external);
`, { mode: 0o700 });
  const packed = await run('npm', ['pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', release, '--cache', join(root, 'fixture-pack-cache')], { cwd: fixture });
  assert.equal(packed.code, 0, packed.stderr);
  const [project] = JSON.parse(packed.stdout);
  const { install, archive: bundle, inventory } = await buildBundledPackage(project, join(release, project.filename), root, release);
  const application = join(install, 'node_modules', 'xenoflux');
  const binary = join(application, 'bin', 'xfx.js');
  const external = join(root, 'external', 'copilot');
  const result = await run(process.execPath, [binary, external], { cwd: install, env: { ...process.env, NODE_PATH: '' } });
  assert.equal(result.code, 0, result.stderr);
  const contents = await run('/usr/bin/tar', ['-tzf', bundle]);
  assert.equal(contents.code, 0, contents.stderr);
  assert.match(contents.stdout, /node_modules\/@anthropic-ai\/claude-agent-sdk\/package\.json/);
  assert.match(contents.stdout, /node_modules\/@github\/copilot-sdk\/package\.json/);
  assert.ok(contents.stdout.includes('node_modules/@koromix/koffi-darwin-arm64/package.json'));
  assert.ok(contents.stdout.includes('node_modules/which/CHANGELOG.md'));
  assert.doesNotMatch(contents.stdout, /node_modules\/(?:@anthropic-ai\/claude-agent-sdk-|@github\/copilot-sdk-|@koromix\/koffi-darwin-x64|vite\/)/);
  assert.doesNotMatch(contents.stdout, /(?:^|\/)\._/m);
  const published = JSON.parse(await readFile(join(application, 'package.json'), 'utf8'));
  assert.equal(published.private, undefined);
  assert.equal(published.scripts.prepack, undefined);
  assert.deepEqual(published.cpu, ['arm64']);
  assert.deepEqual(published.os, ['darwin']);
  assert.deepEqual(Object.keys(published.dependencies).sort(), published.bundleDependencies.toSorted());
  for (const name of ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'zod']) assert.ok(published.dependencies[name]);
  for (const mode of ['normal', 'omit-optional']) {
    const prefix = join(root, mode, 'prefix');
    const installed = await run('npm', ['install', '--global', bundle, '--prefix', prefix, '--offline', '--foreground-scripts',
      '--no-audit', '--no-fund', '--cache', join(root, mode, 'empty-cache'), ...(mode === 'omit-optional' ? ['--omit=optional'] : [])]);
    assert.equal(installed.code, 0, installed.stderr);
    const globalApp = join(prefix, 'lib', 'node_modules', 'xenoflux');
    assert.deepEqual(await packageInventory(globalApp, { npmBinsFor: inventory }), inventory);
    const probe = await run(process.execPath, [join(globalApp, 'bin', 'xfx.js'), external], { cwd: root, env: { ...process.env, NODE_PATH: '' } });
    assert.equal(probe.code, 0, probe.stderr);
  }
  const manifest = manifestFor({ packageName: project.name, version: project.version, tarball: project.filename,
    sha256: await digest(bundle) });
  const installer = join(release, 'install.mjs');
  await writeFile(join(release, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(installer, await readFile(join(process.cwd(), 'scripts', 'install-template.mjs')));
  const standalone = await run(process.execPath, [installer, external], { cwd: root, env: { ...process.env, NODE_PATH: '' } });
  assert.equal(standalone.code, 0, standalone.stderr);
});

async function archive(source, output, name) {
  const result = await run('/usr/bin/tar', ['-czf', output, '-C', source, name]);
  assert.equal(result.code, 0, result.stderr);
}

async function installerFixture(t, { projectDirectory = 'package' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-install-template-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const projectSource = join(root, 'project-source', projectDirectory);
  const dependencySource = projectSource;
  await mkdir(join(projectSource, 'bin'), { recursive: true, mode: 0o700 });
  await writeFile(join(projectSource, 'package.json'), JSON.stringify({ name: 'xenoflux', version: '0.2.0', type: 'module',
    os: ['darwin'], cpu: ['arm64'], bundleDependencies: ['@fixture/sdk'] }) + '\n');
  await writeFile(join(projectSource, 'bin', 'xfx.js'), `import { writeFile } from 'node:fs/promises';
import { marker } from '@fixture/sdk';
if (marker !== 'nested-runtime') throw new Error('Wrong SDK dependency was resolved');
await writeFile(process.env.XFX_INSTALL_ARGUMENTS, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o600 });
  const sdk = join(dependencySource, 'node_modules', '@fixture', 'sdk');
  const nested = join(sdk, 'node_modules', 'runtime-marker');
  await mkdir(nested, { recursive: true });
  await writeFile(join(sdk, 'package.json'), '{"name":"@fixture/sdk","type":"module","exports":"./index.js"}\n');
  await writeFile(join(sdk, 'index.js'), "export { marker } from 'runtime-marker';\n");
  await writeFile(join(nested, 'package.json'), '{"name":"runtime-marker","type":"module","exports":"./index.js"}\n');
  await writeFile(join(nested, 'index.js'), "export const marker = 'nested-runtime';\n");
  const release = join(root, 'release');
  await mkdir(release, { mode: 0o700 });
  const project = join(release, 'xenoflux.tgz');
  await archive(dirname(projectSource), project, projectDirectory);
  const template = join(process.cwd(), 'scripts', 'install-template.mjs');
  await writeFile(join(release, 'install.mjs'), await readFile(template), { mode: 0o700 });
  const manifest = manifestFor({ packageName: 'xenoflux', version: '0.2.0', tarball: 'xenoflux.tgz', sha256: await digest(project) });
  await writeFile(join(release, 'manifest.json'), JSON.stringify(manifest));
  return { root, release, project, manifest, projectSource };
}

test('standalone installer verifies tarballs, stages package paths, and preserves quoted arguments', async t => {
  const f = await installerFixture(t);
  const result = join(f.root, 'arguments.json');
  const quoted = '/tmp/a space "$HOME" $(not-a-command)';
  const processResult = await run(process.execPath, [join(f.release, 'install.mjs'), '--background-path', quoted], {
    cwd: f.root, env: { ...process.env, XFX_INSTALL_ARGUMENTS: result },
  });
  assert.equal(processResult.code, 0, processResult.stderr);
  assert.deepEqual(JSON.parse(await readFile(result, 'utf8')), ['install', '--background-path', quoted]);
});

test('standalone installer rejects a changed bundled archive before staging', async t => {
  const f = await installerFixture(t);
  await writeFile(f.project, 'changed');
  const output = join(f.root, 'arguments.json');
  const result = await run(process.execPath, [join(f.release, 'install.mjs')], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: output } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SHA-256 mismatch/);
  await assert.rejects(readFile(output));
});

test('standalone installer refuses a bundle for a different architecture', async t => {
  const f = await installerFixture(t);
  // A valid Apple Silicon manifest must refuse an Intel host before staging.
  const template = pathToFileURL(join(f.release, 'install.mjs')).href;
  await writeFile(join(f.release, 'manifest.json'), JSON.stringify(f.manifest));
  const output = join(f.root, 'arguments.json');
  const result = await run(process.execPath, ['--input-type=module', '--eval', `Object.defineProperty(process, 'arch', { value: 'x64' }); await import(${JSON.stringify(template)});`], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: output } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Release runtime requires/);
  await assert.rejects(readFile(output));
});

test('standalone installer rejects archives whose entries are outside package', async t => {
  const f = await installerFixture(t, { projectDirectory: 'unexpected' });
  const result = await run(process.execPath, [join(f.release, 'install.mjs')], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: join(f.root, 'arguments.json') } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unsafe archive paths/);
});

test('standalone installer rejects an unsupported Node before loading the release manifest', async t => {
  const template = pathToFileURL(join(process.cwd(), 'scripts', 'install-template.mjs')).href;
  for (const version of ['20.12.0', '22.14.0', '23.0.0', '23.7.0']) {
    const result = await run(process.execPath, ['--input-type=module', '--eval', `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(template)});`]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(`Node 22.15.0+ (22.x) or 23.8.0+ is required; found v${version}`));
  }
});


test('checkout is private and ordinary npm pack refuses the unbundled development tree', async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(process.cwd(), 'package-lock.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.cpu, ['arm64']);
  assert.deepEqual(lock.packages[''].cpu, ['arm64']);
  const result = await run('npm', ['pack', '--dry-run', '--offline', '--json']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Direct checkout packing is disabled/);
});

test('complete package archive conserves upstream changelogs and rejects unsafe members', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-complete-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const dependency = join(source, 'node_modules', 'fixture');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'CHANGELOG.md'), 'Must survive npm packlist filtering.\n');
  await writeFile(join(dependency, 'LICENSE'), 'License must remain byte-identical.\n');
  const expected = await packageInventory(source);
  const archive = join(root, 'complete.tgz');
  await archiveRuntimeDependency(source, archive, { includeNodeModules: true });
  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  const result = await run('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await packageInventory(join(extracted, 'package')), expected);
  await symlink('/outside', join(dependency, 'unsafe-link'));
  await assert.rejects(packageInventory(source), /Unsafe package member/);
  await assert.rejects(archiveRuntimeDependency(source, join(root, 'unsafe.tgz'), { includeNodeModules: true }), /Unsafe installed runtime dependency member/);
});

test('standalone installer refuses unsafe artifact names, digests and incompatible format before effects', async t => {
  for (const change of [
    { tarball: '../outside.tgz' }, { sha256: 'not-a-digest' }, { schemaVersion: 2 },
    { runtime: { bundled: false, platform: 'darwin', arch: 'arm64' } },
  ]) {
    const f = await installerFixture(t);
    await writeFile(join(f.release, 'manifest.json'), JSON.stringify({ ...f.manifest, ...change }));
    const marker = join(f.root, 'arguments.json');
    const result = await run(process.execPath, [join(f.release, 'install.mjs')], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: marker } });
    assert.equal(result.code, 1, result.stderr);
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
});

test('standalone installer rejects links in a correctly hashed archive before extracting', async t => {
  const f = await installerFixture(t);
  await symlink('/outside', join(f.projectSource, 'unsafe-link'));
  await archive(dirname(f.projectSource), f.project, 'package');
  f.manifest.sha256 = await digest(f.project);
  await writeFile(join(f.release, 'manifest.json'), JSON.stringify(f.manifest));
  const marker = join(f.root, 'arguments.json');
  const result = await run(process.execPath, [join(f.release, 'install.mjs')], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: marker } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unsafe archive member type/);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});


test('default install smoke accepts only the reviewed dependency install hook', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-install-hook-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dependency = join(root, 'node_modules', 'koffi');
  await mkdir(dependency, { recursive: true });
  const file = join(dependency, 'package.json');
  const reviewed = { name: 'koffi', version: '3.3.4', scripts: { install: 'node ./cnoke.cjs -P . -D src/koffi --prebuild --release' } };
  await writeFile(file, JSON.stringify(reviewed));
  assert.deepEqual(await assertInstallHooks(root, await packageInventory(root)), ['koffi@3.3.4:install']);
  await writeFile(file, JSON.stringify({ ...reviewed, scripts: { install: 'unreviewed-native-command' } }));
  await assert.rejects(assertInstallHooks(root, await packageInventory(root)), /Unreviewed bundled install hook/);
});


test('installed inventory accepts only npm aliases declared by unchanged bundled manifests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-generated-bin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dependency = join(root, 'node_modules', 'fixture');
  const aliases = join(root, 'node_modules', '.bin');
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture', bin: { fixture: 'bin.js' } }));
  await writeFile(join(dependency, 'bin.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const expected = await packageInventory(root);
  await mkdir(aliases);
  await symlink('../fixture/bin.js', join(aliases, 'fixture'));
  assert.deepEqual(await packageInventory(root, { npmBinsFor: expected }), expected);
  await assert.rejects(packageInventory(root), /Unexpected npm binary link/);
  await symlink('../fixture/bin.js', join(aliases, 'undeclared'));
  await assert.rejects(packageInventory(root, { npmBinsFor: expected }), /Unexpected npm binary link/);
  await rm(join(aliases, 'undeclared'));
  await rm(join(aliases, 'fixture'));
  await symlink('/outside', join(aliases, 'fixture'));
  await assert.rejects(packageInventory(root, { npmBinsFor: expected }));
});
