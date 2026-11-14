import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportAuditReport, readAuditReport, projectReportResourceProvenance } from '../src/audit-store.js';
import { renderAudit } from '../src/audit-report.js';
import { compareAuditRuns } from '../src/audit-report.js';
import { applyAuditReviewSubmission, auditReplayEvidenceRef, buildAuditReviewPacket } from '../src/audit-review.js';

const rootId = '00000000-0000-4000-8000-000000000001';
const childId = '00000000-0000-4000-8000-000000000002';
const fingerprint = 'a'.repeat(64);
function report() {
  return {
    schemaVersion: 1, kind: 'audit-run', id: 'replay-fixture', status: 'partial',
    profile: { profileName: 'Replay fixture' }, source: { kind: 'native-app-server-v2', threadId: rootId },
    sessionReplay: { schemaVersion: 1, kind: 'session-replay', sessions: [
      { id: rootId, parentId: null, depth: 0, status: 'ready', source: { fingerprint }, limits: [], events: [
        { id: `${rootId}:${fingerprint}:2`, sessionId: rootId, turnId: null, kind: 'tool-call', label: 'exec_command', timestamp: '2026-10-28T12:00:00.000Z', sourceLine: 2, callId: 'call-1', body: 'api_key=sk-abcdefghijklmnopqrstuv', bodyStatus: 'included', bodyBytes: 33 },
        { id: `${rootId}:${fingerprint}:3`, sessionId: rootId, turnId: null, kind: 'tool-result', label: 'Tool result', timestamp: null, sourceLine: 3, callId: 'call-1', relatedEventId: `${rootId}:${fingerprint}:2`, body: 'completed', bodyStatus: 'included', bodyBytes: 9 },
      ] },
      { id: childId, parentId: rootId, depth: 1, status: 'ready', source: { fingerprint }, limits: [], events: [
        { id: `${childId}:${fingerprint}:4`, sessionId: childId, turnId: null, kind: 'message', label: 'Assistant message', timestamp: '2026-10-28T12:00:01.000Z', sourceLine: 4, body: 'Child result', bodyStatus: 'included', bodyBytes: 12 },
      ] },
    ] },
  };
}

test('replay exports omit bodies by default and reopen with stable source and event relationships', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await exportAuditReport(report(), { format: 'markdown', output: join(directory, 'comparison.md') });
  const saved = await readAuditReport(receipt.evidencePath);
  const replay = saved.sessionReplay;
  assert.equal(replay.sessions[0].source.fingerprint, fingerprint);
  assert.equal(replay.sessions[0].events[1].relatedEventId, replay.sessions[0].events[0].id);
  assert.equal(replay.sessions[1].parentId, rootId);
  assert.equal(replay.sessions[0].events[0].body, null);
  assert.equal(replay.sessions[0].events[0].bodyStatus, 'omitted');
  assert.match(replay.sessions[0].events[0].bodyReason, /Omitted/);
  assert.doesNotMatch(JSON.stringify(saved), /sk-abcdefghijklmnopqrstuv/);
  assert.doesNotMatch(JSON.stringify(saved), /\/Users\/|rollout-/);
  const markdown = await (await import('node:fs/promises')).readFile(receipt.output, 'utf8');
  assert.match(markdown, /Session replay/);
  assert.match(markdown, /Unavailable|time not recorded/);
  assert.match(markdown, /parent 00000000-0000-4000-8000-000000000001/);
  assert.match(markdown, /Omitted from frozen export/);
});

test('frozen replay preserves captured workspace without filling missing older context', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-cwd-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const includeReplayContent of [false, true]) {
    const value = report();
    value.sessionReplay.sessions[0].cwd = '/recorded/workspace';
    const receipt = await exportAuditReport(value, { output: join(directory, `workspace-${includeReplayContent}.json`), includeReplayContent });
    const saved = await readAuditReport(receipt.evidencePath);
    assert.equal(saved.sessionReplay.sessions[0].cwd, '/recorded/workspace');
    assert.equal(Object.hasOwn(saved.sessionReplay.sessions[1], 'cwd'), false);
    assert.equal(Object.hasOwn(value.sessionReplay.sessions[1], 'cwd'), false);
  }
});

