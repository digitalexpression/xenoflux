import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store, create } from '../src/profiles.js';
import { prepareNativeHome } from '../test-support/native-home-fixture.js';
import { registerHome } from '../src/homes.js';
import { auditNativeSession } from '../src/audit-session.js';
import { resolveAuditProfile } from '../src/audit-discovery.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const exec = promisify(execFile);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rec = (timestamp, type, payload) => ({ timestamp, type, payload });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'xfx-audit-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-codex');
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const native = await prepareNativeHome({ directory: join(root, 'native'), executable, codexVersion: '0.153.4' });
  const store = new Store(join(root, 'store'));
  await store.update(data => create(data, 'A'));
  await registerHome(store, 'A', native.root, { executable, version: '0.153.4' });
  return { root, store, home: native.home };
}

async function seedIndex(home, idValue, path) {
  const db = join(home, 'state_5.sqlite');
  await exec('/usr/bin/sqlite3', [db, 'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER DEFAULT 0, rollout_path TEXT, source TEXT);']);
  const esc = value => String(value).replaceAll("'", "''");
  await exec('/usr/bin/sqlite3', [db, `INSERT INTO threads VALUES ('${esc(idValue)}','/repo','ignored',1,1,1,'${esc(path)}','cli');`]);
}

async function writeRollout(path, task, turn, skillsText, skillPath) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const rows = [
    rec('2026-10-15T10:00:00.000Z', 'session_meta', { id: task, session_id: task, cli_version: '0.153.4' }),
    rec('2026-10-15T10:00:01.000Z', 'turn_context', { turn_id: turn, cwd: '/repo', model: 'gpt-test', effort: 'medium' }),
    rec('2026-10-15T10:00:01.500Z', 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: skillsText }] }),
    rec('2026-10-15T10:00:02.000Z', 'event_msg', { type: 'item_completed', turn_id: turn, item: {
      type: 'CommandExecution', id: 'read-one', command: ['/bin/cat', skillPath],
      parsed_cmd: [{ type: 'read', path: skillPath }], cwd: '/repo', status: 'completed', exit_code: 0,
    } }),
  ];
  await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
}

test('rejects conflicting, unknown, and invalid historical root aliases without guessing a path', async t => {
  const f = await fixture(t), task = id(201), turn = id(202), rollout = join(f.home, 'sessions', 'aliases.jsonl');
  const profile = await resolveAuditProfile(f.store, 'A');
  const target = '/repo/.agents/skills/review/SKILL.md';
  const conflict = `<skills_instructions>\n- \`r0\` = \`/repo/.agents/skills\`\n- \`r0\` = \`/other/.agents/skills\`\n- \`r1\` = \`/repo/.agents/skills\`\n- \`R1\` = \`/other/.agents/skills\`\n- \`r2\` = \`relative/root\`\n- review: fixture (file: r0/review/SKILL.md)\n- mixed: fixture (file: r1/mixed/SKILL.md)\n- unknown: fixture (file: r9/unknown/SKILL.md)\n- invalid: fixture (file: r2/invalid/SKILL.md)\n- traversal: fixture (file: r0/../outside/SKILL.md)\n</skills_instructions>`;
  await seedIndex(f.home, task, rollout);
  await writeRollout(rollout, task, turn, conflict, target);
  const original = await readFile(rollout);
  const report = await auditNativeSession(f.store, 'A', task);

  // A same-case duplicate used to resolve to its last root (/other). The
  // separately mixed-case r1/R1 conflict used to be treated as two labels,
  // leaving r1 guessed as /repo. Neither conflicting catalog may survive.
  assert.equal(report.skills.some(skill => skill.name === 'review'), false);
  assert.equal(report.skills.some(skill => skill.name === 'mixed'), false);
  assert.ok(report.warnings.some(warning => /root alias/i.test(warning)));
  assert.equal(report.status, 'partial');
  assert.equal(report.skills.some(skill => skill.path === '/other/.agents/skills/review/SKILL.md'), false);
  assert.equal(report.skills.some(skill => skill.observations.some(observation => observation.kind === 'definition-read-observed')), false);

  const compactTrial = compactAuditTrial({ runs: [report], warnings: report.warnings });
  const compact = compactTrial.runs[0];
  const base = join(f.root, 'exports'); await mkdir(base, { mode: 0o700 });
  const json = join(base, 'aliases.json'); const md = join(base, 'aliases.md');
  await exportAuditReport(report, { output: json, format: 'json' });
  await exportAuditReport(report, { output: md, format: 'markdown' });
  for (const source of [json, `${md}.audit.json`]) {
    const reopened = await readAuditReport(source);
    assert.ok(reopened.warnings.some(warning => /root alias/i.test(warning)));
    assert.equal(reopened.skills.some(skill => skill.name === 'review'), false);
  }
  const compactExport = join(base, 'aliases-compact.json');
  await exportAuditReport({ ...compact, kind: 'audit-run', schemaVersion: 1 }, { output: compactExport, format: 'json' });
  const compactReopened = await readAuditReport(compactExport);
  assert.equal(compactReopened.skills.some(skill => skill.name === 'review'), false);
  assert.ok(compactTrial.warnings.some(warning => warning.code === 'trial-warning-recorded'));
  assert.equal(JSON.stringify({ report, compact }).includes('/other/.agents'), false);
  assert.equal(JSON.stringify({ report, compact }).includes('PRIVATE'), false);
  assert.deepEqual(await readFile(rollout), original, 'historical rollout stays unchanged');
});

test('normalizes case-insensitive root labels and tolerates identical repeated declarations', async t => {
  const f = await fixture(t), task = id(203), turn = id(204), rollout = join(f.home, 'sessions', 'aliases-case.jsonl');
  const root = '/repo/.agents/skills'; const target = `${root}/review/SKILL.md`;
  const text = `<skills_instructions>\n- \`R0\` = \`${root}\`\n- \`r0\` = \`${root}\`\n- review: fixture (file: R0/review/SKILL.md)\n</skills_instructions>`;
  await seedIndex(f.home, task, rollout); await writeRollout(rollout, task, turn, text, target);
  const report = await auditNativeSession(f.store, 'A', task);
  const skill = report.skills.find(row => row.name === 'review');
  assert.equal(skill?.path, target);
  assert.equal(skill?.rootAlias, 'r0');
  assert.ok(skill?.observations.some(row => row.kind === 'definition-read-observed'));
  assert.equal(report.warnings.some(warning => /root alias/i.test(warning)), false);
});
