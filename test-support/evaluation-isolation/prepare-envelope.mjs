// Offline-only conversion of the frozen fixture campaign into a pending envelope.
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditQualityFingerprint } from '../../src/audit-quality.js';
import { workspaceFiles } from '../substantive-evaluation/check-candidate.mjs';
import { nativePin } from './native-policy.mjs';

const source = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtureSource = join(source, 'test-support/substantive-evaluation');
const taskOrder = ['booking-ledger', 'retry-queue', 'config-overlay'];
const expectedSchedule = [
  [['EvalBaseline', 'EvalWorkflow'], ['EvalWorkflow', 'EvalBaseline']],
  [['EvalWorkflow', 'EvalBaseline'], ['EvalBaseline', 'EvalWorkflow']],
  [['EvalBaseline', 'EvalWorkflow'], ['EvalWorkflow', 'EvalBaseline']],
];
const bounds = { perRunMs: 900000, perTrialMs: 1920000, perTaskSeriesMs: 3840000,
  campaignNominalMs: 11520000, outputBytes: 8388608, isolatedCheckTimeoutMs: 600000,
  monetaryEnforcement: 'pending; wall-clock limits do not impose a provider currency cap' };
const pendingGates = { nativeIsolation: 'pending', workerMappingAndBridgeVerification: 'pending', providerSelection: 'pending',
  enforceableMonetaryBudget: 'pending', reviewerAssignment: 'pending' };
const pendingApproval = { model: null, effort: null, accountRoute: null, monetaryBudget: null, providerEnforcement: null,
  humanReviewer: null, approved: false };
const isolatedChecker = join(source, 'test-support/evaluation-isolation/check-isolated.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
async function fingerprintFile(path, expected, code) {
  const bytes = await readFile(path);
  if (sha(bytes) !== expected) throw new Error(code);
  return bytes;
}
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  if (result.status !== 0 || result.error) throw new Error('envelope-source-git-unavailable');
  return result.stdout.trim();
}
function ignoredOutput(path) {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: source,
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  return result.status === 0 && !result.error;
}
async function campaignInputs(output = null) {
  const files = await workspaceFiles(fixtureSource);
  if (output) {
    const prefix = relative(fixtureSource, output);
    if (prefix && !prefix.startsWith('../')) for (const path of Object.keys(files))
      if (path === prefix || path.startsWith(`${prefix}/`)) delete files[path];
  }
  return files;
}
async function exclusive(path, value, mode = 0o600) {
  await writeFile(path, jsonBytes(value), { flag: 'wx', mode });
}
function isolatedQuality(spec, check) {
  return { ...spec.quality, checks: spec.quality.checks.map(item => ({ ...item,
    name: item.name === 'acceptance-suite' ? check.name : item.name })) };
}
function expectedWorkerContract(envelopePath) {
  return { candidateWorkspace: 'candidate files checked against frozen baseline map; unchanged supporting files plus allowed edits; candidate Git metadata not transferred or independently verified',
    worker: 'one isolated VM per acceptance check; fixture-only read-only input plus candidate workspace and runtime; candidate code never runs on host',
    mapping: 'worker bridge/mount mapping must be independently verified before execution',
    checkArgvTemplate: [process.execPath, isolatedChecker, envelopePath, '<TASK_ID>'] };
}
function expectedExecutionPaths(output) {
  return { status: 'proposed-only-not-registered-or-authenticated', controllerHome: join(output, 'controller-home'),
    store: join(output, 'private-store'), workspaceRoot: join(output, 'workspaces'), profiles: [
      { name: 'EvalBaseline', home: join(output, 'profiles/EvalBaseline'), skills: [] },
      { name: 'EvalWorkflow', home: join(output, 'profiles/EvalWorkflow'), skills: ['evaluation-workflow'] },
    ] };
}
function scheduledSlots() {
  const slots = [];
  for (let t = 0; t < taskOrder.length; t++) for (let repetition = 0; repetition < 2; repetition++)
    for (const profile of expectedSchedule[t][repetition]) slots.push({ slot: slots.length + 1, taskId: taskOrder[t],
      repetition: repetition + 1, profile, profileOrder: [...expectedSchedule[t][repetition]] });
  return slots;
}
function approvedBlockedNative(value) {
  return value === null || (value && value.version === nativePin.version && value.sha256 === nativePin.sha256
    && value.status === 'blocked-managed-preferences' && value.executionAuthorized === false
    && Object.keys(value).length === 4);
}

