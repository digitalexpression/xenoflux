import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOfflineRuntime, hasReadCorroboration, manifestFor, parseArguments, preservesFrozenAuditFields } from '../scripts/local-release.mjs';

test('local release arguments and manifests retain only reviewable artifact facts', () => {
  assert.deepEqual(parseArguments(['--output', '/tmp/release', '--smoke']), {
    output: '/tmp/release', smoke: true,
  });
  assert.throws(() => parseArguments(['--output']), /Missing value/);
  assert.throws(() => parseArguments(['--helpers', '/tmp/helpers']), /Unknown option/);
  assert.deepEqual(manifestFor({ packageName: 'xenoflux', version: '0.1.1-rc.1', tarball: 'xenoflux.tgz',
    sha256: 'abc', dependencies: [{ name: 'xenoflux-runtime', version: '0.1.1-rc.1', tarball: 'runtime.tgz',
      platform: 'darwin', arch: 'arm64', sha256: 'def' }],
    sourceRevision: '5ab3e9f', smoke: { status: 'passed' } }), {
    schemaVersion: 2, package: 'xenoflux', version: '0.1.1-rc.1', tarball: 'xenoflux.tgz',
    sha256: 'abc', dependencies: [{ name: 'xenoflux-runtime', version: '0.1.1-rc.1', tarball: 'runtime.tgz',
      platform: 'darwin', arch: 'arm64', sha256: 'def' }],
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
    'docs/developer/AUDIT-ACCEPTANCE.md', 'docs/developer/history/README.md',
    'docs/developer/DESKTOP-IMPLEMENTATION.md', 'docs/developer/history/DESKTOP-HISTORY.md',
    'docs/developer/AUDIT-GOAL.md', 'docs/developer/ROADMAP.md', 'docs/developer/REVIEW-TASK-IMPLEMENTATION.md', 'docs/developer/history/PROFILE-UI-ASSESSMENT.md',
    'docs/developer/history/evidence/audit-2.0.0-summary.json', 'docs/developer/history/evidence/profile-comparison-2026-10-14-summary.json',
    'docs/developer/history/RELEASE-3.1.1.md', 'docs/developer/history/RELEASE-3.1.0.md',
    'docs/developer/history/RELEASE-2.1.0.md', 'docs/developer/history/RELEASE-3.0.0.md', 'docs/developer/history/RELEASE-3.0.1.md', 'docs/developer/history/RELEASE-2.0.0.md',
    'docs/developer/history/ROADMAP-2.1.0.md', 'docs/developer/history/PROFILE-ASSESSMENT-2.1.0.md'];
  const privatePaths = [
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

test('offline npm installs the locked SDKs and builds a runtime archive without SDK CLIs', { skip: process.platform !== 'darwin' }, async t => {
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
  const { install, dependency } = await buildOfflineRuntime(project, join(release, project.filename), root, release);
  const binary = join(install, 'node_modules', 'xenoflux', 'bin', 'xfx.js');
  const external = join(root, 'external', 'copilot');
  const result = await run(process.execPath, [binary, external], {
    cwd: install, env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(dependency.arch, process.arch);
  const bundle = join(release, dependency.tarball);
  assert.equal(dependency.sha256, await digest(bundle));
  const contents = await run('/usr/bin/tar', ['-tzf', bundle]);
  assert.equal(contents.code, 0, contents.stderr);
  assert.match(contents.stdout, /node_modules\/@anthropic-ai\/claude-agent-sdk\/package\.json/);
  assert.match(contents.stdout, /node_modules\/@github\/copilot-sdk\/package\.json/);
  assert.ok(contents.stdout.includes(`node_modules/@koromix/koffi-darwin-${process.arch}/package.json`));
  assert.doesNotMatch(contents.stdout, /node_modules\/(?:@anthropic-ai\/claude-agent-sdk-|@github\/copilot-sdk-|vite\/)/);
  assert.doesNotMatch(contents.stdout, /(?:^|\/)\._/m);
  const manifest = manifestFor({ packageName: project.name, version: project.version, tarball: project.filename,
    sha256: await digest(join(release, project.filename)), dependencies: [dependency] });
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
  const dependencySource = join(root, 'dependency-source', 'package');
  await mkdir(join(projectSource, 'bin'), { recursive: true, mode: 0o700 });
  await mkdir(dependencySource, { recursive: true, mode: 0o700 });
  await writeFile(join(projectSource, 'package.json'), '{"name":"xenoflux"}\n');
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
  const project = join(release, 'xenoflux.tgz'), dependency = join(release, 'runtime.tgz');
  await archive(dirname(projectSource), project, projectDirectory);
  await archive(dirname(dependencySource), dependency, 'package');
  const template = join(process.cwd(), 'scripts', 'install-template.mjs');
  await writeFile(join(release, 'install.mjs'), await readFile(template), { mode: 0o700 });
  const manifest = {
    schemaVersion: 2, package: 'xenoflux', version: '0.2.0', tarball: 'xenoflux.tgz', sha256: await digest(project),
    dependencies: [{ name: 'xenoflux-runtime', version: '0.2.0', tarball: 'runtime.tgz',
      platform: process.platform, arch: process.arch, sha256: await digest(dependency) }],
  };
  await writeFile(join(release, 'manifest.json'), JSON.stringify(manifest));
  return { root, release, dependency, manifest };
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

test('standalone installer rejects a changed runtime archive before staging', async t => {
  const f = await installerFixture(t);
  await writeFile(f.dependency, 'changed');
  const output = join(f.root, 'arguments.json');
  const result = await run(process.execPath, [join(f.release, 'install.mjs')], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: output } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SHA-256 mismatch/);
  await assert.rejects(readFile(output));
});

test('standalone installer refuses a bundle for a different architecture', async t => {
  const f = await installerFixture(t);
  f.manifest.dependencies[0].arch = process.arch === 'arm64' ? 'x64' : 'arm64';
  await writeFile(join(f.release, 'manifest.json'), JSON.stringify(f.manifest));
  const output = join(f.root, 'arguments.json');
  const result = await run(process.execPath, [join(f.release, 'install.mjs')], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: output } });
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
