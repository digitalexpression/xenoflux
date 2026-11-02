import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { acceptanceCanPass, createMutationTracker, ensureOpen, runAcceptance, runAdmittedMutation, validateManifest } from '../scripts/native-profile-ui-acceptance.mjs';
import { createNativeProfileUiAcceptanceFixture } from '../test-support/native-profile-ui-acceptance.js';

const exec = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(import.meta.url);

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-native-ui-gate-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'candidate'); await mkdir(repo);
  await exec('git', ['init', '-q', repo]);
  await exec('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
  const script = join(repo, 'acceptance.mjs'), source = join(repo, 'src.js');
  await writeFile(script, 'fixture harness\n'); await writeFile(source, 'fixture source\n');
  await exec('git', ['-C', repo, 'add', '.']); await exec('git', ['-C', repo, 'commit', '-qm', 'fixture']);
  const { stdout: commit } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD']);
  const { stdout: tree } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}']);
  const nodePath = process.execPath, nodeHash = digest(await readFile(nodePath));
  const manifest = {
    status: 'approved', approval: { scope: 'native-profile-ui-acceptance' },
    candidate: { repo, head: commit.trim(), commit: commit.trim(), tree: tree.trim() },
    scriptSha256: digest(await readFile(script)), closure: { [source]: digest(await readFile(source)) },
    executables: { node: { path: nodePath, sha256: nodeHash }, codex: { path: nodePath, sha256: nodeHash }, nativeCodex: { path: nodePath, sha256: nodeHash } },
    root: join(root, 'owned-root'), mutationWindowMs: 20 * 60 * 1000,
    limits: { attempts: 1, profiles: 2, modelRuns: 0, versionProbes: 2 },
  };
  const path = join(root, 'manifest.json'); await writeFile(path, JSON.stringify(manifest));
  return { root, repo, script, source, path, manifest };
}