export async function prepareExecutionEnvelope(campaignPath, output, { nativeBinary = null, runtimePath = null } = {}) {
  if (!isAbsolute(campaignPath) || !isAbsolute(output) || resolve(output) !== output)
    throw new Error('envelope-paths-must-be-absolute');
  if (!approvedBlockedNative(nativeBinary)) throw new Error('envelope-native-binary-must-remain-blocked');
  const campaignBytes = await readFile(campaignPath), campaign = JSON.parse(campaignBytes);
  if (campaign.mode !== 'offline-preparation' || campaign.paidExecutionAuthorized !== false
    || campaign.design?.plannedRuns !== 12 || campaign.design?.tasks !== 3
    || campaign.design?.setups !== 2 || campaign.design?.repetitions !== 2
    || JSON.stringify(campaign.design.taskOrder) !== JSON.stringify(taskOrder)
    || campaign.tasks?.length !== 3) throw new Error('envelope-campaign-not-frozen-offline-fixture');
  if (await realpath(dirname(output)) !== dirname(output)) throw new Error('envelope-output-parent-not-canonical');
  const insideSource = !relative(source, output).startsWith('../');
  if (insideSource && (!output.startsWith(`${source}/release-artifacts/`) || !ignoredOutput(output)))
    throw new Error('envelope-output-must-be-outside-source-or-git-ignored');
  if (resolve(campaignPath) === output || campaignPath.startsWith(`${output}/`)) throw new Error('envelope-output-overlaps-campaign');
  if (typeof campaign.checker?.path !== 'string') throw new Error('envelope-checker-missing');
  await fingerprintFile(campaign.checker.path, campaign.checker.sha256, 'envelope-checker-hash-mismatch');
  if (JSON.stringify(await campaignInputs()) !== JSON.stringify(campaign.fixtureInputs))
    throw new Error('envelope-source-fixture-inputs-mismatch');
  const skill = join(source, 'test-support/substantive-evaluation/setups/workflow/skills/evaluation-workflow/SKILL.md');
  await fingerprintFile(skill, campaign.workflowSkillSha256, 'envelope-workflow-skill-hash-mismatch');

  const observer = { head: git(source, 'rev-parse', 'HEAD'), files: {} };
  for (const [path, digest] of Object.entries(await workspaceFiles(join(source, 'src')))) observer.files[`src/${path}`] = digest;
  for (const path of ['package.json', 'package-lock.json', 'test-support/substantive-evaluation/check-candidate.mjs',
    'test-support/evaluation-isolation/check-isolated.mjs', 'test-support/evaluation-isolation/verify-apple.mjs',
    'test-support/evaluation-isolation/guest-probes.mjs', 'test-support/evaluation-isolation/native-policy.mjs',
    'test-support/evaluation-isolation/snapshot-candidate.py',
    'test-support/evaluation-isolation/prepare-envelope.mjs']) {
    try { observer.files[path] = sha(await readFile(join(source, path))); }
    catch (error) { if (error.code === 'ENOENT') observer.files[path] = null;
      else throw error; }
  }
  if (!observer.files['test-support/evaluation-isolation/check-isolated.mjs'])
    throw new Error('envelope-isolated-checker-unavailable');

  const workerRuntime = runtimePath ? { path: runtimePath, sha256: sha(await readFile(runtimePath)) } : null;
  const tasks = [];
  for (let index = 0; index < taskOrder.length; index++) {
    const id = taskOrder[index], task = campaign.tasks[index];
    if (task.id !== id || task.role !== (id === 'config-overlay' ? 'held-out-no-tuning' : 'primary'))
      throw new Error('envelope-task-order-or-role-mismatch');
    if (JSON.stringify(await workspaceFiles(task.repository)) !== JSON.stringify(task.workspaceFiles))
      throw new Error(`envelope-task-workspace-hash-mismatch:${id}`);
    if (git(task.repository, 'rev-parse', 'HEAD') !== task.revision || git(task.repository, 'rev-parse', 'HEAD^{tree}') !== task.tree)
      throw new Error(`envelope-task-baseline-mismatch:${id}`);
    await fingerprintFile(task.oracle.path, task.oracle.sha256, `envelope-oracle-hash-mismatch:${id}`);
    await fingerprintFile(task.specPath, task.specSha256, `envelope-spec-hash-mismatch:${id}`);
    const spec = JSON.parse(await readFile(task.specPath));
    if (spec.revision !== task.revision || spec.repository !== task.repository
      || auditQualityFingerprint(spec.quality, spec.checks) !== task.qualityFingerprint
      || JSON.stringify(spec.trials) !== JSON.stringify({ count: 2, order: 'balanced', budgetMs: 3840000 })
      || spec.checks?.length !== 1 || spec.checks[0].name !== 'acceptance-suite'
      || JSON.stringify(spec.checks[0].argv) !== JSON.stringify([process.execPath, campaign.checker.path, campaignPath, id])
      || spec.profiles?.length !== 2 || JSON.stringify(spec.profiles.map(profile => profile.name))
        !== JSON.stringify(index % 2 ? ['EvalWorkflow', 'EvalBaseline'] : ['EvalBaseline', 'EvalWorkflow'])
      || new Set(spec.profiles.map(profile => profile.name)).size !== 2
      || JSON.stringify(spec.profiles.find(profile => profile.name === 'EvalBaseline')?.skills) !== '[]'
      || JSON.stringify(spec.profiles.find(profile => profile.name === 'EvalWorkflow')?.skills) !== '["evaluation-workflow"]')
      throw new Error(`envelope-spec-quality-or-trials-mismatch:${id}`);
    const isolatedCheck = { name: 'isolated-acceptance-suite', argv: [process.execPath,
      isolatedChecker, join(output, 'envelope.json'), id], timeoutMs: bounds.isolatedCheckTimeoutMs };
    const quality = isolatedQuality(spec, isolatedCheck);
    const checks = [isolatedCheck];
    const checkFingerprint = auditQualityFingerprint(quality, checks);
    tasks.push({ id, role: task.role, repository: task.repository, revision: task.revision, tree: task.tree,
      editableFiles: task.editableFiles, workspaceFiles: task.workspaceFiles,
      oracle: { path: task.oracle.path, sha256: task.oracle.sha256 },
      frozenSpec: { path: task.specPath, sha256: task.specSha256 },
      originalQualityFingerprint: task.qualityFingerprint, isolatedCheck, qualityFingerprint: checkFingerprint,
      quality, trialBounds: { count: spec.trials.count, order: spec.trials.order, budgetMs: spec.trials.budgetMs,
        runMs: spec.limits.runMs, maxRuns: spec.limits.maxRuns, outputBytes: spec.limits.outputBytes } });
  }

  await mkdir(output, { mode: 0o700 }); // exclusive; no cleanup or overwrite
  const slots = scheduledSlots();
  const envelope = { schemaVersion: 1, id: 'substantive-evaluation-execution-envelope-v1', status: 'pending-approval',
    executionAuthorized: false, paidExecutionAuthorized: false, mode: 'offline-envelope-preparation',
    sourceCampaign: { path: campaignPath, sha256: sha(campaignBytes) }, observer,
    checker: { path: campaign.checker.path, sha256: campaign.checker.sha256 }, workflowSkillSha256: campaign.workflowSkillSha256,
    nativeBinary: nativeBinary ?? null, workerRuntime,
    design: { tasks: 3, setups: 2, repetitions: 2, plannedRuns: 12, taskOrder },
    slots, tasks, workerContract: expectedWorkerContract(join(output, 'envelope.json')),
    executionPaths: expectedExecutionPaths(output),
    approval: { ...pendingApproval },
    gates: { ...pendingGates }, budgets: { ...bounds },
    decision: 'validation-only; refuse execution unless every approval and isolation gate is explicitly resolved' };
  const envelopePath = join(output, 'envelope.json');
  for (const task of tasks) {
    task.isolatedCheck.argv[2] = envelopePath;
    task.qualityFingerprint = auditQualityFingerprint(task.quality, [task.isolatedCheck]);
  }
  envelope.workerContract.checkArgvTemplate[2] = envelopePath;
  await exclusive(envelopePath, envelope, 0o400);
  await exclusive(join(output, 'validation.json'), { status: 'prepared-not-executed', paidCalls: 0, nativeCalls: 0,
    envelopePath, envelopeSha256: sha(await readFile(envelopePath)), slots: slots.length, executionAuthorized: false,
    originalCampaignUnchanged: sha(await readFile(campaignPath)) === sha(campaignBytes) });
  return envelope;
}

