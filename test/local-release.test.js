import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { helperTemplates, manifestFor, parseArguments } from '../scripts/local-release.mjs';

test('local release helper templates use the installed executable and a caller-selected store', () => {
  const templates = helperTemplates();
  assert.deepEqual(Object.keys(templates), ['xfx-desktop-switch.command', 'xfx-desktop-recover.command']);
  for (const template of Object.values(templates)) {
    assert.match(template, /Usage: \$0 STORE_DIRECTORY/);
    assert.match(template, /XFX_EXECUTABLE:-xfx/);
    assert.match(template, /"\$xfx_executable" --store "\$1"/);
    assert.doesNotMatch(template, /node|\/Users\//);
  }
  assert.match(templates['xfx-desktop-recover.command'], /desktop recover --no-open/);
});

test('generated helpers pass a store with shell syntax as one literal argument', async t => {
  const root = await mkdtemp(join(tmpdir(), 'xfx-local-release-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const bin = join(root, 'bin'), output = join(root, 'arguments');
  await mkdir(bin, { mode: 0o700 });
  const fake = join(bin, 'xfx');
  await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$XFX_ARGUMENTS"\n', { mode: 0o700 });
  await chmod(fake, 0o700);
  const store = '/tmp/a store "$HOME" $(not-a-command)';
  for (const [name, contents] of Object.entries(helperTemplates())) {
    const helper = join(root, name);
    await writeFile(helper, contents, { mode: 0o700 });
    await chmod(helper, 0o700);
    await new Promise((resolveRun, reject) => {
      const child = spawn(helper, [store], { env: { ...process.env, PATH: '', XFX_EXECUTABLE: fake, XFX_ARGUMENTS: output } });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`helper exited ${code}`)));
    });
    const args = (await readFile(output, 'utf8')).trimEnd().split('\n');
    assert.deepEqual(args.slice(0, 2), ['--store', store]);
    assert.deepEqual(args.slice(2), name.includes('recover') ? ['desktop', 'recover', '--no-open'] : ['desktop', 'pick']);
  }
});

test('local release arguments and manifests retain only reviewable artifact facts', () => {
  assert.deepEqual(parseArguments(['--output', '/tmp/release', '--smoke', '--helpers', '/tmp/helpers']), {
    output: '/tmp/release', smoke: true, helpers: '/tmp/helpers',
  });
  assert.throws(() => parseArguments(['--output']), /Missing value/);
  assert.deepEqual(manifestFor({ packageName: 'xenoflux', version: '0.1.1-rc.1', tarball: 'xenoflux.tgz',
    sha256: 'abc', dependencies: [{ name: 'smol-toml', version: '1.8.0', tarball: 'smol.tgz', sha256: 'def' }],
    sourceRevision: '5ab3e9f', smoke: { status: 'passed' } }), {
    schemaVersion: 1, package: 'xenoflux', version: '0.1.1-rc.1', tarball: 'xenoflux.tgz',
    sha256: 'abc', dependencies: [{ name: 'smol-toml', version: '1.8.0', tarball: 'smol.tgz', sha256: 'def' }],
    sourceRevision: '5ab3e9f', smoke: { status: 'passed' },
  });
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
await writeFile(process.env.XFX_INSTALL_ARGUMENTS, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o600 });
  await writeFile(join(dependencySource, 'package.json'), '{"name":"smol-toml"}\n');
  const release = join(root, 'release');
  await mkdir(release, { mode: 0o700 });
  const project = join(release, 'xenoflux.tgz'), dependency = join(release, 'smol-toml.tgz');
  await archive(dirname(projectSource), project, projectDirectory);
  await archive(dirname(dependencySource), dependency, 'package');
  const template = join(process.cwd(), 'scripts', 'install-template.mjs');
  await writeFile(join(release, 'install.mjs'), await readFile(template), { mode: 0o700 });
  const manifest = {
    schemaVersion: 1, package: 'xenoflux', version: '0.2.0', tarball: 'xenoflux.tgz', sha256: await digest(project),
    dependencies: [{ name: 'smol-toml', version: '1.8.0', tarball: 'smol-toml.tgz', sha256: await digest(dependency) }],
  };
  await writeFile(join(release, 'manifest.json'), JSON.stringify(manifest));
  return { root, release, project, manifest };
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

test('standalone installer rejects a changed artifact before staging', async t => {
  const f = await installerFixture(t);
  await writeFile(f.project, 'changed');
  const output = join(f.root, 'arguments.json');
  const result = await run(process.execPath, [join(f.release, 'install.mjs')], { env: { ...process.env, XFX_INSTALL_ARGUMENTS: output } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SHA-256 mismatch/);
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
  for (const version of ['20.12.0', '22.12.0', '23.0.0', '23.3.0']) {
    const result = await run(process.execPath, ['--input-type=module', '--eval', `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} }); await import(${JSON.stringify(template)});`]);
    assert.equal(result.code, 1);
    assert.ok(result.stderr.includes(`Node 22.13.0+ (22.x) or 23.4.0+ is required; found v${version}`));
  }
});
