// Shared plain-language wording for comparisons (DESIGN.md › Comparison,
// review and run labels). The local app, the Markdown export and
// the demo data use these functions so one engine state always reads the same
// way. Presentation never re-derives eligibility: it reads the explanation the
// engine already built.
import { buildAuditExplanation, freezeAuditComparisonEvidence, gateAuditComparisonDeltas } from './audit-explanation.js';
import { retainedAuditSelectionOptions } from './audit-selection.js';
import path from 'node:path';
import { presentAgentMeasurements } from './audit-agent-measurements.js';
import { presentWorkflowMeasurements } from './audit-workflow-measurements.js';
import { projectAuditFileInventory } from './audit-file-inventory.js';
import { presentCheckRows } from './audit-check-presentation.js';
import { projectAuditWorkspacePatch } from './audit-workspace-patch.js';

const list = value => Array.isArray(value) ? value : [];
const MAX_PRESENTED_STEPS = 80;
const CAPTURE_FAILURE_TEXT = Object.freeze({
  'requested-permission-unconfirmed': 'Codex did not confirm the requested permission mode. The model task did not start.',
  'startup-command-sandbox-unavailable': 'The native command sandbox could not be verified, so the model task did not start.',
});
export function nativeLimitReached(run) {
  const reports = [run?.reason, ...list(run?.capture?.errors).map(error => error?.code)];
  return reports.some(value => typeof value === 'string'
    && /(?:^|[ _.-])(?:rate[ _-]*limit(?:ed|[ _-]*reached)?|usage[ _-]*limit|quota[ _-]*(?:exceeded|exhausted)|resource[ _-]*exhausted)(?:$|[ _.-])/i.test(value));
}

function knownCaptureFailures(run) {
  const errors = [...list(run?.capture?.errors), ...list(run?.captureCheckpoint?.capture?.errors)];
  const codes = [...new Set(errors.map(error => error?.code).filter(code => Object.hasOwn(CAPTURE_FAILURE_TEXT, code)))];
  const hasNativeActivity = list(run?.turns).length > 0
    || [run?.outcome?.nativeTurnStatus, run?.outcome?.task?.nativeTurnStatus, run?.task?.nativeTurnStatus,
      run?.comparisonEvidence?.verification?.nativeCompletion].some(status => ['completed', 'failed', 'interrupted', 'cancelled', 'aborted'].includes(status))
    || list(run?.outcome?.checks).length > 0 || list(run?.checks).length > 0;
  return [
    ...codes.map(code => ({ code, text: code === 'startup-command-sandbox-unavailable' && hasNativeActivity
      ? 'Native command sandbox preflight reported an unavailable check.' : CAPTURE_FAILURE_TEXT[code] })),
    ...(nativeLimitReached(run) ? [{ code: 'native-limit-reached', text: 'The native client reported a usage or rate limit.' }] : []),
  ];
}

/** Completion is distinct from check results and capture coverage. */
export function presentRunExecution(run) {
  if (knownCaptureFailures(run).some(failure => failure.text === CAPTURE_FAILURE_TEXT['startup-command-sandbox-unavailable'] || failure.code === 'requested-permission-unconfirmed')
    || run?.status === 'not-started') return { state: 'not-started', text: 'Model task did not start' };
  if (nativeLimitReached(run)) return { state: 'failed', text: 'Native usage or rate limit reached' };
  const native = freezeAuditComparisonEvidence(run ?? {}).verification?.nativeCompletion;
  if (native === 'completed') return { state: 'completed', text: 'Model task completed' };
  if (native === 'failed') return { state: 'failed', text: 'Model task failed or stopped' };
  return { state: 'unknown', text: 'Task completion not recorded' };
}

/* ---------- Labels ---------- */

/** Default label for an exact comparison state. */
export function comparisonLabel(state) {
  switch (state) {
    case 'changed': case 'added': case 'removed': return 'different';
    case 'identical': return 'same';
    case 'not-applicable': return 'not-applicable';
    default: return 'cannot-compare';
  }
}

export const LABEL_TEXT = Object.freeze({ different: 'Different', same: 'Same', 'cannot-compare': 'Could not compare', 'not-applicable': 'Not applicable' });

/** Exact text shown in details and exports; names the profile for one-sided items. */
export function exactStateText(state, { a = 'the first profile', b = 'the second profile' } = {}) {
  switch (state) {
    case 'changed': return 'Changed';
    case 'added': return `Only in ${b}`;
    case 'removed': return `Only in ${a}`;
    case 'identical': return 'Same within what was read';
    case 'partial': return 'Partly compared';
    case 'unknown': return 'Seen, but not comparable';
    case 'unavailable': return 'Couldn’t be read';
    case 'redacted': return 'Hidden (secret values are never shown)';
    case 'not-applicable': return 'Not applicable';
    default: return 'Seen, but not comparable';
  }
}

export const ASSOCIATION = Object.freeze({
  recorded: { title: 'Same opening task recorded', text: 'Both sessions recorded the same task text at the start. Later turns or project state may still differ.' },
  'recorded-later-differ': { title: 'Same opening task; later prompts differ', text: 'Findings about later turns will be limited.' },
  'user-declared': { title: 'You said these are the same task', text: 'Saved as your statement, not as proof the inputs matched.' },
  unknown: { title: 'Same task not shown by the records', text: 'The recorded task text differs or wasn’t recorded. You can still compare, or say they’re the same task yourself.' },
});

export function countLabels(items) {
  const counts = { different: 0, same: 0, cannotCompare: 0 };
  for (const item of items) {
    if (item.label === 'different') counts.different++;
    else if (item.label === 'same') counts.same++;
    else if (item.label === 'cannot-compare') counts.cannotCompare++;
  }
  return counts;
}

/** "2 different · 1 same" for a group head. */
export function groupMeta(counts) {
  const parts = [];
  if (counts.different) parts.push(`${counts.different} different`);
  if (counts.cannotCompare) parts.push(`${counts.cannotCompare} couldn’t compare`);
  if (counts.same) parts.push(`${counts.same} same`);
  return parts.join(' · ') || 'Nothing found';
}

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

/* ---------- Findings ---------- */

/** Sentences for engine finding assertions; also used by the technical renderer. */
export const ASSERTION_TEXT = Object.freeze({
  'in-boundary-edit-observed': 'Recorded an edit within the declared file boundary',
  'outside-boundary-edit-observed': 'Recorded an edit outside the declared file boundary',
  'editable-boundary-unknown': 'The editable-file boundary was not recorded',
  'edit-scope-unknown': 'No located edit establishes scope; other actions remain unknown',
  'no-file-change-records': 'No file-change records in the complete captured scope; this does not assert no edits occurred',
  'read-before-recorded-edit': 'A read operation is recorded before an edit in the same owned source',
  'read-after-recorded-edit': 'A read operation is recorded after an edit in the same owned source',
  'read-before-edit': 'A successful named read is recorded before an edit invocation in the same owned turn',
  'read-after-edit': 'A successful named read is recorded after an edit invocation in the same owned turn',
  'read-edit-order-unknown': 'Read/edit order cannot be established from the retained evidence',
  'not-identifiable-from-retained-actions': 'This behavior cannot be identified from retained actions',
});
export const assertionText = assertion => ASSERTION_TEXT[assertion] ?? assertion;

const FINDING_TITLE = {
  'editable-file-boundary': 'Kept edits to the files you named',
  'read-edit-sequence': 'Read before editing',
  'named-contract-read-before-edit': 'Read the instructions before editing',
  'named-source-read-before-edit': 'Read source files before editing',
  'named-test-read-before-edit': 'Read tests before editing',
  'named-visible-test-execution': 'Ran a named test',
  'named-inline-edge-assertions': 'Checked edge cases inline',
  'agent-verification': 'Checked its own work',
  'diff-inspection': 'Reviewed its final changes',
};

/** Short, plain observation for one side of a finding. */
const OBSERVATION = {
  'in-boundary-edit-observed': 'Edited only the files you named.',
  'outside-boundary-edit-observed': 'Edited a file outside the ones you named.',
  'editable-boundary-unknown': 'No record of which files it was allowed to change.',
  'edit-scope-unknown': 'No located edit shows the scope of its changes.',
  'no-file-change-records': 'No file changes were recorded.',
  'read-before-recorded-edit': 'Read a file before its first recorded edit.',
  'read-after-recorded-edit': 'Its first recorded edit came before it read the file.',
  'read-edit-order-unknown': 'The order of reads and edits isn’t in the records.',
  'read-invocation-before-edit-invocation': 'Read it before its first edit.',
  'read-invocation-after-edit-invocation': 'Read it only after editing.',
  'named-read-edit-order-unknown': 'No recorded read of these files before an edit.',
  'named-visible-test-recorded': 'Ran a named test.',
  'named-visible-test-unknown': 'No named test run was recorded.',
  'named-inline-assertion-recorded': 'Ran inline assertions.',
  'named-inline-assertion-unknown': 'No inline assertions were recorded.',
  'not-identifiable-from-retained-actions': 'The recorded actions can’t show this.',
};
const UNKNOWN_ASSERTIONS = new Set(['editable-boundary-unknown', 'edit-scope-unknown', 'read-edit-order-unknown', 'named-read-edit-order-unknown',
  'named-visible-test-unknown', 'named-inline-assertion-unknown', 'not-identifiable-from-retained-actions']);
const CLASSIFICATION = { different: 'different', similar: 'same', inconclusive: 'cannot-compare' };

