import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createEnvironmentBinding } from '../src/client-contracts.js';
import { importClaudeSession, listClaudeSessions } from '../src/claude-sessions.js';

const id = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const assistant = '33333333-3333-4333-8333-333333333333';
const bytes = JSON.stringify({ type: 'user', uuid: user, sessionId: id, parentUuid: null, timestamp: '2026-11-10T00:00:00Z',
  cwd: '/disposable/project', message: { role: 'user', content: 'Fixture prompt' } }) + '\n' +
  JSON.stringify({ type: 'assistant', uuid: assistant, sessionId: id, parentUuid: user, timestamp: '2026-11-10T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Fixture answer' }] } }) + '\n';

async function fixture(t) {
  const root = await mkdtemp('/private/tmp/xfx-claude-sessions-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = join(root, 'user'), home = join(root, 'managed', 'config'), stock = join(userHome, '.claude');
  for (const path of [join(home, 'projects', 'fixture'), join(stock, 'projects', 'fixture')]) await mkdir(path, { recursive: true, mode: 0o700 });
  const session = target => join(target, 'projects', 'fixture', id + '.jsonl');
  await writeFile(session(stock), bytes.replace('Fixture answer', 'STOCK PRIVATE'), { mode: 0o600 });
  const profile = (target = home, rootMode = 'explicit') => {
    const profileId = 'claude-session-profile';
    return { userHome, home: target, rootMode, profileId, profileName: 'Fixture Claude',
      environmentBinding: createEnvironmentBinding({ profileId, client: 'claude-code', surface: 'cli', executionLocation: 'local',
        rootMode, roots: { config: target, runtime: target, reservation: dirname(target), user: userHome }, workspace: null,
        executable: { path: '/bin/false', identity: 'synthetic', version: null }, settingsIdentity: null }) };
  };
  return { root, profile, home, stock, session };
}
test('SDK lists only the selected root and imports that exact private source', async t => {
  const f = await fixture(t);
  assert.deepEqual(await listClaudeSessions(f.profile()), { sessions: [], nextOffset: null });
  await writeFile(f.session(f.home), bytes, { mode: 0o600 });
  const { sessions } = await listClaudeSessions(f.profile(), { limit: 1 });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  const result = await importClaudeSession(f.profile(), sessions[0].selection, { directory: join(f.root, 'import') });
  assert.equal(result.profile.profileId, 'claude-session-profile');
  assert.equal(result.nativeReference.sessionId, id);
  assert.equal(result.sessionReplay.sessions[0].events.at(-1).body, 'Fixture answer');
  await assert.rejects(importClaudeSession(f.profile(f.stock, 'implicit'), sessions[0].selection, { directory: join(f.root, 'other') }), /binding/);
  await writeFile(f.session(f.home), bytes.replace('Fixture answer', 'Changed source'));
  await assert.rejects(importClaudeSession(f.profile(), sessions[0].selection, { directory: join(f.root, 'changed') }), /unavailable or changed/);
});
test('Claude listing refuses a link to another profile before running the SDK file reader', async t => {
  const f = await fixture(t);
  await symlink(f.session(f.stock), f.session(f.home));
  await assert.rejects(listClaudeSessions(f.profile()), /unavailable or changed/);
});