export async function validateExecutionEnvelope(envelopePath) {
  const envelopeBytes = await readFile(envelopePath), envelope = JSON.parse(envelopeBytes);
  if (envelope.schemaVersion !== 1 || envelope.status !== 'pending-approval' || envelope.executionAuthorized !== false
    || envelope.paidExecutionAuthorized !== false || envelope.approval?.approved !== false)
    throw new Error('envelope-approval-gate-not-pending');
  const campaignBytes = await fingerprintFile(envelope.sourceCampaign.path, envelope.sourceCampaign.sha256,
    'envelope-campaign-hash-mismatch');
  const requiredObservers = [...Object.keys(await workspaceFiles(join(source, 'src'))).map(path => `src/${path}`),
    'package.json', 'package-lock.json', 'test-support/substantive-evaluation/check-candidate.mjs', 'test-support/evaluation-isolation/check-isolated.mjs',
    'test-support/evaluation-isolation/verify-apple.mjs', 'test-support/evaluation-isolation/guest-probes.mjs',
    'test-support/evaluation-isolation/native-policy.mjs', 'test-support/evaluation-isolation/snapshot-candidate.py',
    'test-support/evaluation-isolation/prepare-envelope.mjs'];
  if (JSON.stringify(Object.keys(envelope.observer?.files ?? {}).sort()) !== JSON.stringify([...requiredObservers].sort()))
    throw new Error('envelope-observer-set-mismatch');
  const campaign = JSON.parse(campaignBytes);
  if (campaign.mode !== 'offline-preparation' || campaign.paidExecutionAuthorized !== false
    || !isAbsolute(envelope.sourceCampaign.path) || JSON.stringify(envelope.checker) !== JSON.stringify(campaign.checker)
    || envelope.schemaVersion !== 1 || envelope.id !== 'substantive-evaluation-execution-envelope-v1'
    || envelope.status !== 'pending-approval' || envelope.executionAuthorized !== false
    || envelope.paidExecutionAuthorized !== false || envelope.mode !== 'offline-envelope-preparation'
    || JSON.stringify(envelope.design) !== JSON.stringify({ tasks: 3, setups: 2, repetitions: 2, plannedRuns: 12, taskOrder })
    || JSON.stringify(envelope.design.taskOrder) !== JSON.stringify(taskOrder)
    || envelope.tasks?.length !== 3 || envelope.observer.head !== git(source, 'rev-parse', 'HEAD'))
    throw new Error('envelope-design-or-observer-head-mismatch');
  if (!approvedBlockedNative(envelope.nativeBinary)) throw new Error('envelope-native-binary-descriptor-mismatch');
  if (JSON.stringify(envelope.approval) !== JSON.stringify(pendingApproval))
    throw new Error('envelope-approval-inputs-must-remain-pending');
  if (JSON.stringify(envelope.budgets) !== JSON.stringify(bounds)
    || JSON.stringify(envelope.gates) !== JSON.stringify(pendingGates)
    || JSON.stringify(envelope.workerContract) !== JSON.stringify(expectedWorkerContract(envelopePath))
    || JSON.stringify(envelope.executionPaths) !== JSON.stringify(expectedExecutionPaths(dirname(envelopePath)))
    || envelope.decision !== 'validation-only; refuse execution unless every approval and isolation gate is explicitly resolved')
    throw new Error('envelope-bounds-mismatch');
  await fingerprintFile(campaign.checker.path, campaign.checker.sha256, 'envelope-checker-hash-mismatch');
  await fingerprintFile(join(source, 'test-support/substantive-evaluation/setups/workflow/skills/evaluation-workflow/SKILL.md'),
    envelope.workflowSkillSha256, 'envelope-workflow-skill-hash-mismatch');
  if (envelope.workerRuntime !== null) {
    if (!envelope.workerRuntime || typeof envelope.workerRuntime.path !== 'string'
      || !/^[a-f0-9]{64}$/.test(envelope.workerRuntime.sha256) || Object.keys(envelope.workerRuntime).length !== 2)
      throw new Error('envelope-worker-runtime-descriptor-invalid');
    await fingerprintFile(envelope.workerRuntime.path, envelope.workerRuntime.sha256, 'envelope-worker-runtime-hash-mismatch');
  }
  if (JSON.stringify(await campaignInputs(dirname(envelopePath))) !== JSON.stringify(campaign.fixtureInputs))
    throw new Error('envelope-source-fixture-inputs-mismatch');
  for (const [path, expected] of Object.entries(envelope.observer.files))
    await fingerprintFile(join(source, path), expected, `envelope-observer-hash-mismatch:${path}`);
  for (let index = 0; index < envelope.tasks.length; index++) {
    const task = envelope.tasks[index], frozen = campaign.tasks[index];
    if (task.id !== taskOrder[index] || frozen.id !== task.id || task.role !== frozen.role
      || task.repository !== frozen.repository || task.revision !== frozen.revision || task.tree !== frozen.tree
      || JSON.stringify(task.editableFiles) !== JSON.stringify(frozen.editableFiles)
      || JSON.stringify(task.workspaceFiles) !== JSON.stringify(frozen.workspaceFiles)
      || JSON.stringify(task.oracle) !== JSON.stringify(frozen.oracle)
      || JSON.stringify(task.frozenSpec) !== JSON.stringify({ path: frozen.specPath, sha256: frozen.specSha256 })
      || task.originalQualityFingerprint !== frozen.qualityFingerprint)
      throw new Error(`envelope-task-binding-mismatch:${task.id}`);
    await fingerprintFile(task.frozenSpec.path, task.frozenSpec.sha256, `envelope-spec-hash-mismatch:${task.id}`);
    const spec = JSON.parse(await readFile(task.frozenSpec.path));
    const expectedQuality = isolatedQuality(spec, task.isolatedCheck);
    const expectedProfileOrder = index % 2 ? ['EvalWorkflow', 'EvalBaseline'] : ['EvalBaseline', 'EvalWorkflow'];
    if (task.isolatedCheck.name !== 'isolated-acceptance-suite'
      || auditQualityFingerprint(spec.quality, spec.checks) !== frozen.qualityFingerprint
      || JSON.stringify(spec.profiles?.map(profile => profile.name)) !== JSON.stringify(expectedProfileOrder)
      || JSON.stringify(task.quality) !== JSON.stringify(expectedQuality)
      || task.originalQualityFingerprint !== auditQualityFingerprint(spec.quality, spec.checks))
      throw new Error(`envelope-frozen-quality-mismatch:${task.id}`);
    await fingerprintFile(task.oracle.path, task.oracle.sha256, `envelope-oracle-hash-mismatch:${task.id}`);
    if (JSON.stringify(await workspaceFiles(task.repository)) !== JSON.stringify(task.workspaceFiles)
      || git(task.repository, 'rev-parse', 'HEAD') !== task.revision || git(task.repository, 'rev-parse', 'HEAD^{tree}') !== task.tree)
      throw new Error(`envelope-task-baseline-mismatch:${task.id}`);
    if (auditQualityFingerprint(task.quality, [task.isolatedCheck]) !== task.qualityFingerprint
      || JSON.stringify(task.isolatedCheck.argv) !== JSON.stringify([process.execPath,
        join(source, 'test-support/evaluation-isolation/check-isolated.mjs'), envelopePath, task.id])
      || task.isolatedCheck.timeoutMs !== envelope.budgets.isolatedCheckTimeoutMs
      || JSON.stringify(task.trialBounds) !== JSON.stringify({ count: 2, order: 'balanced', budgetMs: envelope.budgets.perTaskSeriesMs,
        runMs: envelope.budgets.perRunMs, maxRuns: 2, outputBytes: envelope.budgets.outputBytes }))
      throw new Error(`envelope-isolated-check-fingerprint-mismatch:${task.id}`);
  }
  if (JSON.stringify(envelope.slots) !== JSON.stringify(scheduledSlots()))
    throw new Error('envelope-slot-sequence-mismatch');
  return envelope;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      if (!['--campaign', '--output', '--runtime'].includes(flag) || !value || options.has(flag))
        throw new Error('Use --campaign EXISTING_CAMPAIGN.json --output NEW_ABSOLUTE_DIRECTORY [--runtime RETAINED_RUNTIME.json]');
      options.set(flag, value);
    }
    if (!options.has('--campaign') || !options.has('--output'))
      throw new Error('Use --campaign EXISTING_CAMPAIGN.json --output NEW_ABSOLUTE_DIRECTORY [--runtime RETAINED_RUNTIME.json]');
    const result = await prepareExecutionEnvelope(options.get('--campaign'), options.get('--output'),
      { runtimePath: options.get('--runtime') ?? null });
    console.log(JSON.stringify({ status: result.status, plannedRuns: result.slots.length, executionAuthorized: false }));
  } catch (error) { console.error(`Envelope preparation failed: ${error.message}`); process.exitCode = 1; }
}
