import { canonicalAuditChecks } from './audit-explanation.js';
import { normalizeAuditCheckEvidence } from './audit-check-evidence.js';

const list = value => Array.isArray(value) ? value : [];
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;

function inspectChecks(run, checks, side) {
  const retained = normalizeAuditCheckEvidence(run, { includeContent: true });
  const recipes = list(run?.comparisonConditions?.checkRecipes ?? run?.comparisonEvidence?.conditions?.checkRecipes);
  const results = [...checks];
  for (const recipe of recipes) if (recipe.name && !results.some(check => check.name === recipe.name))
    results.push({ name: recipe.name, status: 'not-recorded', exitCode: null });
  return results.map((check, index) => {
    const candidates = recipes.filter(recipe => recipe.name === check.name);
    const definitionFingerprint = candidates.length === 1 ? fingerprint(candidates[0].fingerprint) : null;
    const records = list(retained?.records).filter(record => record.name === check.name
      && record.definitionFingerprint === definitionFingerprint);
    const record = records.length === 1 ? records[0] : null;
    return { id: `${side}:check:${index}`, name: check.name, status: check.status === 'not-recorded' && record?.execution?.status === 'not-run' ? 'not-run' : check.status ?? 'unknown',
      exitCode: check.exitCode ?? null, origin: (record ? record.origin ?? retained?.origin : null) ?? check.origin ?? 'recorded-check',
      definitionFingerprint,
      definition: { command: record?.definition?.command ?? null, purpose: record?.definition?.purpose ?? null,
        timeoutMs: record?.definition?.timeoutMs ?? null, passCondition: record?.definition?.passCondition ?? null },
      execution: { startedAt: record?.execution?.startedAt ?? null, elapsedMs: record?.execution?.elapsedMs ?? null,
        workspaceFingerprint: record?.execution?.workspaceFingerprint ?? null },
      output: record?.output ?? { stdout: null, stderr: null, status: 'unavailable', truncated: false },
      detailNote: record?.detailNote ?? (record ? record.output?.status === 'omitted'
        ? 'Check command and output were omitted from this report.' : null
        : 'Check definition and output were not retained, or could not be bound to this result.') };
  });
}

/** Align verified recipe identities first. Same-name fallbacks explicitly show unknown/different definitions. */
export function presentCheckRows(left, right, aChecks = canonicalAuditChecks(left), bChecks = canonicalAuditChecks(right)) {
  const a = inspectChecks(left, aChecks, 'a'), b = inspectChecks(right, bChecks, 'b');
  const remaining = new Set(b);
  const rows = a.map(check => {
    const exact = check.definitionFingerprint ? [...remaining].filter(other => other.definitionFingerprint === check.definitionFingerprint) : [];
    const named = [...remaining].filter(other => other.name === check.name);
    const other = exact.length === 1 ? exact[0] : named.length === 1 ? named[0] : null;
    if (other) remaining.delete(other);
    const definitionMatch = !other ? 'one-sided' : !check.definitionFingerprint || !other.definitionFingerprint ? 'unknown'
      : check.definitionFingerprint === other.definitionFingerprint ? 'same' : 'different';
    return { id: check.id, name: check.name, definitionMatch, a: check, b: other };
  });
  for (const check of remaining) rows.push({ id: check.id, name: check.name, definitionMatch: 'one-sided', a: null, b: check });
  return rows;
}
