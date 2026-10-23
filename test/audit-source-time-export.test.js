import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeAuditSkillTelemetry } from '../src/audit-skill-usage.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { compareAuditRuns, renderAudit } from '../src/audit-report.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';
import { projectSkillSourceTime, nsToSourceIso, skillSourceTimeFromRecord } from '../src/audit-source-time.js';

const sourceTime = (nativeNs, eventNs, observedNs) => ({ schemaVersion: 1,
  nativeEvent: { source: 'event.timestamp', clock: 'producer-reported', unixNano: nativeNs },
  otlpEvent: { source: 'timeUnixNano', clock: 'otlp-event', unixNano: eventNs },
  otlpObserved: { source: 'observedTimeUnixNano', clock: 'otlp-observed', unixNano: observedNs },
  clockRelationship: 'unknown', private: 'PRIVATE_TIME_ROOT' });
const event = (observationId, times) => ({ source: 'native-otel-skill-invocation', threadId: 'root', turnId: 'turn-1',
  skillName: 'demo', scope: 'user', invocationType: 'explicit', timestampNs: '1700000000000000000',
  observationId, sourceTime: times });
function makeRun() {
  return { schemaVersion: 1, kind: 'audit-run', id: 'source-time-run', status: 'ready',
    profile: { profileName: 'A' }, source: { kind: 'native-rollout', threadId: 'root', clientVersion: 'unknown' },
    agents: [{ id: 'root', depth: 0 }], skills: [{ id: 'skill-demo', name: 'demo', origin: 'user', scope: 'user',
      catalogs: [{ agentId: 'root' }], observations: [] }], skillInvocations: [], turns: [], coverage: {},
    skillTelemetry: { status: 'observed', delivery: 'best-effort' } };
}

test('source clocks retain precision and disagreement as separate producer-reported domains', () => {
  const fromWire = skillSourceTimeFromRecord({ timeUnixNano: '1792491630123456788', observedTimeUnixNano: '1792491630123456787' },
    '2026-10-20T10:20:30.123456789Z');
  assert.equal(nsToSourceIso(fromWire.nativeEvent.unixNano), '2026-10-20T10:20:30.123456789Z');
  assert.notEqual(fromWire.nativeEvent.unixNano, fromWire.otlpEvent.unixNano);
  const projected = projectSkillSourceTime(sourceTime('1760500000123456789', '1760500000999999999', '1760500000000000001'));
  assert.equal(projected.nativeEvent.unixNano, '1760500000123456789');
  assert.equal(projected.otlpEvent.unixNano, '1760500000999999999');
  assert.equal(projected.otlpObserved.unixNano, '1760500000000000001');
  assert.equal(projected.clockRelationship, 'unknown');
  assert.match(nsToSourceIso(projected.nativeEvent.unixNano), /\.123456789Z$/);
  assert.notEqual(projected.otlpEvent.unixNano, projected.nativeEvent.unixNano);
  assert.equal(projectSkillSourceTime(undefined), null);
  assert.equal(projectSkillSourceTime({ ...sourceTime('1760500000123456789', '0', 'bad'), schemaVersion: 2 }), null);
  const malformed = projectSkillSourceTime({ ...sourceTime('-1', '0', '99999999999999999999'), unknown: 'PRIVATE_TIME_FIELD' });
  assert.equal(malformed.nativeEvent.unixNano, null);
  assert.equal(malformed.otlpEvent.unixNano, null);
  assert.equal(malformed.otlpObserved.unixNano, null);
  assert.doesNotMatch(JSON.stringify(malformed), /PRIVATE/);
});

test('merge excludes source times from receipt identity and is idempotent across repeated input', () => {
  const run = makeRun();
  const first = event(`${'a'.repeat(32)}:1`, sourceTime('1760500000123456789', '1760500000123456788', '1760500000123456787'));
  const second = event(`${'a'.repeat(32)}:2`, sourceTime('1760500000123456789', '1760500000123456788', '1760500000123456787'));
  mergeAuditSkillTelemetry(run, { events: [first, second], metadata: { transport: 'otlp-http-json' } });
  assert.equal(run.skillInvocations.length, 2, 'distinct received receipts remain distinct at identical source times');
  assert.equal(run.skills[0].observations.filter(item => item.kind === 'native-invocation-observed').length, 2);
  mergeAuditSkillTelemetry(run, { events: [first, second], metadata: { transport: 'otlp-http-json' } });
  assert.equal(run.skillInvocations.length, 2);
  assert.equal(run.skills[0].observations.filter(item => item.kind === 'native-invocation-observed').length, 2);
  assert.deepEqual(run.skillInvocations[0].sourceTime, projectSkillSourceTime(first.sourceTime));
  assert.deepEqual(run.skills[0].observations[0].metadata.sourceTime, projectSkillSourceTime(first.sourceTime));
  assert.equal(run.skillInvocations[0].timestampNs, first.timestampNs, 'legacy receipt timestamp remains independent of source clocks');
  const legacy = makeRun();
  mergeAuditSkillTelemetry(legacy, { events: [{ ...event(`${'b'.repeat(32)}:1`), sourceTime: undefined }], metadata: {} });
  assert.equal(Object.hasOwn(legacy.skillInvocations[0], 'sourceTime'), false);
});

