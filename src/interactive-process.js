// An intentionally narrow interactive process owner.  It never captures a
// terminal stream or consults the caller environment: callers must supply the
// executable, working directory, arguments, and complete environment.
import { spawn } from 'node:child_process';

const MESSAGES = {
  INVALID_OPTIONS: 'Invalid interactive process options',
  UNSUPPORTED_PLATFORM: 'Interactive process requires macOS or Linux',
  CANCELLED: 'Interactive process cancelled',
  SPAWN_FAILED: 'Unable to start interactive process',
  ON_SPAWN_FAILED: 'Interactive process setup failed',
  SHUTDOWN_FAILED: 'Interactive process shutdown failed',
};

export class InteractiveProcessError extends Error {
  constructor(code) {
    super(MESSAGES[code] || 'Interactive process failed');
    this.name = 'InteractiveProcessError';
    this.code = code;
  }
}

const error = code => new InteractiveProcessError(code);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function validOptions({ executable, args, cwd, env, signal, onSpawn, testStdio }) {
  if (typeof executable !== 'string' || !executable.startsWith('/') || executable.includes('\0') ||
      !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0') ||
      !env || Object.getPrototypeOf(env) !== Object.prototype ||
      Object.entries(env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')) ||
      (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) ||
      (onSpawn !== undefined && typeof onSpawn !== 'function') ||
      (testStdio !== undefined && testStdio !== 'ignore')) throw error('INVALID_OPTIONS');
}

/**
 * Run a user-facing client in a detached, caller-owned process group.
 *
 * The production path always inherits stdin/stdout/stderr, so TUIs and login
 * prompts remain attached to the invoking terminal.  `testStdio: 'ignore'`
 * exists solely for deterministic synthetic-child tests and never captures
 * terminal output.  The parent owns its signal policy; an AbortSignal is the
 * explicit request to terminate this child group.
 */
export async function runInteractive({
  executable,
  args = [],
  cwd,
  env,
  signal,
  onSpawn,
  testStdio,
} = {}) {
  validOptions({ executable, args, cwd, env, signal, onSpawn, testStdio });
  if (!['darwin', 'linux'].includes(process.platform)) throw error('UNSUPPORTED_PLATFORM');
  if (signal?.aborted) throw error('CANCELLED');

  let child;
  try {
    child = spawn(executable, args, {
      cwd,
      env: { ...env },
      shell: false,
      detached: true,
      stdio: testStdio === 'ignore' ? 'ignore' : 'inherit',
    });
  } catch {
    throw error('SPAWN_FAILED');
  }

  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; } catch (caught) { return caught?.code === 'EPERM'; }
  };
  const waitForGroup = async ms => {
    const until = Date.now() + ms;
    while (groupAlive() && Date.now() < until) await delay(Math.min(25, Math.max(1, until - Date.now())));
    return !groupAlive();
  };
  const signalGroup = kind => {
    if (!groupAlive()) return;
    try { process.kill(-child.pid, kind); } catch { /* verified by waitForGroup */ }
  };

  // A normal leader exit does not prove that a descendant has not kept the
  // group alive.  Always reap the owned group before reporting success.
  const cleanup = async () => {
    if (!(await waitForGroup(100))) {
      signalGroup('SIGTERM');
      if (!(await waitForGroup(500))) {
        signalGroup('SIGKILL');
        if (!(await waitForGroup(1000))) throw error('SHUTDOWN_FAILED');
      }
    }
    return { groupTerminated: true, escapedDescendantsUnverified: true };
  };

  let abortHandler;
  // A detached child group no longer receives the invoking terminal's resize
  // signal.  Forward only SIGWINCH; termination remains the coordinator's
  // responsibility through its AbortSignal.
  const winchHandler = () => signalGroup('SIGWINCH');
  process.on('SIGWINCH', winchHandler);
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  let exitObserved = false;
  let exitCode = null;
  let exitSignal = null;
  child.once('exit', (code, childSignal) => {
    exitObserved = true;
    exitCode = code;
    exitSignal = childSignal;
    resolveExit({ kind: 'exit' });
  });
  child.once('error', () => resolveExit({ kind: 'error' }));

  let abortRequested = false;
  abortHandler = () => {
    abortRequested = true;
    resolveExit({ kind: 'cancelled' });
  };
  if (signal) signal.addEventListener('abort', abortHandler, { once: true });

  try {
    if (onSpawn) {
      try { await onSpawn(child.pid); }
      catch {
        await cleanup();
        throw error('ON_SPAWN_FAILED');
      }
    }

    const outcome = await exited;
    // An abort racing a normal exit is still a cancellation request: the caller
    // cannot safely treat that run as a completed interactive operation.
    if (outcome.kind === 'cancelled' || abortRequested || signal?.aborted) {
      await cleanup();
      throw error('CANCELLED');
    }
    if (outcome.kind === 'error' && !exitObserved) {
      await cleanup();
      throw error('SPAWN_FAILED');
    }
    const shutdown = await cleanup();
    return { exitCode, signal: exitSignal, shutdown };
  } finally {
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    process.off('SIGWINCH', winchHandler);
  }
}