async function browserIdentity(path) {
  return { path, resolvedPath: await realpath(path), sha256: digest(await readFile(path)) };
}
async function browserPackage(entry, expectedName) {
  for (let directory = join(entry, '..'), depth = 0; depth < 8; directory = join(directory, '..'), depth++) {
    const path = join(directory, 'package.json');
    try { if (JSON.parse(await readFile(path, 'utf8')).name === expectedName) return path; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Missing test package ${expectedName}`);
}

test('manifest gates accept a clean exact candidate and reject changed bound source', async t => {
  const f = await fixture(t);
  assert.equal((await validateManifest(f.path, { scriptFile: f.script, synthetic: true })).manifest.candidate.commit, f.manifest.candidate.commit);
  await writeFile(f.source, 'changed\n');
  await assert.rejects(validateManifest(f.path, { scriptFile: f.script, synthetic: true }), /Candidate checkout is not clean|Bound source changed/);
});

test('manifest gate refuses an already existing owned root', async t => {
  const f = await fixture(t); await mkdir(f.manifest.root);
  await assert.rejects(validateManifest(f.path, { scriptFile: f.script, synthetic: true }), /already exists/);
});

test('manifest gate rejects a proposal without approval status', async t => {
  const f = await fixture(t); f.manifest.status = 'proposed';
  await writeFile(f.path, JSON.stringify(f.manifest));
  await assert.rejects(validateManifest(f.path, { scriptFile: f.script, synthetic: true }), /explicit approval/);
  assert.equal((await validateManifest(f.path, { scriptFile: f.script, synthetic: true, allowProposed: true })).manifest.status, 'proposed');
});

test('production manifest requires a complete source closure and verifies wrapper symlink chain', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-native-ui-chain-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'candidate'); await mkdir(repo);
  await exec('git', ['init', '-q', repo]);
  await exec('git', ['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
  await exec('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
  const sourcePaths = ['bin/xfx.js', 'src/ui-engine.js', 'src/ui-server.js', 'src/native-copy.js', 'src/advanced-copy.js',
    'src/desktop-runtime.js', 'src/home-create.js', 'src/profile-command.js', 'web/src/main.tsx', 'web/src/routes.tsx',
    'web/src/pages/Profiles.tsx', 'web/src/pages/CopyPreview.tsx', 'web/src/api/client.ts', 'dist/ui/index.html'];
  const closure = {};
  for (const relative of sourcePaths) {
    const path = join(repo, relative); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'fixture file\n'); closure[path] = digest(await readFile(path));
  }
  const script = join(repo, 'scripts/acceptance.mjs'); await mkdir(join(repo, 'scripts')); await writeFile(script, 'fixture script\n');
  const wrapper = join(repo, 'node_modules/@openai/codex/bin/codex.js'), wrapperCommand = join(root, 'bin/codex');
  const platformRoot = join(repo, 'node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64');
  const platformPackage = join(platformRoot, 'package.json'), native = join(platformRoot, 'vendor/aarch64-apple-darwin/bin/codex');
  const wrapperPackage = join(repo, 'node_modules/@openai/codex/package.json');
  await mkdir(join(wrapper, '..'), { recursive: true }); await writeFile(wrapper, '#!/bin/sh\n', { mode: 0o700 });
  await mkdir(join(platformRoot, 'vendor/aarch64-apple-darwin/bin'), { recursive: true });
  await writeFile(wrapperPackage, JSON.stringify({ name: '@openai/codex', optionalDependencies: { '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.164.0-darwin-arm64' } }));
  await writeFile(platformPackage, JSON.stringify({ name: '@openai/codex', version: '0.164.0-darwin-arm64', os: ['darwin'], cpu: ['arm64'] })); await writeFile(native, '#!/bin/sh\n', { mode: 0o700 });
  await mkdir(join(root, 'bin')); await symlink(wrapper, wrapperCommand);
  const identity = async path => ({ path, resolvedPath: await realpath(path), sha256: digest(await readFile(path)) });
  const executables = { node: await identity(await realpath(process.execPath)), codex: await identity(wrapper), codexCommand: await identity(wrapperCommand),
    nativeCodex: await identity(native), codexPackage: await identity(platformPackage), codexWrapperPackage: await identity(wrapperPackage) };
  const playwrightTestEntry = fileURLToPath(import.meta.resolve('@playwright/test'));
  const playwrightEntry = fileURLToPath(import.meta.resolve('playwright'));
  const playwrightCoreEntry = require.resolve('playwright-core');
  const playwrightTestPackage = await browserPackage(playwrightTestEntry, '@playwright/test');
  const playwrightPackage = await browserPackage(playwrightEntry, 'playwright');
  const playwrightCorePackage = await browserPackage(playwrightCoreEntry, 'playwright-core');
  const lockPath = join(repo, 'package-lock.json');
  await writeFile(lockPath, await readFile(join(process.cwd(), 'package-lock.json')));
  const browser = {
    executable: await browserIdentity(chromium.executablePath()),
    playwrightTestEntry: await browserIdentity(playwrightTestEntry),
    playwrightTestPackage: await browserIdentity(playwrightTestPackage),
    playwrightEntry: await browserIdentity(playwrightEntry),
    playwrightPackage: await browserIdentity(playwrightPackage),
    playwrightCoreEntry: await browserIdentity(playwrightCoreEntry),
    playwrightCorePackage: await browserIdentity(playwrightCorePackage),
    packageLock: await browserIdentity(lockPath),
  };
  for (const path of [...Object.keys(closure), script, wrapper, native, platformPackage, wrapperPackage, lockPath]) await exec('git', ['-C', repo, 'add', path]);
  await exec('git', ['-C', repo, 'commit', '-qm', 'fixture candidate']);
  const { stdout: commit } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD']), { stdout: tree } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}']);
  const manifest = { status: 'approved', approval: { scope: 'native-profile-ui-acceptance' }, candidate: { repo, head: commit.trim(), commit: commit.trim(), tree: tree.trim() },
    closure, scriptSha256: digest(await readFile(script)), executables, browser, root: join(root, 'attempt'), mutationWindowMs: 20 * 60 * 1000,
    limits: { attempts: 1, profiles: 2, modelRuns: 0, versionProbes: 2 } };
  const path = join(root, 'manifest.json'); await writeFile(path, JSON.stringify(manifest));
  assert.equal((await validateManifest(path, { scriptFile: script })).manifest.executables.codexCommand.resolvedPath, wrapper);
  manifest.closure = {}; await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(validateManifest(path, { scriptFile: script }), /closure is empty or missing/);
});

test('deadline prevents beginning a newly admitted mutation', async () => {
  await assert.rejects(ensureOpen(Date.now() - 1), /admission expired/);
  await assert.doesNotReject(ensureOpen(Date.now() + 1000));
});

test('each mutation dispatch gets a fresh admission and a failed request stays ambiguous', async () => {
  let checks = 0;
  for (let i = 0; i < 3; i++) await runAdmittedMutation(Date.now() + 1000, async () => { checks++; });
  assert.equal(checks, 3);
  const tracker = createMutationTracker(), request = {};
  tracker.track(request); tracker.fail(request);
  assert.equal(tracker.ambiguous, true);
  assert.equal(tracker.requests.has(request), true);
  tracker.complete(request);
  assert.equal(tracker.ambiguous, true);
});

test('artifact failures prevent a final passed verdict after functional checks', () => {
  const base = { functionalPass: true, screenshotComplete: true, traceComplete: true, browserClosed: true, artifactErrors: [], serverStopped: true, mutationAmbiguous: false };
  assert.equal(acceptanceCanPass(base), true);
  assert.equal(acceptanceCanPass({ ...base, screenshotComplete: false }), false);
  assert.equal(acceptanceCanPass({ ...base, traceComplete: false }), false);
  assert.equal(acceptanceCanPass({ ...base, artifactErrors: ['trace failed'] }), false);
  assert.equal(acceptanceCanPass({ ...base, browserClosed: false }), false);
  assert.equal(acceptanceCanPass({ ...base, serverStopped: false }), false);
  assert.equal(acceptanceCanPass({ ...base, mutationAmbiguous: true }), false);
});

test('offline browser journey creates, previews, applies and undoes through Profiles UI', async t => {
  const app = await createNativeProfileUiAcceptanceFixture();
  try {
    await runAcceptance({ manifest: { root: app.root, mutationWindowMs: 20 * 60 * 1000 }, repo: process.cwd(), testFixture: app });
    const receipts = join(app.root, 'receipts');
    const acceptance = JSON.parse(await readFile(join(receipts, 'acceptance.json'), 'utf8'));
    assert.equal(acceptance.result, 'passed');
    assert.equal(acceptance.profileCount, 2);
    assert.equal(acceptance.profileCreationRequests, 2);
    assert.equal(acceptance.modelRunRequests, 0);
    assert.equal(acceptance.versionProbeUpperBound, 2);
    assert.equal(acceptance.versionProbesObserved, 2);
    assert.equal(acceptance.admissionChecks, app.mutationAdmissionCount());
    assert.equal(acceptance.admissionChecks, 22);
    assert.ok((await readFile(join(receipts, 'undone.png'))).length > 0);
    assert.ok((await readFile(join(receipts, 'trace.zip'))).length > 0);
    assert.ok((await stat(join(app.root, 'browser-profile'))).isDirectory());
    assert.ok((await stat(join(app.root, 'browser-artifacts'))).isDirectory());
    t.diagnostic(`Complete offline UI journey passed; screenshot and trace retained at ${receipts}`);
  } catch (error) {
    await app.close({ retainRoot: true });
    t.diagnostic(`Retained failed browser journey and trace at ${app.root}`);
    throw error;
  }
  await app.close({ retainRoot: true });
});
