import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readlink, rm, open, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createResourceProvenance, compareResourceProvenance } from '../src/audit-provenance.js';
import { compactAuditTrial } from '../src/audit-statistics.js';
import { exportAuditReport, readAuditReport } from '../src/audit-store.js';

async function fixture(t) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'xfx-alias-binding-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const root = join(workspace, '.agents/skills');
  for (const name of ['alpha', 'beta']) { await mkdir(join(root,name), { recursive: true }); await writeFile(join(root,name,'SKILL.md'), `PRIVATE_BODY_${name}`); }
  const alias = join(root,'alias'); await symlink('alpha',alias);
  const retarget = async () => { await rm(alias); await symlink('beta',alias); };
  const skill = { id: '0123456789abcdef01234567', name: 'alias', origin: 'repository', scope: 'project', path: join(alias,'SKILL.md') };
  return { workspace, alias, retarget, skill };
}

test('alias retarget between identity resolution and definition read cannot fingerprint the wrong canonical resource', async t => {
  const f = await fixture(t); let changed = false;
  const p = createResourceProvenance({ workspace: f.workspace, fs: { readlink: async path => {
    const value = await readlink(path);
    if (!changed && path === f.alias) { changed = true; await f.retarget(); }
    return value;
  } } });
  await p.observeCatalog([f.skill], { agentId: 'root' });
  const result = p.snapshot();
  assert.equal(result.resources[0].identity.location, 'workspace/.agents/skills/alpha');
  assert.equal(result.resources[0].canonicalRef, 'workspace/.agents/skills/alpha');
  assert.equal(result.resources[0].snapshots[0].definition.status, 'changed-during-read');
  assert.equal(result.resources[0].snapshots[0].definition.fingerprint, undefined);
  assert.equal(result.status, 'partial');
});

test('alias retarget while canonical bytes are read invalidates that sample', async t => {
  const f = await fixture(t); let changed = false;
  const p = createResourceProvenance({ workspace: f.workspace, fs: { open: async (...args) => {
    const handle = await open(...args);
    return { stat: (...a) => handle.stat(...a), close: () => handle.close(), read: async (...a) => {
      const result = await handle.read(...a);
      if (!changed) { changed = true; await f.retarget(); }
      return result;
    } };
  } } });
  await p.observeCatalog([f.skill], { agentId: 'root' });
  assert.equal(p.snapshot().resources[0].snapshots[0].definition.status, 'changed-during-read');
  assert.equal(p.snapshot().resources[0].snapshots[0].definition.fingerprint, undefined);
});

test('after-task alias retarget keeps the original identity and leaves changed binding incomparable', async t => {
  const f = await fixture(t);
  const p = createResourceProvenance({ workspace: f.workspace });
  await p.observeCatalog([f.skill], { agentId: 'root' });
  const original = p.snapshot();
  await f.retarget();
  const result = await p.finish();
  assert.deepEqual(result.resources[0].identity, original.resources[0].identity);
  assert.equal(result.resources[0].canonicalRef, original.resources[0].canonicalRef);
  assert.equal(result.resources[0].snapshots[1].definition.status, 'changed-during-read');
  assert.equal(result.resources[0].snapshots[1].definition.fingerprint, undefined);
  assert.equal(compareResourceProvenance(result,result,{ sameBaseline: true }).changes[0].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BODY|xfx-alias-binding/);
  const compact = compactAuditTrial({ runs: [{ id: 'binding-change', profileName: 'fixture', status: 'partial', resourceProvenance: result }] }).runs[0];
  const exports = await mkdtemp(join(tmpdir(), 'xfx-binding-export-'));
  t.after(() => rm(exports, { recursive: true, force: true }));
  await rm(f.workspace, { recursive: true, force: true });
  for (const format of ['json', 'markdown']) {
    const exported = await exportAuditReport({ ...compact, schemaVersion: 1, kind: 'audit-run' }, { output: join(exports, `run.${format}`), format });
    const reopened = await readAuditReport(exported.evidencePath);
    assert.deepEqual(reopened.resourceProvenance, result);
    assert.equal(compareResourceProvenance(reopened.resourceProvenance,result,{ sameBaseline: true }).changes[0].status,'unknown');
  }
});

