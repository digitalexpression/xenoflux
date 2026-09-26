#!/usr/bin/env node

// This file is copied verbatim as install.mjs into a local release bundle.
// Keep the runtime check before loading any application or Node core module.
const version = process.versions.node.split('.').map(Number);
if (!Number.isInteger(version[0]) || !Number.isInteger(version[1])
  || version[0] < 22 || (version[0] === 22 && version[1] < 13) || (version[0] === 23 && version[1] < 4)) {
  process.stderr.write(`Node 22.13.0+ (22.x) or 23.4.0+ is required; found v${process.versions.node}\n`);
  process.exitCode = 1;
} else {
  const [{ createHash }, fs, childProcess, path, os, url] = await Promise.all([
    import('node:crypto'), import('node:fs/promises'), import('node:child_process'), import('node:path'),
    import('node:os'), import('node:url'),
  ]);
  const { access, lstat, mkdir, mkdtemp, readFile, rename, rm } = fs;
  const { spawn } = childProcess;
  const { basename, dirname, isAbsolute, join, relative, resolve, sep } = path;
  const { tmpdir } = os;
  const { fileURLToPath } = url;
  const bundle = dirname(fileURLToPath(import.meta.url));

  function fail(message) { throw new Error(message); }
  function validArtifact(name) {
    if (typeof name !== 'string' || !name || basename(name) !== name || name.includes('\\') || !name.endsWith('.tgz'))
      fail('Release manifest contains an unsafe artifact name');
    return name;
  }
  function validDigest(value) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) fail('Release manifest contains an invalid SHA-256 digest');
    return value.toLowerCase();
  }
  function inside(root, candidate) {
    const relation = relative(root, candidate);
    return relation && !relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation);
  }
  async function digest(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
  async function run(file, args, options = {}) {
    await new Promise((resolveRun, reject) => {
      const child = spawn(file, args, { ...options, stdio: options.stdio ?? 'inherit' });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`${file} exited ${code}`)));
    });
  }
  async function tarEntries(archive) {
    const output = [];
    await new Promise((resolveRun, reject) => {
      const child = spawn('/usr/bin/tar', ['-tzf', archive], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => output.push(chunk));
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolveRun() : reject(new Error(`Unable to inspect ${basename(archive)}`)));
    });
    const entries = output.join('').split('\n').filter(Boolean);
    if (!entries.length || entries.some(entry => entry.includes('\\') || entry.startsWith('/')
      || entry.split('/').some(segment => segment === '..' || segment === '.'))
      || entries.some(entry => entry !== 'package' && !entry.startsWith('package/')))
      fail(`Unsafe archive paths in ${basename(archive)}`);
  }
  async function extract(archive, destination) {
    await tarEntries(archive);
    await run('/usr/bin/tar', ['-xzf', archive, '-C', destination]);
    const extracted = join(destination, 'package');
    const info = await lstat(extracted).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) fail(`Archive did not contain a safe package directory: ${basename(archive)}`);
    return extracted;
  }
  async function main() {
    const manifestPath = join(bundle, 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch { fail('Unable to read release manifest'); }
    if (manifest?.schemaVersion !== 1 || typeof manifest.package !== 'string' || typeof manifest.version !== 'string'
      || !Array.isArray(manifest.dependencies) || manifest.dependencies.length !== 1) fail('Unsupported release manifest');
    const project = { name: validArtifact(manifest.tarball), digest: validDigest(manifest.sha256) };
    const dependency = manifest.dependencies[0];
    if (dependency?.name !== 'smol-toml') fail('Release manifest must include smol-toml');
    const dependencyArtifact = { name: validArtifact(dependency.tarball), digest: validDigest(dependency.sha256) };
    if (project.name === dependencyArtifact.name) fail('Release artifacts must be distinct');
    for (const artifact of [project, dependencyArtifact]) {
      const file = resolve(bundle, artifact.name);
      if (!inside(bundle, file)) fail('Release manifest resolves outside its bundle');
      await access(file).catch(() => fail(`Release artifact is missing: ${artifact.name}`));
      if (await digest(file) !== artifact.digest) fail(`SHA-256 mismatch for ${artifact.name}`);
      artifact.file = file;
    }
    const temporary = await mkdtemp(join(tmpdir(), 'xfx-install-'));
    try {
      const projectExtract = join(temporary, 'project-extract');
      const dependencyExtract = join(temporary, 'dependency-extract');
      await Promise.all([mkdir(projectExtract, { mode: 0o700 }), mkdir(dependencyExtract, { mode: 0o700 })]);
      const projectRoot = await extract(project.file, projectExtract);
      const dependencyRoot = await extract(dependencyArtifact.file, dependencyExtract);
      const stage = join(temporary, 'xenoflux');
      await rename(projectRoot, stage);
      const modules = join(stage, 'node_modules');
      await mkdir(modules, { recursive: true, mode: 0o700 });
      await rename(dependencyRoot, join(modules, 'smol-toml'));
      const command = join(stage, 'bin', 'xfx.js');
      const commandInfo = await lstat(command).catch(() => null);
      if (!commandInfo?.isFile() || commandInfo.isSymbolicLink()) fail('Release package has no safe xfx command');
      await run('node', [command, 'install', ...process.argv.slice(2)], { cwd: stage, stdio: 'inherit' });
    } finally { await rm(temporary, { force: true, recursive: true }); }
  }
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
