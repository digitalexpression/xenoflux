import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, create, bind } from '../src/profiles.js';
import { createExperiment, createExperimentRun, writeAuditState } from '../src/audit-experiment-store.js';
import { validateAuditSpec } from '../src/audit-spec.js';
import { registerHome } from '../src/homes.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { prepareNativeHome } from './native-home-fixture.js';

const execFile = promisify(execFileCallback);

/**
 * Disposable U3 browser fixture. It uses registered real profile homes, a real
 * committed Git repository, the real run manager/runner, private workspaces,
 * reservations, and persisted reports. Only Codex capture and child processes
 * are replaced so no native client, model call, or user repository is touched.
 *
 * Modes: { capture: 'success' | 'partial' | 'delayed' | 'crash' | 'sandbox-unavailable' | 'sandbox-error-with-turn', check: 'pass' | 'fail' | 'output',
 * staleCommit: boolean }. Delayed capture waits for cancellation. The fixture's
 * `releaseCapture()` also lets a test resume it deterministically.
 */
export async function createUiRunsFixture({
  staticRoot = join(process.cwd(), 'dist', 'ui'),
  mode = {}, reviewContext = {}, beforeCapture,
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ui-runs-')));
  let server, provider;
  const calls = { captures: [], checks: [] };
  let delayedRelease;
  let releaseRequested = false;
  try {
    const executable = join(root, 'codex');
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex 0.153.4\\n"; exit 0; fi\nexit 99\n', { mode: 0o700 });
    const repository = join(root, 'repository');
    await mkdir(repository, { mode: 0o700 });
    await execFile('git', ['init', '-q', repository]);
    await execFile('git', ['-C', repository, 'config', 'user.name', 'U3 Fixture']);
    await execFile('git', ['-C', repository, 'config', 'user.email', 'u3-fixture@example.invalid']);
    await writeFile(join(repository, 'README.md'), '# Disposable U3 project\n');
    await execFile('git', ['-C', repository, 'add', 'README.md']);
    await execFile('git', ['-C', repository, 'commit', '-qm', 'fixture baseline']);
    const [baseline, strict] = await Promise.all(['baseline', 'strict-review'].map(name =>
      prepareNativeHome({ directory: join(root, `native-${name}`), executable, codexVersion: '0.153.4' })));
    const store = new Store(join(root, 'store'));
    await store.update(async data => {
      create(data, 'baseline'); create(data, 'strict-review');
      await bind(data, 'baseline', repository); await bind(data, 'strict-review', repository);
    });
    await registerHome(store, 'baseline', baseline.root, { executable, version: '0.153.4' });
    await registerHome(store, 'strict-review', strict.root, { executable, version: '0.153.4' });
    const defaultUserHome = join(root, 'default-user-home');
    await mkdir(join(defaultUserHome, '.codex'), { recursive: true, mode: 0o700 });

    const capture = async input => {
      calls.captures.push(input.profile.profileName);
      if (mode.capture === 'crash') throw Object.assign(new Error('Fixture capture interruption'), { code: 'FIXTURE_CAPTURE_CRASH' });
      await input.processOptions.onSpawn?.({ pid: 4000 + calls.captures.length,
        processIdentity: { pid: 4000, started: 'fixture', command: 'fixture-capture', host: 'test' } });
      if (beforeCapture && !await beforeCapture(input)) return { process: { status: 'cancelled', exitCode: null,
        shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } },
        run: { status: 'partial', coverage: {}, skills: [], agents: [], turns: [], events: [],
          outcome: { status: 'unknown', nativeTurnStatus: 'cancelled' } }, capture: { status: 'partial', errors: [] } };
      if (mode.capture === 'delayed') {
        await new Promise(resolve => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            input.processOptions.signal?.removeEventListener('abort', finish);
            if (delayedRelease === finish) delayedRelease = null;
            resolve();
          };
          delayedRelease = finish;
          if (input.processOptions.signal?.aborted || releaseRequested) {
            releaseRequested = false;
            finish();
          }
          else input.processOptions.signal?.addEventListener('abort', finish, { once: true });
        });
        if (input.processOptions.signal?.aborted) return { process: { status: 'cancelled', exitCode: null,
          elapsedMs: 1, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } },
          run: { status: 'partial', coverage: { skills: 'unavailable' }, skills: [], agents: [], turns: [], events: [],
            outcome: { status: 'unknown', nativeTurnStatus: 'cancelled' } },
          capture: { status: 'unavailable', capabilities: {}, errors: [] }, capabilities: {} };
      }
      const threadId = beforeCapture && input.execution?.model ? input.limits.id : input.profile.profileName === 'baseline'
        ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002';
      if (mode.capture === 'sandbox-unavailable') {
        const run = { schemaVersion: 1, kind: 'audit-run', id: input.limits.id,
          status: 'unavailable', reason: 'Profile write protection and native command sandbox could not be verified together; no model task was started',
          profile: { profileId: input.profile.profileId, profileName: input.profile.profileName,
            home: input.profile.home, userHome: input.profile.userHome },
          agents: [], turns: [], events: [], skills: [], metrics: { wallMs: 5 },
          source: { kind: 'native-rollout', nativeSessionId: threadId, threadId, clientVersion: '0.153.4' },
          coverage: { skills: 'unavailable', agents: 'unavailable', timeline: 'unavailable' },
          outcome: { status: 'unknown' } };
        const capture = { status: 'unavailable', capabilities: {},
          errors: [{ code: 'startup-command-sandbox-unavailable', message: 'PRIVATE RAW STARTUP DETAIL' }] };
        await input.onSession?.(run, capture);
        return { process: { status: 'exited', exitCode: 0, elapsedMs: 5, pid: 4000,
          processIdentity: null, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } },
          run, capture, capabilities: {} };
      }
      const run = { schemaVersion: 1, kind: 'audit-run', id: input.limits.id, status: 'ready',
        profile: { profileId: input.profile.profileId, profileName: input.profile.profileName,
          home: input.profile.home, userHome: input.profile.userHome },
        agents: [{ id: threadId, parentId: null, depth: 0 }],
        turns: [{ agentId: threadId, turnId: 'fixture-turn', model: input.execution?.model ?? 'fixture-model', reasoningEffort: input.execution?.reasoningEffort ?? 'medium', status: 'completed' }],
        events: [], skills: [], usage: {}, metrics: { wallMs: 5, processElapsedMs: 5, toolsActiveIntervalMs: 0, activeWaitMs: 0 },
        coverage: { skills: 'complete', agents: 'complete', timeline: 'complete' },
        outcome: { status: 'native-claim', nativeTurnStatus: 'completed' },
        source: { kind: 'native-rollout', nativeSessionId: threadId, threadId, clientVersion: '0.153.4' } };
      if (mode.capture === 'partial') {
        run.status = 'partial';
        run.reason = 'Skill invocation coverage is best effort.';
        run.coverage.skills = 'partial';
        run.source = { ...run.source, kind: 'native-app-server-v2', version: '0.153.4',
          workspace: input.workspace, client: 'cli' };
        const path = join(input.workspace, 'README.md');
        await writeFile(path, '# Updated disposable U3 project\n');
        run.artifacts = [{ kind: 'recorded-file-change', path, status: 'update', agentId: threadId, turnId: 'fixture-turn', sourceLine: 8 }];
      }
      await input.onTaskEnd?.({ at: new Date().toISOString(), run, complete: true });
      await input.onSession?.(run, { status: 'ready' });
      const errors = mode.capture === 'sandbox-error-with-turn'
        ? [{ code: 'startup-command-sandbox-unavailable', message: 'PRIVATE RAW STARTUP DETAIL' }] : [];
      return { process: { status: 'exited', exitCode: 0, elapsedMs: 5, pid: 4000,
        processIdentity: null, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } },
        run, capture: { status: mode.capture === 'partial' ? 'partial' : 'ready', capabilities: { skillsList: 'available' }, errors },
        capabilities: { appServerV2: 'available', skillsList: 'available' } };
    };
    const runProcess = async options => {
      if (options.args?.length) calls.checks.push(options.args);
      await options.onSpawn?.({ pid: 5000 + calls.checks.length,
        processIdentity: { pid: 5000, started: 'fixture', command: 'fixture-check', host: 'test' } });
      const failed = mode.check === 'fail' && options.args?.at(-1) === 'true';
      if (mode.check === 'output') {
        const stdout = 'CHECK_STDOUT retained fixture output\n';
        const stderr = 'CHECK_STDERR warning with OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh\n';
        await writeFile(options.stdoutPath, stdout, { mode: 0o600 });
        await writeFile(options.stderrPath, stderr, { mode: 0o600 });
        return { status: 'exited', exitCode: 0, elapsedMs: 2,
          processIdentity: null, shutdown: { groupTerminated: true },
          output: { bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr), truncated: false } };
      }
      return { status: 'exited', exitCode: failed ? 1 : 0, elapsedMs: 2,
        processIdentity: null, shutdown: { groupTerminated: true }, output: { bytes: 0, truncated: false } };
    };
    let accessChecks = 0;
    const runContext = {
      capture, process: runProcess,
      ...(mode.blockFinalPreflight ? { observeAccess: async () => ++accessChecks > 4
        ? { status: 'blocked', reason: 'fixture-access-changed', clients: [], sourceReservation: null }
        : { status: 'ready', clients: [], sourceReservation: null } } : {}),
      ...(mode.staleCommit ? { inspectRepository: async (...args) => {
        calls.repositoryInspections = (calls.repositoryInspections ?? 0) + 1;
        const { inspectAuditRepository } = await import('../src/audit-workspace.js');
        const result = await inspectAuditRepository(...args);
        return calls.repositoryInspections > 1 ? { ...result, commit: 'f'.repeat(40) } : result;
      } } : {}),
    };
    const reportsRoot = join(root, 'reports');
    const serverLogs = [];
    const makeProvider = () => createEngineProvider({ store, reportsRoot, defaultUserHome, profilesBase: join(root, 'profiles'), runContext, reviewContext,
      lockOptions: { lockPath: join(root, 'global.lock'), concurrentLockPath: join(root, 'desktop.lock') },
      copyRuntime: () => createDesktopRuntime({ concurrentLockPath: join(root, 'desktop.lock'),
        processSnapshot: async () => [{ pid: globalThis.process.pid, ppid: 1, uid: globalThis.process.getuid(), startedAt: 'fixture', executable: globalThis.process.execPath }] }),
    });
    provider = makeProvider();
    server = await startUiServer({ provider, staticRoot, log: message => serverLogs.push(message) });
    const seedStoppedRun = async () => {
      const input = { task: 'Private interrupted fixture task', files: '', a: 'baseline', b: 'strict-review',
        repository, commit: 'HEAD', checks: [] };
      const spec = validateAuditSpec({ schemaVersion: 1, repository, revision: 'HEAD', task: input.task,
        profiles: [input.a, input.b], allowIncompleteCapture: true });
      const profiles = [
        { profileId: (await store.read()).profiles.find(profile => profile.name === input.a).id,
          profileName: input.a, home: baseline.home },
        { profileId: (await store.read()).profiles.find(profile => profile.name === input.b).id,
          profileName: input.b, home: strict.home },
      ];
      const parent = await createExperiment(store, { spec, task: spec.task, profiles });
      for (const profile of profiles) {
        const child = await createExperimentRun(store, { experimentId: parent.id, profile });
        await writeAuditState(store, child.id, { coordinator: { pid: 2147483000, host: hostname(),
          processIdentity: { pid: 2147483000, started: 'fixture-stopped', host: hostname() } }, process: null, reservation: null });
      }
      const uiRuns = join(store.directory, 'ui-runs');
      await mkdir(uiRuns, { recursive: true, mode: 0o700 });
      await writeFile(join(uiRuns, `${parent.id}.json`), JSON.stringify({ id: parent.id,
        createdAt: new Date().toISOString(), profiles: [input.a, input.b] }) + '\n', { flag: 'wx', mode: 0o600 });
      return { id: parent.id };
    };
    const fixture = { root, store, repository, executable, homes: { baseline, strict }, reportsRoot, serverLogs, calls, runContext,
      get url() { return server.launchUrl; }, get origin() { return server.origin; }, get provider() { return provider; },
      seedStoppedRun,
      releaseCapture: () => {
        if (delayedRelease) delayedRelease();
        else releaseRequested = true;
      },
      restartServer: async () => {
        await provider.close?.();
        await server.close();
        provider = makeProvider();
        server = await startUiServer({ provider, staticRoot, log: message => serverLogs.push(message) });
        return { url: server.launchUrl, origin: server.origin };
      },
      close: async () => { await provider.close?.(); await server.close(); await rm(root, { recursive: true, force: true }); } };
    return fixture;
  } catch (error) {
    if (server) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
