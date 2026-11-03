// `xfx ui`: one launch action that starts the local app (or reuses a running
// one for the same store) and opens it in the default browser.
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startUiServer, randomToken } from './ui-server.js';

export const UI_STATIC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

async function readState(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return Number.isSafeInteger(value?.pid) && Number.isSafeInteger(value?.port) && typeof value?.launchToken === 'string' ? value : null;
  } catch { return null; }
}

async function answers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return response.status < 500 && response.headers.get('content-security-policy') !== null;
  } catch { return false; }
}

export function openInBrowser(url) {
  return new Promise((done, reject) => execFile('open', [url], error => error ? reject(error) : done()));
}

/**
 * Start or reuse the app. Resolves once the server is listening, with
 * `{ url, reused, closed }`; `closed` settles when the server stops.
 */
export async function runUi({ store, provider, demo = false, port = 0, openBrowser = true, staticRoot = UI_STATIC_ROOT,
  open = openInBrowser, out = text => process.stdout.write(text), signals = true } = {}) {
  const stateFile = join(store.directory, demo ? 'ui-demo-server.json' : 'ui-server.json');
  const existing = await readState(stateFile);
  if (existing && existing.pid !== process.pid && alive(existing.pid) && await answers(existing.port)) {
    const url = `http://127.0.0.1:${existing.port}/#launch=${existing.launchToken}`;
    out(`Xenoflux is already running at http://127.0.0.1:${existing.port}/\n`);
    if (openBrowser) await open(url);
    return { url, reused: true, closed: Promise.resolve() };
  }

  const launchToken = randomToken();
  let server;
  try { server = await startUiServer({ provider, staticRoot, port, launchToken, log: text => process.stderr.write(`${text}\n`) }); }
  catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(`Port ${port} is in use by another program. Run xfx ui without --port to choose a free port.`);
    throw error;
  }
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  const temporary = join(store.directory, `.ui-server-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify({ pid: process.pid, port: server.port, launchToken, demo })}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, stateFile);

  let finish;
  const closed = new Promise(done => { finish = done; });
  let stopping;
  const stop = () => stopping ??= (async () => {
    await provider.close?.();
    await server.close();
    const current = await readState(stateFile);
    if (current?.pid === process.pid && current.port === server.port) await unlink(stateFile).catch(() => {});
    finish();
  })();
  if (signals) for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop().then(() => process.exit(0)); });

  out(`Xenoflux${demo ? ' (demo data)' : ''} is running at ${server.origin}/\n`
    + 'Keep this window open while you use the app. Press Ctrl+C to stop it; running tasks keep their own records.\n');
  if (openBrowser) await open(server.launchUrl).catch(() => out(`Open this link in your browser: ${server.launchUrl}\n`));
  else out(`Open this link in your browser: ${server.launchUrl}\n`);
  return { url: server.launchUrl, origin: server.origin, reused: false, closed, stop };
}
