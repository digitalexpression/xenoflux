// Synthetic recorded-source controls; these are not genuine MDM/admin acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { resolveAuditProfile } from '../src/audit-discovery.js';
import { auditNativeSession } from '../src/audit-session.js';
import { compareAuditRuns } from '../src/audit-report.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const exec = promisify(execFile);
const task = '00000000-0000-4000-8000-000000000901', turn = '00000000-0000-4000-8000-000000000902';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-managed-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const native = await prepareNativeHome({ directory: join(root, 'native'), executable, codexVersion: '0.163.0-alpha.10.2' });
  const store = new Store(join(root, 'store')); await store.update(data => create(data, 'A'));
  await registerHome(store, 'A', native.root, { executable, version: '0.163.0-alpha.10.2' });
  return { root, store, profile: await resolveAuditProfile(store, 'A'), home: native.home };
}
async function capture(f, entries, structured = []) {
  const path = join(f.home, 'sessions', 'managed-history.jsonl');
  const esc = value => value.replaceAll("'", "''");
  await exec('/usr/bin/sqlite3', [join(f.home, 'state_5.sqlite'),
    `CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,rollout_path TEXT,source TEXT); INSERT INTO threads VALUES ('${task}','/repo','fixture',1,1,0,'${esc(path)}','cli');`]);
  const record = (type, payload) => ({ timestamp: '2026-01-01T00:00:00Z', type, payload });
  const rows = [record('session_meta', { id: task, session_id: task, cli_version: '0.163.0-alpha.10.2', originator: 'codex_cli_rs' }),
    record('turn_context', { turn_id: turn, cwd: '/repo', skills: structured }),
    record('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text',
      text: `<skills_instructions>\n${entries.map(([name, target]) => `- ${name}: fixture (file: ${target})`).join('\n')}\n</skills_instructions>` }] }),
    record('event_msg', { type: 'task_complete', turn_id: turn, status: 'completed' })];
  await mkdir(join(f.home, 'sessions'), { recursive: true, mode: 0o700 });
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const original = await readFile(path), report = await auditNativeSession(f.store, 'A', task);
  assert.deepEqual(await readFile(path), original);
  return report;
}

test('historical administrator-looking and unrelated system-looking paths do not establish those sources', async t => {
  const f = await fixture(t);
  const entries = [
    ['etc-other', '/etc/project/skills/review/SKILL.md'],
    ['etc-candidate', '/etc/codex/skills/review/SKILL.md'],
    ['admin-fragment', '/repo/admin/skills/review/SKILL.md'],
    ['project-fragment', '/repo/.agents/skills/admin/skills/review/SKILL.md'],
    ['profile-fragment', join(f.home, 'skills', 'admin', 'skills', 'review', 'SKILL.md')],
    ['opt-fragment', '/repo/opt/codex/skills/review/SKILL.md'],
    ['share-fragment', '/repo/usr/share/example/skills/review/SKILL.md'],
    ['system-fragment', '/repo/.agents/skills/skills/.system/review/SKILL.md'],
    ['bundled-profile', join(f.home, 'skills', '.system', 'review', 'SKILL.md')],
    ['bundled-user', join(f.profile.userHome, '.codex', 'skills', '.system', 'review', 'SKILL.md')],
    ['bundled-lookalike', join(f.home, 'skills', '.system-shadow', 'review', 'SKILL.md')],
  ];
  const report = await capture(f, entries);
  assert.equal(report.skills.length, entries.length);
  const byName = new Map(report.skills.map(skill => [skill.name, skill]));
  for (const [name] of entries) assert.notEqual(byName.get(name).scope, 'admin', name);
  for (const name of ['etc-other', 'etc-candidate', 'admin-fragment', 'project-fragment', 'profile-fragment', 'opt-fragment', 'share-fragment', 'system-fragment', 'bundled-lookalike']) {
    assert.notEqual(byName.get(name).scope, 'system', name);
    assert.notEqual(byName.get(name).origin, 'system', name);
  }
  assert.equal(byName.get('project-fragment').scope, 'project');
  assert.equal(byName.get('system-fragment').scope, 'project');
  assert.equal(byName.get('profile-fragment').scope, 'profile');
  assert.equal(byName.get('bundled-profile').scope, 'system');
  assert.equal(byName.get('bundled-user').scope, 'system');
  const compact = compactAuditTrial({ runs: [report] }).runs[0];
  assert.deepEqual(compact.skills.map(skill => [skill.name, skill.scope]), report.skills.map(skill => [skill.name, skill.scope]));
  const comparison = compareAuditRuns(report, report);
  assert.ok(comparison.comparison.skills.every(row => row.left.scope !== 'admin'));
  for (const format of ['json', 'markdown']) {
    const exported = await exportAuditReport(report, { output: join(f.root, `history.${format === 'json' ? 'json' : 'md'}`), format });
    const reopened = await readAuditReport(exported.evidencePath);
    assert.deepEqual(reopened.skills.map(skill => [skill.name, skill.scope]), report.skills.map(skill => [skill.name, skill.scope]));
  }
});

test('structured recorded native administrator/system scope survives independently of path guesses', async t => {
  const f = await fixture(t);
  const report = await capture(f, [], [
    { name: 'recorded-admin', path: '/opaque/provider/one/SKILL.md', origin: 'admin', scope: 'admin' },
    { name: 'recorded-system', path: '/opaque/provider/two/SKILL.md', origin: 'system', scope: 'system' },
  ]);
  assert.deepEqual(report.skills.map(skill => [skill.name, skill.origin, skill.scope]), [
    ['recorded-admin', 'admin', 'admin'], ['recorded-system', 'system', 'system'],
  ]);
});
