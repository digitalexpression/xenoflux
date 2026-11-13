// Stock app opening uses the app's existing native account, independently of managed profiles.
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const STOCK_DESKTOP_APPS = Object.freeze({
  claude: { name: 'Claude', path: '/Applications/Claude.app', bundleId: 'com.anthropic.claudefordesktop', teamIdentifier: 'Q6L2SF6YDW' },
  copilot: { name: 'GitHub Copilot', path: '/Applications/GitHub Copilot.app', bundleId: 'com.github.githubapp', teamIdentifier: 'VEKTX9H2N7' },
});
const APPS = STOCK_DESKTOP_APPS;
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\p{Cc}\p{Cf}]/u.test(value);

async function executableIdentity(path) {
  if (await realpath(path) !== path) throw new Error('App executable path is not canonical');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !(before.mode & 0o111)) throw new Error('App executable is unavailable');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('App executable changed while inspecting');
    return { dev: after.dev, ino: after.ino, size: after.size, mode: after.mode, mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}

export function createStockDesktopApps({ execFile = promisify(execFileCallback), appPaths = {} } = {}) {
  async function inspect(client, binding = false) {
    const app = APPS[client];
    if (!app) throw new Error('Unsupported stock desktop client');
    const path = appPaths[client] ?? app.path;
    try {
      if (!path.startsWith('/') || resolve(path) !== path || await realpath(path) !== path || !(await lstat(path)).isDirectory())
        throw new Error('App bundle path is not canonical');
      const metadata = async () => {
        const { stdout } = await execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents', 'Info.plist')], { maxBuffer: 1024 * 1024, timeout: 15000 });
        const info = JSON.parse(stdout);
        if (info.CFBundleIdentifier !== app.bundleId || !text(info.CFBundleExecutable)
          || info.CFBundleExecutable.includes('/') || !text(info.CFBundleShortVersionString) || !text(info.CFBundleVersion))
          throw new Error('App bundle identity is unavailable');
        return { bundleId: info.CFBundleIdentifier, executable: info.CFBundleExecutable,
          version: info.CFBundleShortVersionString, build: info.CFBundleVersion,
          urlSchemes: [...new Set((Array.isArray(info.CFBundleURLTypes) ? info.CFBundleURLTypes : [])
            .flatMap(type => Array.isArray(type?.CFBundleURLSchemes) ? type.CFBundleURLSchemes : [])
            .filter(scheme => typeof scheme === 'string' && /^[A-Za-z][A-Za-z0-9+.-]{0,127}$/.test(scheme)))].sort() };
      };
      const info = await metadata();
      const executable = join(path, 'Contents', 'MacOS', info.executable);
      const identity = await executableIdentity(executable);
      await execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', path], { maxBuffer: 1024 * 1024, timeout: 15000 });
      const signature = await execFile('/usr/bin/codesign', ['--display', '--verbose=4', path], { maxBuffer: 1024 * 1024, timeout: 15000 });
      const details = `${signature.stdout ?? ''}\n${signature.stderr ?? ''}`;
      const signing = Object.fromEntries(['Identifier', 'TeamIdentifier', 'CDHash'].map(key => [key, details.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1] ?? null]));
      if (signing.Identifier !== app.bundleId || signing.TeamIdentifier !== app.teamIdentifier || !text(signing.CDHash))
        throw new Error('App signing identity is unavailable');
      if (JSON.stringify(info) !== JSON.stringify(await metadata()) || JSON.stringify(identity) !== JSON.stringify(await executableIdentity(executable)))
        throw new Error('App identity changed while inspecting');
      const scope = { client, path, ...info, identity, signing };
      return { client, name: app.name, status: 'available', appKey: hash(JSON.stringify(scope)), path,
        bundleId: info.bundleId, version: info.version, build: info.build, teamIdentifier: signing.TeamIdentifier,
        sessionNavigation: client === 'copilot' && info.urlSchemes.includes('ghapp') ? 'available' : 'unavailable',
        ...(binding ? { executable, executableIdentity: identity } : {}) };
    } catch { return { client, name: app.name, status: 'unavailable' }; }
  }
  return {
    locations: Object.keys(APPS).map(client => appPaths[client] ?? APPS[client].path),
    async list() { return Promise.all(Object.keys(APPS).map(client => inspect(client))); },
    async binding({ client, appKey }) {
      if (!Object.hasOwn(APPS, client) || typeof appKey !== 'string' || !/^[a-f0-9]{64}$/.test(appKey))
        throw new Error('Desktop app identity is required');
      const app = await inspect(client, true);
      if (app.status !== 'available' || app.appKey !== appKey) throw new Error('Desktop app changed or is unavailable; refresh installed apps');
      return app;
    },
    async open({ client, appKey, sessionId } = {}) {
      if (!Object.hasOwn(APPS, client)) throw new Error('Unsupported stock desktop client');
      if (sessionId !== undefined && (client !== 'copilot' || typeof sessionId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId))) throw new Error('Copilot navigation requires a valid app-local session ID');
      if (typeof appKey !== 'string' || !/^[a-f0-9]{64}$/.test(appKey)) throw new Error('Stock app identity is required');
      const app = await inspect(client);
      if (app.status !== 'available' || app.appKey !== appKey) throw new Error('Stock app changed or is unavailable; refresh the installed apps');
      if (sessionId !== undefined && app.sessionNavigation !== 'available')
        throw new Error('This Copilot app does not register the ghapp session navigation scheme');
      await execFile('/usr/bin/open', ['-a', app.path, ...(sessionId !== undefined ? [`ghapp://sessions/${sessionId}`] : [])], { maxBuffer: 1024 * 1024, timeout: 15000 });
      if (sessionId !== undefined) return { status: 'link-opened', message: `Opened GitHub Copilot link for app-local session ${sessionId}. Session association and completion are not confirmed; no new task was requested.` };
      return { status: 'opened', message: `Opened ${app.name} using its existing setup. No managed profile was selected; sign-in and task execution were not checked.` };
    },
  };
}