test('event citations in reviews survive default source-free export and reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-review-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const subject = projectReportResourceProvenance(report());
  for (const session of subject.sessionReplay.sessions) for (const event of session.events) {
    event.body = null;
    event.bodyStatus = 'omitted';
    event.bodyReason = 'not-retained-in-source';
    delete event.bodyBytes;
  }
  const packet = buildAuditReviewPacket(subject);
  const event = subject.sessionReplay.sessions[1].events[0];
  const ref = auditReplayEvidenceRef(subject.id, event.sessionId, event.id);
  assert(packet.evidenceRefs.includes(ref));
  const reviews = applyAuditReviewSubmission(subject, null, {
    schemaVersion: 1, kind: 'xfx-audit-review-submission', evidenceFingerprint: packet.evidenceFingerprint,
    reviews: [{ id: 'event-review', reviewer: { type: 'human', name: 'Reviewer' },
      reviewedAt: '2026-10-29T10:00:00Z', method: 'manual', scope: packet.claimScopes[0],
      conclusion: 'inconclusive', summary: 'The cited replay event is unavailable.', evidenceRefs: [ref] }], supplementalChecks: [],
  });
  const evaluation = { schemaVersion: 1, kind: 'audit-evaluation-report', id: 'event-review-eval',
    status: 'complete', exitCode: 0, source: { evidenceFingerprint: packet.evidenceFingerprint },
    subject, reviewPacket: packet, reviewHistory: reviews };
  const receipt = await exportAuditReport(evaluation, { output: join(directory, 'review.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  const savedPacket = buildAuditReviewPacket(reopened.subject);
  assert(savedPacket.evidenceRefs.includes(ref));
  assert.deepEqual(reopened.reviewState.reviews[0].evidenceRefs, [ref]);
  assert.equal(reopened.subject.sessionReplay.sessions[1].events[0].bodyStatus, 'omitted');
});

test('replay body export is explicit and redacts supported secret forms', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-content-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await exportAuditReport(report(), { output: join(directory, 'with-content.json'), includeReplayContent: true });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.match(reopened.sessionReplay.sessions[0].events[0].body, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(reopened), /sk-abcdefghijklmnopqrstuv/);
  assert.equal(reopened.sessionReplay.sessions[0].events[0].bodyStatus, 'included');
  assert.equal(reopened.sessionReplay.sessions[0].events[1].relatedEventId, reopened.sessionReplay.sessions[0].events[0].id);
  assert.match(renderAudit(reopened, { format: 'markdown' }), /REDACTED/);

  const structured = report();
  structured.sessionReplay.sessions[0].events[0].body = JSON.stringify({ api_key: 'plain-secret-value',
    authorization: 'Bearer plain-secret-value' });
  structured.sessionReplay.sessions[0].events[0].bodyBytes = Buffer.byteLength(structured.sessionReplay.sessions[0].events[0].body);
  const structuredReceipt = await exportAuditReport(structured,
    { output: join(directory, 'structured.json'), includeReplayContent: true });
  const structuredSaved = await readAuditReport(structuredReceipt.evidencePath);
  assert.doesNotMatch(JSON.stringify(structuredSaved), /plain-secret-value/);
  assert.match(JSON.stringify(structuredSaved), /REDACTED/);

  // Redaction can make a short JSON value longer; the saved byte count must
  // describe the redacted content so the artifact can still reopen.
  structured.sessionReplay.sessions[0].events[0].body = '{"api_key":"x"}';
  structured.sessionReplay.sessions[0].events[0].bodyBytes = 15;
  const expanded = await exportAuditReport(structured,
    { output: join(directory, 'expanded.json'), includeReplayContent: true });
  const expandedEvent = (await readAuditReport(expanded.evidencePath)).sessionReplay.sessions[0].events[0];
  assert.equal(expandedEvent.bodyBytes, Buffer.byteLength(expandedEvent.body));
  assert.equal(expandedEvent.bodyReason, 'known-secret-patterns-redacted');
});

test('truncated structured replay bodies are omitted during content export and metadata strings are redacted', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-truncated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = report();
  const completeBody = JSON.stringify({ api_key: 'front-secret-value', payload: 'x'.repeat(1024 * 1024) });
  const event = value.sessionReplay.sessions[0].events[0];
  event.body = completeBody.slice(0, 1024 * 1024);
  event.bodyBytes = Buffer.byteLength(completeBody);
  event.bodyStatus = 'truncated';
  event.bodyReason = 'event-body-limit';
  event.label = 'api_key=sk-abcdefghijklmnopqrstuv';
  event.status = 'Authorization: Bearer plain-secret-value';
  const receipt = await exportAuditReport(value,
    { output: join(directory, 'truncated.json'), includeReplayContent: true });
  const reopened = await readAuditReport(receipt.evidencePath);
  const replayEvent = reopened.sessionReplay.sessions[0].events[0];
  assert.equal(replayEvent.body, null);
  assert.equal(replayEvent.bodyStatus, 'omitted');
  assert.equal(replayEvent.bodyReason, 'truncated-content-not-safely-redactable');
  assert.equal(replayEvent.bodyBytes, Buffer.byteLength(completeBody));
  assert.doesNotMatch(JSON.stringify(reopened), /front-secret-value|abcdefghijklmnopqrstuv|plain-secret-value/);
  assert.match(JSON.stringify(reopened), /REDACTED/);
});

