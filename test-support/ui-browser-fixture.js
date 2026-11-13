import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, create } from '../src/profiles.js';
import { registerHome } from '../src/homes.js';
import { nativeClient } from '../src/profile-command.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';
import { createDesktopRuntime } from '../src/desktop-runtime.js';
import { prepareNativeHome } from './native-home-fixture.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const skillLines = Array.from({ length: 15 }, (_, i) => `strict-only line ${i + 1}`);
const prefix = `shared-${'a'.repeat(82)}`;
const longSkillNames = [`${prefix}-first`, `${prefix}-second`];
const privacyMarkers = {
  credential: 'UI_CREDENTIAL_DO_NOT_EXPORT', source: 'UI_SOURCE_BODY_DO_NOT_EXPORT',
  prompt: 'UI_PROMPT_DO_NOT_EXPORT', output: 'UI_TOOL_OUTPUT_DO_NOT_EXPORT',
};
const put = async (base, relative, text) => {
  const path = join(base, relative);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  return path;
};

async function addSession(home, n, title, source, updatedAt) {
  const taskId = id(n), rollout = join(home, 'sessions', '2026', '10', '15', `rollout-${taskId}.jsonl`);
  await mkdir(dirname(rollout), { recursive: true, mode: 0o700 });
  const originator = source === 'vscode' ? 'Codex Desktop' : 'codex_cli';
  const rows = [
    { timestamp: '2026-10-15T08:00:00.000Z', type: 'session_meta', payload: { id: taskId, cli_version: '0.153.4', originator, cwd: '/workspace/project' } },
    { timestamp: '2026-10-15T08:00:01.000Z', type: 'turn_context', payload: { turn_id: id(n + 10000), cwd: '/workspace/project', model: 'fixture-model', effort: 'medium' } },
    ...(n === 1 ? [{ timestamp: '2026-10-15T08:00:01.100Z', type: 'event_msg', payload: { type: 'user_message', message: privacyMarkers.prompt } }] : []),
    ...(n <= 2 ? recordedActions(n + 10000, source) : []),
    { timestamp: '2026-10-15T08:00:09.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: id(n + 10000), success: true } },
  ];
  await writeFile(rollout, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, source TEXT, rollout_path TEXT);');
  db.prepare('INSERT INTO threads (id,cwd,title,created_at,updated_at,archived,source,rollout_path) VALUES (?,?,?,?,?,?,?,?)')
    .run(taskId, '/workspace/project', title, updatedAt - 1, updatedAt, 0, source, rollout);
  db.close();
  return rollout;
}

function recordedActions(turnNumber, source) {
  const turn = id(turnNumber), start = '2026-10-15T08:00:';
  const readId = `read-${turnNumber}`, editId = `edit-${turnNumber}`;
  const patch = '*** Begin Patch\n*** Update File: src/date.js\n@@\n-old date\n+new date\n*** End Patch';
  const action = (callId, input, second) => [
    { timestamp: `${start}${second}.000Z`, type: 'response_item', payload: { type: 'custom_tool_call', turn_id: turn, call_id: callId, name: 'exec', input } },
    { timestamp: `${start}${second}.250Z`, type: 'response_item', payload: { type: 'custom_tool_call_output', turn_id: turn, call_id: callId,
      output: [{ type: 'input_text', text: JSON.stringify({ exit_code: 0, stdout: privacyMarkers.output }) }] } },
  ];
  const read = action(readId, 'text(await tools.exec_command({cmd:"cat src/date.js",workdir:"/workspace/project"}));', source === 'vscode' ? '06' : '02');
  const edit = action(editId, `text(await tools.apply_patch(${JSON.stringify(patch)}));`, source === 'vscode' ? '02' : '06');
  const functionRead = source === 'cli' ? [
    { timestamp: `${start}01.500Z`, type: 'response_item', payload: { type: 'function_call', turn_id: turn, name: 'functions.exec', call_id: `tool-read-${turnNumber}`,
      arguments: JSON.stringify({ code: 'await tools.exec_command({cmd:"cat src/date.js"})' }) } },
    { timestamp: `${start}01.750Z`, type: 'response_item', payload: { type: 'function_call_output', turn_id: turn, call_id: `tool-read-${turnNumber}`, output: 'Read src/date.js successfully.' } },
  ] : [];
  return [
    { timestamp: `${start}00.500Z`, type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
    ...(source === 'vscode' ? [...edit, ...read] : [...functionRead, ...read, ...edit]),
  ];
}

/** Build a disposable, real-engine app fixture. No Codex client is launched. */
export async function createUiBrowserFixture({ staticRoot = join(process.cwd(), 'dist', 'ui'), setupInspection = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-ui-browser-')));
  let server;
  try {
    const executable = join(root, 'codex');
    await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex 0.153.4\\n"; exit 0; fi\nexit 99\n', { mode: 0o700 });
    const [baseline, strict] = await Promise.all(['baseline', 'strict-review'].map(name =>
      prepareNativeHome({ directory: join(root, `native-${name}`), executable, codexVersion: '0.153.4' })));
    const store = new Store(join(root, 'store'));
    await store.update(data => { create(data, 'baseline'); create(data, 'strict-review'); });
    await registerHome(store, 'baseline', baseline.root, { executable, version: '0.153.4' });
    await registerHome(store, 'strict-review', strict.root, { executable, version: '0.153.4' });
    const instructions = {
      baseline: await put(baseline.home, 'AGENTS.md', `Run the test suite before proposing a commit.\n${privacyMarkers.source}\n`),
      strict: await put(strict.home, 'AGENTS.md', 'Run the full test suite and lint before proposing a commit.\nExplain every skipped check.\n'),
    };
    await put(baseline.home, 'config.toml', 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\nmodel_reasoning_effort = "medium"\n');
    await put(strict.home, 'config.toml', 'allow_symlinked_codex_home = true\ncli_auth_credentials_store = "file"\nmodel_reasoning_effort = "high"\n');
    await put(baseline.home, 'auth.json', JSON.stringify({ fixture: privacyMarkers.credential }) + '\n');
    const common = '---\nname: review-helper\ndescription: Review changes.\n---\nCheck the diff.\n';
    await put(baseline.home, 'skills/review-helper/SKILL.md', common);
    await put(strict.home, 'skills/review-helper/SKILL.md', common);
    await put(strict.home, 'skills/review-helper/extra.txt', `${skillLines.join('\n')}\n`);
    for (const name of longSkillNames) await put(strict.home, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Long fixture skill.\n---\nReview.\n`);
    const defaultUserHome = join(root, 'default-user-home');
    await mkdir(join(defaultUserHome, '.codex'), { recursive: true, mode: 0o700 });
    await put(join(defaultUserHome, '.codex'), 'AGENTS.md', 'Default instructions.\n');
    await put(join(defaultUserHome, '.claude'), 'CLAUDE.md', 'Claude fixture instructions.\n');
    const claudeExecutable = join(root, 'claude');
    await symlink(await realpath(process.execPath), join(root, 'node'));
    const nativeProfileLog = join(root, 'claude-launches.log');
    await writeFile(claudeExecutable, `#!/bin/sh
printf '%s\\n' "$*" >> "${nativeProfileLog}"
case "$*" in
  --version) printf '2.1.319 (Claude Code)\\n' ;;
  'auth status') printf '{"loggedIn":false,"authMethod":"none"}\\n'; exit 1 ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    let setupSources = null;
    if (setupInspection) {
      const repository = await realpath(await mkdir(join(root, 'inspection-project'), { recursive: true }).then(() => join(root, 'inspection-project')));
      await put(repository, 'AGENTS.md', 'Project Codex inspection instruction.\n');
      await put(repository, 'CLAUDE.md', 'Project Claude inspection instruction.\n');
      await put(repository, '.github/copilot-instructions.md', 'Project Copilot inspection instruction.\n');
      const nativeRoots = {};
      const identity = (await store.read()).profiles.find(profile => profile.name === 'baseline').native.executableIdentity;
      for (const [client, name] of [['claude-code', 'Claude source'], ['copilot', 'Copilot source']]) {
        const nativeRoot = join(root, `${client}-source`), configRoot = join(nativeRoot, 'config');
        await mkdir(configRoot, { recursive: true, mode: 0o700 });
        await store.update(data => {
          const profile = create(data, name, '', client);
          profile.native = { environmentId: randomUUID(), root: nativeRoot, configRoot, rootMode: 'explicit',
            executable: join(root, `${client}-missing-cli`), executableIdentity: identity, version: '1.0.0' };
        });
        await put(configRoot, 'settings.json', JSON.stringify({ model: `${client}-fixture`, theme: 'dark',
          mcpServers: { 'source-tools': { command: '/fixture/source-server', args: ['--local'], enabled: false } },
          hooks: { SessionStart: [{ command: '/fixture/source-hook' }] }, enabledPlugins: { 'source-plugin@fixture': false } }) + '\n');
        await put(configRoot, client === 'claude-code' ? 'CLAUDE.md' : 'copilot-instructions.md', `${client} profile inspection instruction.\n`);
        await put(configRoot, 'skills/source-helper/SKILL.md', '---\nname: source-helper\ndescription: Inspect source evidence.\n---\nKeep the inspection source text visible.\n');
        await put(configRoot, 'skills/source-helper/scripts/check.sh', 'echo source-inspection-fixture\n');
        nativeRoots[client] = configRoot;
      }
      await put(join(defaultUserHome, '.copilot'), 'copilot-instructions.md', 'Default Copilot fixture instruction.\n');
      const colon = await prepareNativeHome({ directory: join(root, 'native-colon'), executable, codexVersion: '0.153.4' });
      await store.update(data => { create(data, 'codex:with:colon'); });
      await registerHome(store, 'codex:with:colon', colon.root, { executable, version: '0.153.4' });
      await put(colon.home, 'AGENTS.md', 'Colon profile inspection instruction.\n');
      setupSources = { repository, nativeRoots, colon };
    }
    const rollouts = [];
    rollouts.push(await addSession(baseline.home, 1, 'Fix the date test', 'cli', 10));
    rollouts.push(await addSession(strict.home, 2, 'Fix the date test', 'vscode', 11));
    rollouts.push(await addSession(baseline.home, 3, 'Other task', 'cli', 12));
    rollouts.push(await addSession(baseline.home, 4, 'Rare older task', 'cli', 13));
    for (let i = 0; i < 101; i++) rollouts.push(await addSession(baseline.home, 100 + i, `Filler task ${i + 1}`, 'cli', 100 + i));
    const reportsRoot = join(root, 'reports');
    const serverLogs = [];
    const terminalEnvironment = { PATH: root + ':/usr/bin:/bin', HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME };
    const provider = createEngineProvider({ store, reportsRoot, defaultUserHome, profilesBase: join(root, 'profiles'),
      resolveClient: signal => nativeClient(store, { '--codex': executable }, signal),
      stockApps: { list: async () => [], open: async () => { throw new Error('No fixture stock app is installed'); } },
      discoveryContext: { inspectDesktop: async () => { throw new Error('No fixture desktop app is installed'); } },
      runContext: { terminalEnvironment },
      reviewContext: { terminalEnvironment },
      catalogContext: { terminalEnvironment },
      accountContext: { terminalEnvironment },
      lockOptions: { lockPath: join(root, 'global.lock'), concurrentLockPath: join(root, 'desktop.lock') },
      // Isolate only OS process discovery to this fixture's empty process table.
      // Real DesktopRuntime idle guards still run; no client-control operation is called.
      copyRuntime: () => createDesktopRuntime({ concurrentLockPath: join(root, 'desktop.lock'),
        processSnapshot: async () => [{ pid: process.pid, ppid: 1, uid: process.getuid(), startedAt: 'fixture', executable: process.execPath }] }),
    });
    server = await startUiServer({ provider, staticRoot, log: message => serverLogs.push(message) });
    return { url: server.launchUrl, origin: server.origin, root, store,
      homes: { baseline, strict }, defaultUserHome, reportsRoot, rollouts, instructions, skillLines, longSkillNames, privacyMarkers, nativeProfileLog,
      serverLogs, setupSources,
      close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    if (server) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
