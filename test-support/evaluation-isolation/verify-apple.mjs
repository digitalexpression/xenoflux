// Offline controls only. Never invokes a model or starts services. Cached local
// images are required; any observed fetch attempt fails the verification.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspaceFiles } from '../substantive-evaluation/check-candidate.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const fixtureSource = join(source, '../substantive-evaluation');
const probeNames = ['guest_code_executed', 'fixture_read', 'tmp_write_read_remove', 'identity_capabilities', 'network_interfaces',
  'routes', 'tcp_documentation_ipv4', 'tcp_documentation_ipv6', 'udp_documentation_ipv4', 'host_loopback_listener',
  'host_canary_read', 'host_canary_open_readwrite', 'host_canary_via_tmp_symlink', 'readonly_fixture_write',
  'host_unix_socket', 'child_process_boundary', 'sensitive_environment_names', 'mount_modes'];
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const safeRelative = name => typeof name === 'string' && name.split('/').every(part =>
  /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const listen = (server, target) => new Promise((accept, reject) => {
  server.once('error', reject); server.listen(target, () => { server.off('error', reject); accept(); });
});
const close = server => new Promise(resolve => server.close(resolve));

async function candidateSnapshot(workspace) {
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', join(source, 'snapshot-candidate.py'), workspace], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', PYTHONNOUSERSITE: '1' },
    encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error('isolation-candidate-acquisition-rejected');
  const entries = JSON.parse(result.stdout), files = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (!safeRelative(name) || hash(Buffer.from(entry.base64, 'base64')) !== entry.sha256)
      throw new Error('isolation-candidate-snapshot-invalid');
    files[name] = entry.sha256;
  }
  return { entries, files };
}

