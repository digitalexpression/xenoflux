import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile, lstat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/profiles.js';
import { createExperiment, createExperimentRun, finalizeAuditRecord, readAuditRecord, reserveAuditProfile, writeAuditState } from '../src/audit-experiment-store.js';
import { cleanAuditExperiment, recoverAuditExperiment } from '../src/audit-experiment.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

const deadPid = 2147483647;

async function fixture(t, { runs = 1 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'xfx-audit-recovery-failure-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'controller'));
  await mkdir(store.directory, { mode: 0o700 });
  const experiment = await createExperiment(store, { spec: {}, task: 'Recovery fixture', profiles: [] });
  const members = [];
  for (let index = 0; index < runs; index++) {
    const home = join(root, `native-home-${index}`);
    await mkdir(home, { mode: 0o700 });
    const profile = { id: `fixture-${index}`, profileId: `fixture-${index}`, profileName: `Fixture ${index}`, home };
    const run = await createExperimentRun(store, { experimentId: experiment.id, profile });
    const owner = { kind: 'audit-experiment', pid: process.pid, host: hostname(), runId: run.id,
      experimentId: experiment.id, storePath: store.directory, profileId: profile.profileId, home };
    const reservation = await reserveAuditProfile({ root: home, owner });
    await writeAuditState(store, run.id, { status: 'running', phase: 'task', coordinator: { pid: deadPid, host: hostname() },
      process: null, nativeSessionId: 'fixture-session', reservation: { root: home, owner } });
    members.push({ run, profile, owner, reservation });
  }
  await writeAuditState(store, experiment.id, { status: 'running', coordinator: { pid: deadPid, host: hostname() } });
  return { root, store, experiment, members };
}

function resolver(member) {
  return async (_store, name) => ({ ...member.profile, profileId: member.profile.profileId,
    profileName: member.profile.profileName, home: member.profile.home });
}

async function recover(f, member = f.members[0], extra = {}) {
  return recoverAuditExperiment(f.store, f.experiment.id, { apply: true, resolveProfile: resolver(member), ...extra });
}

test('dead coordinator with a live owned task blocks recovery and cleanup, then recovers after the harness stops it', async t => {
  const f = await fixture(t);
  const workspace = join(f.root, 'owned-workspace');
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(join(workspace, 'partial.txt'), 'fixture output', { mode: 0o600 });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(child.pid);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close').catch(() => {});
    }
  });
  await writeAuditState(f.store, f.members[0].run.id, { process: { pid: child.pid, host: hostname() },
    workspace: { directory: workspace, owner: { experimentId: f.experiment.id, runId: f.members[0].run.id }, active: true } });

  const blocked = await recover(f);
  assert.equal(blocked.status, 'blocked');
  assert.equal((await readAuditRecord(f.store, f.members[0].run.id)).finalized, false);
  assert.equal((await readAuditRecord(f.store, f.members[0].run.id)).recovery, null);
  assert.equal(await readFile(join(f.members[0].reservation.lock, 'owner.json'), 'utf8').then(JSON.parse).then(value => value.runId), f.members[0].run.id);
  await stat(workspace);
  assert.equal((await cleanAuditExperiment(f.store, f.experiment.id, { apply: true })).status, 'blocked');

  child.kill('SIGKILL');
  await once(child, 'close');
  const recovered = await recover(f);
  assert.equal(recovered.status, 'recovered');
  assert.equal((await readAuditRecord(f.store, f.members[0].run.id)).finalized, true);
  const repeated = await recover(f);
  assert.deepEqual(repeated, recovered);
  assert.equal((await readAuditRecord(f.store, f.members[0].run.id)).recovery.status, 'recovered');
});