test('replay exports reject broken links and oversized event bodies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const badLink = report();
  badLink.sessionReplay.sessions[0].events[1].relatedEventId = 'missing-event';
  await assert.rejects(exportAuditReport(badLink, { output: join(directory, 'bad.json') }), /link/i);
  const tooLarge = report();
  tooLarge.sessionReplay.sessions[0].events[0].body = 'x'.repeat(1024 * 1024 + 1);
  tooLarge.sessionReplay.sessions[0].events[0].bodyBytes = tooLarge.sessionReplay.sessions[0].events[0].body.length;
  await assert.rejects(exportAuditReport(tooLarge, { output: join(directory, 'large.json'), includeReplayContent: true }), /body|size|limit/i);
  const extra = report();
  extra.sessionReplay.sessions[0].events[0].privateTranscript = 'PRIVATE_EXTRA_BODY';
  await assert.rejects(exportAuditReport(extra, { output: join(directory, 'extra.json') }), /unsupported fields/i);
  assert.equal(await import('node:fs/promises').then(({ access }) => access(join(directory, 'extra.json')).then(() => true, () => false)), false);
});

test('default replay export redacts credential patterns in opaque event IDs and preserves event links', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-id-redaction-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const value = report();
  const [call, result] = value.sessionReplay.sessions[0].events;
  call.callId = 'ghp_12345678901234567890';
  call.itemId = 'api_key=sk-abcdefghijklmnopqrstuv';
  result.callId = call.callId;
  const originalEventId = call.id;
  const originalLink = result.relatedEventId;
  const receipt = await exportAuditReport(value, { output: join(directory, 'redacted.json') });
  const bytes = await readFile(receipt.evidencePath, 'utf8');
  const reopened = await readAuditReport(receipt.evidencePath);
  const [savedCall, savedResult] = reopened.sessionReplay.sessions[0].events;
  assert.doesNotMatch(bytes, /ghp_12345678901234567890|sk-abcdefghijklmnopqrstuv/);
  assert.equal(savedCall.callId, '[REDACTED]');
  assert.equal(savedCall.itemId, 'api_key=[REDACTED]');
  assert.equal(savedResult.callId, '[REDACTED]');
  assert.equal(savedCall.id, originalEventId);
  assert.equal(savedResult.relatedEventId, originalLink);
});

