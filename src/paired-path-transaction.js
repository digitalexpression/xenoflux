// Shared transaction for a validated pair of directory aliases. The adapter
// supplies context and inspection; fixture construction lives in test-support.
import { lstat, realpath, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { exists, privateDirectory, readJSON, record, acquire, release } from './metadata.js';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sameIdentity = (s, expected) => s && s.dev === expected.device && s.ino === expected.inode;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };

// Both aliases must expose the same stable target keys.
function targets(p) {
  const values = Object.keys(p.components?.[0]?.targets ?? {});
  if (!values.length || values.includes('Default')
    || p.components.some(component => JSON.stringify(Object.keys(component.targets).sort()) !== JSON.stringify(values.slice().sort())))
    throw new Error('Invalid paired activation targets');
  return ['Default', ...values];
}

export class PairedPathTransaction {
  async journal(p) {
    if (!await exists(p.journal)) return null;
    const j = await readJSON(p.journal);
    if (j.schemaVersion !== 1 || j.activationId !== p.meta.id || !uuid.test(j.id ?? '')
      || !targets(p).includes(j.from) || !targets(p).includes(j.to) || j.from === j.to
      || !['prepared', 'committed', 'recovered'].includes(j.phase)) throw new Error('Invalid paired switch journal');
    return j;
  }

  async componentState(p, c) {
    const source = await exists(c.alias), original = await exists(c.original);
    const isOriginal = s => s?.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid()
      && !(s.mode & (p.originalModeMask ?? 0o077)) && sameIdentity(s, p.expected(c.alias));
    if (isOriginal(source) && !original) return 'Default';
    if (!isOriginal(original)) throw new Error(`Unexpected preserved original for ${c.name}; preserving paths`);
    if (!source) return 'parked';
    if (source.isSymbolicLink() && source.uid === process.getuid()) {
      const target = await readlink(c.alias);
      const label = Object.keys(c.targets).find(label => target === c.targets[label]);
      if (label && await realpath(c.alias) === target) return label;
    }
    throw new Error(`Unexpected alias for ${c.name}; preserving paths`);
  }

  async states(p, j) {
    const values = [];
    for (const c of p.components) values.push(await this.componentState(p, c));
    if (!j && values.some(v => v !== 'Default')) throw new Error('Unjournaled paired selection; preserving paths');
    if (j?.phase === 'prepared') {
      const allowed = [j.from, j.to, ...([j.from, j.to].includes('Default') ? ['parked'] : [])];
      if (values.some(v => !allowed.includes(v))) throw new Error('Selection differs from interrupted journal; preserving paths');
    } else if (j) {
      const expected = j.phase === 'committed' ? j.to : j.from;
      if (values.some(v => v !== expected)) throw new Error('Selection differs from completed journal; preserving paths');
    }
    return values;
  }

  async locked(p, recover, action) {
    const owner = { kind: 'paired-path-switch', root: p.root, activationId: p.meta.id, host: hostname(), pid: process.pid, runId: randomUUID() };
    if (await exists(p.lock)) {
      await privateDirectory(p.lock);
      const previous = await readJSON(join(p.lock, 'owner.json'));
      if (!recover) throw new Error('Paired activation is locked; recover after its writer stops');
      if (previous.kind !== owner.kind || previous.root !== p.root || previous.activationId !== p.meta.id
        || previous.host !== owner.host || !Number.isSafeInteger(previous.pid) || previous.pid < 1 || !uuid.test(previous.runId ?? ''))
        throw new Error('Unknown paired lock owner; preserving lock');
      if (alive(previous.pid)) throw new Error('Paired path writer is still running');
      await release(p.lock, previous);
    }
    await acquire(p.lock, owner, true);
    try { return await action(); }
    finally { await release(p.lock, owner); }
  }

  stage(c, j, recovering) { return join(dirname(c.alias), `.xfx-${recovering ? 'rollback' : 'next'}-${j.id}-${c.name}`); }

  async validateStages(p, j) {
    for (const c of p.components) for (const recovering of [false, true]) {
      const path = this.stage(c, j, recovering), s = await exists(path);
      if (!s) continue;
      const label = recovering ? j.from : j.to;
      if (label === 'Default' || !s.isSymbolicLink() || s.uid !== process.getuid() || await readlink(path) !== c.targets[label])
        throw new Error('Unexpected staged link; preserving paths');
    }
  }

  async change(p, c, target, j, recovering, checkpoint) {
    // Repeat full validation immediately before each component mutation. The
    // native adapter supplies writer-quiescence checks through checkpoint.
    await this.context();
    await this.states(p, j);
    await this.validateStages(p, j);
    let state = await this.componentState(p, c);
    if (state === target) return;
    const event = phase => checkpoint(`${recovering ? 'recover:' : ''}${c.name}:${phase}`);
    if (target === 'Default') {
      if (state !== 'parked') { await unlink(c.alias); await event('alias-removed'); }
      if (await this.componentState(p, c) !== 'parked') throw new Error('Original restoration state changed');
      await rename(c.original, c.alias);
      await event('original-restored');
    } else {
      if (state === 'Default') { await rename(c.alias, c.original); await event('original-preserved'); }
      const staged = this.stage(c, j, recovering);
      await this.validateStages(p, j);
      if (!await exists(staged)) await symlink(c.targets[target], staged, 'dir');
      await event('link-staged');
      await this.context();
      await this.states(p, j);
      await this.validateStages(p, j);
      await rename(staged, c.alias);
      await event('alias-installed');
    }
    if (await this.componentState(p, c) !== target) throw new Error('Paired component verification failed');
  }

  async cleanStages(p, j) {
    await this.validateStages(p, j);
    for (const c of p.components) for (const recovering of [false, true]) {
      const path = this.stage(c, j, recovering);
      if (await exists(path)) await unlink(path);
    }
  }

  async switchTo(target, { checkpoint = async () => {} } = {}) {
    const p = await this.context();
    if (!targets(p).includes(target)) throw new Error('Choose a registered paired activation target');
    return this.locked(p, false, async () => {
      const previous = await this.journal(p);
      if (previous?.phase === 'prepared') throw new Error('Recover the interrupted paired switch first');
      const [from] = await this.states(p, previous);
      if (from === target) return { ...await this.inspect(), changed: false };
      const j = { schemaVersion: 1, activationId: p.meta.id, id: randomUUID(), from, to: target, phase: 'prepared' };
      await record(p.journal, j);
      await checkpoint('prepared');
      for (const c of p.components) await this.change(p, c, target, j, false, checkpoint);
      if ((await this.states(p, j)).some(v => v !== target)) throw new Error('Paired selection verification failed');
      await this.cleanStages(p, j);
      await record(p.journal, { ...j, phase: 'committed' });
      await checkpoint('committed');
      return { ...await this.inspect(), changed: true };
    });
  }

  async restore(options) { return this.switchTo('Default', options); }

  async recover({ checkpoint = async () => {} } = {}) {
    const p = await this.context();
    return this.locked(p, true, async () => {
      const j = await this.journal(p);
      await this.states(p, j);
      if (!j || j.phase !== 'prepared') return { ...await this.inspect(), recovered: false };
      await this.validateStages(p, j);
      for (const c of [...p.components].reverse()) await this.change(p, c, j.from, j, true, checkpoint);
      if ((await this.states(p, j)).some(v => v !== j.from)) throw new Error('Paired recovery verification failed');
      await this.cleanStages(p, j);
      await record(p.journal, { ...j, phase: 'recovered' });
      await checkpoint('recovered');
      return { ...await this.inspect(), recovered: true };
    });
  }

}