export async function verifyAppleIsolation(runtimePath, campaignPath, output, candidate = null) {
  if (process.platform !== 'darwin' || !isAbsolute(output) || resolve(output) !== output
    || /[,\n\r:]/.test(output) || await realpath(dirname(output)) !== dirname(output)) throw new Error('isolation-output-invalid');
  const runtime = JSON.parse(await readFile(runtimePath)), campaign = JSON.parse(await readFile(campaignPath));
  if (campaign.mode !== 'offline-preparation' || campaign.paidExecutionAuthorized !== false) throw new Error('isolation-offline-campaign-required');
  const root = await realpath(dirname(runtimePath)), campaignRoot = await realpath(dirname(campaignPath));
  const rootInfo = await lstat(root);
  if ((rootInfo.mode & 0o077) || rootInfo.uid !== process.getuid()) throw new Error('isolation-private-runtime-root-required');
  const expectedEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(root, 'control-home'),
    XDG_CONFIG_HOME: join(root, 'control-home/.config'), CONTAINER_INSTALL_ROOT: runtime.installRoot,
    CONTAINER_APP_ROOT: runtime.appRoot, CONTAINER_LOG_ROOT: runtime.logRoot,
    CONTAINER_REGISTRY_HOST: `127.0.0.1:${runtime.registryTripwirePort}`, CONTAINER_REGISTRY_USER: 'offline-fixture',
    CONTAINER_REGISTRY_TOKEN: 'synthetic-not-a-credential', XFX_ISOLATION_HOST_CANARY: 'synthetic-host-only-not-a-credential' };
  if (!same(runtime.environment, expectedEnvironment)) throw new Error('isolation-runtime-environment-invalid');
  for (const path of [runtime.appRoot, runtime.installRoot, runtime.logRoot, runtime.container, runtime.kernel]) {
    if (typeof path !== 'string' || !path.startsWith(root + '/') || await realpath(path) !== path) throw new Error('isolation-private-runtime-path-required');
  }
  for (const [name, plistPath, executable, allowedKeys] of [
    ['apiserver', join(root, 'apiserver-private.plist'), join(runtime.installRoot, 'bin/container-apiserver'),
      Object.keys(expectedEnvironment).filter(key => key !== 'XFX_ISOLATION_HOST_CANARY')],
    ['container-core-images', join(runtime.appRoot, 'plugin-state/container-core-images/service.plist'),
      join(runtime.installRoot, 'libexec/container/plugins/container-core-images/bin/container-core-images'),
      Object.keys(expectedEnvironment).filter(key => key.startsWith('CONTAINER_'))],
  ]) {
    const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath],
      { env: runtime.environment, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    if (result.status !== 0 || result.error) throw new Error('isolation-service-config-unavailable');
    const plist = JSON.parse(result.stdout), env = plist.EnvironmentVariables;
    if (plist.Label !== `com.apple.container.${name}` || JSON.stringify(plist.ProgramArguments) !== JSON.stringify([executable, 'start'])
      || Object.keys(env).sort().join(',') !== allowedKeys.sort().join(',')) throw new Error('isolation-service-config-invalid');
    for (const key of allowedKeys) {
      if (key.endsWith('_ROOT')) {
        if (await realpath(env[key]) !== await realpath(expectedEnvironment[key])) throw new Error('isolation-service-root-mismatch');
      } else if (env[key] !== expectedEnvironment[key]) throw new Error('isolation-service-environment-mismatch');
    }
    const job = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${plist.Label}`],
      { env: runtime.environment, encoding: 'utf8', timeout: 3000, maxBuffer: 65536 });
    const lines = job.stdout?.split('\n') ?? [];
    if (job.status !== 0 || job.error || !lines.some(line => line.trim() === `program = ${executable}`)
      || !lines.some(line => line.trim() === `CONTAINER_REGISTRY_HOST => ${expectedEnvironment.CONTAINER_REGISTRY_HOST}`)
      || !lines.some(line => line.trim() === 'CONTAINER_REGISTRY_USER => offline-fixture')
      || !lines.some(line => line.trim() === 'CONTAINER_REGISTRY_TOKEN => synthetic-not-a-credential')) throw new Error('isolation-live-service-mismatch');
    for (const key of ['CONTAINER_APP_ROOT', 'CONTAINER_INSTALL_ROOT', 'CONTAINER_LOG_ROOT']) {
      const prefix = `${key} => `, line = lines.map(value => value.trim()).find(value => value.startsWith(prefix));
      if (!line || await realpath(line.slice(prefix.length)) !== await realpath(expectedEnvironment[key])) throw new Error('isolation-live-service-root-mismatch');
    }
  }
  if (!Array.isArray(campaign.tasks) || campaign.tasks.map(task => task.id).sort().join(',') !== 'booking-ledger,config-overlay,retry-queue'
    || !campaign.fixtureInputs || Object.keys(campaign.fixtureInputs).some(name => !safeRelative(name))
    || !same(await workspaceFiles(fixtureSource), campaign.fixtureInputs)
    || campaign.checker.path !== join(campaignRoot, 'check-candidate.mjs')) throw new Error('isolation-frozen-campaign-invalid');
  for (const task of campaign.tasks) {
    if (task.repository !== join(campaignRoot, 'tasks', task.id)
      || task.oracle.path !== join(campaignRoot, 'oracles', `${task.id}.test.mjs`)
      || Object.keys(task.workspaceFiles).some(name => !safeRelative(name))) throw new Error('isolation-task-path-invalid');
    const definition = JSON.parse(await readFile(join(fixtureSource, 'tasks', task.id, 'task.json')));
    if (JSON.stringify(task.editableFiles) !== JSON.stringify(definition.editableFiles)) throw new Error('isolation-task-edit-scope-invalid');
    for (const path of [task.repository, task.oracle.path]) {
      if (await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) throw new Error('isolation-campaign-symlink');
    }
  }
  if (await realpath(campaign.checker.path) !== campaign.checker.path
    || (await lstat(campaign.checker.path)).isSymbolicLink()
    || campaign.checker.sha256 !== hash(await readFile(join(fixtureSource, 'check-candidate.mjs')))) throw new Error('isolation-checker-source-invalid');
  const registry = `127.0.0.1:${runtime.registryTripwirePort}`;
  if (!Number.isInteger(runtime.registryTripwirePort) || runtime.registryTripwirePort < 1024
    || runtime.registryTripwirePort > 65535 || runtime.image !== `${registry}/xfx/worker:frozen`
    || runtime.initImage !== `${registry}/xfx/vminit:frozen`
    || runtime.environment.CONTAINER_REGISTRY_HOST !== registry
    || runtime.environment.CONTAINER_REGISTRY_USER !== 'offline-fixture'
    || runtime.environment.CONTAINER_REGISTRY_TOKEN !== 'synthetic-not-a-credential'
    || Object.keys(runtime.environment).some(key => /proxy/i.test(key))) throw new Error('isolation-runtime-route-invalid');
  for (const path of [runtime.container, runtime.kernel]) {
    const stat = await lstat(path);
    if (!isAbsolute(path) || stat.isSymbolicLink() || !stat.isFile() || await realpath(path) !== path) throw new Error('isolation-runtime-path-invalid');
  }
  if (hash(await readFile(runtime.kernel)) !== runtime.kernelSha256) throw new Error('isolation-kernel-changed');
  for (const [name, digest] of Object.entries(campaign.fixtureInputs)) {
    if (hash(await readFile(join(fixtureSource, name))) !== digest) throw new Error('isolation-fixture-source-changed');
  }
  let candidateTask, candidateFiles, candidateEntries;
  if (candidate !== null) {
    candidateTask = campaign.tasks.find(task => task.id === candidate.taskId);
    if (!candidateTask || !isAbsolute(candidate.workspace) || await realpath(candidate.workspace) !== candidate.workspace
      || (await lstat(candidate.workspace)).isSymbolicLink()) throw new Error('isolation-candidate-path-invalid');
    ({ files: candidateFiles, entries: candidateEntries } = await candidateSnapshot(candidate.workspace));
    const editable = new Set(candidateTask.editableFiles);
    if (Object.keys(candidateFiles).length > 64 || Object.keys(candidateFiles).some(name => !safeRelative(name)
      || !Object.hasOwn(candidateTask.workspaceFiles, name))
      || Object.keys(candidateTask.workspaceFiles).some(name => !Object.hasOwn(candidateFiles, name)
        || !editable.has(name) && candidateFiles[name] !== candidateTask.workspaceFiles[name])) throw new Error('isolation-candidate-scope-changed');
  }
  await mkdir(output, { mode: 0o700 }); // Exclusive; failures and previous receipts remain untouched.
  const results = [], owned = new Set(), attempted = new Set(), input = join(output, 'input');
  await mkdir(input, { mode: 0o700 });
  let registryConnections = 0, hostConnections = 0, unixConnections = 0;
  const registryServer = createServer(socket => { registryConnections++; socket.destroy(); });
  const hostServer = createServer(socket => { hostConnections++; socket.end('owned-loopback-control'); });
  const unixServer = createServer(socket => { unixConnections++; socket.end('owned-unix-control'); });
  // macOS Unix-domain sockets have a short path limit; this directory is owned
  // by this invocation and contains only its synthetic listener.
  const socketRoot = await mkdtemp('/private/tmp/xfx-isolation-');
  const outsideFile = join(output, 'outside-host-canary.txt'), outsideSocket = join(socketRoot, 'outside.sock');
  await writeFile(outsideFile, 'synthetic-host-file-must-remain-private', { flag: 'wx', mode: 0o600 });
  const outsideHash = hash(await readFile(outsideFile));
  async function cli(name, args, timeout = 60000) {
    const result = await new Promise(resolve => {
      const child = spawn(runtime.container, args, { env: runtime.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0, error = null;
      const kill = reason => { error = reason; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const collect = (kind, chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { kill('output-limit'); return; }
        if (kind === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      };
      child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
      const timer = setTimeout(() => kill('timeout'), timeout);
      child.once('error', value => { error = value.code ?? 'spawn-error'; });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, error, stdout, stderr }); });
    });
    await json(join(output, `${name}.json`), { args, ...result });
    return result;
  }
  async function guest(name, args, workdir = '/tmp') {
    const id = `xfx-eval-offline-${randomUUID()}`;
    const baseline = await cli(`${name}-before`, ['list', '--all', '--format', 'json']);
    if (baseline.code !== 0 || !Array.isArray(JSON.parse(baseline.stdout))) throw new Error('isolation-container-inventory-unavailable');
    if (JSON.parse(baseline.stdout).some(value => value.id === id)) throw new Error('isolation-name-collision');
    owned.add(id); attempted.add(id);
    const created = await cli(`${name}-create`, ['create', '--name', id, '--label', `xfx.offline-probe=${id}`,
      '--network', 'none', '--no-dns', '--read-only', '--cap-drop', 'ALL', '--uid', '65532', '--gid', '65532',
      '--cpus', '2', '--memory', '768M', '--tmpfs', '/tmp:rw,size=64m,mode=1777',
      '--mount', `type=bind,source=${input},target=/fixture,readonly`,
      '--kernel', runtime.kernel, '--init-image', runtime.initImage,
      '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'TMP=/tmp', '--env', 'TEMP=/tmp',
      '--workdir', workdir, '--entrypoint', '/usr/local/bin/node', runtime.image, ...args]);
    if (created.code !== 0 || created.error) throw new Error('isolation-container-create-failed');
    if (registryConnections) throw new Error('isolation-unexpected-image-fetch');
    const inspect = await cli(`${name}-inspect-before-start`, ['inspect', id], 15000);
    const data = JSON.parse(inspect.stdout), configuration = data[0]?.configuration;
    const mounts = configuration?.mounts;
    if (inspect.code !== 0 || data.length !== 1 || configuration?.readOnly !== true
      || data[0].status?.state !== 'stopped' || data[0].status?.startedDate != null || data[0].status?.networks?.length
      || !Array.isArray(configuration.networks) || configuration.networks.length
      || !Array.isArray(mounts) || mounts.length !== 2
      || !mounts.some(mount => mount.destination === '/fixture' && mount.source === input && mount.type?.virtiofs && mount.options.includes('ro'))
      || !mounts.some(mount => mount.destination === '/tmp' && mount.type?.tmpfs)
      || configuration.publishedPorts?.length || configuration.publishedSockets?.length || configuration.ssh
      || configuration.dns != null || configuration.rosetta || configuration.virtualization
      || configuration.labels?.['xfx.offline-probe'] !== id || configuration.image?.reference !== runtime.image
      || configuration.image?.descriptor.digest !== runtime.imageDescriptor
      || configuration.platform?.os !== 'linux' || configuration.platform?.architecture !== 'arm64'
      || configuration.initProcess?.user?.id?.uid !== 65532 || configuration.initProcess?.user?.id?.gid !== 65532
      || configuration.initProcess?.executable !== '/usr/local/bin/node'
      || JSON.stringify(configuration.initProcess?.arguments) !== JSON.stringify(args)
      || configuration.initProcess?.workingDirectory !== workdir
      || configuration.capAdd?.length || JSON.stringify(configuration.capDrop) !== '["ALL"]') throw new Error('isolation-container-config-mismatch');
    const environment = configuration.initProcess.environment;
    const allowedGuestEnvironment = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'NODE_VERSION', 'YARN_VERSION', 'HOSTNAME']);
    if (!Array.isArray(environment) || environment.some(value => !allowedGuestEnvironment.has(value.split('=')[0]))
      || ['HOME=/tmp', 'TMPDIR=/tmp', 'TMP=/tmp', 'TEMP=/tmp'].some(value => !environment.includes(value))) throw new Error('isolation-guest-environment-mismatch');
    const runtimeConfiguration = JSON.parse(await readFile(join(runtime.appRoot, 'containers', id, 'runtime-configuration.json')));
    await json(join(output, `${name}-runtime-configuration.json`), runtimeConfiguration);
    if (runtimeConfiguration.kernel?.path !== pathToFileURL(runtime.kernel).href
      || runtimeConfiguration.kernel.platform?.os !== 'linux' || runtimeConfiguration.kernel.platform?.architecture !== 'arm64'
      || runtimeConfiguration.initialFilesystem?.source !== join(runtime.appRoot, 'snapshots', runtime.initPlatformDigest.slice(7), 'snapshot')
      || !runtimeConfiguration.initialFilesystem.options?.includes('ro')) throw new Error('isolation-kernel-or-init-mismatch');
    const result = await cli(name, ['start', '--attach', id]);
    results.push({ name, id, code: result.code, error: result.error, configurationVerifiedBeforeStart: true });
    await cli(`${name}-stop`, ['stop', '--time', '2', id], 15000);
    const deleted = await cli(`${name}-delete`, ['delete', '--force', id], 15000);
    if (deleted.code !== 0) throw new Error('isolation-owned-container-cleanup-failed');
    owned.delete(id);
    if (registryConnections) throw new Error('isolation-unexpected-image-fetch');
    return result;
  }
  const summary = { mode: 'offline-isolation-controls', paidCalls: 0, nativeModelCalls: 0, status: 'failed', results };
  try {
    await listen(registryServer, { host: '127.0.0.1', port: runtime.registryTripwirePort });
    await listen(hostServer, { host: '127.0.0.1', port: 0 }); await listen(unixServer, outsideSocket);
    for (const target of [{ host: '127.0.0.1', port: hostServer.address().port }, { path: outsideSocket }]) {
      await new Promise((accept, reject) => { const socket = connect(target); socket.once('error', reject); socket.once('data', () => { socket.destroy(); accept(); }); });
    }
    if (hostConnections !== 1 || unixConnections !== 1) throw new Error('isolation-host-listener-control-failed');
    const status = await cli('runtime-status', ['system', 'status', '--format', 'json'], 15000);
    const observed = JSON.parse(status.stdout);
    for (const key of ['appRoot', 'installRoot', 'logRoot']) {
      if (status.code !== 0 || await realpath(observed.paths[key]) !== await realpath(runtime[key])) throw new Error('isolation-runtime-root-mismatch');
    }
    const state = JSON.parse(await readFile(join(runtime.appRoot, 'state.json')));
    for (const [reference, digest] of [[runtime.image, runtime.imageDescriptor], [runtime.initImage, runtime.initDescriptor]]) {
      if (!/^sha256:[a-f0-9]{64}$/.test(digest) || state[reference]?.digest !== digest) throw new Error('isolation-image-alias-changed');
    }
    // vminit is hidden by image inspect when it is the configured init image. Its
    // separately retained source alias must have the same descriptor and platform.
    for (const [name, reference, digest, descriptor] of [['worker', runtime.image, runtime.imagePlatformDigest, runtime.imageDescriptor],
      ['vminit', runtime.initSource, runtime.initPlatformDigest, runtime.initDescriptor]]) {
      const inspection = await cli(`preflight-image-${name}`, ['image', 'inspect', reference], 15000);
      const images = JSON.parse(inspection.stdout), image = images.find(value => value.configuration?.name === reference);
      if (inspection.code !== 0 || image?.configuration.descriptor.digest !== descriptor || !image.variants.some(value =>
        value.digest === digest && value.platform.os === 'linux' && value.platform.architecture === 'arm64')) throw new Error('isolation-local-image-platform-unavailable');
    }
    await writeFile(join(input, 'guest-probes.mjs'), await readFile(join(source, 'guest-probes.mjs')), { flag: 'wx', mode: 0o444 });
    await writeFile(join(input, 'read-canary.txt'), 'fixture-canary-readable', { flag: 'wx', mode: 0o444 });
    await writeFile(join(input, 'write-canary.txt'), 'read-only-mount-canary', { flag: 'wx', mode: 0o666 });
    await chmod(join(input, 'write-canary.txt'), 0o666); // Distinguish a RO mount from ordinary UID permissions.
    await json(join(input, 'probe-config.json'), { outsideFile, outsideSocket, allowedRead: '/fixture/read-canary.txt',
      readonlyWrite: '/fixture/write-canary.txt', hostLoopbackPort: hostServer.address().port });
    await chmod(join(input, 'probe-config.json'), 0o444);
    await writeFile(join(input, 'check-candidate.mjs'), await readFile(campaign.checker.path), { flag: 'wx', mode: 0o444 });
    if (hash(await readFile(campaign.checker.path)) !== campaign.checker.sha256) throw new Error('isolation-checker-changed');
    const driver = `import {checkCandidate} from '/fixture/check-candidate.mjs';\nconst [id,variant]=process.argv.slice(2);\nconst result=await checkCandidate('/fixture/'+id+'.json',id,'/fixture/'+variant+'/'+id);\nconsole.log(JSON.stringify(result));process.exitCode=result.passed?0:1;\n`;
    await writeFile(join(input, 'check.mjs'), driver, { flag: 'wx', mode: 0o444 });
    for (const task of campaign.tasks) {
      if (JSON.stringify(await workspaceFiles(task.repository)) !== JSON.stringify(task.workspaceFiles)) throw new Error('isolation-starter-source-changed');
      const definition = JSON.parse(await readFile(join(fixtureSource, 'tasks', task.id, 'task.json')));
      for (const variant of ['starter', 'reference']) {
        for (const name of Object.keys(task.workspaceFiles)) {
          const target = join(input, variant, task.id, name); await mkdir(dirname(target), { recursive: true, mode: 0o755 });
          const from = variant === 'reference' && definition.referenceFiles[name]
            ? join(fixtureSource, 'tasks', task.id, definition.referenceFiles[name]) : join(task.repository, name);
          await writeFile(target, await readFile(from), { flag: 'wx', mode: 0o444 });
        }
      }
      const oracle = `${task.id}.oracle.mjs`, bytes = await readFile(task.oracle.path);
      if (hash(bytes) !== task.oracle.sha256) throw new Error('isolation-oracle-changed');
      await writeFile(join(input, oracle), bytes, { flag: 'wx', mode: 0o444 });
      await json(join(input, `${task.id}.json`), { mode: 'offline-preparation',
        checker: { path: '/fixture/check-candidate.mjs', sha256: campaign.checker.sha256 },
        tasks: [{ id: task.id, editableFiles: task.editableFiles, workspaceFiles: task.workspaceFiles,
          oracle: { path: `/fixture/${oracle}`, sha256: task.oracle.sha256 } }] });
      await chmod(join(input, `${task.id}.json`), 0o444);
    }
    // The known candidate attempts these operations from inside both real test
    // subprocesses, including a further child. Only synthetic canaries are used.
    const hostile = `import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const config=JSON.parse(fs.readFileSync('/fixture/probe-config.json'));
assert.throws(()=>fs.readFileSync(config.outsideFile),{code:'ENOENT'});
assert.throws(()=>fs.writeFileSync(config.outsideFile,'synthetic-overwrite-attempt'),{code:'ENOENT'});
assert.throws(()=>fs.writeFileSync(config.readonlyWrite,'synthetic-overwrite-attempt'),{code:'EROFS'});
assert.match(process.env.HOME,new RegExp('^/tmp/xfx-evaluation-check-[a-zA-Z0-9]+$'));
assert.equal(process.env.CODEX_HOME,process.env.HOME+'/empty-native');
assert.equal(process.env.EVAL_WORKSPACE,'/fixture/adversarial/booking-ledger');
// The checker intentionally adds an empty CODEX_HOME/workspace and Node adds a
// test context. Validate those inputs, then retain every other inherited key
// for the strict standalone environment probe.
const childEnv={...process.env};delete childEnv.CODEX_HOME;delete childEnv.EVAL_WORKSPACE;delete childEnv.NODE_TEST_CONTEXT;
const child=spawnSync(process.execPath,['/fixture/guest-probes.mjs','/fixture/probe-config.json'],{env:childEnv,encoding:'utf8',timeout:5000});
assert.equal(child.status,0,child.stdout+child.stderr);const report=JSON.parse(child.stdout);
assert.deepEqual(report.observations.map(row=>row.name).sort(),${JSON.stringify([...probeNames].sort())});
assert.deepEqual(report.failures,[]);assert.ok(report.observations.every(row=>row.ok===true));
console.log('XFX_ISOLATION_ATTACK_DENIALS_VERIFIED');\n`;
    await writeFile(join(input, 'host-access-attempt.mjs'), hostile, { flag: 'wx', mode: 0o444 });
    const attackTask = campaign.tasks.find(task => task.id === 'booking-ledger');
    for (const name of Object.keys(attackTask.workspaceFiles)) {
      const target = join(input, 'adversarial', attackTask.id, name); await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      const bytes = await readFile(join(input, 'reference', attackTask.id, name));
      await writeFile(target, attackTask.editableFiles.includes(name)
        ? Buffer.concat([Buffer.from("import '/fixture/host-access-attempt.mjs';\n"), bytes]) : bytes, { flag: 'wx', mode: 0o444 });
    }
    if (candidateTask) {
      for (const name of Object.keys(candidateFiles)) {
        const target = join(input, 'candidate', candidateTask.id, name);
        const bytes = Buffer.from(candidateEntries[name].base64, 'base64');
        if (hash(bytes) !== candidateFiles[name]) throw new Error('isolation-candidate-changed-during-copy');
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, bytes, { flag: 'wx', mode: 0o444 });
      }
      if (!same((await candidateSnapshot(candidate.workspace)).files, candidateFiles)) throw new Error('isolation-candidate-changed-during-copy');
      summary.candidateInput = { taskId: candidateTask.id, files: candidateFiles,
        fingerprint: hash(Buffer.from(JSON.stringify(Object.entries(candidateFiles).sort()))) };
    }
    await chmod(input, 0o555);
    const inputBefore = await workspaceFiles(input);
    const probes = await guest('safety-probes', ['/fixture/guest-probes.mjs', '/fixture/probe-config.json']);
    const probeReport = JSON.parse(probes.stdout);
    if (probes.code !== 0 || probes.error || !Array.isArray(probeReport.observations) || !Array.isArray(probeReport.failures)
      || probeReport.observations.map(row => row.name).sort().join(',') !== [...probeNames].sort().join(',')
      || probeReport.failures.length || probeReport.observations.some(row => row.ok !== true)) throw new Error('isolation-safety-probe-failed');
    summary.probeObservations = probeReport.observations;
    for (const task of campaign.tasks) for (const variant of ['starter', 'reference']) {
      const result = await guest(`${task.id}-${variant}`, ['/fixture/check.mjs', task.id, variant], `/fixture/${variant}/${task.id}`);
      const check = JSON.parse(result.stdout);
      if (result.error || ![0, 1].includes(result.code) || check.suites.length !== 2
        || check.suites.some(suite => suite.passed !== (variant === 'reference'))
        || (result.code === 0) !== (variant === 'reference')) throw new Error('isolation-reference-control-failed');
    }
    const attack = await guest('imported-candidate-denials', ['/fixture/check.mjs', attackTask.id, 'adversarial'], `/fixture/adversarial/${attackTask.id}`);
    const attackReport = JSON.parse(attack.stdout);
    if (attack.code !== 0 || attack.error || !attackReport.passed || attackReport.suites.length !== 2
      || attackReport.suites.some(suite => !suite.passed || !suite.stdout.includes('XFX_ISOLATION_ATTACK_DENIALS_VERIFIED'))) throw new Error('isolation-imported-candidate-control-failed');
    if (candidateTask) {
      const checked = await guest('candidate-acceptance', ['/fixture/check.mjs', candidateTask.id, 'candidate'], `/fixture/candidate/${candidateTask.id}`);
      const report = JSON.parse(checked.stdout);
      if (checked.error || ![0, 1].includes(checked.code) || !Array.isArray(report.suites) || report.suites.length !== 2
        || report.suites.map(suite => suite.name).join(',') !== 'visible,acceptance'
        || report.suites.some(suite => typeof suite.passed !== 'boolean')
        || report.passed !== report.suites.every(suite => suite.passed) || (checked.code === 0) !== report.passed)
        throw new Error('isolation-candidate-result-invalid');
      summary.candidateCheck = report;
      if (!same((await candidateSnapshot(candidate.workspace)).files, candidateFiles)) throw new Error('isolation-candidate-source-changed');
    }
    if (!same(await workspaceFiles(input), inputBefore)
      || hash(await readFile(outsideFile)) !== outsideHash || hostConnections !== 1 || unixConnections !== 1
      || hash(await readFile(runtime.kernel)) !== runtime.kernelSha256 || registryConnections !== 0) throw new Error('isolation-host-or-input-changed');
    const inventory = await cli('final-containers', ['list', '--all', '--format', 'json']);
    if (inventory.code !== 0 || JSON.parse(inventory.stdout).some(value => results.some(result => result.id === value.id))) throw new Error('isolation-owned-container-remains');
    Object.assign(summary, { status: candidateTask ? 'verified-offline-candidate-check' : 'verified-offline-worker-only', hostCanaryUnchanged: true, inputUnchanged: true,
      hostListenerControlConnections: hostConnections, hostUnixControlConnections: unixConnections, registryConnections,
      referenceTasks: campaign.tasks.length, starterTasksRejected: campaign.tasks.length, ownedContainersRemaining: 0,
      importedCandidateDenials: 'verified in both suites and nested child', inputSha256: hash(Buffer.from(JSON.stringify(Object.entries(inputBefore).sort()))),
      kernelSha256: runtime.kernelSha256, imagePlatformDigest: runtime.imagePlatformDigest, initPlatformDigest: runtime.initPlatformDigest });
    return summary;
  } catch (error) { summary.failure = error.message; throw error; }
  finally {
    const cleanup = { attempts: [], remainingIds: [], inventoryStatus: 'not-required' };
    for (const id of owned) {
      const stop = await cli(`cleanup-${id}-stop`, ['stop', '--time', '2', id], 15000);
      const deletion = await cli(`cleanup-${id}-delete`, ['delete', '--force', id], 15000);
      cleanup.attempts.push({ id, stopCode: stop.code, deleteCode: deletion.code, stopError: stop.error, deleteError: deletion.error });
    }
    if (attempted.size) {
      const final = await cli('cleanup-final-inventory', ['list', '--all', '--format', 'json'], 15000);
      try {
        const rows = JSON.parse(final.stdout);
        if (final.code !== 0 || final.error || !Array.isArray(rows)) throw new Error('unavailable');
        cleanup.inventoryStatus = 'verified';
        cleanup.remainingIds = rows.filter(row => attempted.has(row.id)).map(row => row.id);
      } catch { cleanup.inventoryStatus = 'unavailable'; cleanup.remainingIds = [...attempted]; }
    }
    for (const server of [registryServer, hostServer, unixServer]) if (server.listening) await close(server);
    await rm(socketRoot, { recursive: true, force: true });
    Object.assign(summary, { registryConnections, hostConnections, unixConnections, cleanup });
    const unresolvedCleanup = cleanup.remainingIds.length || cleanup.inventoryStatus === 'unavailable';
    if (unresolvedCleanup) summary.status = 'cleanup-required';
    await json(join(output, 'verification.json'), summary);
    if (unresolvedCleanup) throw new Error('isolation-cleanup-required-see-private-receipt');
  }
}

// The controller copies bytes only; candidate imports and both suites stay in
// the guest. This offline transport has no native/model-provider entry point.
export function verifyAppleCandidate(runtimePath, campaignPath, output, taskId, workspace) {
  return verifyAppleIsolation(runtimePath, campaignPath, output, { taskId, workspace });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 5) throw new Error('usage: verify-apple.mjs RUNTIME.json CAMPAIGN.json NEW_ABSOLUTE_OUTPUT');
    const result = await verifyAppleIsolation(...process.argv.slice(2));
    console.log(JSON.stringify({ status: result.status, controls: result.results.length, paidCalls: 0 }));
  } catch (error) { console.error(`Offline isolation rejected: ${error.message}`); process.exitCode = 1; }
}