test('legacy reports export/reopen without gaining replay content', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = { schemaVersion: 1, kind: 'audit-run', id: 'legacy', status: 'passed', profile: { profileName: 'Legacy' },
    source: { kind: 'native-app-server-v2', threadId: rootId }, events: [] };
  const receipt = await exportAuditReport(legacy, { output: join(directory, 'legacy.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.equal(Object.hasOwn(reopened, 'sessionReplay'), false);
  assert.equal(Object.hasOwn(reopened, 'replayContentBoundary'), false);
});

test('default body omission follows experiment comparisons and evaluation subject and series report paths', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-nested-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const withReplay = (id, threadId, text) => ({ id, status: 'passed', profile: { profileId: id, profileName: id },
    source: { kind: 'native-app-server-v2', threadId }, agents: [], turns: [], events: [],
    sessionReplay: { schemaVersion: 1, kind: 'session-replay', sessions: [{ id: threadId, parentId: null, depth: 0,
      status: 'ready', source: { fingerprint }, limits: [], events: [{ id: `${threadId}:${fingerprint}:7`, sessionId: threadId, turnId: null,
        kind: 'message', label: 'Assistant message', timestamp: null, sourceLine: 7, body: text,
        bodyStatus: 'included', bodyBytes: Buffer.byteLength(text) }] }] } });
  const left = withReplay('left', rootId, 'NESTED_SECRET=sk-abcdefghijklmnopqrstuv');
  const right = withReplay('right', childId, 'NESTED_RIGHT=sk-abcdefghijklmnopqrstuv');
  const comparison = compareAuditRuns(left, right);
  const experiment = { schemaVersion: 1, kind: 'audit-experiment-report', id: 'nested-experiment', status: 'complete',
    runs: [], comparisons: [comparison] };
  const series = { schemaVersion: 1, kind: 'audit-series-report', id: 'nested-series', status: 'complete',
    profiles: [], plan: [], trials: [{ index: 1, runs: [withReplay('series-run', rootId, 'SERIES_SECRET=sk-abcdefghijklmnopqrstuv')] }], comparisons: [], warnings: [] };
  const subject = projectReportResourceProvenance(experiment);
  const packet = buildAuditReviewPacket(subject);
  const evaluationSubject = { schemaVersion: 1, kind: 'audit-evaluation-report', id: 'eval-subject', status: 'complete',
    exitCode: 0, source: { evidenceFingerprint: packet.evidenceFingerprint }, subject, reviewPacket: packet, reviewHistory: null };
  const evaluationSeries = { schemaVersion: 1, kind: 'audit-evaluation-report', id: 'eval-series', status: 'complete',
    exitCode: 0, source: {}, series };
  for (const [name, value] of [['experiment', experiment], ['evaluation-series', evaluationSeries]]) {
    const receipt = await exportAuditReport(value, { output: join(directory, `${name}.json`) });
    const saved = await readAuditReport(receipt.evidencePath);
    const encoded = JSON.stringify(saved);
    assert.doesNotMatch(encoded, /sk-abcdefghijklmnopqrstuv/);
    assert.doesNotMatch(encoded, /NESTED_SECRET|NESTED_RIGHT|SERIES_SECRET/);
    assert.match(encoded, /replayContentBoundary/);
  }
  await assert.rejects(exportAuditReport(evaluationSubject, { output: join(directory, 'eval-subject-omitted.json') }), /change reviewed evidence/i);
  assert.equal(await import('node:fs/promises').then(({ access }) => access(join(directory, 'eval-subject-omitted.json')).then(() => true, () => false)), false);
  await assert.rejects(exportAuditReport(evaluationSubject,
    { output: join(directory, 'eval-subject-redacted.json'), includeReplayContent: true }), /change reviewed evidence/i);
  assert.equal(await import('node:fs/promises').then(({ access }) => access(join(directory, 'eval-subject-redacted.json')).then(() => true, () => false)), false);

  const unchangedSubject = projectReportResourceProvenance({ ...experiment,
    comparisons: [compareAuditRuns(withReplay('clean-left', rootId, 'Plain recorded reply.'),
      withReplay('clean-right', childId, 'Another recorded reply.'))] });
  const unchangedPacket = buildAuditReviewPacket(unchangedSubject);
  const unchangedEvaluation = { schemaVersion: 1, kind: 'audit-evaluation-report', id: 'eval-subject-unchanged', status: 'complete',
    exitCode: 0, source: { evidenceFingerprint: unchangedPacket.evidenceFingerprint }, subject: unchangedSubject,
    reviewPacket: unchangedPacket, reviewHistory: null };
  const unchangedReceipt = await exportAuditReport(unchangedEvaluation,
    { output: join(directory, 'eval-subject-included.json'), includeReplayContent: true });
  const unchangedSaved = await readAuditReport(unchangedReceipt.evidencePath);
  assert.match(JSON.stringify(unchangedSaved), /Plain recorded reply/);
  const included = await exportAuditReport(experiment, { output: join(directory, 'experiment-included.json'), includeReplayContent: true });
  const content = JSON.stringify(await readAuditReport(included.evidencePath));
  assert.doesNotMatch(content, /sk-abcdefghijklmnopqrstuv/);
  assert.match(content, /\[REDACTED\]/);
  assert.match(content, /NESTED_SECRET/);
});

test('legacy evaluation export preserves an existing review history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'xfx-replay-legacy-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const subject = projectReportResourceProvenance({ schemaVersion: 1, kind: 'audit-run', id: 'reviewed-legacy-run', status: 'complete',
    profile: { profileName: 'Legacy' }, source: { kind: 'native-app-server-v2', threadId: rootId }, events: [] });
  const packet = buildAuditReviewPacket(subject);
  const reviewHistory = applyAuditReviewSubmission(subject, null, { schemaVersion: 1, kind: 'xfx-audit-review-submission',
    evidenceFingerprint: packet.evidenceFingerprint, reviews: [{ id: 'human-review-1', reviewer: { type: 'human', name: 'Reviewer' },
      reviewedAt: '2026-10-29T10:00:00Z', method: 'manual', scope: packet.claimScopes[0], conclusion: 'inconclusive',
      summary: 'Insufficient retained evidence.', evidenceRefs: [] }], supplementalChecks: [] });
  const evaluation = { schemaVersion: 1, kind: 'audit-evaluation-report', id: 'legacy-review-eval', status: 'complete', exitCode: 0,
    source: { evidenceFingerprint: packet.evidenceFingerprint }, subject, reviewPacket: packet, reviewHistory };
  const receipt = await exportAuditReport(evaluation, { output: join(directory, 'reviewed.json') });
  const reopened = await readAuditReport(receipt.evidencePath);
  assert.equal(reopened.reviewState.status, 'reviewed');
  assert.equal(reopened.reviewState.reviews[0].reviewer.name, 'Reviewer');
});