test('source times survive compact and full JSON/Markdown export while malformed nested data is stripped', async t => {
  const run = makeRun();
  const times = sourceTime('1760500000123456789', '1760500000999999999', '1760500000000000001');
  mergeAuditSkillTelemetry(run, { events: [event(`${'c'.repeat(32)}:1`, times)], metadata: { transport: 'otlp-http-json' } });
  const hostile = structuredClone(run);
  hostile.skillInvocations[0].sourceTime.nativeEvent.private = 'PRIVATE_NESTED_TIME';
  hostile.skills[0].observations[0].metadata.sourceTime.otlpEvent.secret = 'PRIVATE_SKILL_METADATA';
  const compact = compactAuditTrial({ runs: [hostile] });
  const compactRun = compact.runs[0];
  assert.deepEqual(compactRun.skillInvocations[0].sourceTime, projectSkillSourceTime(times));
  assert.deepEqual(compactRun.skills[0].observations[0].metadata.sourceTime, projectSkillSourceTime(times));
  assert.deepEqual(compactAuditTrial(compact).runs[0].skillInvocations[0].sourceTime, compactRun.skillInvocations[0].sourceTime);

  const directory = await mkdtemp(join(tmpdir(), 'xfx-source-time-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const json = await exportAuditReport(hostile, { format: 'json', output: join(directory, 'run.json') });
  const reopened = await readAuditReport(json.evidencePath);
  assert.deepEqual(reopened.skillInvocations[0].sourceTime, projectSkillSourceTime(times));
  assert.deepEqual(reopened.skills[0].observations[0].metadata.sourceTime, projectSkillSourceTime(times));
  assert.doesNotMatch(JSON.stringify(reopened), /PRIVATE_TIME|PRIVATE_SKILL/);
  const markdown = await exportAuditReport(hostile, { format: 'markdown', output: join(directory, 'run.md') });
  const markdownEvidence = await readAuditReport(markdown.evidencePath);
  assert.deepEqual(markdownEvidence.skillInvocations[0].sourceTime, projectSkillSourceTime(times));
  assert.match(renderAudit(markdownEvidence), /event\.timestamp \[producer-reported\]/);
  assert.match(renderAudit(markdownEvidence), /timeUnixNano \[otlp-event\]/);
  assert.match(renderAudit(markdownEvidence), /observedTimeUnixNano \[otlp-observed\]/);
  assert.match(renderAudit(markdownEvidence), /clock relationship unknown/);
  assert.doesNotMatch(renderAudit(markdownEvidence), /latency|clock drift|ordered by source time/i);

  const comparison = compareAuditRuns(hostile, hostile);
  const derivedIncomplete = structuredClone(comparison.comparison.skillInvocations.incomplete);
  assert.doesNotMatch(JSON.stringify(comparison), /PRIVATE_NESTED_TIME|PRIVATE_SKILL_METADATA/);
  assert.equal(hostile.skillInvocations[0].sourceTime.nativeEvent.private, 'PRIVATE_NESTED_TIME', 'projection does not modify original evidence');
  comparison.comparison.skillInvocations.left.invocations[0].sourceTime.private = 'PRIVATE_COMPARISON_TIME';
  comparison.comparison.skills[0].left.observations[0].sourceTime.secret = 'PRIVATE_COMPARISON_SKILL';
  comparison.comparison.skillInvocations.incomplete.left = [{ sourceTime: { ...times, private: 'PRIVATE_INCOMPLETE_TIME' } }];
  const comparisonExport = await exportAuditReport(comparison, { format: 'json', output: join(directory, 'comparison.json') });
  const comparisonReopened = await readAuditReport(comparisonExport.evidencePath);
  assert.deepEqual(comparisonReopened.comparison.skillInvocations.left.invocations[0].sourceTime, projectSkillSourceTime(times));
  assert.deepEqual(comparisonReopened.comparison.skills[0].left.observations[0].sourceTime, projectSkillSourceTime(times));
  assert.deepEqual(comparisonReopened.comparison.skillInvocations.incomplete, derivedIncomplete,
    'reopen derives incomplete invocation evidence from validated sides instead of preserving injected rows');
  assert.doesNotMatch(JSON.stringify(comparisonReopened), /PRIVATE_COMPARISON|PRIVATE_INCOMPLETE_TIME/);
});
