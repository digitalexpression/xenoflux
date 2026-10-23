// Version is descriptive evidence, not a native capability allowlist. Even the
// metadata-only probe runs with saved profile definitions protected from writes.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareAuditStartup } from './audit-startup.js';
import { probeVersion } from './version-probe.js';

export async function probeAuditVersion(options) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-version-')));
  let preserve = false;
  try {
    const launch = await prepareAuditStartup({
      profile: { home: options.env?.CODEX_HOME, userHome: options.env?.HOME, executable: options.executable },
      directory: join(directory, 'policy'), args: ['--version'],
    });
    try { return await probeVersion({ ...options, executable: launch.executable, args: launch.args }); }
    catch (error) {
      // A version flag/output shape is not the app-server capability contract.
      // The execution capture validates initialize and skills/list directly.
      if (['VERSION_MISMATCH', 'PROTOCOL_ERROR', 'OUTPUT_LIMIT', 'RPC_TIMEOUT'].includes(error?.code)) return null;
      throw error;
    }
  } catch (error) {
    preserve = error.code === 'SHUTDOWN_FAILED';
    throw error;
  } finally {
    if (!preserve) await rm(directory, { recursive: true, force: true });
  }
}