function testOutcome(side) {
  const statuses = list(side.actions).map(action => action.status);
  if (!statuses.length) return '';
  if (statuses.every(status => status === 'passed' || status === 'invocation-passed')) return ' It passed.';
  if (statuses.some(status => status === 'failed' || status === 'invocation-failed')) return ' It failed.';
  return ' Its result wasn’t recorded.';
}

function observation(side) {
  const base = OBSERVATION[side.assertion] ?? assertionText(side.assertion);
  return side.assertion === 'named-visible-test-recorded' ? `${base.slice(0, -1)}${list(side.actions)[0]?.targets?.length ? ` (${side.actions[0].targets.join(', ')})` : ''}.${testOutcome(side)}` : base;
}

function inconclusiveReason(finding, names) {
  const sides = [['left', names.a], ['right', names.b]].filter(([key]) => UNKNOWN_ASSERTIONS.has(finding[key].assertion) || finding[key].state === 'unavailable');
  if (sides.length === 2) return finding.left.assertion === 'not-identifiable-from-retained-actions' ? 'The recorded actions can’t show this' : 'Not shown in either session’s records';
  if (sides.length === 1) return `Not shown in ${sides[0][1]}’s records`;
  if (!finding.eligibility?.eligible) return 'The task association wasn’t established';
  return 'The two records can’t be compared on this';
}

function presentFinding(finding, names) {
  const label = CLASSIFICATION[finding.classification] ?? 'cannot-compare';
  return { id: finding.id, rule: finding.rule, label, title: FINDING_TITLE[finding.rule] ?? finding.title,
    cells: [{ side: 'a', profile: names.a, text: observation(finding.left) }, { side: 'b', profile: names.b, text: observation(finding.right) }],
    caveat: finding.limitation, ...(label === 'cannot-compare' ? { reason: inconclusiveReason(finding, names) } : {}),
    refs: { a: list(finding.left.evidenceRefs).length, b: list(finding.right.evidenceRefs).length } };
}

/* ---------- Conditions and limits ---------- */

const CONDITION = {
  task: 'Opening task text', commit: 'Commit', tree: 'Project files at the start', nativeVersion: 'Codex version',
  models: 'Model', reasoningEffort: 'Reasoning effort', setup: 'Recorded profile setup', editableFiles: 'Files it may change',
};
const HASHED = new Set(['task', 'tree', 'setup']);
const valueText = (key, value) => value == null || (Array.isArray(value) && !value.length) ? 'Not recorded'
  : HASHED.has(key) ? 'Recorded' : key === 'commit' ? String(value).slice(0, 12) : Array.isArray(value) ? value.join(', ') : String(value);

const COVERAGE = {
  timeline: 'Recorded steps', agents: 'Subagents', skills: 'Skill use', usage: 'Token counts', tools: 'Tool use', mcp: 'MCP use',
  hooks: 'Hooks', workspaceDiff: 'File changes at the end', outcome: 'Outcome',
};
const COMPLETE = new Set(['complete', 'ready', 'observed', 'none-recorded', 'recorded', 'not-applicable']);
const coverageText = status => status === 'partial' ? 'partly recorded' : status === 'unavailable' ? 'not available' : 'not known';

const CLIENT_TEXT = { cli: 'Codex CLI', desktop: 'Codex Desktop' };

