// Offline fixture preparation only. There is deliberately no paid-run entry point.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, create, bind } from '../../src/profiles.js';
import { registerHome } from '../../src/homes.js';
import { previewAuditSeries } from '../../src/audit-series.js';
import { validateAuditSpec } from '../../src/audit-spec.js';
import { auditQualityFingerprint } from '../../src/audit-quality.js';
import { prepareNativeHome } from '../native-home-fixture.js';
import { workspaceFiles } from './check-candidate.mjs';
const source = dirname(fileURLToPath(import.meta.url));
const ids = ['booking-ledger', 'retry-queue', 'config-overlay'];
const hash = value => createHash('sha256').update(value).digest('hex');
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
function git(cwd, env, ...args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('fixture-git-failed');
  return result.stdout.trim();
}
async function copyRegular(from, to) {
  const info = await lstat(from);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('fixture-source-unsafe');
  if (info.isDirectory()) {
    await mkdir(to, { mode: 0o700 });
    for (const entry of await readdir(from)) await copyRegular(join(from, entry), join(to, entry));
  } else await writeFile(to, await readFile(from), { flag: 'wx', mode: 0o600 });
}
const rubric = { id: 'substantive-coding-review', version: '1', required: true, minimumPercent: 75,
  criteria: [
    { id: 'correctness', label: 'Contract correctness and edge behavior', maxScore: 4, weight: 3 },
    { id: 'verification', label: 'Evidence and test interpretation', maxScore: 4, weight: 2 },
    { id: 'maintainability', label: 'Clear, scoped implementation', maxScore: 4, weight: 1 },
    { id: 'honesty', label: 'Accurate completion and limitation claims', maxScore: 4, weight: 1 },
  ] };
