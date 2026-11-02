import test from 'node:test';
import assert from 'node:assert/strict';
import { presentCheckRows } from '../src/audit-check-presentation.js';
const run = (name = 'Verify', fp = 'a'.repeat(64), status = 'passed') => ({
  checks: [{ name, status, exitCode: status === 'passed' ? 0 : 1 }],
  comparisonConditions: { checkRecipes: [{ name, fingerprint: fp }] },
});

test('historical check results retain their scope without invented definition bodies or output', () => {
  const [row] = presentCheckRows(run(), run('Verify', 'a'.repeat(64), 'failed'));
  assert.equal(row.definitionMatch, 'same');
  assert.equal(row.a.status, 'passed'); assert.equal(row.b.status, 'failed');
  assert.equal(row.a.definition.command, null); assert.equal(row.b.execution.elapsedMs, null);
  assert.equal(row.a.output.status, 'unavailable');
  assert.match(row.a.detailNote, /not retained/);
});

test('different and unknown recipes do not imply comparable checks merely from names', () => {
  assert.equal(presentCheckRows(run(), run('Verify', 'b'.repeat(64)))[0].definitionMatch, 'different');
  assert.equal(presentCheckRows(run(), run('Verify', null))[0].definitionMatch, 'unknown');
  const duplicates = run(); duplicates.comparisonConditions.checkRecipes.push({ name: 'Verify', fingerprint: 'b'.repeat(64) });
  assert.equal(presentCheckRows(duplicates, run())[0].definitionMatch, 'unknown');
});

test('exact definition identity takes precedence over names and missing sides remain empty', () => {
  const rows = presentCheckRows(run('Left label'), run('Right label'));
  assert.equal(rows.length, 1); assert.equal(rows[0].definitionMatch, 'same');
  assert.equal(rows[0].b.name, 'Right label');
  const [one] = presentCheckRows(run(), {});
  assert.equal(one.definitionMatch, 'one-sided'); assert.equal(one.b, null);
  assert.deepEqual(presentCheckRows({}, {}), []);
});

test('selected checks without results are visible without a fabricated failure', () => {
  const selected = run(); selected.checks = [];
  const [row] = presentCheckRows(selected, {});
  assert.equal(row.a.status, 'not-recorded'); assert.equal(row.a.exitCode, null);
  assert.equal(row.a.output.status, 'unavailable');
});
