// Read-only client state for the Profiles screen: which processes hold a
// profile's Codex files, and whether each holder belongs to a Codex Desktop app
// or a standalone CLI. Inspection never closes, signals or starts anything.
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { inspectNativeResources } from './audit-profile.js';
import { createCodexDesktopSurface } from './desktop-surface.js';

const TARGETS = ['config.toml', 'auth.json', 'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm'];

async function presentTargets(home) {
  const present = [];
  for (const name of TARGETS) {
    const path = join(home, name);
    try { const info = await lstat(path); if (info.isFile() && !info.isSymbolicLink()) present.push(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return present;
}

const insideApp = executable => /\.app\/Contents\//.test(executable ?? '');

/**
 * Classify the holders of one home's files. `desktopRunning` is the named
 * instance journal's observation when there is one. Unknown is never idle.
 */
export async function observeProfileClients(home, { desktopRunning = null, inspect = inspectNativeResources,
  desktopSurface = createCodexDesktopSurface(), snapshot = () => desktopSurface.snapshot() } = {}) {
  let holders, rows;
  try {
    holders = (await inspect(await presentTargets(home))).clients;
    rows = holders.length ? await snapshot() : [];
  } catch {
    return { cli: { state: 'unknown', text: 'unknown (couldn’t check)' }, desktop: { state: desktopRunning ? 'running' : 'unknown', text: desktopRunning ? 'open' : 'unknown (couldn’t check)' } };
  }
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const fromApp = pid => {
    const seen = new Set();
    for (let row = byPid.get(pid); row && !seen.has(row.pid); row = byPid.get(row.ppid)) {
      seen.add(row.pid);
      if (insideApp(row.executable)) return true;
    }
    return false;
  };
  const desktopHolders = holders.filter(holder => fromApp(holder.pid));
  const others = holders.filter(holder => !fromApp(holder.pid));
  const cliHolders = others.filter(holder => /codex/i.test(basename(byPid.get(holder.pid)?.executable ?? holder.command)));
  const foreign = others.filter(holder => !cliHolders.includes(holder));
  const desktopOpen = desktopRunning === true || desktopHolders.length > 0;
  const cli = cliHolders.length ? { state: 'running', text: `running (PID ${cliHolders.map(h => h.pid).join(', ')})` }
    : desktopOpen ? { state: 'unavailable', text: 'not available while its Desktop is open' }
      : foreign.length ? { state: 'unknown', text: `files in use by ${[...new Set(foreign.map(h => h.command))].join(', ')}` }
        : { state: 'not-running', text: 'not running' };
  return { cli, desktop: desktopOpen ? { state: 'running', text: 'open' } : { state: 'not-running', text: 'not running' } };
}
