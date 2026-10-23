import test from 'node:test';
import assert from 'node:assert/strict';
import { instructionReferenceId } from '../src/audit-instructions.js';
import { compactRequiredContext, evaluateRequiredContext, validateRequiredContextRules } from '../src/audit-context.js';

const version = '0.163.0-alpha.10.2';
const ref = (origin, path, name = 'AGENTS.md') => ({ id: instructionReferenceId(origin, path), origin, name });
function run({ coverage = 'observed', versionValue = version, rows = null } = {}) {
  return { source: { kind: 'native-app-server-v2', version: versionValue, threadId: 'root' },
    coverage: { agents: 'complete', instructions: coverage },
    agents: [{ id: 'root', parentId: null }, { id: 'child', parentId: 'root' }],
    instructionSources: rows ?? [
      { agentId: 'root', source: 'thread/start', phase: 'before-task', sourceLine: null, status: 'reported', reportedCount: 1, sources: [ref('repository', 'docs/AGENTS.md')], omittedCount: 0, rejectedCount: 0, reason: null },
      { agentId: 'child', source: 'thread/resume-loaded', phase: 'after-task', sourceLine: null, status: 'reported', reportedCount: 1, sources: [ref('profile', 'profiles/default/AGENTS.override.md', 'AGENTS.override.md')], omittedCount: 0, rejectedCount: 0, reason: null },
    ] };
}

test('matches selectors against every selected owned actor using relocated logical identities', () => {
  const result = evaluateRequiredContext(run(), [
    { origin: 'repository', path: 'docs/AGENTS.md' },
    { agents: 'descendants', origin: 'profile', path: 'profiles/default/AGENTS.override.md', phase: 'after-task' },
  ]);
  assert.equal(result.status, 'passed');
  assert.equal(result.checks[0].checks[0].referenceId, ref('repository', 'docs/AGENTS.md').id);
  assert.equal(result.checks[1].checks[0].agentId, 'child');
  assert.equal(result.checks[1].checks[0].source, 'thread/resume-loaded');
});

test('root preflight can pass from complete root evidence while final descendant requirement fails', () => {
  const captured = run({ coverage: 'partial' });
  captured.coverage.agents = 'partial';
  captured.instructionSources = [captured.instructionSources[0]];
  const rules = [{ origin: 'repository', path: 'docs/AGENTS.md' },
    { agents: 'descendants', origin: 'profile', path: 'profiles/default/AGENTS.override.md' }];
  const preflight = evaluateRequiredContext(captured, rules, { rootOnly: true });
  assert.equal(preflight.checks.length, 1);
  assert.equal(preflight.checks[0].status, 'passed');
  assert.equal(evaluateRequiredContext(captured, rules).checks[1].status, 'failed');
});

test('accepts strictly complete historical evidence across versions and rejects unavailable or malformed rows', () => {
  const rules = [{ origin: 'repository', path: 'docs/AGENTS.md' }];
  assert.equal(evaluateRequiredContext(run({ versionValue: 'future-client-version' }), rules).status, 'passed');
  const current = run({ versionValue: '0.163.0' });
  assert.equal(evaluateRequiredContext(current, rules).status, 'passed');
  assert.equal(evaluateRequiredContext(run({ versionValue: '0.163.0-alpha.10.2' }), rules).status, 'passed');
  const oldUnavailable = run({ versionValue: '0.163.0-alpha.11' });
  oldUnavailable.instructionSources[0] = { ...oldUnavailable.instructionSources[0], status: 'unavailable',
    reportedCount: null, sources: [], reason: 'unsupported-native-version' };
  assert.equal(evaluateRequiredContext(oldUnavailable, rules).checks[0].reason, 'instruction-evidence-incomplete');
  const absent = run(); absent.instructionSources[0].sources = undefined;
  assert.equal(evaluateRequiredContext(absent, rules).status, 'failed');
  assert.equal(evaluateRequiredContext(run({ rows: [] }), rules).status, 'failed');
  const partial = run(); partial.instructionSources[0].omittedCount = 1;
  assert.equal(evaluateRequiredContext(partial, rules).status, 'failed');
  const malformed = run(); malformed.instructionSources[0].sources[0].id = 'bad';
  assert.equal(evaluateRequiredContext(malformed, rules).status, 'failed');
  assert.equal(evaluateRequiredContext(run({ coverage: 'unavailable' }), rules).status, 'failed');
  const noInstructionCoverage = run(); delete noInstructionCoverage.coverage.instructions;
  assert.equal(evaluateRequiredContext(noInstructionCoverage, rules).status, 'failed');
  assert.equal(evaluateRequiredContext(run(), [{ ...rules[0], phase: 'after-task' }]).checks[0].reason, 'phase-source-mismatch');
});

test('validates safe bounded selectors without echoing unsafe values', () => {
  assert.throws(() => validateRequiredContextRules([{ origin: 'user', path: '../AGENTS.md' }]), /Invalid captureRequirements/);
  assert.throws(() => validateRequiredContextRules([{ origin: 'user', path: '/Users/private/AGENTS.md' }]), /Invalid captureRequirements/);
  assert.throws(() => validateRequiredContextRules([{ origin: 'user', path: 'AGENTS.md', secret: 'value' }]), /Invalid captureRequirements/);
  assert.throws(() => validateRequiredContextRules(Array.from({ length: 51 }, () => ({ origin: 'user', path: 'AGENTS.md' }))), /Invalid captureRequirements/);
  for (const path of ['.env', 'auth.json', 'secrets/provider.json'])
    assert.throws(() => validateRequiredContextRules([{ origin: 'user', path }]), /Invalid captureRequirements/);
});