export async function prepareEvaluation(output) {
  if (!isAbsolute(output) || resolve(output) !== output) throw new Error('fixture-output-must-be-absolute');
  if (!relative(source, output).startsWith('../')) throw new Error('fixture-output-must-be-outside-source');
  if (await realpath(dirname(output)) !== dirname(output)) throw new Error('fixture-output-parent-must-be-canonical');
  const fixtureInputs = await workspaceFiles(source);
  await mkdir(output, { mode: 0o700 }); // Exclusive: never overwrite or clean an existing campaign.
  const home = join(output, 'preparation-home'); await mkdir(home, { mode: 0o700 });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Evaluation Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Evaluation Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const fake = join(output, 'blocked-codex.mjs'), version = '0.0.0-evaluation-fixture';
  await writeFile(fake, `#!${process.execPath}\nif (process.argv.length === 3 && process.argv[2] === '--version') console.log('codex ${version}');\nelse { console.error('Paid execution is not authorized; this is a blocked preparation fixture.'); process.exitCode = 78; }\n`, { mode: 0o700, flag: 'wx' });
  const store = new Store(join(output, 'private-store'));
  const names = ['EvalBaseline', 'EvalWorkflow'], homes = [];
  for (const name of names) {
    const native = await prepareNativeHome({ directory: join(output, name), executable: fake, codexVersion: version });
    await writeFile(join(native.home, 'config.toml'), 'allow_symlinked_codex_home=true\ncli_auth_credentials_store="file"\nmodel="EVALUATION_PENDING_APPROVAL"\nmodel_reasoning_effort="medium"\n');
    if (name === 'EvalWorkflow') {
      await mkdir(join(native.home, 'skills'), { mode: 0o700 });
      await copyRegular(join(source, 'setups/workflow/skills/evaluation-workflow'), join(native.home, 'skills/evaluation-workflow'));
    }
    await store.update(data => create(data, name));
    await registerHome(store, name, native.root, { executable: fake, version }); homes.push(native.home);
  }
  const manifestPath = join(output, 'campaign.json');
  const checker = join(output, 'check-candidate.mjs');
  await writeFile(checker, await readFile(join(source, 'check-candidate.mjs')), { mode: 0o600, flag: 'wx' });
  const manifest = { schemaVersion: 1, id: 'substantive-evaluation-v1', mode: 'offline-preparation',
    paidExecutionAuthorized: false, fixtureLauncher: fake, fixtureVersion: version, store: store.directory, fixtureInputs,
    design: { tasks: 3, setups: 2, repetitions: 2, plannedRuns: 12, taskOrder: ids,
      intendedVariable: 'one selected human-authored workflow skill; fresh homes, no copied personal state',
      heldOutTask: 'config-overlay', cache: 'uncontrolled; no cache reset', allocation: 'three sequential balanced two-trial series' },
    executionApprovalRequired: { model: null, effort: 'medium proposed; must approve and freeze', nativeBinary: null,
      accountRoute: null, monetaryBudget: null, providerLimit: null, humanReviewer: null, hostCheckIsolation: null },
    budgets: { perRunMs: 900000, perTrialMs: 1920000, perTaskSeriesMs: 3840000, campaignNominalMs: 11520000,
      monetaryEnforcement: 'not provided by xfx wall-clock limits; requires an external enforceable provider budget or explicit acceptance of that limitation' },
    profileHomes: homes, checker: { path: checker, sha256: hash(await readFile(checker)) },
    workflowSkillSha256: hash(await readFile(join(source, 'setups/workflow/skills/evaluation-workflow/SKILL.md'))),
    tasks: [] };
  await mkdir(join(output, 'tasks'), { mode: 0o700 }); await mkdir(join(output, 'oracles'), { mode: 0o700 });
  await mkdir(join(output, 'specs'), { mode: 0o700 });
  for (const [index, id] of ids.entries()) {
    const base = join(source, 'tasks', id), task = JSON.parse(await readFile(join(base, 'task.json')));
    const repository = join(output, 'tasks', id); await copyRegular(join(base, 'workspace'), repository);
    await json(join(repository, 'package.json'), { private: true, type: 'module', scripts: { test: 'node --test test/visible.test.js' } });
    git(repository, env, 'init', '--quiet'); git(repository, env, 'add', '--all');
    git(repository, env, 'commit', '--quiet', '-m', 'Frozen evaluation fixture baseline');
    const revision = git(repository, env, 'rev-parse', 'HEAD'), tree = git(repository, env, 'rev-parse', 'HEAD^{tree}');
    await store.update(async data => { for (const name of names) await bind(data, name, repository); });
    const oracle = join(output, 'oracles', `${id}.test.mjs`); await writeFile(oracle, await readFile(join(base, task.oracle)), { mode: 0o600, flag: 'wx' });
    const profiles = names.map(name => ({ name, skills: name === 'EvalWorkflow' ? ['evaluation-workflow'] : [] }));
    if (index % 2) profiles.reverse();
    const checks = [{ name: 'acceptance-suite', argv: [process.execPath, checker, manifestPath, id], timeoutMs: 40000 }];
    const spec = validateAuditSpec({ schemaVersion: 1, repository, revision,
      task: `${task.goal} Read README.md for the complete API and constraints. Change only ${task.editableFiles.join(', ')}. Preserve tests and Git metadata; no network, dependency installation or access outside the workspace. Run visible tests and report what passed and any remaining limitations.`,
      profiles, trials: { count: 2, order: 'balanced', budgetMs: 3840000 },
      variables: ['selected evaluation-workflow skill vs no selected skill'], setup: [], checks,
      quality: { schemaVersion: 1, id: `substantive-${id}`, version: '1', checks: checks.map(({ name }) => ({ name, required: true })),
        workspace: { maxChangedFiles: task.editableFiles.length }, rubric },
      captureRequirements: { minAgents: 1, context: [{ agents: 'root', origin: 'repository', path: 'AGENTS.md', phase: 'before-task' }] },
      limits: { runMs: 900000, experimentMs: 1920000, maxRuns: 2, outputBytes: 8388608 }, sandbox: 'workspace-write', allowIncompleteCapture: true });
    const specPath = join(output, 'specs', `${id}.json`); await json(specPath, spec);
    manifest.tasks.push({ id, title: task.title, kind: task.kind, role: id === 'config-overlay' ? 'held-out-no-tuning' : 'primary',
      repository, revision, tree, editableFiles: task.editableFiles, workspaceFiles: await workspaceFiles(repository),
      oracle: { path: oracle, sha256: hash(await readFile(oracle)) }, specPath, specSha256: hash(await readFile(specPath)),
      qualityFingerprint: auditQualityFingerprint(spec.quality, spec.checks) });
    await json(join(output, 'specs', `${id}.human-review-template.json`), {
      schemaVersion: 1, runId: 'REQUIRES_RECORDED_RUN_ID', fingerprint: auditQualityFingerprint(spec.quality, spec.checks),
      reviewer: 'REQUIRES_HUMAN_REVIEWER', reviewedAt: 'REQUIRES_ACTUAL_REVIEW_TIMESTAMP', rubricId: rubric.id, rubricVersion: rubric.version,
      ratings: rubric.criteria.map(criterion => ({ criterionId: criterion.id, score: null,
        rationale: 'Not yet reviewed.', evidenceRefs: [] })) });
  }
  await json(manifestPath, manifest);
  const previews = [];
  for (const task of manifest.tasks) {
    const preview = await previewAuditSeries(store, JSON.parse(await readFile(task.specPath)));
    await json(join(output, 'specs', `${task.id}.preview.json`), preview);
    if (preview.status !== 'ready' || preview.plannedRuns !== 4) throw new Error('fixture-preview-not-ready');
    previews.push({ id: task.id, plannedRuns: preview.plannedRuns, schedule: preview.schedule.map(slot => slot.profileOrder) });
  }
  await json(join(output, 'preparation.json'), { status: 'prepared-not-executed', manifestPath, paidCalls: 0, nativeCalls: 0,
    fixturesOnly: true, previews, warning: 'ready is an offline fixture scheduling preview, not native/account/model readiness' });
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('Use --output NEW_ABSOLUTE_DIRECTORY');
    const manifest = await prepareEvaluation(process.argv[3]);
    console.log(JSON.stringify({ status: 'prepared-not-executed', tasks: manifest.tasks.length, plannedRuns: 12, paidExecutionAuthorized: false }));
  } catch (error) { console.error(`Preparation failed: ${error.code ?? error.message}`); process.exitCode = 1; }
}
