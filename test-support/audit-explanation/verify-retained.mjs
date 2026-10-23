// Offline acceptance of an explicitly selected retained same-task pair. Does
// not run a task, checker, native client, or provider. Outputs are exclusive.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/profiles.js';
import { showAuditRecord } from '../../src/audit-experiment.js';
import { readAuditRecord } from '../../src/audit-experiment-store.js';
import { compareAuditRuns, renderAudit } from '../../src/audit-report.js';
import { compactAuditTrial } from '../../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../../src/audit-store.js';

const [storePath, leftId, rightId, output] = process.argv.slice(2);
assert.ok(storePath && leftId && rightId && output, 'Pass STORE LEFT_RUN RIGHT_RUN NEW_OUTPUT');
const store = new Store(resolve(storePath)), directory = resolve(output);
await mkdir(directory, { mode: 0o700 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originals = await Promise.all([leftId, rightId].map(id => readAuditRecord(store, id)));
const originalHashes = Object.fromEntries(await Promise.all(originals.map(async r => [join(r.directory, 'report.json'), sha(await readFile(join(r.directory, 'report.json')))])));
const runs = await Promise.all([leftId, rightId].map(id => showAuditRecord(store, id)));
assert.ok(runs.every(run => run.reportProjection?.context === 'verified' && run.reportProjection?.native === 'ready'));
assert.ok(runs.every(run => run.nativeControls?.turns.length && run.quality?.rubric?.status === 'pending-review'));
for (const [index, run] of runs.entries()) {
  assert.deepEqual(run.checks, originals[index].report.checks, 'original checks retained');
  assert.equal(run.status, originals[index].report.status);
  assert.ok(run.actions.some(action => action.kind === 'visible-test' && action.exitCode === 0));
  await exportAuditReport(run, { output: join(directory, `${index}.json`) });
}
const comparison = compareAuditRuns(...runs), explanation = comparison.comparison.explanation;
assert.equal(explanation.conditions.eligible, true);
const named = explanation.findings.find(row => row.rule === 'named-inline-edge-assertions');
assert.equal(named.classification, 'different');
assert.ok(named.left.evidenceRefs.length && named.right.evidenceRefs.length);
assert.ok(explanation.evidence.nativeControls.left.turns.every(turn => turn.source === 'turn_context' && turn.sourceLine > 0));
assert.ok(explanation.evidence.nativeControls.right.turns.every(turn => turn.source === 'turn_context' && turn.sourceLine > 0));
assert.equal(explanation.verification.left.human.status, 'pending-review');
assert.equal(explanation.verification.right.human.status, 'pending-review');
const compact = compareAuditRuns(...compactAuditTrial({ runs }).runs);
assert.deepEqual(compact.comparison.explanation, explanation);
await exportAuditReport(comparison, { output: join(directory, 'comparison.json') });
const markdown = await exportAuditReport(compact, { output: join(directory, 'comparison.md'), format: 'markdown' });
assert.deepEqual((await readAuditReport(markdown.evidencePath)).comparison.explanation, explanation);
const text = await readFile(join(directory, 'comparison.md'), 'utf8');
const headings = ['Comparison conditions', 'Behavioral findings', 'Paired action evidence', 'Verification', 'Time and tokens', 'Outcome and code changes'];
let last = -1;
for (const heading of headings) { const at = text.indexOf(`## ${heading}`); assert.ok(at > last); last = at; }
assert.match(text, /maximum\\?-safe\\?-integer/);
assert.match(text, /pending\\?-review/);

// Node's filesystem permission boundary forbids access to the owning native
// homes/controller store. Reopen must use only the exported evidence graph.
const root = fileURLToPath(new URL('../../', import.meta.url)), cli = join(root, 'bin/xfx.js');
const invoke = args => {
  const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${root}`, cli,
    '--store', join(directory, 'absent-store'), '--json', 'audit', ...args], {
    env: { ...process.env, HOME: join(directory, 'absent-user-home'), CODEX_HOME: join(directory, 'absent-native-home') },
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000 });
  assert.ifError(result.error); assert.ok([0, 2, 4].includes(result.status), result.stderr);
  return JSON.parse(result.stdout);
};
assert.deepEqual(invoke(['show', join(directory, 'comparison.json')]).comparison.explanation, explanation);
assert.deepEqual(invoke(['diff', join(directory, '0.json'), join(directory, '1.json')]).comparison.explanation, explanation);
const denied = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${root}`, '--input-type=module', '-e',
  'import{accessSync}from"node:fs";try{accessSync(process.argv[1]);process.exit(1)}catch(e){process.exit(e.code==="ERR_ACCESS_DENIED"?0:2)}',
  join(originals[0].directory, 'report.json')], { encoding: 'utf8' });
assert.equal(denied.status, 0, 'source-free process cannot access original controller records');
for (const [path, hash] of Object.entries(originalHashes)) assert.equal(sha(await readFile(path)), hash);
const result = { schemaVersion: 1, kind: 'retained-pair-report-acceptance', runIds: runs.map(run => run.id),
  projection: runs.map(run => run.reportProjection), conditions: explanation.conditions,
  namedActions: explanation.evidence.namedActions, nativeControls: explanation.evidence.nativeControls,
  classifications: explanation.findings.map(row => ({ rule: row.rule, classification: row.classification })),
  compactionParity: true, jsonMarkdownSidecarParity: true, sourceFreeCliShowDiffParity: true,
  originalControllerAccessDenied: true, originalReportHashes: originalHashes, originalsUnchanged: true,
  humanReview: 'pending', taskExecutions: 0, paidCalls: 0, nativeProcesses: 0 };
await writeFile(join(directory, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ output: directory, classifications: result.classifications, sourceFreeCli: true, originalsUnchanged: true, humanReview: 'pending' }));
