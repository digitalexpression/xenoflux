import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, realpath } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { acquire, exists, globalLock, privateDirectory, readJSON, record, release } from './metadata.js';
import { observeAuditProcess } from './audit-process.js';

const current = new AsyncLocalStorage();
const busy = () => Object.assign(new Error('Copilot shares its GitHub CLI account. Finish active Copilot work or sign-in before trying again.'), { code: 'copilot-account-busy' });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

async function stopped(owner, allowIncompleteReceipt = false) {
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || alive(owner.pid)) return false;
  if (owner.shutdown && owner.shutdown.groupTerminated !== true && !allowIncompleteReceipt) return false;
  if (owner.shutdown?.groupTerminated === true || !owner.spawnIntent) return true;
  return owner.processIdentity && (await observeAuditProcess(owner.processIdentity)).status === 'stopped';
}

export async function acquireCopilotAccount(home, { exclusive = false } = {}) {
  const canonical = await realpath(home);
  const inherited = current.getStore();
  if (inherited?.home === canonical) {
    if (exclusive && !inherited.exclusive) throw busy();
    if (inherited.exclusive) return { run: action => action(), release: async () => {}, checkpoint: value => inherited.lease.checkpoint(value),
      get reference() { return inherited.lease.reference; } };
  }
  const key = createHash('sha256').update(canonical).digest('hex');
  const root = `${globalLock()}.copilot-${key}`;
  await privateDirectory(root, true);
  const owner = { kind: exclusive ? 'copilot-account-signin' : 'copilot-account-use', runId: randomUUID(), pid: process.pid, host: hostname() };
  const gate = join(root, 'operation');
  const guarded = async action => {
    const until = Date.now() + 5000, gateOwner = { kind: 'copilot-account-operation', runId: randomUUID(), pid: process.pid, host: hostname() };
    while (true) {
      try { await acquire(gate, gateOwner, true); break; }
      catch {
        if (Date.now() >= until) {
          let interrupted = false;
          try {
            const saved = await readJSON(join(gate, 'owner.json'));
            interrupted = saved.kind === 'copilot-account-operation' && saved.host === hostname()
              && Number.isSafeInteger(saved.pid) && saved.pid > 0 && !alive(saved.pid);
          } catch {}
          throw new Error(interrupted ? 'The shared GitHub account operation is interrupted. Its reservation was preserved for recovery.'
            : 'Another shared GitHub account operation is running or uncertain. Its reservation was preserved; try again after it finishes.');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await action(); } finally { await release(gate, gateOwner); }
  };
  const claim = join(root, exclusive ? 'writer' : owner.runId);
  await guarded(async () => {
    for (const name of await readdir(root)) {
      if (name !== 'writer' && !/^[a-f0-9-]{36}$/.test(name)) continue;
      const stalePath = join(root, name), stale = await readJSON(join(stalePath, 'owner.json'));
      const recognized = stale?.kind === (name === 'writer' ? 'copilot-account-signin' : 'copilot-account-use')
        && /^[a-f0-9-]{36}$/.test(stale.runId ?? '') && (name === 'writer' || stale.runId === name)
        && Number.isSafeInteger(stale.pid) && stale.pid > 0;
      if (recognized && await stopped(stale)) await release(stalePath, stale);
    }
    if (await exists(join(root, 'writer'))) throw busy();
    if (exclusive && (await readdir(root)).some(name => name !== 'operation')) throw busy();
    await acquire(claim, owner, true);
  });
  const lease = { run: action => current.run({ home: canonical, exclusive, lease }, action), release: () => guarded(() => release(claim, owner)),
    get reference() { return { path: claim, owner: structuredClone(owner) }; },
    async checkpoint(value) { Object.assign(owner, value); await record(join(claim, 'owner.json'), owner); },
  };
  return lease;
}

export async function recoverCopilotAccountClaim(claim, { userHome } = {}) {
  const home = await realpath(userHome), key = createHash('sha256').update(home).digest('hex');
  const root = `${globalLock()}.copilot-${key}`;
  if (claim?.path !== join(root, 'writer') || claim.owner?.kind !== 'copilot-account-signin') throw new Error('Invalid shared account reservation; preserving it.');
  if (!await exists(claim.path)) return;
  const owner = { kind: 'copilot-account-recovery', runId: randomUUID(), pid: process.pid, host: hostname() };
  const gate = join(root, 'operation');
  await acquire(gate, owner, true);
  try {
    const saved = await readJSON(join(claim.path, 'owner.json'));
    if (['kind', 'runId', 'pid', 'host'].some(key => saved[key] !== claim.owner[key]) || !await stopped(saved, true))
      throw new Error('Shared account reservation changed or is still owned; preserving it.');
    await release(claim.path, saved);
  } finally { await release(gate, owner); }
}
