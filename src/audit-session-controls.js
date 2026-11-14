import { freezeAuditComparisonEvidence } from './audit-explanation.js';

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' && value ? value : null;
const setting = value => text(value) ?? text(value?.value);
const controls = [
  { key: 'model', name: 'Model', group: 'model' },
  { key: 'reasoningEffort', name: 'Reasoning effort', group: 'harness' },
  { key: 'permissionMode', name: 'Permission mode', group: 'harness' },
];

export function presentSessionControls(run) {
  const settings = run.settingsEvidence ?? {};
  const configured = run.profile?.execution ?? run.comparisonConditions?.requestedExecution ?? run.nativeControls?.configured;
  const settingsRows = controls.map(({ key, name }) => ({
    name,
    requested: setting(settings.requested?.[key]) ?? setting(configured?.[key])
      ?? (key === 'reasoningEffort' ? setting(configured?.modelReasoningEffort) : null),
    sent: setting(settings.sent?.[key]), confirmed: setting(settings.confirmed?.[key]),
    observed: setting(settings.observed?.[key]),
  }));
  const turns = [
    ...list(run.turns).map(turn => {
      const proofs = list(run.nativeControls?.turns).filter(proof => proof.agentId === turn.agentId && proof.turnId === turn.turnId
        && proof.model === turn.model && proof.reasoningEffort === turn.reasoningEffort
        && proof.source === 'turn_context' && proof.workspaceMatched === true
        && /^[a-f0-9]{64}$/.test(proof.sourceFingerprint ?? '') && Number.isSafeInteger(proof.sourceLine) && proof.sourceLine > 0);
      const proof = proofs.length === 1 ? proofs[0] : null;
      return { agentId: turn.agentId ?? null, turnId: turn.turnId ?? null,
        model: text(turn.model), effort: text(turn.reasoningEffort), recordedAt: text(turn.recordedAt),
        sourceLine: proof?.sourceLine ?? turn.sourceLine ?? null,
        source: proof ? 'Retained native turn context' : 'Retained turn record' };
    }),
    ...list(settings.observed?.turns).map(turn => ({ agentId: turn.threadId ?? null, turnId: turn.turnId ?? null,
      model: text(turn.model), effort: text(turn.reasoningEffort), recordedAt: null, sourceLine: turn.sourceLine ?? null,
      source: text(settings.observed.source) ?? 'Native settings observation' })),
  ];
  return { settings: settingsRows, turns };
}

