import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { UiError } from './ui-server.js';

const active = state => ['starting', 'waiting-for-browser', 'verifying'].includes(state);
const openBrowser = url => new Promise((resolve, reject) => execFile('/usr/bin/open', [url], { timeout: 10000 }, error => error ? reject(error) : resolve()));

export function createUiSignins({ nativeProfiles, select, invalidate = () => {}, browser = openBrowser }) {
  const attempts = new Map();
  let closing = false;
  const view = attempt => structuredClone(attempt.value);
  const get = ({ id }) => {
    const attempt = attempts.get(id);
    if (!attempt) throw new UiError(404, 'This sign-in attempt is no longer available. Start sign-in again.', 'signin-not-found');
    return view(attempt);
  };
  async function start({ name }) {
    if (closing) throw new UiError(409, 'Xenoflux is stopping.', 'closing');
    const selected = await select(name);
    if (closing) throw new UiError(409, 'Xenoflux is stopping.', 'closing');
    const client = selected.client;
    const scope = client === 'copilot' ? 'copilot' : selected.id;
    const previous = [...attempts.values()].find(attempt => attempt.scope === scope && active(attempt.value.state));
    if (previous) {
      if (previous.value.profileName !== selected.name)
        throw new UiError(409, `GitHub sign-in is already running for ${previous.value.profileName}. Finish it before signing in to another Copilot profile.`, 'signin-busy');
      return view(previous);
    }
    if ([...attempts.values()].filter(attempt => active(attempt.value.state)).length >= 8)
      throw new UiError(409, 'Eight sign-ins are already active. Finish or cancel one before starting another.', 'signin-capacity');
    const attempt = { scope, controller: new AbortController(), value: { id: randomUUID(), client,
      profileName: selected.name, accountScope: client === 'copilot' ? 'shared' : 'per-root', state: 'starting',
      message: 'Starting browser sign-in…' } };
    attempts.set(attempt.value.id, attempt);
    while (attempts.size > 30) {
      const oldest = [...attempts].find(([, item]) => !active(item.value.state));
      if (!oldest) break;
      attempts.delete(oldest[0]);
    }
    attempt.promise = Promise.resolve().then(async () => {
      try {
        await invalidate(client);
        const opened = new Set();
        await nativeProfiles.signin(name, client, { signal: attempt.controller.signal, onProgress(progress) {
          if (!active(attempt.value.state) || attempt.controller.signal.aborted) return;
          if (progress.state === 'verifying') {
            attempt.value = { ...attempt.value, state: 'verifying', message: 'Checking sign-in for this profile…', browserUrl: undefined, deviceCode: undefined };
            return;
          }
          attempt.value = { ...attempt.value, ...progress, state: 'waiting-for-browser',
            message: client === 'claude-code'
              ? 'Complete sign-in in the browser opened by Claude Code. If no browser opens, cancel and try again. Xenoflux will check it automatically.'
              : 'Complete sign-in in your browser. Xenoflux will check it automatically.' };
          if (client === 'copilot' && progress.browserUrl && !opened.has(progress.browserUrl)) {
            opened.add(progress.browserUrl);
            void browser(progress.browserUrl).catch(() => {
              if (attempt.value.state === 'waiting-for-browser') attempt.value.message = 'Open the sign-in page below and complete authorization. Xenoflux will check it automatically.';
            });
          }
        } });
        attempt.value = { ...attempt.value, state: 'completed', message: client === 'copilot'
          ? 'Signed in and verified. This GitHub CLI account is shared by qualified Copilot profiles.'
          : 'Signed in and verified for this Claude Code profile.' };
      } catch (error) {
        const state = error.code === 'SHUTDOWN_FAILED' || error.process && error.process.shutdown?.groupTerminated !== true ? 'uncertain'
          : attempt.controller.signal.aborted || error.code === 'SIGNIN_CANCELLED' ? 'cancelled'
          : error.code === 'SIGNIN_TIMEOUT' ? 'timed-out' : 'failed';
        attempt.value = { ...attempt.value, state, browserUrl: undefined, deviceCode: undefined,
          message: state === 'cancelled' ? 'Sign-in cancelled. Browser authorization may already have changed the native account. Start sign-in again to verify it.' : error.message };
      } finally { await invalidate(client); }
    });
    return view(attempt);
  }
  async function cancel({ id }) {
    const attempt = attempts.get(id);
    if (!attempt) return get({ id });
    if (active(attempt.value.state)) attempt.controller.abort();
    await attempt.promise;
    return view(attempt);
  }
  async function close() {
    closing = true;
    for (const attempt of attempts.values()) if (active(attempt.value.state)) attempt.controller.abort();
    await Promise.allSettled([...attempts.values()].map(attempt => attempt.promise));
    const uncertain = [...attempts.values()].filter(attempt => attempt.value.state === 'uncertain');
    if (uncertain.length) throw new AggregateError(uncertain.map(attempt => new Error(attempt.value.message)), 'Some sign-in processes could not be confirmed stopped. Their reservations were preserved.');
  }
  return { start, get, cancel, close };
}
