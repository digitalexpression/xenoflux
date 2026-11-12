// The surface boundary keeps UI operations on the existing journal/ownership path.
import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DESKTOP_APP } from './desktop-runtime.js';
import { createDesktopInstanceRuntime } from './desktop-instance-runtime.js';
import { focusDesktopInstance, listDesktopInstances, openDesktopInstance } from './desktop-instances.js';
import { capabilityState } from './client-contracts.js';

export function createCodexDesktopSurface(store, { runtime = createDesktopInstanceRuntime(),
  execFile = promisify(nodeExecFile), ...options } = {}) {
  const operationOptions = extra => ({ ...options, ...extra, runtime });
  return {
    async openDefault() { await execFile('/usr/bin/open', ['-b', DESKTOP_APP.bundleId], { timeout: 15000 }); },
    open: (name, extra) => openDesktopInstance(store, name, operationOptions(extra)),
    focus: (name, extra) => focusDesktopInstance(store, name, operationOptions(extra)),
    list: extra => listDesktopInstances(store, operationOptions(extra)),
    snapshot: () => runtime.snapshot(),
    async inspect() {
      // Re-observe every time: an installed update must not inherit qualifications.
      const app = await runtime.inspectApp();
      const context = { client: 'codex', surface: 'desktop', executionLocation: 'local',
        app: { appPath: app.appPath, bundleId: app.bundleId, executable: app.executable,
          version: app.version ?? null, build: app.build ?? null, asarSha256: app.asarSha256 ?? null },
        backend: { identity: null, build: null },
        routes: { config: null, data: null, callback: null } };
      return { context,
        contextKey: createHash('sha256').update(JSON.stringify(context)).digest('hex'),
        observedAt: new Date().toISOString(),
        // Existing lifecycle implementation is available; fixtures do not qualify native isolation.
        implementation: { openDefault: 'supported', open: 'supported', focus: 'supported', inspect: 'supported' },
        capabilities: Object.fromEntries(['launch', 'focus', 'managedProfiles', 'modelEffort',
          'exactSessionHandoff', 'sessionImport', 'automatedExecution'].map(name => [name, capabilityState(null)])),
        nativeAcceptance: 'pending' };
    },
  };
}