function sessionTime(run) {
  const first = list(run?.turns).map(turn => Date.parse(turn?.recordedAt)).filter(Number.isFinite).sort((x, y) => x - y)[0];
  if (!Number.isFinite(first)) return 'time not recorded';
  return new Date(first).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function duration(ms) {
  if (!Number.isFinite(ms)) return 'Not recorded';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function rootReplayTime(run) {
  const sessions = list(run?.sessionReplay?.sessions);
  if (!run?.sessionReplay) return null;
  const roots = sessions.filter(session => session?.parentId === null);
  if (roots.length !== 1) return { ms: null, scope: 'root-replay-events', note: roots.length
    ? 'The root replay is ambiguous, so no span is reported.' : 'The root session is unavailable, so no replay span is reported.' };
  const root = roots[0];
  const events = list(root?.events);
  const times = events.map(event => Date.parse(event?.timestamp)).filter(Number.isFinite);
  if (times.length < 2) return { ms: null, scope: 'root-replay-events', note: times.length === 1
    ? 'Only one root event timestamp is available; a span cannot be measured.'
    : 'Root event timestamps are unavailable.' };
  const partial = times.length < events.length;
  return { ms: Math.max(...times) - Math.min(...times), scope: 'root-replay-events', note: partial
    ? `First to last of ${times.length} timestamped root events (${events.length - times.length} without timestamps); not active working time.`
    : 'First to last recorded root event; not active working time.' };
}

function recordedSpanForRun(run, comparisonSpan, key) {
  const replaySpan = rootReplayTime(run);
  if (replaySpan) return { ...replaySpan, scope: replaySpan.scope === 'root-replay-events' ? 'Root replay event timestamps' : replaySpan.scope };
  const value = comparisonSpan?.[key];
  const basis = run?.metrics?.recordedSpanKind;
  const scope = basis === 'owned-turn-evidence' ? 'Recorded owned-turn events'
    : basis === 'source-recorded-span' ? 'Recorded source timestamps' : 'Recorded native-session activity';
  return { ms: value, scope: Number.isFinite(value) ? scope : 'Not available',
    note: Number.isFinite(value) ? 'First to last recorded native session activity; not active working time.' : 'Session timestamps do not establish a span.' };
}

const TOKEN_FIELDS = [['inputTokens', 'input'], ['cachedInputTokens', 'cached input'], ['outputTokens', 'output'], ['reasoningOutputTokens', 'reasoning'], ['totalTokens', 'total']];

function associationView(association, sameTaskLabel) {
  const status = association?.status;
  if (status === 'recorded') return { basis: 'recorded', title: ASSOCIATION.recorded.title, text: 'Both sessions recorded the same opening task. Later turns and project state may still differ.' };
  if (status === 'user-declared') return { basis: 'user-declared', title: ASSOCIATION['user-declared'].title,
    text: `You said these are the same task${sameTaskLabel ? ` (“${sameTaskLabel}”)` : ''}. That’s your statement, not proof the inputs matched.` };
  if (status === 'contradictory') return { basis: 'unknown', title: 'Different tasks recorded', text: 'The two sessions recorded different opening tasks. Findings are still shown, but they don’t compare the same work.' };
  return { basis: 'unknown', title: ASSOCIATION.unknown.title, text: 'The records don’t show whether both sessions got the same task. Findings are still shown; whether they come from the same task is unknown.' };
}

/* ---------- Reviews ---------- */

const VERDICT = { positive: 'positive', negative: 'negative', mixed: 'mixed', inconclusive: 'inconclusive', better: 'positive', worse: 'negative' };

/** Display shape for retained reviews; never averages or invents a verdict. */
export function presentReviews(reviews, names, runIds = {}) {
  const rows = list(reviews?.reviews);
  const current = new Set(list(reviews?.currentReviewIds));
  const prefers = row => !row.preferredRunId ? 'neither' : row.preferredRunId === runIds.a ? names.a : row.preferredRunId === runIds.b ? names.b : 'a run not in this pair';
  const card = row => ({ kind: row.reviewer?.type === 'ai' ? 'ai' : 'human', reviewer: [row.reviewer?.name, row.reviewer?.model].filter(Boolean).join(' · ') || 'Reviewer not named',
    verdict: VERDICT[row.conclusion] ?? 'inconclusive', prefers: prefers(row), quote: row.summary ?? '', basedOn: list(row.evidenceRefs).map(ref => ({ text: String(ref), href: null })),
    date: row.reviewedAt ? `Reviewed ${row.reviewedAt}` : 'Date not recorded' });
  const byScope = new Map();
  for (const row of rows) {
    const scope = row.scope ?? 'Overall';
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(row);
  }
  const topics = [...byScope.entries()].map(([scope, items]) => {
    const active = items.filter(row => current.has(row.id));
    const superseded = items.filter(row => !current.has(row.id));
    return { title: scope, meta: `${plural(active.length, 'review')}${superseded.length ? ` · ${plural(superseded.length, 'earlier version')}` : ''}`,
      disagreement: reviews?.disagreement && new Set(active.map(row => row.conclusion)).size > 1 ? 'The reviewers disagree. Both views are shown side by side, not combined into a score or a winner.' : null,
      notReviewed: false,
      reviews: active.map(row => {
        const earlier = superseded.find(old => old.id === row.supersedes);
        return { ...card(row), earlier: earlier ? { verdict: VERDICT[earlier.conclusion] ?? 'inconclusive', quote: earlier.summary ?? '', date: earlier.reviewedAt ? `${earlier.reviewedAt} · kept for the record` : 'kept for the record' } : null };
      }) };
  });
  const checks = list(reviews?.supplementalChecks).map(row => ({ status: row.status === 'passed' ? 'success' : row.status === 'failed' ? 'error' : 'neutral',
    text: `${row.name ?? 'Check'}: ${row.status ?? 'unknown'}`, by: `on ${row.runId === runIds.a ? names.a : row.runId === runIds.b ? names.b : 'another run'}’s result${row.checkedAt ? ` · ${row.checkedAt}` : ''}` }));
  return { topics, checksAfter: checks, reviewed: rows.length > 0 };
}

/* ---------- Comparison report ---------- */

/**
 * Build the plain-language report for an `audit-comparison`. `names` lets the
 * caller use profile names; `title` is a task label the caller may know.
 */
export function presentTaskEndPatch(run) {
  const snapshot = run?.workspace?.taskEnd;
  const patch = projectAuditWorkspacePatch(snapshot?.patchContent, {
    taskEndFingerprint: snapshot?.fingerprint, baselineFingerprint: snapshot?.baselineFingerprint, sourcePatchSha256: snapshot?.patchSha256,
  });
  if (!patch) return { status: 'unavailable', text: null, note: 'Task-end patch unavailable: this capture did not retain patch content.', sourceCommit: null };
  const reasons = {
    'recorded-content-not-included': 'Patch content was omitted from this export.',
    'binary-content': 'The captured patch contains binary data and cannot be shown as text.',
    'size-limit': 'The captured patch exceeds the 256 KiB text limit; no partial patch is shown.',
    'invalid-utf8': 'The captured patch is not valid UTF-8 text.',
    'unsafe-redaction': 'The captured patch could not be safely redacted.',
    'no-changes': 'The captured patch contains no changes against the source baseline.',
    'source-baseline-unavailable': 'The source baseline for this patch is unavailable.',
  };
  return { status: patch.status, text: patch.status === 'available' ? patch.text : null,
    sourceCommit: patch.sourceBaseline?.commit ?? null,
    note: patch.status === 'available'
      ? `${snapshot.timing === 'after-process-fallback' ? 'Captured after the process ended; exact task-end timing is not established. ' : snapshot.timing !== 'task-end' || snapshot.captureComplete !== true ? 'Task-end capture boundary is unverified. ' : ''}${patch.captureProvenance === 'verified-retained-artifact' ? 'Added from a verified retained snapshot to this new report. ' : ''}Captured task-end patch against the source baseline; may include setup changes. Known secret patterns are redacted. Ignored file contents and unchanged source files are not included.`
      : reasons[patch.reason] ?? `Patch content unavailable (${patch.reason ?? 'reason not recorded'}).` };
}

export function presentComparison(value, { title, reviews, sameTaskLabel } = {}) {
  const left = value.left ?? {}, right = value.right ?? {};
  const explanation = value.comparison?.explanation ?? buildAuditExplanation(left, right, retainedAuditSelectionOptions(value.selection));
  const c = gateAuditComparisonDeltas(value.comparison ?? {}, explanation.conditions);
  const names = {
    a: left.profile?.profileName ?? value.selection?.left?.profileName ?? 'Left',
    b: right.profile?.profileName ?? value.selection?.right?.profileName ?? 'Right',
  };
  const executions = [left, right].map(presentRunExecution);
  const notStarted = executions.every(item => item.state === 'not-started');
  const completed = executions.every(item => item.state === 'completed');
  if (names.a === names.b) { names.a = `${names.a} (left)`; names.b = `${names.b} (right)`; }
  const nativeClient = run => run.clientIdentity?.client ?? run.nativeReference?.client ?? run.profile?.client ?? null;
  const clientText = (key, run) => ({ 'claude-code': 'Claude Code CLI', copilot: 'GitHub Copilot CLI' }[nativeClient(run)]
    ?? CLIENT_TEXT[run.source?.client ?? value.selection?.[key]?.client] ?? (nativeClient(run) === 'codex' ? 'Codex CLI' : 'Client not known'));
  const side = (key, run) => {
    const readContext = run.source?.readContext;
    const context = readContext ?? run.environmentBinding ?? run.profile;
    const surface = readContext?.surface ?? run.clientIdentity?.surface ?? context?.surface;
    const executionLocation = readContext?.executionLocation ?? run.clientIdentity?.executionLocation ?? context?.executionLocation;
    const provenance = readContext || run.clientIdentity || run.environmentBinding ? {
      basis: readContext ? 'Import read context' : 'Execution context',
      ...(typeof readContext?.profileName === 'string' ? { profileName: readContext.profileName } : {}),
      surface: ['cli', 'desktop'].includes(surface) ? surface : null,
      rootMode: ['implicit', 'explicit'].includes(context?.rootMode) ? context.rootMode : null,
      executionLocation: ['local', 'ssh', 'cloud'].includes(executionLocation) ? executionLocation : null,
    } : null;
    const settings = run.settingsEvidence;
    const permission = source => {
      const mode = source?.permissionMode;
      return typeof mode === 'string' ? mode : typeof mode?.value === 'string' ? mode.value : null;
    };
    const auto = nativeClient(run) === 'copilot' && (settings?.requested?.model === 'auto' || settings?.confirmed?.model === 'auto'
      || settings?.observed?.route === 'auto' || list(run.usage?.observations).some(row => row.auto === true));
    const autoTurns = auto ? list(run.turns).map(turn => {
      const models = list(run.usage?.observations).filter(row => row.turnId === turn.turnId).map(row => row.model);
      if (turn.model) models.push(turn.model);
      if (!models.some(Boolean) && settings?.observed?.model && turn.turnId === run.nativeReference?.turnId) models.push(settings.observed.model);
      return { turnId: turn.turnId, models: [...new Set(models.filter(model => model && model !== 'auto'))] };
    }) : null;
    return { side: key === 'left' ? 'a' : 'b', profile: key === 'left' ? names.a : names.b,
      client: clientText(key, run), nativeClient: nativeClient(run), time: sessionTime(run),
      session: run.nativeReference?.sessionId ?? run.source?.nativeSessionId ?? value.selection?.[key]?.sessionId ?? run.id ?? 'not recorded',
      provenance,
      permissions: settings ? { requested: permission(settings.requested), sent: permission(settings.sent),
        confirmed: permission(settings.confirmed), observed: permission(settings.observed) } : null,
      autoTurns,
    };
  };
  const rootContext = run => {
    const rootId = run.source?.threadId ?? run.source?.nativeSessionId;
    const roots = list(run.agents).filter(agent => agent.parentId === null
      && (rootId ? agent.id === rootId : agent.role === 'root'));
    const root = roots.length === 1 ? roots[0] : null;
    const setup = root?.source?.recordedSetup ?? (root && root.id === rootId ? run.source?.recordedSetup : null);
    const nativeValue = key => {
      if (setup?.source !== 'native-turn-context' || !['observed', 'partial'].includes(setup.status)) return null;
      const values = [...new Set(list(setup[key]).filter(value => typeof value === 'string' && value.trim()))];
      // Keep all recorded root values; never select a child's or a single turn's setting.
      return values.length > 1 ? `Multiple recorded: ${values.join(', ')}` : values[0] ?? null;
    };
    const actualModel = root?.model ?? run.source?.model ?? nativeValue('model') ?? run.capture?.effectiveSettings?.model;
    const actualEffort = root?.reasoningEffort ?? run.source?.reasoningEffort ?? nativeValue('effort') ?? run.capture?.effectiveSettings?.reasoningEffort;
    const selected = run.profile?.execution ?? run.comparisonConditions?.requestedExecution;
    const requested = run.nativeControls?.configured ?? {};
    return {
      model: valueText('model', actualModel), effort: valueText('reasoningEffort', actualEffort),
      requestedModel: selected ? selected.model ?? 'Profile default' : actualModel == null && requested.model != null ? valueText('model', requested.model) : null,
      requestedEffort: selected ? selected.reasoningEffort ?? 'Profile default' : actualEffort == null && requested.modelReasoningEffort != null ? valueText('reasoningEffort', requested.modelReasoningEffort) : null,
    };
  };

  const findings = explanation.findings.map(finding => presentFinding(finding, names));
  const primary = findings.filter(f => f.label !== 'cannot-compare');
  const observedInconclusive = findings.filter(f => f.label === 'cannot-compare' && (f.refs.a || f.refs.b));
  const shown = [...primary, ...observedInconclusive].slice(0, Math.max(3, primary.length));
  const more = findings.filter(f => !shown.includes(f));

  const conditions = explanation.conditions;
  const declared = new Set(list(conditions.userDeclaredVariables));
  const rows = conditions.fields.map(field => ({ key: field.key, name: CONDITION[field.key] ?? field.key,
    label: field.status === 'different' ? 'different' : field.status === 'match' ? 'same' : 'cannot-compare',
    a: valueText(field.key, field.left), b: valueText(field.key, field.right) }));
  const clientNames = [clientText('left', left), clientText('right', right)];
  rows.push({ key: 'client', name: 'Client', label: clientNames.includes('Client not known') ? 'cannot-compare' : clientNames[0] === clientNames[1] ? 'same' : 'different',
    a: clientNames[0], b: clientNames[1] });
  const differing = rows.filter(row => row.label === 'different').map(row => ({ ...row, intent: declared.has(row.name) ? 'intended' : 'not-marked' }));
  const same = rows.filter(row => row.label === 'same').length, unknown = rows.filter(row => row.label === 'cannot-compare').length;

  const sides = [side('left', left), side('right', right)];
  const limits = [];
  if (nativeClient(left) && nativeClient(right) && nativeClient(left) !== nativeClient(right))
    limits.push('These sides use different native permission rules.');
  if (sides.some(side => side.autoTurns))
    limits.push('Copilot Auto can select a different model per turn. This pair may not be reproducible.');
  if (!['recorded', 'user-declared'].includes(explanation.conditions.taskAssociation?.status))
    limits.push('Whether both sessions got the same task — the records don’t show it.');
  for (const key of Object.keys(COVERAGE)) {
    const states = ['left', 'right'].map(sideKey => (sideKey === 'left' ? left : right).coverage?.[key]);
    const gaps = states.map((state, index) => state && !COMPLETE.has(state) ? `${coverageText(state)} for ${index ? names.b : names.a}` : null).filter(Boolean);
    if (gaps.length) limits.push(`${COVERAGE[key]}: ${gaps.join(', ')}.`);
  }
  const fullSetup = [left, right].some(run => run.source?.recordedSetup?.fullHistoricalSetup === 'unavailable');
  if (fullSetup) limits.push('The full setup each session ran with — only the model and reasoning effort are recorded per turn. Today’s setup is a separate snapshot.');
  limits.push('Environment and cache state — Codex doesn’t record them.');
  limits.push('Whether these differences repeat — this is one pair, so consistency is unmeasured.');

  const verification = ['left', 'right'].map(key => {
    const run = key === 'left' ? left : right;
    const captureFailures = knownCaptureFailures(run);
    const taskDidNotStart = captureFailures.some(failure => failure.code === 'startup-command-sandbox-unavailable'
      && failure.text === CAPTURE_FAILURE_TEXT['startup-command-sandbox-unavailable']);
    const v = explanation.verification[key];
    const claim = v.agentClaim;
    const claimText = !claim ? 'No structured success assessment was recorded.' : claim.success === true ? 'The agent said it succeeded.'
      : claim.success === false ? 'The agent said it didn’t succeed.' : 'Its final message was recorded, but it doesn’t say whether the task succeeded.';
    const checks = list(v.checks).map(check => ({ status: check.status === 'passed' ? 'success' : check.status === 'failed' ? 'error' : 'neutral',
      text: `${check.status === 'passed' ? 'Your check' : check.status === 'failed' ? 'Your check' : 'Check'} (${check.name}) ${check.status === 'passed' ? 'passed' : check.status === 'failed' ? 'failed' : `: ${check.status ?? 'not run'}`}` }));
    const selected = list((key === 'left' ? left : right).comparisonConditions?.checkRecipes);
    for (const recipe of selected) if (!v.checks.some(check => check.name === recipe.name))
      checks.push({ status: 'neutral', text: taskDidNotStart
        ? `Your check (${recipe.name}) was skipped because the model task did not start.`
        : `Your check (${recipe.name}) was selected; no result was recorded.` });
    if (!checks.length) checks.push({ status: 'neutral', text: 'No check result was recorded.' });
    return { side: key === 'left' ? 'a' : 'b', profile: key === 'left' ? names.a : names.b, claim: claimText, checks,
      executionFailures: captureFailures.map(failure => failure.text) };
  });
  const noResults = explanation.verification.left.checks.length === 0 && explanation.verification.right.checks.length === 0;
  const noChecks = noResults && !list(left.comparisonConditions?.checkRecipes).length && !list(right.comparisonConditions?.checkRecipes).length;
  const review = presentReviews(reviews, names, { a: left.id, b: right.id });

  const span = c.metrics?.recordedSpanMs;
  const recordedSpan = {
    left: recordedSpanForRun(left, span, 'left'),
    right: recordedSpanForRun(right, span, 'right'),
  };
  const workflowMeasurements = { a: presentWorkflowMeasurements(left), b: presentWorkflowMeasurements(right) };
  const workflowValue = measurement => measurement.usageStatus === 'validated'
    ? measurement.counters.total.toLocaleString('en-GB')
    : ['unvalidated', 'partial'].includes(measurement.usageStatus) ? 'Not validated' : 'Unavailable';
  const leftTokens = c.usage?.left?.values, rightTokens = c.usage?.right?.values;
  const timeRows = [
    { name: 'Recorded time span', a: duration(recordedSpan.left.ms), b: duration(recordedSpan.right.ms),
      scope: { a: recordedSpan.left.scope, b: recordedSpan.right.scope },
      caveat: [recordedSpan.left.note, recordedSpan.right.note].filter((note, index, notes) => notes.indexOf(note) === index).join(' ')
        + (span?.status === 'ineligible' ? ' The same task is not established, so the durations are not compared.' : '') },
    { name: 'Runner task phase', a: duration(c.metrics?.taskMs?.left), b: duration(c.metrics?.taskMs?.right),
      scope: { a: 'Runner task and capture phase', b: 'Runner task and capture phase' },
      caveat: 'Local wall time for the task and capture, including startup and shutdown. Excludes setup and verification checks; not active working time.' },
    ...TOKEN_FIELDS.map(([key, name], index) => ({ name: `Main-session ${name} tokens`, scope: { a: 'Codex-reported root session', b: 'Codex-reported root session' },
      a: Number.isFinite(leftTokens?.[key]) ? leftTokens[key].toLocaleString('en-GB') : 'Not recorded',
      b: Number.isFinite(rightTokens?.[key]) ? rightTokens[key].toLocaleString('en-GB') : 'Not recorded',
      ...(index === TOKEN_FIELDS.length - 1 ? { caveat: 'As counted by Codex for the main session only.' } : {}) })),
    { name: 'Total for the whole workflow', scope: { a: 'Whole workflow', b: 'Whole workflow' },
      a: workflowValue(workflowMeasurements.a), b: workflowValue(workflowMeasurements.b),
      caveat: [...new Set([workflowMeasurements.a.usageNote, workflowMeasurements.b.usageNote])].join(' ') },
    { name: 'Validated captured-session tokens', scope: { a: 'Captured sessions only', b: 'Captured sessions only' },
      a: workflowMeasurements.a.counters.total?.toLocaleString('en-GB') ?? 'Not recorded',
      b: workflowMeasurements.b.counters.total?.toLocaleString('en-GB') ?? 'Not recorded',
      caveat: 'Each independently owned session is counted once. Missing sessions remain unknown; this is not billed cost.' },
  ];

  const artifacts = side => list(c.artifacts?.[side]?.artifacts).filter(item => item.kind === 'recorded-file-change' && item.path)
    .map(item => {
      const run = side === 'left' ? left : right;
      const root = run.sourceWorkspace?.directory ?? run.source?.workspace;
      if (!path.isAbsolute(item.path) || typeof root !== 'string' || !path.isAbsolute(root)) return item;
      const relative = path.relative(root, item.path);
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        ? { ...item, path: relative.split(path.sep).join('/') } : item;
    });
  const inventories = Object.fromEntries(['left', 'right'].map(key => {
    const snapshot = c.artifacts?.snapshots?.taskEnd?.[key];
    const inventory = snapshot?.captureComplete === true && snapshot?.timing === 'task-end'
      ? projectAuditFileInventory(snapshot.changeInventory, { postSetupFingerprint: snapshot.baselineFingerprint,
        taskEndFingerprint: snapshot.fingerprint, changedFileCount: snapshot.changedFileCount }) : null;
    return [key, inventory?.status === 'recorded' ? inventory : null];
  }));
  const fileStatus = { added: 'Added', modified: 'Changed', deleted: 'Deleted' };
  const entriesFor = key => inventories[key]?.entries ?? artifacts(key).map(item => ({ path: item.path,
    change: item.status === 'add' ? 'added' : item.status === 'delete' ? 'deleted' : 'modified', origin: 'observed' }));
  const entries = Object.fromEntries(['left', 'right'].map(key => [key, new Map(entriesFor(key).map(item => [item.path, item]))]));
  const paths = [...new Set([...entries.left.keys(), ...entries.right.keys()])].sort();
  const files = paths.map(path => {
    const l = entries.left.get(path), r = entries.right.get(path);
    const origins = [...new Set([l?.origin, r?.origin].filter(Boolean))];
    const category = origins.length === 1 ? origins[0] : 'mixed';
    const cell = (item, key) => item ? `${fileStatus[item.change]}${category === 'mixed' ? ` · ${item.origin}` : ''}`
      : inventories[key] ? 'Not changed' : 'Not recorded';
    return { path, a: cell(l, 'left'), b: cell(r, 'right'), category };
  });
  const changeText = (key, name) => {
    const inventory = inventories[key];
    if (!inventory) return `${name}: ${plural(entries[key].size, 'observed file path')}; complete task-end inventory unavailable`;
    return `${name}: ${plural(inventory.counts.tracked, 'tracked file')} · ${inventory.counts.ignored} ignored ${inventory.counts.ignored === 1 ? 'file or artifact' : 'files or artifacts'}`;
  };
  const outcomeSummary = `${changeText('left', names.a)}. ${changeText('right', names.b)}.`;
  const fileScopeNote = ['left', 'right'].map(key => inventories[key]
    ? `${key === 'left' ? names.a : names.b}: counts and rows use the same post-setup to task-end snapshot inventory.`
    : `${key === 'left' ? names.a : names.b}: only observed edit paths are listed; missing paths do not establish no change.`).join(' ')
    + ' Ignored file inventory does not imply captured file contents.';

  // Count the distinct actions that the paired findings can actually show.
  // Findings may cite the same action more than once, and named actions are
  // presented alongside the generic timeline actions below.
  const evidenceCounts = ['left', 'right'].map(sideName => {
    const actions = [...list(explanation.evidence[sideName]), ...list(explanation.evidence.namedActions?.[sideName])];
    const available = new Set(actions.map(action => action.id));
    const cited = new Set(list(explanation.findings).flatMap(finding => list(finding[sideName]?.evidenceRefs)));
    return [...cited].filter(id => available.has(id)).length;
  });
  return {
    title: title || 'Session comparison',
    a: sides[0], b: sides[1],
    replayRootContext: { a: rootContext(left), b: rootContext(right) },
    replay: { a: left.sessionReplay ?? null, b: right.sessionReplay ?? null },
    attempt: {
      title: notStarted ? 'Neither model task started' : completed ? 'Both model tasks completed'
        : executions.some(item => item.state === 'failed') ? 'One or both model tasks failed or stopped' : 'Task completion is incomplete or unknown',
      text: notStarted ? 'This attempt has no model work to compare. Actions, agent claims and model token usage are unavailable because the tasks did not start.'
        : completed ? 'Completion is recorded for both profiles. Verification checks and evidence coverage are separate from task completion.'
          : 'Read the per-profile task states before interpreting the findings and measurements.',
      notStarted,
      cells: executions.map((item, index) => ({ side: index ? 'b' : 'a', profile: index ? names.b : names.a,
        ...item, detail: knownCaptureFailures(index ? right : left).map(failure => failure.text).join(' ') })),
    },
    association: { ...associationView(explanation.conditions.taskAssociation, sameTaskLabel),
      ...(notStarted && explanation.conditions.taskAssociation?.status === 'recorded'
        ? { text: 'The same task was prepared for both profiles; neither model task started.' } : {}) },
    counts: countLabels(findings),
    summaryLine: `Verification: ${noChecks ? 'no independent check was recorded' : notStarted ? 'checks not run; model tasks did not start' : noResults ? 'checks selected; no results recorded' : 'checks recorded'} · Reviews: ${review.reviewed ? 'attached' : 'not reviewed'} · One pair, so whether this repeats is unmeasured.`,
    conditions: { rows: differing, allRows: rows,
      scopeNote: 'Model and reasoning effort summarize recorded turns across the captured actors. Root values are shown separately.'
        + ([left, right].some(run => run.comparisonConditions?.sharedProfileOverlap) ? ' Other jobs were observed on the same profile. Timing reflects shared conditions.' : ''),
      footer: `${plural(same, 'condition')} the same · ${unknown} not recorded`,
      all: rows.map(row => ({ label: row.name, value: row.a === row.b ? `${row.a} on both` : `${names.a}: ${row.a} · ${names.b}: ${row.b}` })) },
    limits,
    findings: shown, moreFindings: { text: `View all findings · ${more.length} more that the records can’t show or compare`, items: more },
    evidence: { rows: [
      { name: 'Referenced steps', a: evidenceCounts[0] ? plural(evidenceCounts[0], 'distinct referenced step') : 'No referenced action steps to show',
        b: evidenceCounts[1] ? plural(evidenceCounts[1], 'distinct referenced step') : 'No referenced action steps to show',
        caveat: 'Distinct referenced steps, counted once. Each session keeps its own order; steps are not matched one to one.' },
      { name: 'Observed tool invocations', a: Number.isSafeInteger(c.tools?.left?.observedCount) ? `${c.tools.left.observedCount} retained` : 'Not recorded',
        b: Number.isSafeInteger(c.tools?.right?.observedCount) ? `${c.tools.right.observedCount} retained` : 'Not recorded',
        caveat: 'Retained invocation metadata, not a complete activity count or proof of named reads and tests.' },
    ], cells: evidenceCounts.map((count, index) => ({ side: index ? 'b' : 'a', profile: index ? names.b : names.a,
      text: count ? plural(count, 'distinct referenced step') : 'No referenced action steps to show' })),
      summary: `${names.a}: ${evidenceCounts[0] ? plural(evidenceCounts[0], 'distinct referenced step') : 'no referenced action steps to show'} · ${names.b}: ${evidenceCounts[1] ? plural(evidenceCounts[1], 'distinct referenced step') : 'no referenced action steps to show'}. A step cited by multiple findings is counted once. Steps are listed in each session’s own order and aren’t matched one to one.` },
    verification: { cells: verification, rows: presentCheckRows(left, right, explanation.verification.left.checks, explanation.verification.right.checks), none: noChecks, reviews: { text: review.reviewed ? `${plural(list(reviews?.reviews).length, 'review')} attached` : 'Not reviewed', reviewed: review.reviewed } },
    agentMeasurements: { a: presentAgentMeasurements(left), b: presentAgentMeasurements(right) },
    workflowMeasurements,
    timeTokens: { rows: timeRows, footer: 'Not cost, and less time or fewer tokens don’t mean better work.' },
    outcome: { summary: outcomeSummary, cells: [changeText('left', names.a), changeText('right', names.b)], files, code: null,
      patches: { a: presentTaskEndPatch(left), b: presentTaskEndPatch(right) },
      scopeNote: fileScopeNote },
    consistency: explanation.consistency,
    conclusion: value.comparison?.conclusion ?? 'Observed differences do not establish causality or a winner.',
  };
}

/* ---------- Paired evidence ---------- */

function stepText(action) {
  switch (action.kind) {
    case 'file-change': return action.path
      ? `${action.status === 'add' ? 'Added' : action.status === 'delete' ? 'Deleted' : 'Changed'} ${action.path}`
      : 'File-change event (file path not recorded)';
    case 'read': return 'Read a file (which one isn’t recorded)';
    case 'resource-read': return `Read ${action.resource?.name ?? 'a skill file'}`;
    case 'resource-invocation': return `Used ${action.resource?.name ?? 'a skill'}`;
    case 'tool': return action.tool?.kind === 'command' ? `Ran a command${Number.isSafeInteger(action.exitCode) ? ` (exit ${action.exitCode})` : ''}`
      : `Called ${[action.tool?.serverName, action.tool?.toolName].filter(Boolean).join(' › ') || 'a tool'}`;
    default: return action.kind;
  }
}
function namedText(action) {
  const targets = list(action.targets).join(', ');
  if (action.kind === 'read') return `Read ${targets || 'a named file'}`;
  if (action.kind === 'edit') return `Edited ${targets || 'a named file'}`;
  if (action.kind === 'visible-test') return `Ran test ${targets}`.trim() + (action.exitCode === 0 ? '; it passed' : Number.isSafeInteger(action.exitCode) ? '; it failed' : '');
  if (action.kind === 'inline-assertion') return 'Ran inline assertions';
  return action.name ?? action.kind;
}

/** Steps per finding, in each session's own recorded order; never aligned across sides. */
export function presentEvidence(value) {
  const left = value.left ?? {}, right = value.right ?? {};
  const explanation = value.comparison?.explanation ?? buildAuditExplanation(left, right, retainedAuditSelectionOptions(value.selection));
  const report = presentComparison(value);
  const turnNumber = run => {
    const order = new Map();
    list(run.turns).forEach((turn, index) => { if (!order.has(turn.turnId)) order.set(turn.turnId, index + 1); });
    return turnId => order.get(turnId);
  };
  const turns = { left: turnNumber(left), right: turnNumber(right) };
  const ref = (key, action) => {
    const turn = turns[key](action.turnId);
    return [turn ? `Turn ${turn}` : null, action.sourceLine ? `history line ${action.sourceLine}` : null].filter(Boolean).join(' · ') || 'Reference not recorded';
  };
  const actionsFor = key => [...explanation.evidence[key].map(action => ({ action, text: stepText(action) })),
    ...list(explanation.evidence.namedActions?.[key]).map(action => ({ action, text: namedText(action) }))]
    .sort((x, y) => (x.action.sourceLine ?? Infinity) - (y.action.sourceLine ?? Infinity));
  const all = { left: actionsFor('left'), right: actionsFor('right') };
  const findings = explanation.findings.map(finding => {
    const presented = presentFinding(finding, { a: report.a.profile, b: report.b.profile });
    const column = key => {
      const cited = new Set(list(finding[key].evidenceRefs));
      const other = list(finding[key === 'left' ? 'right' : 'left'].evidenceRefs).length;
      const citedActions = [...new Map(all[key].filter(({ action }) => cited.has(action.id)).map(row => [row.action.id, row])).values()];
      const actionIds = new Set(citedActions.map(({ action }) => action.id));
      const steps = citedActions.slice(0, MAX_PRESENTED_STEPS).map(({ action, text }) => ({ text, ref: ref(key, action), kind: other ? 'cited' : 'alone' }));
      const unresolved = [...cited].filter(id => !id.startsWith('session-evidence:') && !actionIds.has(id)).length;
      const omitted = Math.max(0, citedActions.length - steps.length);
      const meta = [
        omitted ? `Showing first ${steps.length} of ${plural(citedActions.length, 'referenced step')}; ${plural(omitted, 'step')} not shown`
          : steps.length ? plural(citedActions.length, 'step')
            : unresolved ? 'No steps shown; cited action references are unavailable' : 'No action steps referenced',
        unresolved ? `${plural(unresolved, 'cited action reference')} unavailable` : null,
      ].filter(Boolean).join(' · ');
      return { side: key === 'left' ? 'a' : 'b', profile: key === 'left' ? report.a.profile : report.b.profile,
        meta, total: citedActions.length, steps };
    };
    const columns = [column('left'), column('right')];
    const different = presented.label === 'different';
    return { id: finding.id, label: presented.label, title: presented.title, counts: { a: columns[0].total, b: columns[1].total },
      sentence: { text: `{a}: ${presented.cells[0].text} {b}: ${presented.cells[1].text}${different ? '' : ` ${presented.reason ?? ''}`}`.trim(), a: report.a.profile, b: report.b.profile },
      columns };
  });
  return { findings, explanation: 'Steps are listed in the order each session recorded them. Steps on the same line aren’t matched to each other, and the two sessions’ clocks aren’t aligned.',
    refsNote: 'References point to lines in each session’s own history. Commands, file contents and conversation text aren’t shown. A saved report keeps these references, so each step can be checked after the original history is gone.' };
}

/* ---------- Markdown ---------- */

/** Plain-language lines that open each Markdown/terminal report section. */
export function comparisonSummaryLines(report) {
  const row = text => `  ${text}`;
  const labelOf = label => LABEL_TEXT[label];
  return {
    conditions: [
      `${report.a.profile} (${report.a.client}, ${report.a.time}) vs ${report.b.profile} (${report.b.client}, ${report.b.time}).`,
      ...[report.a, report.b].flatMap(side => [
        ...(side.provenance ? [row(`${side.profile} · ${side.provenance.basis} · ${[side.provenance.profileName, side.provenance.surface,
          side.provenance.rootMode, side.provenance.executionLocation].filter(Boolean).join(' · ')}`)] : []),
        ...(side.permissions ? [row(`${side.profile} permission mode · requested ${side.permissions.requested ?? 'inherited'} · sent ${side.permissions.sent ?? 'not recorded'} · confirmed ${side.permissions.confirmed ?? 'not recorded'} · turn reported ${side.permissions.observed ?? 'not recorded'}`)] : []),
        ...list(side.autoTurns).map((turn, index) => row(`${side.profile} Auto turn ${index + 1} · ${turn.models.join(', ') || 'model not recorded'}`)),
      ]),
      `${report.association.title}. ${report.association.text}`,
      ...report.conditions.rows.map(r => row(`${r.name}: ${report.a.profile} ${r.a} → ${report.b.profile} ${r.b} · ${r.intent === 'intended' ? 'you meant to vary this' : 'not marked as intended'}`)),
      row(report.conditions.footer), 'Technical detail:',
    ],
    limits: report.limits.map(text => `- ${text}`),
    findings: [...report.findings, ...report.moreFindings.items].flatMap(f => [
      `- ${labelOf(f.label)}: ${f.title}${f.reason ? ` (${f.reason})` : ''}`,
      ...f.cells.map(cell => row(`${cell.profile}: ${cell.text}`)), row(`Limit: ${f.caveat}`)]).concat('Technical detail:'),
    evidence: [report.evidence.summary],
    replay: ['Inspect the retained session replay in the JSON companion. Source event identities and capture limits are preserved.'],
    verification: [...report.verification.cells.flatMap(cell => [`- ${cell.profile}: ${cell.claim}`,
      ...(cell.executionFailures ?? []).map(failure => row(`Execution failure: ${failure}`)), ...cell.checks.map(check => row(check.text))]),
      report.verification.none ? 'No verification checks selected.' : '', `Reviews: ${report.verification.reviews.text}.`].filter(Boolean).concat('Technical detail:'),
    time: report.timeTokens.rows.map(r => `- ${r.name}: ${report.a.profile} ${r.a} · ${report.b.profile} ${r.b}.${r.caveat ? ` ${r.caveat}` : ''}`).concat(
      ['a', 'b'].flatMap(side => (report.agentMeasurements?.[side] ?? []).map(agent =>
        `- ${report[side].profile} / ${agent.name} (${agent.id}): observed span ${duration(agent.durationMs)}; reported tokens ${Object.entries(agent.counters).map(([key, count]) => `${key}=${count ?? 'not recorded'}`).join(', ')}. ${agent.timingNote} ${agent.usageNote}`)),
      'Agent spans overlap; do not sum them as elapsed workflow time. Cached input and reasoning counters are subsets.', report.timeTokens.footer, 'Technical detail:'),
    outcome: [report.outcome.summary, report.outcome.scopeNote, ...report.outcome.files.map(file => `- ${file.path} (${file.category}): ${report.a.profile} ${file.a} · ${report.b.profile} ${file.b}`), 'Technical detail:'],
  };
}

/* ---------- Setup comparison ---------- */

const SETUP_GROUP = [
  ['settings', 'Settings', item => ['config', 'feature', 'setting'].includes(item.category) && !/^memor/i.test(item.name ?? '')],
  ['instructions', 'Instructions, agents and rules', item => ['instruction', 'agent', 'rule'].includes(item.category)],
  ['skills', 'Skills', item => item.category === 'skill'],
  ['integrations', 'MCP, plugins and hooks', item => ['mcp', 'plugin', 'hook'].includes(item.category)],
  ['tools', 'Tools', item => item.category === 'tool'],
  ['memory', 'Memory settings', item => /^memor/i.test(item.name ?? '') || item.category === 'memory'],
];
const COPYABLE = new Set(['config', 'instruction', 'agent', 'rule', 'skill']);
const SCOPE_TEXT = { profile: 'Profile', user: 'User', project: 'Project', system: 'Codex client', plugin: 'From a plugin', admin: 'Administrator' };
const COVERAGE_AREA = { client: 'Client settings', config: 'Profile config', instructions: 'Instructions', agents: 'Agents', skills: 'Skills', rules: 'Rules',
  plugins: 'Plugins', mcp: 'MCP servers', hooks: 'Hooks', tools: 'Tools', memorySettings: 'Memory settings', system: 'Codex built-ins', project: 'Project', sourceValues: 'Displayed source values' };
const READ_TEXT = { complete: 'Read in full', partial: 'Partly read', unavailable: 'Couldn’t be read', unknown: 'Not known', 'not-applicable': 'Not applicable' };

const shortValue = value => value === undefined || value === null ? 'Not set'
  : typeof value === 'object' ? JSON.stringify(value) : String(value);
const tildePath = (path, home) => typeof path === 'string' && home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;

function setupState(bucket, resource) {
  if (resource.status === 'not-applicable') return 'not-applicable';
  if (bucket === 'added') return 'added';
  if (bucket === 'removed') return 'removed';
  if (bucket === 'changed') return 'changed';
  if (bucket === 'unchanged') return 'identical';
  if (resource.status === 'redacted' || resource.valueStatus === 'redacted' || resource.left?.valueStatus === 'redacted') return 'redacted';
  if (resource.comparison === 'partial') return 'partial';
  if (['unavailable', 'unreadable', 'denied'].includes(resource.status)) return 'unavailable';
  return 'unknown';
}

function hunkLines(hunks) {
  const lines = [];
  for (const hunk of hunks) {
    const label = hunk.path && hunk.path !== 'content' ? `${hunk.path}` : null;
    if (hunk.kind === 'content-changed') { lines.push({ kind: '~', text: `${label ?? 'file'}: full file contents differ${Number.isFinite(hunk.left?.bytes) && Number.isFinite(hunk.right?.bytes) ? ` (${hunk.left.bytes} → ${hunk.right.bytes} bytes)` : ''}` }); continue; }
    if (hunk.kind === 'metadata-changed') { lines.push({ kind: '~', text: `${label ?? 'file'}: permissions ${(hunk.left?.mode ?? 0).toString(8)} → ${(hunk.right?.mode ?? 0).toString(8)}` }); continue; }
    if (hunk.kind === 'unknown') { lines.push({ kind: '~', text: `${label ?? 'value'}: ${hunk.reason ?? 'not comparable'}` }); continue; }
    if (label && hunks.length > 1) lines.push({ kind: ' ', text: `${label}` });
    const as = value => Array.isArray(value) ? value.map(shortValue) : value === undefined ? [] : [shortValue(value)];
    for (const text of as(hunk.left)) lines.push({ kind: '-', text });
    for (const text of as(hunk.right)) lines.push({ kind: '+', text });
  }
  return lines.slice(0, 400);
}

function setupSummary(state, item, names, hunks) {
  const different = ['changed', 'added', 'removed'].includes(state);
  if (state === 'added') return [{ text: 'only in ' }, { text: names.b, side: 'b' }];
  if (state === 'removed') return [{ text: 'only in ' }, { text: names.a, side: 'a' }];
  if (state === 'changed') {
    const l = item.left?.value, r = item.right?.value;
    if (l !== undefined && r !== undefined && typeof l !== 'object' && typeof r !== 'object')
      return [{ text: shortValue(l), side: 'a' }, { text: ' → ' }, { text: shortValue(r), side: 'b' }];
    const files = new Set(hunks.map(h => h.path).filter(path => path && path !== 'content' && path !== 'value'));
    if (files.size) return [{ text: `${files.size} ${files.size === 1 ? 'file' : 'files'} differ` }];
    const removed = hunks.reduce((n, h) => n + (Array.isArray(h.left) ? h.left.length : 0), 0), added = hunks.reduce((n, h) => n + (Array.isArray(h.right) ? h.right.length : 0), 0);
    if (removed || added) return [{ text: `−${removed}`, side: 'a' }, { text: ' ' }, { text: `+${added}`, side: 'b' }, { text: ' lines' }];
    return [{ text: 'contents differ' }];
  }
  if (!different && item.value !== undefined && state === 'identical') return [{ text: shortValue(item.value) }];
  return [{ text: state === 'identical' ? 'same' : item.reason ?? exactStateText(state, names) }];
}

const SETUP_NOTE = {
  config: 'This is the configured value. Whether a session used it isn’t known from setup alone; a project setting or launch option can override it.',
  feature: 'This is the configured value. Whether a session used it isn’t known from setup alone.',
  instruction: 'Instructions differ in what was read. Which instructions a session loads isn’t known from setup alone.',
  agent: 'Agent definitions as configured; whether a session used them isn’t known from setup alone.',
  rule: 'Rules as configured; whether Codex enforced them in a session isn’t known from setup alone.',
  skill: 'The whole package was compared, including extra files and permissions, where readable.',
  mcp: 'MCP servers are set up in Codex. Xenoflux shows the steps but never copies, installs or connects them. Secret values are never shown or compared.',
  plugin: 'Plugins are set up in Codex. Xenoflux shows the steps but never copies or installs them. A definition doesn’t prove the plugin is installed or enabled.',
  hook: 'Hooks are set up in Codex. Their commands aren’t shown, and Xenoflux never copies them.',
  tool: 'A configured tool doesn’t prove it was available or used in a session.',
};

function integrationItem(key, identity, entries, names) {
  const evidence = entries.map(({ item }) => item);
  const different = evidence.some(item => item.label === 'different');
  const unknown = evidence.some(item => item.label === 'cannot-compare');
  const label = different ? 'different' : unknown ? 'cannot-compare' : 'same';
  const exactState = different ? 'changed' : unknown ? 'unknown' : 'identical';
  const values = ['a', 'b'].map(side => {
    const seen = new Set();
    let configured = 0, cached = 0, unverified = 0;
    for (const { item, resource } of entries) for (const source of item.detail.sources.filter(source => source.side === side)) {
      const key = `${source.where}\0${resource.sourceRole === 'plugin-cache' ? 'cache' : 'config'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (source.status !== 'Present') unverified++;
      else if (resource.sourceRole === 'plugin-cache') cached++; else configured++;
    }
    return { side, label: names[side], value: [configured && `${configured} configuration ${configured === 1 ? 'source' : 'sources'}`,
      cached && `${cached} cached ${cached === 1 ? 'package' : 'packages'}`, unverified && `${unverified} source ${unverified === 1 ? 'location' : 'locations'} not verified`].filter(Boolean).join('; ') || 'No source observed; see evidence for absence or reading limits' };
  });
  const hasConfiguration = entries.some(({ resource }) => resource.state?.configured === 'present');
  return { id: Buffer.from(`integration\0${key}`).toString('base64url'),
    name: identity, category: entries[0].resource.category, scope: 'Integration', label, exactState,
    exactText: different ? 'Source evidence differs' : unknown ? 'Source evidence is not fully comparable' : 'Source evidence matches',
    ...(unknown && !different ? { reason: 'See configuration and cache evidence for comparison limits.' } : {}),
    summary: [{ text: `${evidence.length} ${evidence.length === 1 ? 'evidence record' : 'evidence records'}` }],
    detail: { values, evidence, sources: [], facts: [{ label: 'Used by a session', value: 'Not known from setup alone' }],
      note: 'Configuration and cached packages are separate observations. They do not establish effective precedence, installation, availability or use.' },
    actions: hasConfiguration && label !== 'same' ? { guidance: [`If you want ${identity} in the other profile, check its Codex configuration first; add it only if absent.`,
      'A cached package alone is not a reason to install or enable it. Xenoflux never copies, installs or connects integrations.'] } : {} };
}

function setupItemId(resource) {
  return Buffer.from([resource.category, resource.scope, resource.sourceRole ?? '', resource.provider ?? '', resource.name, resource.path ?? ''].join('\u0000')).toString('base64url');
}

/** Plain view of an `audit-profile-comparison` in the order: summary, limits, groups. */
export function presentSetupComparison(value, { home } = {}) {
  const names = { a: value.left?.profile?.profileName ?? 'Left', b: value.right?.profile?.profileName ?? 'Right' };
  const localValues = Boolean(value.left?.context?.includeSourceValues || value.right?.context?.includeSourceValues);
  const buckets = value.comparison?.resources ?? {};
  const items = [];
  const integrations = new Map();
  for (const bucket of ['changed', 'added', 'removed', 'unavailable', 'unchanged']) for (const resource of list(buckets[bucket])) {
    const state = setupState(bucket, resource);
    const label = comparisonLabel(state);
    const hunks = list(resource.detailDiff?.hunks);
    const l = resource.left ?? (bucket === 'added' ? null : bucket === 'removed' || bucket === 'unchanged' || resource.comparison === 'unverified-on-right' ? resource : null);
    const r = resource.right ?? (bucket === 'removed' ? null : bucket === 'added' || bucket === 'unchanged' || resource.comparison === 'unverified-on-left' ? resource : null);
    const isFile = ['instruction', 'skill', 'agent', 'rule'].includes(resource.category);
    const valueOf = side => !side ? bucket === 'unavailable' ? 'Not established from the sources read' : 'Not present' : side.valueStatus === 'omitted' ? localValues ? side.note ?? 'Source value could not be included; see evidence limits' : 'Value not shown (not a recognized safe setting)'
      : side.value !== undefined ? localValues && typeof side.value === 'object' ? JSON.stringify(side.value, null, 2) : shortValue(side.value) : side.detail?.files ? side.detail.files.map(file => file.path).join('\n') : side.status === 'present' ? 'Present' : READ_TEXT[side.status] ?? side.status ?? 'Not known';
    const id = setupItemId(resource);
    const lines = hunkLines(hunks);
    const useDiff = lines.length > 0 && (isFile || hunks.some(h => Array.isArray(h.left) || Array.isArray(h.right)));
    const scopeText = `${SCOPE_TEXT[resource.scope] ?? resource.scope ?? 'Unknown scope'}${resource.provider && resource.scope === 'plugin' ? ` · ${resource.provider}` : ''}`;
    const readStatus = side => resource.category === 'skill' && side.detail?.coverage?.comparison === 'complete'
      ? side.detail.coverage.content === 'complete' ? 'Full file comparison and text preview complete' : 'Full file comparison complete; text preview limited'
      : READ_TEXT[side.detail?.status] ?? (side.status === 'present' ? 'Present' : side.status);
    const item = {
      id, name: resource.name ?? resource.path ?? 'unnamed', category: resource.category, scope: scopeText, label, exactState: state, exactText: exactStateText(state, names),
      ...(label === 'cannot-compare' ? { reason: resource.reason ?? (state === 'redacted' ? 'Secret values are never compared' : state === 'unavailable' ? 'Couldn’t be read' : 'Not comparable from what was read') } : {}),
      summary: localValues && [l, r].some(side => side?.value && typeof side.value === 'object') && ['identical', 'changed'].includes(state)
        ? [{ text: state === 'identical' ? 'source values match' : 'source values differ' }] : setupSummary(state, resource, names, hunks),
      detail: {
        ...(!useDiff || (localValues && !isFile) ? { values: [{ side: 'a', label: names.a, value: valueOf(l), mono: true }, { side: 'b', label: names.b, value: valueOf(r), mono: true }] } : {}),
        ...(useDiff ? { diff: lines } : {}),
        note: localValues && resource.category === 'skill' ? 'Package comparison checks full file bytes and file permissions where readable. Text previews have separate size limits; matching files do not prove the skill was loaded or followed.'
          : localValues && !isFile ? `${resource.sourceRole === 'plugin-cache' ? 'Cached manifest values' : 'Configured source values'} as read on this Mac. Effective overrides, authentication, runtime availability and session use are not established.` : SETUP_NOTE[resource.category] ?? 'Shown as discovered; runtime use isn’t known from setup alone.',
        sources: [l && { side: 'a', where: tildePath(l.path, home) ?? 'not recorded', scope: SCOPE_TEXT[l.scope] ?? l.scope ?? 'Unknown scope', status: readStatus(l) },
          r && { side: 'b', where: tildePath(r.path, home) ?? 'not recorded', scope: SCOPE_TEXT[r.scope] ?? r.scope ?? 'Unknown scope', status: readStatus(r) }].filter(Boolean),
        facts: [{ label: 'Used by a session', value: 'Not known from setup alone' },
          ...[['a', l], ['b', r]].filter(([, side]) => side?.aliasPaths?.length).map(([key, side]) => ({ label: `Cache aliases · ${names[key]}`, value: side.aliasPaths.map(path => tildePath(path, home)).join(', ') })),
          ...(resource.sourceRelationship === 'shared-physical-source' ? [{ label: 'Shared physical source', value: 'Both observations refer to the same local source; the profile-specific comparison is retained separately.' }] : []),
          ...(resource.sourceRelationship === 'shared-profile-user-root' ? [{ label: 'Shared profile and user directory', value: 'This profile uses the same directory for its Codex home and user configuration. Both source roles use the observed files.' }] : []),
          ...(localValues && resource.category === 'skill' ? [['a', l], ['b', r]].filter(([, side]) => side?.detail?.coverage).flatMap(([key, side]) => [
            { label: `File comparison · ${names[key]}`, value: side.detail.coverage.comparison === 'complete' ? 'All discovered file bytes and file permissions compared' : 'Incomplete; unreadable or unexamined files remain unknown' },
            { label: `Text previews · ${names[key]}`, value: side.detail.coverage.content === 'complete' ? 'Included in full' : 'Limited; omitted previews do not prevent full-byte comparison' },
          ]) : resource.comparison === 'partial' || resource.detailDiff?.coverage === 'partial' ? [{ label: 'Coverage', value: 'Partly read; omitted parts aren’t claimed to match' }] : [])],
      },
      actions: {
        ...(COPYABLE.has(resource.category) && ['profile', 'user'].includes(resource.scope) && label === 'different'
          && resource.sourceRelationship !== 'shared-profile-user-root' ? { copyable: true } : {}),
        ...(resource.category === 'skill' && (resource.detail?.files?.length || resource.left?.detail?.files?.length || resource.right?.detail?.files?.length) ? { package: resource.name } : {}),
        ...(['mcp', 'plugin', 'hook'].includes(resource.category) && label !== 'same' ? { guidance: [`Set ${resource.name} up in the other profile’s Codex settings if you want it there.`, 'Check first; add only if absent. Xenoflux never copies, installs or connects it.'] } : {}),
      },
    };
    if (['mcp', 'plugin', 'hook'].includes(resource.category) && (resource.state?.configured === 'present' || resource.sourceRole === 'plugin-cache')) {
      const identity = resource.integrationId ?? resource.name;
      const key = `${resource.category}\0${resource.sourceRole === 'plugin-cache' && !resource.integrationId ? resource.path ?? resource.id : identity}`;
      if (!integrations.has(key)) integrations.set(key, { identity, entries: [] });
      item.name = resource.sourceRole === 'plugin-cache' ? resource.status === 'present' ? `Cached package${resource.version ? ` · ${resource.version}` : ''}` : 'Cache location (not verified)' : 'Configuration';
      integrations.get(key).entries.push({ item, resource });
    } else items.push(item);
  }
  for (const [key, { identity, entries }] of integrations) items.push(integrationItem(key, identity, entries, names));
  const groups = SETUP_GROUP.map(([key, title, test]) => {
    return { id: key, label: title, items: items.filter(test) };
  });
  // An item belongs to its first matching group only.
  const seen = new Set();
  for (const group of groups) group.items = group.items.filter(item => !seen.has(item.id) && seen.add(item.id));
  const other = items.filter(item => !seen.has(item.id));
  if (other.length) groups.push({ id: 'other', label: 'Other', items: other });
  const finished = groups.filter(group => group.items.length).map(group => {
    const counts = countLabels(group.items);
    return { ...group, counts, meta: groupMeta(counts), hiddenSame: counts.same };
  });
  const coverageText = (status, key) => key === 'sourceValues'
    ? status === 'complete' ? 'Included in full' : status === 'partial' ? 'Some read values omitted (detail limit)' : 'Not known'
    : localValues && status === 'partial' ? 'Partial evidence' : READ_TEXT[status] ?? 'Not known';
  const coverageRows = Object.keys(COVERAGE_AREA).filter(key => value.left?.coverage?.[key] !== undefined || value.right?.coverage?.[key] !== undefined)
    .map(key => ({ area: COVERAGE_AREA[key], a: coverageText(value.left?.coverage?.[key], key), b: coverageText(value.right?.coverage?.[key], key) }));
  const gaps = coverageRows.filter(row => !['Read in full', 'Included in full'].includes(row.a) || !['Read in full', 'Included in full'].includes(row.b)).map(row => row.area);
  return { a: { name: names.a }, b: { name: names.b }, counts: countLabels(items), groups: finished,
    limits: gaps.length ? { text: localValues
      ? `Locally readable configuration and cached manifest values are shown. ${gaps.slice(0, 4).join(', ')}${gaps.length > 4 ? ` and ${gaps.length - 4} more` : ''} have incomplete evidence in at least one profile. Package read limits and runtime unknowns remain explicit; source values do not establish effective overrides or session use.`
      : `${gaps.slice(0, 4).join(', ')}${gaps.length > 4 ? ` and ${gaps.length - 4} more` : ''} couldn’t be read in full in at least one profile. Nothing is claimed about what wasn’t read; configured or discovered items don’t prove a session loaded or used them.`, coverage: coverageRows } : null,
    items };
}

/** Files of one skill package across both profiles, from the bounded detail diff. */
export function presentSkillPackage(value, skillName, { itemId } = {}) {
  const view = presentSetupComparison(value);
  const buckets = value.comparison?.resources ?? {};
  const item = view.items.find(entry => entry.category === 'skill' && entry.name === skillName && (!itemId || entry.id === itemId));
  if (!item) return null;
  const resource = ['changed', 'unavailable', 'added', 'removed', 'unchanged'].flatMap(bucket => list(buckets[bucket]).map(row => ({ bucket, row })))
    .find(({ row }) => row.category === 'skill' && setupItemId(row) === item.id);
  if (!resource) return null;
  const hunks = list(resource.row.detailDiff?.hunks);
  const row = resource.row, bucket = resource.bucket;
  const left = row.left ?? (bucket === 'removed' || bucket === 'unchanged' || row.comparison === 'unverified-on-right' ? row : null);
  const right = row.right ?? (bucket === 'added' || bucket === 'unchanged' || row.comparison === 'unverified-on-left' ? row : null);
  const leftFiles = new Map(list(left?.detail?.files).map(file => [file.path, file]));
  const rightFiles = new Map(list(right?.detail?.files).map(file => [file.path, file]));
  const byPath = new Map();
  for (const hunk of hunks) {
    const path = hunk.path && hunk.path !== 'content' ? hunk.path : 'SKILL.md';
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(hunk);
  }
  const paths = [...new Set([...leftFiles.keys(), ...rightFiles.keys(), ...byPath.keys()])].sort();
  const files = paths.map(path => {
    const parts = byPath.get(path) ?? [], l = leftFiles.get(path), r = rightFiles.get(path);
    const kinds = new Set(parts.map(part => part.kind));
    const complete = side => side?.detail?.coverage?.comparison === 'complete' || side?.detail?.status === 'available';
    if (kinds.has('added') || kinds.has('removed') || (!l && r && (bucket === 'added' || complete(left))) || (!r && l && (bucket === 'removed' || complete(right)))) {
      const side = kinds.has('added') || (!l && r) ? 'b' : 'a';
      const file = side === 'a' ? l : r;
      const content = file?.content !== undefined ? file.content.split('\n') : parts.flatMap(part => Array.isArray(part.right ?? part.left) ? part.right ?? part.left : []);
      return { path, label: 'different', exactText: `Only in ${side === 'a' ? view.a.name : view.b.name}`, summary: [{ text: 'only in ' }, { text: side === 'a' ? view.a.name : view.b.name, side }],
        ...(content.length ? { only: { side, lines: content.map(String) } } : { statement: 'File presence was established; a text preview is not available.' }) };
    }
    const meta = parts.find(part => part.kind === 'metadata-changed') ?? (Number.isFinite(l?.mode) && Number.isFinite(r?.mode) && l.mode !== r.mode ? { left: { mode: l.mode }, right: { mode: r.mode } } : null);
    const lineParts = parts.filter(part => part.kind === 'changed');
    const byteChange = parts.find(part => part.kind === 'content-changed') ?? (typeof l?.digest === 'string' && typeof r?.digest === 'string' && l.comparison === 'available' && r.comparison === 'available' && l.digest !== r.digest ? { kind: 'content-changed' } : null);
    const sameBytes = l && r && typeof l.digest === 'string' && l.digest === r.digest && l.comparison === 'available' && r.comparison === 'available';
    const sameVisible = l?.status === 'available' && r?.status === 'available' && l.content !== undefined && l.content === r.content
      && [l, r].every(file => file.comparison === undefined || file.comparison === 'available');
    const verifiedTextChange = lineParts.length && l && r && (l.comparison === 'available' && r.comparison === 'available'
      || l.comparison === undefined && r.comparison === undefined && l.status === 'available' && r.status === 'available');
    if (!parts.length && (sameBytes || sameVisible) && l.mode === r.mode)
      return { path, label: 'same', exactText: 'Same within what was compared', summary: [{ text: 'same' }], statement: sameBytes ? 'Full file bytes and file permissions match. Text previews may be limited.' : 'The fully readable source text matches.' };
    if (!meta && !verifiedTextChange && !byteChange) {
      const reason = parts.find(part => part.kind === 'unknown')?.reason ?? l?.comparisonReason ?? r?.comparisonReason ?? 'This file could not be compared against a complete matching source.';
      return { path, label: 'cannot-compare', exactText: 'Seen, but not comparable', summary: [{ text: reason }],
        statement: `${reason}${lineParts.length ? ' Limited preview differences do not establish a full-file difference.' : ''}`,
        ...(lineParts.length ? { diff: hunkLines(lineParts) } : {}) };
    }
    const statements = [byteChange ? 'Full file contents differ. The text preview may omit the changed bytes.' : null,
      meta ? `File permissions differ: ${(meta.left?.mode ?? 0).toString(8)} in ${view.a.name}, ${(meta.right?.mode ?? 0).toString(8)} in ${view.b.name}.` : null,
      ...parts.filter(part => part.kind === 'unknown').map(part => part.reason)].filter(Boolean);
    return { path, label: 'different', exactText: 'Changed',
      summary: byteChange ? [{ text: 'file contents differ' }] : lineParts.length ? [{ text: `−${lineParts.reduce((n, p) => n + list(p.left).length, 0)}`, side: 'a' }, { text: ' ' }, { text: `+${lineParts.reduce((n, p) => n + list(p.right).length, 0)}`, side: 'b' }, { text: ' lines' }] : [{ text: 'file permissions differ' }],
      ...(lineParts.length ? { diff: hunkLines(lineParts) } : {}),
      ...(statements.length ? { statement: statements.join(' ') } : {}) };
  });
  const coverage = left && right && [left, right].every(side => side.detail?.coverage?.comparison === 'complete')
    ? 'All discovered file bytes and file permissions were compared on both sides. Text previews have separate limits.'
    : resource.row.detailDiff?.coverage === 'complete' ? 'The package was read in full on both sides, including file permissions.' : 'Package comparison is incomplete; unreadable or unexamined files remain unknown.';
  return { name: skillName, label: item.label, a: view.a, b: view.b, coverage,
    source: `${SCOPE_TEXT[row.scope] ?? row.scope}${row.provider ? ` · ${row.provider}` : ''}`,
    copyable: ['profile', 'user'].includes(row.scope) && !row.provider,
    toolsNote: 'Tools a skill calls aren’t checked, and copying a skill doesn’t install them.', files };
}
