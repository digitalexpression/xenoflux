// Normal controller with disposable Git, profile roots and inert native wire peers.
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { inspectClaudeExecutable, resolveClaudeProfile } from '../src/claude-profile.js';
import { copilotAccountRoute, inspectCopilotExecutable, resolveCopilotProfile } from '../src/copilot-profile.js';
import { create } from '../src/profiles.js';
import { createEngineProvider } from '../src/ui-engine.js';
import { startUiServer } from '../src/ui-server.js';
import { seedNativeHistory } from './ui-review-browser-fixture.js';
import { createUiRunsFixture } from './ui-runs-fixture.js';

export const duplicateSession = '00000000-0000-4000-8000-000000000001';
export const pinnedCheck = 'test "$(cat README.md)" = "# Disposable U3 project"';

export async function createMixedClientFixture() {
  const base = await createUiRunsFixture({ mode: { mixedClaude: true } });
  const fixtureHome = join(base.root, 'default-user-home');
  const { homedir, username } = userInfo();
  const terminalEnvironment = { HOME: homedir, USER: username, LOGNAME: username, TMPDIR: '/private/tmp',
    PATH: [base.root, '/usr/bin', '/bin'].join(':') };
  const executable = join(base.root, 'copilot-fixture.js');
  const claude = join(base.root, 'claude');
  let server, provider;
  const profiles = {};
  try {
    await copyFile(new URL('../test/fixtures/copilot/cli.cjs', import.meta.url), executable);
    await copyFile(new URL('../test/fixtures/copilot/events.json', import.meta.url), join(base.root, 'events.json'));
    await chmod(executable, 0o700);
    await symlink(executable, join(base.root, 'copilot'));
    const script = await readFile(new URL('./mixed-codex-app-server.cjs', import.meta.url), 'utf8');
    await writeFile(base.executable, '#!' + await realpath(process.execPath) + '\n' + script, { mode: 0o700 });
    for (const [client, name, version, binary] of [
      ['claude-code', 'Claude managed', '2.1.319', await inspectClaudeExecutable(claude)],
      ['copilot', 'Copilot managed', '1.0.107', await inspectCopilotExecutable(executable)],
    ]) {
      const root = join(base.root, name), configRoot = join(root, 'config');
      await mkdir(configRoot, { recursive: true, mode: 0o700 });
      await mkdir(join(root, 'workspace'), { mode: 0o700 });
      await base.store.update(data => {
        const profile = create(data, name, '', client);
        profile.native = { ...binary, root, configRoot, rootMode: 'explicit', environmentId: randomUUID(), version };
        profile.repositories = [{ path: base.repository }];
        profiles[client] = profile;
      });
    }
    await seedNativeHistory(base, 'baseline', duplicateSession, 'baseline');
    const copilotRoot = profiles.copilot.native.configRoot, claudeRoot = profiles['claude-code'].native.configRoot;
    const copilotConfig = join(copilotRoot, 'fixture.json');
    await writeFile(copilotConfig, JSON.stringify({ label: 'Private Copilot list title', storedText: 'Stored Copilot answer.', noTools: true }), { mode: 0o600 });
    await writeFile(join(claudeRoot, 'settings.json'), '{"model":"sonnet"}\n', { mode: 0o600 });
    await writeFile(join(fixtureHome, '.claude', 'settings.json'), '{"model":"haiku"}\n', { mode: 0o600 });
    const parent = join(claudeRoot, 'projects', '-private-claude-folder');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const transcript = join(parent, duplicateSession + '.jsonl');
    const nativeTime = new Date().toISOString();
    const rows = [
      { type: 'user', sessionId: duplicateSession, uuid: randomUUID(), timestamp: nativeTime, cwd: '/private-claude-folder',
        message: { role: 'user', content: 'Synthetic opening prompt.' } },
      { type: 'assistant', sessionId: duplicateSession, uuid: randomUUID(), timestamp: nativeTime, cwd: '/private-claude-folder',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Stored Claude answer.' }] } },
      { type: 'custom-title', sessionId: duplicateSession, customTitle: 'Private Claude list title' },
    ];
    await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });

    const profileResolvers = {
      'claude-code': options => resolveClaudeProfile({ ...options, defaultUserHome: fixtureHome }),
      copilot: async options => {
        if (!options.selected) throw new Error('Only the disposable managed Copilot root is configured.');
        const profile = await resolveCopilotProfile({ ...options, defaultUserHome: homedir });
        // Reuse the captured fixture account-route qualification. Dispatch still
        // checks the actual bound binary, workspace and fixture account response.
        profile.accountQualification = { scope: 'shared', authType: 'gh-cli', sdk: '1.0.29',
          rootMode: 'explicit', runtimeVersion: '1.0.107', executableIdentity: profile.executableIdentity,
          route: copilotAccountRoute(profile.environmentBinding), expiresAt: Number.MAX_SAFE_INTEGER };
        return profile;
      },
    };
    const context = { terminalEnvironment, profileResolvers };
    provider = createEngineProvider({ store: base.store, reportsRoot: base.reportsRoot, defaultUserHome: fixtureHome,
      runContext: context, catalogContext: context, reviewContext: context,
      lockOptions: { lockPath: join(base.root, 'mixed-operation.lock'), concurrentLockPath: join(base.root, 'mixed-desktop.lock') } });
    server = await startUiServer({ provider, staticRoot: join(process.cwd(), 'dist/ui') });
    return { ...base, url: server.launchUrl, origin: server.origin, provider, profiles, copilotConfig, transcript,
      close: async () => { await provider.close(); await server.close(); await base.close(); } };
  } catch (error) {
    await provider?.close();
    await server?.close();
    await base.close();
    throw error;
  }
}
