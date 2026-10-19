import test from 'node:test';
import assert from 'node:assert/strict';
import { projectInstructionSources, compactInstructionSources, nativeInstructionSourceContract } from '../src/audit-instructions.js';

const context = { agentId: 'root', source: 'thread/start', phase: 'before-task', sourceLine: 7,
  workspace: '/private/workspace', profileHome: '/private/profile', userHome: '/private/user' };

test('projects loaded-source references without retaining private paths or instruction content', () => {
  const row = projectInstructionSources(['/private/workspace/AGENTS.md', '/private/profile/AGENTS.override.md',
    'file:///private/user/my%20private%20instructions.md', '/private/other/AGENTS.md'], context);
  assert.equal(row.status, 'reported');
  assert.deepEqual(row.sources.map(source => source.origin), ['repository', 'profile', 'user', 'external']);
  assert.deepEqual(row.sources.map(source => source.name), ['AGENTS.md', 'AGENTS.override.md', 'instruction-file', 'AGENTS.md']);
  assert.ok(row.sources.every(source => /^sha256:[a-f0-9]{64}$/.test(source.id)));
  assert.equal(new Set(row.sources.map(source => source.id)).size, 4);
  assert.equal(JSON.stringify(row).includes('/private'), false);
  assert.equal(JSON.stringify(row).includes('my private'), false);
});

test('logical repository references survive relocation but distinguish resource positions', () => {
  const a = projectInstructionSources(['/private/workspace/AGENTS.md', '/private/workspace/child/AGENTS.md'], context);
  const b = projectInstructionSources(['/other/run/AGENTS.md'], { ...context, workspace: '/other/run' });
  assert.equal(a.sources[0].id, b.sources[0].id);
  assert.notEqual(a.sources[0].id, a.sources[1].id);
  assert.equal(projectInstructionSources(['/private/workspace-evil/AGENTS.md'], context).sources[0].origin, 'external');
});

test('preserves native instruction order and repeated source entries through frozen projection', () => {
  const paths = ['/private/profile/AGENTS.md', '/private/workspace/AGENTS.md', '/private/profile/AGENTS.md'];
  const row = projectInstructionSources(paths, context);
  assert.equal(row.reportedCount, 3);
  assert.equal(row.sources.length, 3);
  assert.equal(row.sources[0].id, row.sources[2].id);
  assert.notEqual(row.sources[0].id, row.sources[1].id);
  assert.deepEqual(compactInstructionSources([row]).rows, [row]);
});

test('separates missing, empty, malformed, rejected and capped native source evidence', () => {
  assert.equal(projectInstructionSources(undefined, context).status, 'unavailable');
  const empty = projectInstructionSources([], context);
  assert.equal(empty.status, 'reported-empty'); assert.equal(empty.reportedCount, 0);
  assert.equal(projectInstructionSources({}, context).reason, 'invalid-source-list');
  const malformed = projectInstructionSources(['relative/AGENTS.md', 'file:///private/AGENTS.md?token=secret',
    '/private/workspace/AGENTS.md', '/private/workspace/control\nAGENTS.md'], context);
  assert.equal(malformed.status, 'partial'); assert.equal(malformed.rejectedCount, 3);
  assert.equal(malformed.sources.length, 1);
  const capped = projectInstructionSources(['/private/workspace/AGENTS.md', '/private/profile/AGENTS.md'], { ...context, maxSources: 1 });
  assert.equal(capped.status, 'partial'); assert.equal(capped.omittedCount, 1);
  assert.equal(capped.reportedCount, 2);
});

test('frozen projection drops untrusted fields, invalid references and duplicate actor claims', () => {
  const row = projectInstructionSources(['/private/workspace/AGENTS.md'], context);
  const result = compactInstructionSources([{ ...row, body: 'PRIVATE_TEXT', path: '/private/file',
    sources: [...row.sources.map(source => ({ ...source, path: '/private/file', body: 'PRIVATE_TEXT' })),
      { id: 'not-an-opaque-reference', origin: 'user', name: 'PRIVATE_FILENAME' }] }, row]);
  assert.equal(result.status, 'partial'); assert.equal(result.omittedAgents, 1);
  assert.equal(result.rows[0].rejectedCount, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('/private'), false);
  assert.equal(result.rows[0].sourceLine, 7);
});

test('frozen source limits preserve missingness and survive repeated projection', () => {
  const row = projectInstructionSources(['/private/workspace/AGENTS.md', '/private/profile/AGENTS.md'], context);
  const compact = compactInstructionSources([row], { maxSources: 1 });
  assert.equal(compact.status, 'partial'); assert.equal(compact.omittedSources, 1);
  assert.deepEqual(compactInstructionSources(compact.rows, { maxSources: 1 }), compact);
  const unknown = projectInstructionSources([], { ...context, reason: 'agent-not-loaded' });
  assert.equal(unknown.status, 'unavailable');
  assert.equal(compactInstructionSources([unknown]).status, 'unavailable');
  assert.equal(compactInstructionSources([]).status, 'unavailable');
});

test('pins the loaded-thread observation contract and rejects unowned source envelopes', () => {
  assert.ok(nativeInstructionSourceContract('0.163.0-alpha.10.2'));
  assert.equal(nativeInstructionSourceContract('0.163.0'), null);
  assert.throws(() => projectInstructionSources([], { ...context, agentId: '/unowned' }));
  assert.throws(() => projectInstructionSources([], { ...context, source: 'invented-source' }));
});