test('an initially unresolvable alias cannot gain a fingerprint under an unverified canonical identity', async t => {
  const f = await fixture(t);
  await rm(f.alias); await symlink('/outside-boundary',f.alias);
  let changed = false;
  const p = createResourceProvenance({ workspace: f.workspace, fs: { readlink: async path => {
    const value = await readlink(path);
    if (!changed && path === f.alias) { changed = true; await rm(f.alias); await symlink('alpha',f.alias); }
    return value;
  } } });
  await p.observeCatalog([f.skill], { agentId: 'root' });
  const resource = p.snapshot().resources[0];
  assert.equal(resource.identity.location, 'workspace/.agents/skills/alias');
  assert.equal(resource.canonicalRef, resource.identity.location);
  assert.equal(resource.snapshots[0].definition.status, 'changed-during-read');
  assert.equal(resource.snapshots[0].definition.fingerprint, undefined);
});


test('after-task sampling refuses a vanished or retargeted workspace root alias', async t => {
  for (const target of ['missing', 'different']) {
    const f = await fixture(t);
    const container = await realpath(await mkdtemp(join(tmpdir(), 'xfx-root-binding-')));
    t.after(() => rm(container, { recursive: true, force: true }));
    const visible = join(container,'workspace'); await symlink(f.workspace,visible);
    const p = createResourceProvenance({ workspace: visible });
    await p.observeCatalog([{ ...f.skill, path: join(visible,'.agents/skills/alpha/SKILL.md') }], { agentId: 'root' });
    assert.equal(p.snapshot().resources[0].snapshots[0].definition.status,'present');
    await rm(visible);
    if (target === 'different') {
      const next = join(container,'next');await mkdir(join(next,'.agents/skills/alpha'),{recursive:true});
      await writeFile(join(next,'.agents/skills/alpha/SKILL.md'),'PRIVATE_BODY_alpha');
      await symlink(next,visible);
    }
    const result = await p.finish();
    assert.equal(result.status,'partial');
    assert.equal(result.resources[0].snapshots[1].definition.status,'outside-boundary');
    assert.equal(result.resources[0].snapshots[1].definition.fingerprint,undefined);
  }
});

test('a missing direct definition may appear later at the same logical identity', async t => {
  const f = await fixture(t);
  const path = join(f.workspace,'.agents/skills/missing/SKILL.md');
  const p = createResourceProvenance({ workspace: f.workspace });
  await p.observeCatalog([{ ...f.skill, path }], { agentId: 'root' });
  await mkdir(join(path,'..'),{recursive:true});await writeFile(path,'definition appeared');
  const result = await p.finish();
  assert.equal(result.resources[0].snapshots[0].definition.status,'missing');
  assert.equal(result.resources[0].snapshots[1].definition.status,'present');
  assert.equal(result.resources[0].identity.location,'workspace/.agents/skills/missing');
});


test('root alias retarget during after-task sampling invalidates the endpoint fingerprint', async t => {
  const f = await fixture(t);
  const container = await realpath(await mkdtemp(join(tmpdir(), 'xfx-root-binding-race-')));
  t.after(() => rm(container, { recursive: true, force: true }));
  const next = join(container,'next');await mkdir(join(next,'.agents/skills/alpha'),{recursive:true});
  await writeFile(join(next,'.agents/skills/alpha/SKILL.md'),'PRIVATE_BODY_alpha');
  const visible = join(container,'workspace');await symlink(f.workspace,visible);
  let finishing = false, changed = false;
  const p = createResourceProvenance({ workspace: visible, fs: { lstat: async path => {
    const st = await lstat(path);
    if (finishing && !changed && path === join(f.workspace,'.agents/skills/alpha/SKILL.md')) {
      changed = true; await rm(visible); await symlink(next,visible);
    }
    return st;
  } } });
  await p.observeCatalog([{ ...f.skill, path: join(visible,'.agents/skills/alpha/SKILL.md') }], { agentId: 'root' });
  finishing = true;
  const result = await p.finish();
  assert.equal(changed,true);
  assert.equal(result.status,'partial');
  assert.equal(result.resources[0].snapshots[1].definition.status,'changed-during-read');
  assert.equal(result.resources[0].snapshots[1].definition.fingerprint,undefined);
});