const display = value => value == null ? 'Unknown' : Array.isArray(value) ? value.length ? value.join(', ') : 'None selected' : String(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const known = value => value !== null && value !== undefined;
const clientOf = run => text(run.clientIdentity?.client) ?? text(run.nativeReference?.client) ?? text(run.profile?.client)
  ?? ({ 'native-rollout': 'codex', 'native-app-server-v2': 'codex', 'claude-agent-sdk': 'claude-code',
    'claude-code-sdk-file-import': 'claude-code', 'copilot-sdk-stdio': 'copilot', 'copilot-sdk-session-import': 'copilot' }[run.source?.kind] ?? null);

export function compareSessionControls(left, right, { conditions } = {}) {
  const runs = [left, right];
  const cores = runs.map(run => freezeAuditComparisonEvidence(run));
  const valid = cores.every(core => core.status === 'recorded');
  const views = runs.map(presentSessionControls);
  const clients = runs.map(clientOf);
  const sameClient = clients.every(known) && clients[0] === clients[1];
  const controlComparable = clients.every(known) ? sameClient : null;
  const rows = [];
  const add = (id, name, group, stage, values, note, comparable = true) => {
    const status = !valid || !values.every(known) || comparable === null ? 'unknown' : !comparable ? 'not-comparable'
      : equal(...values) ? 'same' : 'different';
    const row = { id, name, group, stage, status, a: display(values[0]), b: display(values[1]),
      note: !valid ? 'Bound comparison evidence is unavailable or invalid; these values cannot establish control equivalence or change.' : note };
    rows.push(row);
    return row;
  };
  add('client', 'Native client', 'harness', null, clients,
    'Retained native client attribution; model vendor does not identify the harness.');
  const historicalImport = run => run.source?.kind === 'native-rollout' || /import/.test(run.source?.kind ?? '') || Boolean(run.source?.readContext);
  add('surface', 'Original client surface', 'harness', 'observed', runs.map((run, index) =>
    historicalImport(run) && clients[index] !== 'codex' ? null
      : text(run.clientIdentity?.surface) ?? (['cli', 'desktop'].includes(run.source?.client) ? run.source.client : null)),
  'Original recorded CLI or Desktop attribution. Import read context never supplies this value.');
  add('execution-location', 'Original execution location', 'harness', 'observed', runs.map(run =>
    historicalImport(run) ? null : text(run.clientIdentity?.executionLocation)),
  'Original captured execution location only; the local location of an imported file does not establish where the task ran.');
  add('native-version', 'Native version', 'harness', 'observed', cores.map(core => core.observedControls?.nativeVersion),
    'Retained native version; equal versions do not establish equal historical configuration.', controlComparable);
  for (const [index, control] of controls.entries()) {
    for (const stage of ['requested', 'sent', 'confirmed', 'observed']) {
      add(`${control.key}-${stage}`, control.name, control.group, stage, views.map(view => view.settings[index][stage]),
        stage === 'requested' ? 'Recorded requested control; this does not establish the model or policy actually used.'
          : stage === 'observed' ? 'Retained response-stage observation; requested and confirmed values do not fill missing observations.'
            : `Retained ${stage} control; this does not fill any other evidence stage.`,
        control.group === 'model' ? true : controlComparable);
    }
  }
  for (const [key, name] of [['planModeReasoningEffort', 'Plan mode reasoning effort'], ['loginMethod', 'Login method']]) {
    const values = cores.map(core => core.nativeControls?.configured?.[key]);
    if (values.some(known)) add(`native-${key}`, name, 'harness', 'requested', values,
      'Retained native configuration request; this does not establish the effective historical policy.', controlComparable);
  }
  add('selected-skills', 'Selected skill requests', 'harness', 'requested', cores.map(core => core.conditions.selectedSkills?.slice().sort()),
    'Recorded selected skill requests; this does not establish definitions, loading, invocation or historical skill equality.');
  add('observed-model-set', 'Native observed model set', 'model', 'observed', cores.map(core =>
    core.observedControls?.complete && core.observedControls.models.length ? core.observedControls.models : null),
  'Canonical complete native observations only. Equal sets do not establish equal per-turn routes or actors. Auto requests remain separate from actual model routes.');
  add('observed-effort-set', 'Native observed reasoning effort set', 'harness', 'observed', cores.map(core =>
    core.observedControls?.complete && core.observedControls.efforts.length ? core.observedControls.efforts : null),
  'Canonical complete native effort observations across captured actors. Matching labels do not establish identical computation or turn sequences.', controlComparable);
  for (const [key, name] of [['task', 'Task input'], ['commit', 'Baseline commit'], ['tree', 'Baseline tree'], ['editableFiles', 'Editable file scope']]) {
    const field = list(conditions?.fields).find(row => row.key === key);
    add(`condition-${key}`, name, 'inputs', null, [field?.left ?? null, field?.right ?? null],
      'Canonical retained comparison conditions; this row does not change task or metric eligibility.');
  }
  const setup = list(conditions?.fields).find(row => row.key === 'setup');
  add('setup-inputs', 'Setup and native configuration inputs', 'inputs', null, [setup?.left ?? null, setup?.right ?? null],
    'This fingerprint combines setup recipes and the entire nativeConfig, including model. A difference alone cannot identify a harness change; a match cannot establish full historical equality.');
  add('historical-harness', 'Full historical harness, context and cache', 'harness', null, [null, null],
    'Historical settings, skills, hooks, MCP, effective context and cache equality are unknown. Import readContext describes the reader, not the original execution surface.');
  const modelRequest = rows.find(row => row.id === 'model-requested');
  const heldRequests = rows.filter(row => row.group === 'harness' && row.stage === 'requested');
  const modelOnly = modelRequest.status === 'different' && sameClient && heldRequests.every(row => row.status === 'same');
  const requested = modelOnly
    ? { kind: 'model-only-request', label: 'Model-only request', text: 'Only the model differs among the listed recorded requested controls under the same known client. Full historical harness equivalence is unknown.' }
    : modelRequest.status === 'different'
      ? { kind: 'model-change-requested', label: 'Model change requested', text: 'The recorded model requests differ. Constancy of the other listed requested controls is unknown or contradicted; full historical harness equivalence is unknown.' }
      : { kind: 'requested-controls', label: 'Requested controls', text: 'The staged rows describe recorded requests. Missing controls remain unknown; requested values do not establish actual execution.' };
  const harnessChanges = rows.some(row => row.group === 'harness' && row.status === 'different');
  const modelChanges = rows.some(row => row.group === 'model' && row.stage === 'observed' && row.status === 'different');
  const inputChanges = rows.some(row => row.id.startsWith('condition-') && row.status === 'different');
  const recorded = inputChanges
    ? { kind: 'comparison-inputs-differ', label: 'Task or baseline inputs differ', text: 'Recorded task, source baseline or editable scope differs. This pair cannot isolate a model change while holding those inputs constant. Other control differences remain inspectable below.' }
    : harnessChanges
    ? { kind: 'harness-controls-differ', label: 'Harness controls differ', text: 'Concrete retained client, version or non-model control evidence differs. The rows identify the evidence stage; full historical equivalence remains unknown.' }
    : modelChanges
      ? { kind: 'observed-models-differ', label: 'Observed models differ', text: 'Retained response-stage or complete native observed model evidence differs. This does not establish otherwise equal routes, actors or historical harnesses.' }
      : { kind: 'historical-equivalence-unknown', label: 'Historical equivalence unknown', text: 'The retained evidence does not establish full historical harness, context or cache equality.' };
  return { schemaVersion: 1, basis: 'retained-evidence', requested, recorded, rows, limits: [
    'Only retained evidence is compared. No current profile, settings, skill, hook, MCP or cache files are read.',
    'Full historical harness, effective context and cache equivalence remain unknown, including when setup fingerprints match.',
    'Imported readContext identifies the reader and never proves the original execution surface.',
    'Requested, sent, confirmed and observed controls remain distinct. Native Auto requests do not identify actual routed models.',
    'Matching observed model sets do not prove matching per-turn routes or actor models.',
    'A model change can change context selection, caching or offered tools. Matching requested controls do not rule out those effects.',
    ...(!valid ? ['Invalid or unavailable bound comparison evidence suppresses stronger control conclusions.'] : []),
  ] };
}
