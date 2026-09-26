import { mkdir, lstat, realpath } from 'node:fs/promises';
import { basename, join, dirname, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDirectory, readJSON, record } from '../src/metadata.js';
import { PairedPathTransaction } from '../src/paired-path-transaction.js';

const names = ['codex-home', 'desktop-data'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const identity = s => ({ device: s.dev, inode: s.ino });
const sameIdentity = (s, expected) => s && s.dev === expected.device && s.ino === expected.inode;
const validIdentity = v => v && Number.isSafeInteger(v.device) && Number.isSafeInteger(v.inode) && v.inode > 0;
const limitations = ['Filesystem fixture only; no native app, login, credential or database access.',
  'Requires exclusive access to fixture paths; it is not an OS sandbox or a hostile-writer defense.',
  'Process-interruption recovery is tested; power-loss durability is not verified.'];

function layout(root) {
  const normal = join(root, 'normal-home');
  const aliases = [join(normal, '.codex'), join(normal, 'Library', 'Application Support', 'Codex')];
  const components = names.map((name, i) => ({ name, alias: aliases[i], original: `${aliases[i]}.xenoflux-original`,
    targets: Object.fromEntries(['A', 'B'].map(label => [label, join(root, 'environments', label, name)])) }));
  const parents = [root, join(root, 'environments'), normal, join(normal, 'Library'),
    join(normal, 'Library', 'Application Support'), ...['A', 'B'].map(label => join(root, 'environments', label))];
  return { root, components, parents, manifest: join(root, 'paired-fixture.json'), journal: join(root, 'paired-switch.json'), lock: join(root, '.paired-lock') };
}

// The paired-path fixture needs only an owned root and its environments parent.
// Its manifest below is the durable fixture identity.
class FixtureStorage {
  constructor(path) {
    if (typeof path !== 'string' || !path.trim()) throw new Error('Fixture directory must be nonempty');
    this.path = resolve(path);
  }
  outsideDiscovery(path) {
    if (path.split(sep).some(part => ['.codex', '.agents'].includes(part.toLowerCase())))
      throw new Error('A paired fixture must be outside Codex discovery directories');
  }
  async init() {
    this.outsideDiscovery(this.path);
    const parent = await realpath(dirname(this.path));
    const root = join(parent, basename(this.path));
    this.outsideDiscovery(root);
    await mkdir(root, { mode: 0o700 });
    await mkdir(join(root, 'environments'), { mode: 0o700 });
    this.path = root;
    return root;
  }
  async root() {
    await privateDirectory(this.path);
    const root = await realpath(this.path);
    this.outsideDiscovery(root);
    await privateDirectory(join(root, 'environments'));
    return root;
  }
}

// The detached release smoke supplies the installed transaction implementation.
export function createPairedPathFixture(path, Transaction = PairedPathTransaction) {
  return new class extends Transaction {
    constructor() { super(); this.storage = new FixtureStorage(path); }
    async init() {
      const root = await this.storage.init();
      const p = layout(root);
      for (const path of p.parents.slice(2)) await mkdir(path, { recursive: true, mode: 0o700 });
      for (const c of p.components) for (const path of [c.alias, ...Object.values(c.targets)]) await mkdir(path, { mode: 0o700 });
      const identities = {};
      for (const path of [...p.parents, ...p.components.flatMap(c => [c.alias, ...Object.values(c.targets)])])
        identities[relative(root, path) || '.'] = identity(await lstat(path));
      await record(p.manifest, { schemaVersion: 1, purpose: 'paired-activation-fixture-only', id: randomUUID(), root, identities });
      return this.inspect();
    }

    async context() {
      const root = await this.storage.root(), p = layout(root);
      await privateDirectory(root);
      const meta = await readJSON(p.manifest);
      const expectedPaths = [...p.parents, ...p.components.flatMap(c => [c.alias, ...Object.values(c.targets)])];
      const keys = expectedPaths.map(path => relative(root, path) || '.').sort();
      if (meta.schemaVersion !== 1 || meta.purpose !== 'paired-activation-fixture-only' || !uuid.test(meta.id ?? '')
        || meta.root !== root || !meta.identities || JSON.stringify(Object.keys(meta.identities).sort()) !== JSON.stringify(keys)
        || !Object.values(meta.identities).every(validIdentity)) throw new Error('Invalid paired fixture metadata');
      const expected = path => meta.identities[relative(root, path) || '.'];
      // Canonical parent and target identities fence every operation to the new
      // fixture. Child contents may change, but a replaced directory is refused.
      for (const path of [...p.parents, ...p.components.flatMap(c => Object.values(c.targets))]) {
        await privateDirectory(path);
        if (!sameIdentity(await lstat(path), expected(path))) throw new Error('Fixture directory identity changed; preserving paths');
      }
      return { ...p, meta, expected };
    }

    async inspect() {
      const p = await this.context(), j = await this.journal(p), states = await this.states(p, j);
      return { state: 'fixture-only', root: p.root, selected: states.every(v => v === states[0]) && states[0] !== 'parked' ? states[0] : 'incomplete',
        recoveryRequired: j?.phase === 'prepared' || false, journal: j, components: p.components.map((c, i) => ({ ...c, state: states[i] })),
        liveHomeChanged: false, limitations };
    }
  }();
}