test('a dead owned group leader with a live same-group child blocks recovery until the harness kills the group', async t => {
  const f = await fixture(t), member = f.members[0], childPidPath = join(f.root, 'group-child.pid');
  const leader = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const child=spawn(process.execPath,['-e',"process.on('SIGHUP',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(childPidPath)},String(child.pid),{mode:0o600}); child.unref(); setTimeout(()=>process.exit(0),1500);`],
  { detached: true, stdio: 'ignore' });
  assert.ok(leader.pid);
  t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch {} });
  await once(leader, 'close');
  const childPid = Number(await readFile(childPidPath, 'utf8'));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  const savedIdentity = { pid: leader.pid, started: 'fixture-process-start', command: 'node', host: hostname() };
  await writeAuditState(f.store, member.run.id, { process: { ...savedIdentity, processIdentity: savedIdentity } });

  const blocked = await recover(f);
  assert.equal(blocked.status, 'blocked');
  assert.equal((await readAuditRecord(f.store, member.run.id)).finalized, false);
  assert.equal((await readAuditRecord(f.store, member.run.id)).recovery, null);
  await stat(member.reservation.lock);
  try { process.kill(childPid, 0); } catch (error) { assert.fail(`owned child exited before recovery: ${error.code}`); }

  await writeAuditState(f.store, member.run.id, { process: { pid: leader.pid, host: hostname() } });
  const legacyBlocked = await recover(f);
  assert.equal(legacyBlocked.status, 'blocked');
  assert.equal((await readAuditRecord(f.store, member.run.id)).finalized, false);
  await stat(member.reservation.lock);

  try { process.kill(-leader.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(-leader.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const recovered = await recover(f);
  assert.equal(recovered.status, 'recovered');
  assert.equal((await readAuditRecord(f.store, member.run.id)).finalized, true);
});

test('a report write failure is retryable and produces one immutable partial report', async t => {
  const f = await fixture(t), member = f.members[0];
  const reportPath = join(member.run.directory, 'report.json');
  let blockedOnce = false;
  await assert.rejects(recover(f, member, { readNative: async () => {
    if (!blockedOnce) { blockedOnce = true; await mkdir(reportPath, { mode: 0o700 }); }
    return null;
  } }), /Unsafe or oversized audit record/);
  await rm(reportPath, { recursive: true });
  let current = await readAuditRecord(f.store, member.run.id);
  assert.equal(current.finalized, false);
  assert.equal(current.recovery, null);

  const recovered = await recover(f);
  assert.equal(recovered.status, 'recovered');
  current = await readAuditRecord(f.store, member.run.id);
  assert.equal(current.report.status, 'partial');
  await assert.rejects(finalizeAuditRecord(f.store, member.run.id, current.report), /already exists/);
  const output = join(f.root, 'partial.json');
  await exportAuditReport(current.report, { output });
  assert.equal((await readAuditReport(output)).status, 'partial');
  assert.deepEqual(await recover(f), recovered);
});

test('a lease ownership change after report finalization preserves the lease and retry completes after fixture repair', async t => {
  const f = await fixture(t, { runs: 2 }), member = f.members[0];
  const ownerPath = join(member.reservation.lock, 'owner.json');
  let changed = false;
  await assert.rejects(recover(f, member, { readNative: async () => {
    if (!changed) {
      changed = true;
      await writeFile(ownerPath, JSON.stringify({ ...member.owner, runId: f.members[1].run.id }), { mode: 0o600 });
    }
    return null;
  } }), /belongs to another operation/);
  let current = await readAuditRecord(f.store, member.run.id);
  assert.equal(current.finalized, true);
  assert.equal(current.recovery, null);
  assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).runId, f.members[1].run.id);
  await writeFile(ownerPath, JSON.stringify(member.owner), { mode: 0o600 });

  const recovered = await recoverAuditExperiment(f.store, member.run.id, { apply: true, resolveProfile: resolver(member) });
  assert.equal(recovered.status, 'recovered');
  current = await readAuditRecord(f.store, member.run.id);
  assert.equal(current.report.status, 'partial');
  assert.equal(current.recovery.status, 'recovered');
  const repeated = await recoverAuditExperiment(f.store, member.run.id, { apply: true, resolveProfile: resolver(member) });
  assert.equal(repeated.status, 'recovered');
  assert.equal(repeated.actions[0].status, 'reconciled');
});

test('a recovery receipt failure after lease release retries without replaying task work', async t => {
  const f = await fixture(t), member = f.members[0];
  const recoveryPath = join(member.run.directory, 'recovery.json');
  const injectReceiptBlock = (async () => {
    for (let attempt = 0; attempt < 2000; attempt++) {
      try { await lstat(join(member.run.directory, 'report.json')); await mkdir(recoveryPath, { mode: 0o700 }); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error('Recovery did not publish its run report within the fixture deadline');
  })();
  await assert.rejects(recover(f), /Unsafe or oversized audit record/);
  await injectReceiptBlock;
  await assert.rejects(stat(member.reservation.lock), { code: 'ENOENT' });
  await rm(recoveryPath, { recursive: true });
  const current = await readAuditRecord(f.store, member.run.id);
  assert.equal(current.finalized, true);
  assert.equal(current.recovery, null);

  const recovered = await recover(f);
  assert.equal(recovered.status, 'recovered');
  assert.equal((await readAuditRecord(f.store, member.run.id)).recovery.status, 'recovered');
  assert.equal((await recover(f)).status, recovered.status);
});

test('parent report failure after member receipts retries to a final parent report', async t => {
  const f = await fixture(t), parentReport = join(f.experiment.directory, 'report.json');
  let blockedOnce = false;
  await assert.rejects(recover(f, f.members[0], { readNative: async () => {
    if (!blockedOnce) { blockedOnce = true; await mkdir(parentReport, { mode: 0o700 }); }
    return null;
  } }), /Unsafe or oversized audit record/);
  await rm(parentReport, { recursive: true });
  const member = await readAuditRecord(f.store, f.members[0].run.id);
  assert.equal(member.finalized, true);
  assert.equal(member.recovery.status, 'recovered');
  assert.equal((await readAuditRecord(f.store, f.experiment.id)).recovery, null);
  const recovered = await recover(f);
  assert.equal(recovered.status, 'recovered');
  const parent = await readAuditRecord(f.store, f.experiment.id);
  assert.equal(parent.finalized, true);
  assert.equal(parent.report.status, 'interrupted');
  assert.equal(parent.recovery.status, 'recovered');
  assert.deepEqual(await recover(f), recovered);
});
