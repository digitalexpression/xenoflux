import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { find, strictDescendant } from './profiles.js';
import { resolveHome } from './homes.js';
import { exists, readJSON, record } from './metadata.js';
import { withProfileOperation } from './desktop-instances.js';
import { isNativeCliParticipant, readProfileOwners } from './profile-reservations.js';
import { observeCodexCli, observeManagedCli, readCliReport } from './native-participants.js';

const requestLifetimeMs = 30000;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requestPath = path => join(dirname(path), 'close-request.json');
const validRequest = (request, runId) => equal(request, {
  schemaVersion: 1, runId, expiresAt: request?.expiresAt,
}) && Number.isSafeInteger(request.expiresAt) && request.expiresAt > Date.now()
  && request.expiresAt <= Date.now() + requestLifetimeMs;
const owners = root => readProfileOwners(root).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return [];
});

async function closeTarget(store, profile, runtime) {
  const { native, id: profileId } = profile, client = profile.client ?? 'codex';
  if (!native) return;
  const owner = (await owners(native.root)).find(owner => isNativeCliParticipant(owner, client));
  if (!owner) return;
  let home, environmentId;
  if (client === 'codex') {
    const resolved = await resolveHome(store, profileId);
    if (!equal(native, resolved.native)) return;
    ({ home, id: environmentId } = resolved.environment);
  } else {
    if (native.rootMode !== 'explicit' || !strictDescendant(native.root, native.configRoot)) return;
    ({ configRoot: home, environmentId } = native);
  }
  const plan = { nativeRoot: native.root, home, environmentId, client, profileId };
  const report = await readCliReport(store, plan, owner);
  if (report.closeSupported !== true || report.status !== 'running' || !report.processIdentity) return;
  const observe = client === 'codex' ? observeCodexCli : observeManagedCli;
  if ((await observe(store, plan, owner, runtime, { resolveExecutable: true })).status !== 'running') return;
  return { owner, plan };
}

export async function cliCloseRunId(store, profile, runtime) {
  try { return (await closeTarget(store, profile, runtime))?.owner.runId; }
  catch { return undefined; }
}

export async function requestCliClose(store, profileId, runId, { runtime, lockOptions, waitMs = 12000 }) {
  const target = await withProfileOperation(store, profileId, { waitMs: 5000, ...lockOptions }, async () => {
    const current = find(await store.read(), profileId);
    const selected = await closeTarget(store, current, runtime);
    if (!selected || selected.owner.runId !== runId)
      throw new Error('This CLI run is no longer available to close. Refresh Profiles.');
    const path = requestPath(selected.owner.reportPath);
    const previous = await exists(path) && await readJSON(path);
    if (!validRequest(previous, runId))
      await record(path, { schemaVersion: 1, runId, expiresAt: Date.now() + requestLifetimeMs });
    return selected;
  });
  const deadline = Date.now() + waitMs;
  do {
    const held = (await owners(target.plan.nativeRoot)).find(owner => owner?.runId === runId);
    if (held && !equal(held, target.owner)) throw new Error('CLI ownership changed during shutdown.');
    const report = await readCliReport(store, target.plan, target.owner);
    if (!held && report.shutdown?.groupTerminated === true && ['exited', 'failed'].includes(report.status)) return 'closed';
    if (report.status === 'incomplete') throw new Error('CLI shutdown could not be verified. Its reservation was preserved.');
    if (Date.now() >= deadline) break;
    await delay(100);
  } while (true);
  return 'pending';
}

export function watchCliClose(owner, verify, close) {
  let check, stopped = false;
  const timer = setInterval(() => {
    if (check || stopped) return;
    check = (async () => {
      const path = requestPath(owner.reportPath);
      const request = await exists(path) && await readJSON(path);
      if (validRequest(request, owner.runId)) {
        await verify();
        if (!stopped && validRequest(request, owner.runId)) {
          close();
          clearInterval(timer);
        }
      }
    })().catch(() => {}).finally(() => { check = undefined; });
  }, 150);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await check;
  };
}
