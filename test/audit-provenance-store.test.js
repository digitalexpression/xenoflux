import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportAuditReport, readAuditReport, projectReportResourceProvenance } from '../src/audit-store.js';
import { compareAuditRuns } from '../src/audit-report.js';
import { renderAudit } from '../src/audit-report.js';

const block = { schemaVersion: 1, status: 'complete', counts: { observed: 1, omitted: 0, snapshots: 1 }, resources: [
  { identity: { origin: 'project', location: 'workspace/skills/review' }, name: 'review', scope: 'project', nativeSkillIds: ['review'], agentIds: ['root'], aliases: [],
    snapshots: [{ phase: 'after-task', status: 'present', definition: { status: 'present', fingerprint: 'a'.repeat(64) } }],
    absolutePath: '/Users/private/.ssh/id_rsa', rawBody: 'PRIVATE_BODY_SENTINEL', arbitraryManifest: { token: 'PRIVATE_TOKEN_SENTINEL' } },
] };

test('report store projects known provenance blocks and reopens without source files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-provenance-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.md');
  await writeFile(source, 'PRIVATE_SOURCE_SENTINEL');
  const report = { schemaVersion: 1, kind: 'audit-run', id: 'run-provenance', status: 'complete', resourceProvenance: block,
    skillPathFromCapture: source };
  const jsonPath = join(directory, 'run.json');
  const receipt = await exportAuditReport(report, { output: jsonPath });
  const exported = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(exported.resourceProvenance.resources[0].absolutePath, undefined);
  assert.equal(JSON.stringify(exported).includes('PRIVATE_BODY_SENTINEL'), false);
  assert.equal(JSON.stringify(exported).includes('PRIVATE_TOKEN_SENTINEL'), false);
  await rm(source);
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened.resourceProvenance, exported.resourceProvenance);

  const markdownPath = join(directory, 'run.md');
  const mdReceipt = await exportAuditReport(report, { output: markdownPath, format: 'markdown' });
  const sidecar = await readAuditReport(mdReceipt.evidencePath);
  assert.deepEqual(sidecar.resourceProvenance, reopened.resourceProvenance);
  assert.match(await readFile(markdownPath, 'utf8'), /Resource provenance: complete/);
});

test('legacy report reopening preserves its original shape and report rendering shows unavailable provenance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-provenance-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyPath = join(directory, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify({ schemaVersion: 1, kind: 'audit-run', id: 'old' }));
  const legacy = await readAuditReport(legacyPath);
  assert.equal(Object.hasOwn(legacy, 'resourceProvenance'), false);
  assert.match(renderAudit(legacy), /Resource provenance: unavailable/);
  const exportedPath = join(directory, 'legacy-export.json');
  const receipt = await exportAuditReport(legacy, { output: exportedPath });
  assert.deepEqual(await readAuditReport(receipt.evidencePath), legacy);
  const normalized = projectReportResourceProvenance({ schemaVersion: 1, kind: 'audit-run', resourceProvenance: { status: 'complete', resources: 'malformed' } });
  assert.equal(normalized.resourceProvenance.status, 'unavailable');
  assert.equal(normalized.resourceProvenance.reason, 'invalid');
  assert.equal(Object.hasOwn(projectReportResourceProvenance({ schemaVersion: 1, kind: 'audit-run' }), 'resourceProvenance'), false);
});

test('checkpoint wrapper walker normalizes every known provenance location in one pass', () => {
  const wrapper = { captureCheckpoint: { kind: 'audit-capture-checkpoint', run: { id: 'checkpoint-run', resourceProvenance: block } },
    state: { trials: [{ summary: { runs: [{ id: 'summary-run', resourceProvenance: block }] } }] },
    record: { run: { id: 'record-run', resourceProvenance: block } },
    report: { schemaVersion: 1, kind: 'audit-run', id: 'report-run', resourceProvenance: block } };
  const result = projectReportResourceProvenance(wrapper);
  for (const run of [result.captureCheckpoint.run, result.state.trials[0].summary.runs[0], result.record.run, result.report]) {
    assert.equal(run.resourceProvenance.resources[0].rawBody, undefined);
    assert.equal(run.resourceProvenance.resources[0].absolutePath, undefined);
  }
});

test('comparison JSON and Markdown sidecar retain the canonical comparison summary', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-provenance-comparison-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const left = { id: 'left', resourceProvenance: block, sourceWorkspace: { sourceCommit: 'c', sourceTree: 't' } };
  const right = { id: 'right', resourceProvenance: block, sourceWorkspace: { sourceCommit: 'c', sourceTree: 't' } };
  const comparison = compareAuditRuns(left, right);
  const expected = comparison.comparison.resourceProvenance;
  const receipt = await exportAuditReport(comparison, { output: join(directory, 'comparison.md'), format: 'markdown' });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.deepEqual(reopened.comparison.resourceProvenance, expected);
  assert.match(await readFile(join(directory, 'comparison.md'), 'utf8'), /Resource provenance comparison: complete/);
});

test('store recomputes baseline trust from embedded source identities', () => {
  const make = (left, right) => projectReportResourceProvenance({ schemaVersion: 1, kind: 'audit-comparison', left, right,
    comparison: { resourceProvenance: { schemaVersion: 1, status: 'complete', sameBaseline: true, stabilityProven: false, changes: [] } } });
  const withBlock = commit => ({ resourceProvenance: block, sourceWorkspace: commit ? { sourceCommit: commit, sourceTree: 'tree' } : {} });
  const mismatched = make(withBlock('commit-a'), withBlock('commit-b'));
  assert.equal(mismatched.comparison.resourceProvenance.sameBaseline, false);
  assert.equal(mismatched.comparison.resourceProvenance.changes[0].status, 'unknown');
  const missing = make(withBlock(null), withBlock(null));
  assert.equal(missing.comparison.resourceProvenance.sameBaseline, false);
  assert.equal(missing.comparison.resourceProvenance.changes[0].status, 'unknown');
  const matching = make(withBlock('commit-a'), withBlock('commit-a'));
  assert.equal(matching.comparison.resourceProvenance.sameBaseline, true);
});

test('series provenance projection preserves every prebounded planned trial', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-provenance-series-slots-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = { schemaVersion: 1, kind: 'audit-series-report', id: 'large-series', status: 'partial',
    trials: Array.from({ length: 162 }, (_, i) => ({ index: i + 1, status: 'not-started', profiles: [] })) };
  const receipt = await exportAuditReport(value, { output: join(directory, 'series.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.equal(reopened.trials.length, 162);
  assert.equal(reopened.trials.at(-1).index, 162);
});
