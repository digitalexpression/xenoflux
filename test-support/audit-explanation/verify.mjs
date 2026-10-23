// Offline M1 acceptance: authored controls and optional retained normalized native reports.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { bookingLedgerPair } from './booking-ledger.js';
import { compareAuditRuns, renderAudit } from '../../src/audit-report.js';
import { compactAuditTrial } from '../../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../../src/audit-store.js';

const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'xfx-m1-acceptance-'));
if (process.argv[2]) await mkdir(root, { mode: 0o700 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const controls = [
  ['difference', () => {}],
  ['similar', pair => { pair[1].artifacts[0].path = pair[0].artifacts[0].path; }],
  ['missing-left-run', pair => { pair[0] = null; }],
  ['missing-right-run', pair => { pair[1] = null; }],
  ...['partial', 'unknown', 'unavailable', 'not-found'].map(state => [state, pair => { pair[1].artifacts = []; pair[1].coverage.workspaceDiff = state; }]),
  ['complete-empty', pair => { for (const run of pair) { run.artifacts = []; run.coverage.workspaceDiff = 'complete'; } }],
  ['incompatible-task', pair => { pair[1].comparisonConditions.taskFingerprint = 'f'.repeat(64); }],
  ['incompatible-baseline', pair => { pair[1].sourceWorkspace.sourceTree = 'different-tree'; }],
  ['incompatible-model', pair => { pair[1].turns[0].model = 'different-model'; }],
  ['incompatible-effort', pair => { pair[1].turns[0].reasoningEffort = 'low'; }],
  ['incompatible-checks', pair => { pair[1].comparisonConditions.checkRecipes[0].fingerprint = 'f'.repeat(64); }],
  ['conflicting-checks', pair => { pair[1].outcome.checks = [{ name: 'scope', status: 'passed', exitCode: 0 }]; }],
  ['unknown-actor', pair => { pair[1].artifacts[0].agentId = 'foreign'; }],
  ['capped-contradiction', pair => { for (const run of pair) run.artifacts = Array.from({ length: 256 }, (_, i) => ({ ...run.artifacts[0], path: 'src/booking-ledger.js', sourceLine: i + 1 })); pair[1].artifacts.push({ ...pair[1].artifacts[0], path: 'test/visible.test.js', sourceLine: 257 }); }],
];
const summary = { schemaVersion: 1, kind: 'audit-m1-explanation-acceptance', evidence: 'authored synthetic controls plus separately labeled retained native replay',
  controls: [], native: [], noModelExecution: true, humanReaderWalkthrough: 'not-performed', consistency: 'unmeasured' };
for (const [name, change] of controls) {
  const pair = bookingLedgerPair(); change(pair);
  const full = compareAuditRuns(...pair);
  const compact = compactAuditTrial({ runs: full ? [full.left, full.right] : pair });
  const compactComparison = compareAuditRuns(...compact.runs);
  assert.deepEqual(compactComparison.comparison.explanation, full.comparison.explanation, name);
  const directory = join(root, name); await mkdir(directory, { mode: 0o700 });
  await exportAuditReport(full, { output: join(directory, 'comparison.json') });
  const md = await exportAuditReport(compactComparison, { output: join(directory, 'comparison.md'), format: 'markdown' });
  const reopened = await readAuditReport(md.evidencePath);
  assert.deepEqual(reopened.comparison.explanation, full.comparison.explanation, name);
  const section = reopened.comparison.explanation.findings[0];
  assert.equal(section.classification, name === 'difference' || name === 'conflicting-checks' || name === 'incompatible-checks' ? 'different' : name === 'similar' || name === 'complete-empty' ? 'similar' : 'inconclusive', name);
  summary.controls.push({ name, classification: section.classification, eligible: reopened.comparison.explanation.conditions.eligible, compactExportReopenParity: true });
}
// Ordinary CLI path with explicitly absent source home; this never selects a native session.
const cliDirectory = join(root, 'cli'); await mkdir(cliDirectory, { mode: 0o700 });
const sourceHome = join(cliDirectory, 'removed-home'); await mkdir(sourceHome); await writeFile(join(sourceHome, 'not-read'), 'synthetic');
const pair = compactAuditTrial({ runs: bookingLedgerPair() }).runs;
for (const [i, run] of pair.entries()) await exportAuditReport({ ...run, schemaVersion: 1, kind: 'audit-run' }, { output: join(cliDirectory, `${i}.json`) });
await rm(sourceHome, { recursive: true });
const cli = fileURLToPath(new URL('../../bin/xfx.js', import.meta.url));
const invoke = args => {
  const result = spawnSync(process.execPath, [cli, '--store', join(cliDirectory, 'store'), '--json', 'audit', ...args], {
    env: { ...process.env, HOME: cliDirectory, CODEX_HOME: sourceHome, XFX_NATIVE_PROFILE_OPEN: '0' }, encoding: 'utf8' });
  assert.ifError(result.error); assert.ok([0, 2].includes(result.status), result.stderr); return JSON.parse(result.stdout);
};
const compared = invoke(['diff', join(cliDirectory, '0.json'), join(cliDirectory, '1.json')]);
await exportAuditReport(compared, { output: join(cliDirectory, 'comparison.json') });
assert.deepEqual(invoke(['show', join(cliDirectory, 'comparison.json')]).comparison.explanation, compared.comparison.explanation);
const exported = invoke(['export', join(cliDirectory, 'comparison.json'), '--format', 'markdown', '--output', join(cliDirectory, 'comparison.md')]);
assert.deepEqual((await readAuditReport(exported.evidencePath)).comparison.explanation, compared.comparison.explanation);
summary.sourceFreeCli = true;
for (const input of process.argv.slice(3)) {
  const before = await readFile(input), normalized = await readAuditReport(input);
  assert.equal(normalized.kind, 'audit-comparison');
  const full = compareAuditRuns(normalized.left, normalized.right), compact = compactAuditTrial({ runs: [full.left, full.right] });
  const projected = compareAuditRuns(...compact.runs);
  assert.deepEqual(projected.comparison.explanation, full.comparison.explanation);
  assert.equal(projected.comparison.explanation.conditions.eligible, false);
  const directory = join(root, `native-${summary.native.length + 1}`); await mkdir(directory, { mode: 0o700 });
  const output = await exportAuditReport(projected, { output: join(directory, 'comparison.md'), format: 'markdown' });
  assert.deepEqual((await readAuditReport(output.evidencePath)).comparison.explanation, full.comparison.explanation);
  assert.equal(hash(await readFile(input)), hash(before));
  summary.native.push({ retainedInputSha256: hash(before), sameTaskEligible: false, compactExportReopenParity: true, originalsUnchanged: true,
    limitation: 'Historical unmatched workflows; no same-task profile effect or quality measurement.' });
}
await writeFile(join(root, 'acceptance.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: root, controls: summary.controls.length, retainedNativeComparisons: summary.native.length, sourceFreeCli: true }));