test('rejects ambiguous actor rows and unavailable or malformed ownership while allowing unrelated external refs', () => {
  const rule = [{ origin: 'repository', path: 'docs/AGENTS.md' }];
  const external = run();
  external.instructionSources[0].sources.push({ id: `sha256:${'a'.repeat(64)}`, origin: 'external', name: 'instruction-file' });
  external.instructionSources[0].reportedCount++;
  assert.equal(evaluateRequiredContext(external, rule).status, 'passed');
  const duplicate = run(); duplicate.instructionSources.push(structuredClone(duplicate.instructionSources[0]));
  assert.equal(evaluateRequiredContext(duplicate, rule).status, 'failed');
  const duplicateActor = run(); duplicateActor.agents.push({ id: 'root', parentId: null });
  assert.equal(evaluateRequiredContext(duplicateActor, rule).status, 'failed');
  const malformedActor = run(); malformedActor.agents.push(null);
  assert.equal(evaluateRequiredContext(malformedActor, rule).status, 'failed');
  const noRoot = run(); noRoot.agents = [{ id: 'child', parentId: 'missing' }];
  const noRootResult = evaluateRequiredContext(noRoot, rule);
  assert.equal(noRootResult.checks[0].checks[0].reason, 'selected-agents-unavailable');
  assert.match(noRootResult.checks[0].checks[0].referenceId, /^sha256:/);
  const noDescendants = run(); noDescendants.agents = [{ id: 'root', parentId: null }];
  const empty = evaluateRequiredContext(noDescendants, [{ agents: 'descendants', origin: 'user', path: 'AGENTS.md' }]);
  assert.equal(empty.status, 'failed');
  assert.equal(empty.checks[0].checks[0].reason, 'selected-agents-unavailable');
  const invalidRoot = run(); invalidRoot.agents[0].parentId = 'foreign';
  assert.equal(evaluateRequiredContext(invalidRoot, [{ agents: 'descendants', origin: 'repository', path: 'docs/AGENTS.md' }]).status, 'failed');
});

test('compaction cannot upgrade missing, malformed, or truncated checks to passed', () => {
  assert.equal(compactRequiredContext({ status: 'passed', requirements: [], checks: [] }).status, 'failed');
  const rule = [{ origin: 'repository', path: 'docs/AGENTS.md' }];
  const good = evaluateRequiredContext(run(), rule);
  assert.equal(compactRequiredContext(good).status, 'passed');
  assert.equal(compactRequiredContext({ ...good, checks: [] }).status, 'failed');
  assert.equal(compactRequiredContext({ ...good, checks: [{ ...good.checks[0], checks: [] }] }).status, 'failed');
  const noPhase = structuredClone(good); noPhase.checks[0].checks[0].phase = null;
  assert.equal(compactRequiredContext(noPhase).status, 'failed');
  const tooManyActors = structuredClone(good); tooManyActors.checks[0].checks = Array.from({ length: 161 }, () => ({ ...good.checks[0].checks[0] }));
  assert.equal(compactRequiredContext(tooManyActors).status, 'failed');
});

test('compaction requires one ordered, selector-matched check and actor reference for every rule', () => {
  const rules = [{ origin: 'repository', path: 'docs/AGENTS.md' },
    { agents: 'descendants', origin: 'profile', path: 'profiles/default/AGENTS.override.md', phase: 'after-task' }];
  const good = evaluateRequiredContext(run(), rules);
  assert.equal(good.status, 'passed');
  assert.equal(compactRequiredContext(good).status, 'passed');
  assert.equal(compactRequiredContext({ ...good, checks: [good.checks[0], good.checks[0]] }).status, 'failed');
  assert.equal(compactRequiredContext({ ...good, checks: [good.checks[1]] }).status, 'failed');
  assert.equal(compactRequiredContext({ ...good, checks: [...good.checks].reverse() }).status, 'failed');
  const wrongReference = structuredClone(good);
  wrongReference.checks[1].checks[0].referenceId = wrongReference.checks[0].checks[0].referenceId;
  assert.equal(compactRequiredContext(wrongReference).status, 'failed');
});

test('compaction preserves well-formed context failures and observed phase details', () => {
  const missing = run();
  missing.instructionSources[0].sources[0].id = instructionReferenceId('repository', 'different/AGENTS.md');
  const missingResult = compactRequiredContext(evaluateRequiredContext(missing, [{ origin: 'repository', path: 'docs/AGENTS.md' }]));
  assert.equal(missingResult.status, 'failed');
  assert.equal(missingResult.malformed, false);
  assert.equal(missingResult.checks[0].checks[0].reason, 'required-context-not-observed');

  const mixed = compactRequiredContext(evaluateRequiredContext(run(), [{ agents: 'all', origin: 'repository', path: 'docs/AGENTS.md' }]));
  assert.equal(mixed.status, 'failed');
  assert.equal(mixed.malformed, false);
  assert.deepEqual(mixed.checks[0].checks.map(row => row.reason), [null, 'required-context-not-observed']);

  const phaseMismatch = compactRequiredContext(evaluateRequiredContext(run(), [
    { origin: 'repository', path: 'docs/AGENTS.md', phase: 'after-task' },
  ]));
  assert.equal(phaseMismatch.status, 'failed');
  assert.equal(phaseMismatch.malformed, false);
  assert.equal(phaseMismatch.checks[0].checks[0].phase, 'before-task');
  assert.equal(phaseMismatch.checks[0].checks[0].source, 'thread/start');
  assert.equal(phaseMismatch.checks[0].checks[0].reason, 'phase-source-mismatch');
});
