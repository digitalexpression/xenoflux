const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function sum(...values) {
  return values.includes(null) ? null : count(values.reduce((total, value) => total + value, 0));
}

function measured(scope, note, counters) {
  if (Object.values(counters).every(value => value === null)) return null;
  return { scope, note, counters: { input: null, uncachedInput: null, cacheRead: null, cacheWrite: null,
    output: null, reasoning: null, total: null, ...counters } };
}

function claudeSubmission(usage) {
  if (!Array.isArray(usage?.observations) || usage.observationsOmitted) return null;
  const rows = usage.observations.filter(row => row?.source === 'claude-sdk-result' && row.scope === 'single-submission');
  if (rows.length !== 1) return null;
  const values = rows[0].values;
  const uncachedInput = count(values?.input_tokens), cacheRead = count(values?.cache_read_input_tokens);
  const cacheWrite = count(values?.cache_creation_input_tokens), output = count(values?.output_tokens);
  const input = sum(uncachedInput, cacheRead, cacheWrite);
  return measured('Claude task submission', 'Input includes uncached tokens, cache reads and cache writes. The total adds output for this submission.',
    { input, uncachedInput, cacheRead, cacheWrite, output, total: sum(input, output) });
}

function copilotResponse(run) {
  const rootId = run.source.threadId;
  if (typeof rootId !== 'string' || !rootId || !Array.isArray(run.turns) || !Array.isArray(run.usage?.observations)
    || run.usage.observationsOmitted) return null;
  const turns = new Set(run.turns.filter(turn => turn?.agentId === rootId && typeof turn.turnId === 'string' && turn.turnId).map(turn => turn.turnId));
  const rows = run.usage.observations.filter(row => row?.source === 'assistant.usage' && row.agentId === rootId
    && turns.has(row.turnId) && typeof row.nativeEventId === 'string' && row.nativeEventId);
  if (!rows.length || new Set(rows.map(row => row.nativeEventId)).size !== rows.length) return null;
  const last = rows.at(-1);
  return measured('Copilot usage event', 'The latest retained usage event provides these input and output counts. A task total requires whole-task accounting.',
    { input: count(last.inputTokens), output: count(last.outputTokens) });
}

/** Project scoped usage from retained evidence without changing comparison eligibility. */
export function presentReportedUsage(run, agentMeasurements = []) {
  const source = run?.source;
  if (source?.kind === 'claude-agent-sdk') return claudeSubmission(run.usage);
  if (source?.kind === 'copilot-sdk-stdio') return copilotResponse(run);
  if (source?.kind !== 'native-app-server-v2' && source?.kind !== 'native-rollout') return null;
  const rootId = source.threadId ?? source.nativeSessionId;
  const roots = agentMeasurements.filter(agent => agent?.parentId === null);
  if (!rootId || roots.length !== 1 || roots[0].id !== rootId) return null;
  const root = roots[0];
  const input = count(root.counters?.input), cacheRead = count(root.counters?.cachedInput);
  const output = count(root.counters?.output), reasoning = count(root.counters?.reasoning);
  const total = count(root.counters?.total);
  const raw = source.kind === 'native-app-server-v2' ? run.usage?.[rootId]?.total : null;
  const matchesSnapshot = raw && ![input, cacheRead, output, reasoning, total].includes(null)
    && raw.inputTokens === input && raw.cachedInputTokens === cacheRead && raw.outputTokens === output
    && raw.reasoningOutputTokens === reasoning && raw.totalTokens === total;
  const cacheWrite = matchesSnapshot ? count(raw.cacheWriteInputTokens) : null;
  return measured('Codex main session', 'Cached tokens are included in input. Reasoning is included in output. Cache writes are shown as a separate counter.',
    { input, uncachedInput: input !== null && cacheRead !== null ? count(input - cacheRead) : null,
      cacheRead, cacheWrite, output, reasoning, total });
}
