// Bounded private provenance for resources exposed by the native catalog.
// Only approved SKILL.md definitions and allowlisted plugin manifest fields are read.
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, sep, isAbsolute, basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_RESOURCES = 160;
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const MAX_BLOCK = 128 * 1024;
const MAX_SNAPSHOTS = 2;
const MAX_HOPS = 8;
const SAFE = /^[A-Za-z0-9._+-]{1,96}$/;
const hash = b => createHash('sha256').update(b).digest('hex');
const inside = (root, p) => {
  const r = relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};
const unavailable = reason => ({
  schemaVersion: 1,
  status: 'unavailable',
  reason,
  counts: { observed: 0, omitted: 0, snapshots: 0 },
  omissionReasons: {},
  resources: []
});
const label = x => typeof x === 'string' && SAFE.test(x) && !/[\\/]/.test(x) && !secretLike(x) ? x : undefined;
const logical = x => typeof x === 'string' && x.length <= 512 && x.split('/').every(p => SAFE.test(p) && !secretLike(p)) ? x : undefined;
const statusSet = new Set([
  'present', 'missing', 'not-loaded', 'inactive', 'unavailable', 'outside-boundary',
  'unsafe', 'unreadable', 'omitted', 'budget-exceeded', 'changed-during-read', 'unsupported'
]);
const O_NOFOLLOW_ANY = constants.O_NOFOLLOW_ANY ?? (process.platform === 'darwin' ? 0x20000000 : undefined);
const omissionKinds = new Set([
  'invalid-catalog-entry', 'outside-approved-root', 'unsafe-resource-reference',
  'resource-limit', 'projection-limit', 'unspecified'
]);
const origins = new Set(['profile', 'user', 'repository', 'project', 'plugin', 'admin', 'system', 'unknown']);
const scopes = new Set(['profile', 'user', 'project', 'plugin', 'admin', 'system', 'unknown']);
const reasons = new Set(['not-recorded', 'invalid', 'size-limit']);
const phases = new Set(['before-task', 'after-task', 'late-observation']);
const sensitivePart = x => /^(?:\.env(?:\..*)?|auth(?:entication)?\.json|credentials?(?:\.json)?|secrets?(?:\.json)?|token(?:s)?(?:\.json)?|cookies?\.sqlite|login\.data|keychain|\.ssh|\.aws|\.gnupg|.*\.(?:sqlite|sqlite3|db|pem|key|p12|pfx))$/i.test(x);
const secretLike = x => /(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|npm)_[-A-Za-z0-9]{12,}|bearer[-_ ]?[A-Za-z0-9._-]{16,})/i.test(x);
const semver = x => typeof x === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][A-Za-z0-9.-]+)?$/.test(x) ? x : undefined;

async function rootsFor({ workspace, profileHome, userHome, cwd }, io = { lstat }) {
  const specs = [];
  if (typeof workspace === 'string') {
    for (const p of ['.agents/skills', '.codex/skills']) {
      specs.push({ role: 'workspace', base: resolve(workspace), sub: p, logicalPrefix: [] });
    }
    if (typeof cwd === 'string') {
      try {
        const canonicalWorkspace = await realpath(resolve(workspace));
        const canonicalCwd = await realpath(resolve(cwd));
        if (inside(canonicalWorkspace, canonicalCwd)) {
          const prefix = relative(canonicalWorkspace, canonicalCwd).split(sep).filter(Boolean);
          if (prefix.every(p => SAFE.test(p) && !secretLike(p))) {
            for (const p of ['.agents/skills', '.codex/skills']) {
              specs.push({ role: 'workspace', base: resolve(cwd), sub: p, logicalPrefix: prefix });
            }
          }
        }
      } catch {}
    }
  }
  if (typeof profileHome === 'string') {
    specs.push({ role: 'profile', base: resolve(profileHome), sub: 'skills' });
    specs.push({ role: 'profile', base: resolve(profileHome), sub: 'plugins', pluginRoot: true });
  }
  if (typeof userHome === 'string') {
    for (const p of ['.agents/skills', '.codex/skills', '.codex/plugins']) {
      specs.push({
        role: 'user', base: resolve(userHome), sub: p,
        ...(p === '.codex/plugins' ? { pluginRoot: true } : {})
      });
    }
  }
  const out = [];
  for (const s of specs) {
    const supplied = join(s.base, s.sub);
    try {
      const st = await io.lstat(supplied);
      if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) || (st.mode & 0o7000)) continue;
      const canonicalBase = await realpath(s.base);
      const canonicalRoot = await realpath(supplied);
      if (!inside(canonicalBase, canonicalRoot)) continue;
      out.push({ ...s, aliasRoot: supplied, root: canonicalRoot });
    } catch {}
  }
  return out.sort((a, b) => b.aliasRoot.length - a.aliasRoot.length);
}

// Resolve path components one link at a time. The catalog path remains a logical alias;
// this function returns a private canonical file path only after enforcing the hop bound.
async function resolveWithin(root, relativeFile, io = { lstat, readlink }) {
  if (relativeFile.split(sep).some(sensitivePart)) return { status: 'unsafe' };
  let pending = relativeFile.split(sep).filter(Boolean);
  let current = root.root;
  let hops = 0;
  const seen = new Set();
  while (pending.length) {
    const part = pending.shift();
    if (part === '.' || part === '..' || sensitivePart(part)) return { status: 'unsafe' };
    const next = join(current, part);
    let st;
    try {
      st = await io.lstat(next);
    } catch (e) {
      return { status: e.code === 'ENOENT' ? 'missing' : 'unreadable' };
    }
    if (st.isSymbolicLink()) {
      if (++hops > MAX_HOPS || seen.has(next)) return { status: 'unsafe' };
      seen.add(next);
      let target;
      try {
        target = await io.readlink(next);
      } catch {
        return { status: 'unreadable' };
      }
      let resolved = resolve(dirname(next), target);
      if (!inside(root.root, resolved) && inside(root.aliasRoot, resolved)) {
        resolved = join(root.root, relative(root.aliasRoot, resolved));
      }
      if (!inside(root.root, resolved)) return { status: 'outside-boundary' };
      current = root.root;
      pending = [...relative(root.root, resolved).split(sep).filter(Boolean), ...pending];
      continue;
    }
    if (pending.length && !st.isDirectory()) return { status: 'unsupported' };
    if ((st.mode & 0o022) || (st.mode & 0o7000) || (st.uid !== process.getuid?.() && st.uid !== 0)) {
      return { status: 'unsafe' };
    }
    current = next;
  }
  return { status: 'resolved', path: current };
}

async function parentIdentity(path, allowedRoot, io) {
  if (!inside(allowedRoot, path)) return null;
  const chain = [];
  let current = dirname(path);
  while (inside(allowedRoot, current)) {
    let st;
    try {
      st = await io.lstat(current);
    } catch {
      return null;
    }
    if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o022) || (st.mode & 0o7000) || (st.uid !== process.getuid?.() && st.uid !== 0)) {
      return null;
    }
    chain.push({ path: current, dev: st.dev, ino: st.ino });
    if (current === allowedRoot) break;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return chain.length && chain.at(-1).path === allowedRoot ? chain : null;
}
async function sameParents(chain, io) {
  if (!chain) return false;
  for (const item of chain) {
    try {
      const now = await io.lstat(item.path);
      if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== item.dev || now.ino !== item.ino) return false;
    } catch {
      return false;
    }
  }
  return true;
}
async function readSafe(path, allowedRoot, budget, io = { lstat, open }) {
  let handle;
  try {
    if (O_NOFOLLOW_ANY === undefined) return { status: 'unsupported' };
    const parents = await parentIdentity(path, allowedRoot, io);
    if (!parents) return { status: 'unsafe' };
    const pre = await io.lstat(path);
    if (pre.isSymbolicLink() || !pre.isFile()) return { status: 'unsafe' };
    if (pre.size > MAX_FILE || pre.nlink !== 1 || (pre.mode & 0o022) || (pre.mode & 0o7000) || (pre.uid !== process.getuid?.() && pre.uid !== 0)) {
      return { status: 'unsafe' };
    }
    if (budget.used + pre.size > (budget.limit ?? MAX_TOTAL)) return { status: 'budget-exceeded' };
    budget.used+=pre.size; // Reserve before open so racy size changes cannot exceed the aggregate I/O bound.
    handle = await io.open(path, constants.O_RDONLY | O_NOFOLLOW_ANY | constants.O_NONBLOCK);
    const before = await handle.stat();
    const pathBefore = await io.lstat(path);
    if (!before.isFile() || before.dev !== pre.dev || before.ino !== pre.ino || before.size !== pre.size || before.nlink !== 1 || before.size > MAX_FILE || (before.mode & 0o022) || (before.mode & 0o7000) || (before.uid !== process.getuid?.() && before.uid !== 0) || budget.used > (budget.limit ?? MAX_TOTAL) || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino || pathBefore.isSymbolicLink() || !await sameParents(parents, io)) {
      return { status: 'changed-during-read' };
    }
    const data = Buffer.alloc(before.size);
    let off = 0;
    while (off < data.length) {
      const x = await handle.read(data, off, data.length - off, off);
      if (!x.bytesRead) break;
      off += x.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await io.lstat(path);
    if (off !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.isSymbolicLink()) {
      return { status: 'changed-during-read' };
    }
    if (!await sameParents(parents, io)) return { status: 'changed-during-read' };
    return { status: 'present', data };
  } catch (e) {
    return { status: e.code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    await handle?.close();
  }
}

async function identify(skill, roots, io) {
  if (!skill || typeof skill !== 'object' || typeof skill.path !== 'string' || skill.path.startsWith('file:') || skill.path.includes('\0')) {
    return { unavailable: 'invalid-catalog-entry' };
  }
  const supplied = resolve(skill.path);
  if (basename(supplied) !== 'SKILL.md') return { unavailable: 'unsafe-resource-reference' };
  const root = roots.find(r => inside(r.aliasRoot, supplied));
  if (!root) return { unavailable: 'outside-approved-root' };
  const rel = relative(root.aliasRoot, supplied);
  if (!rel || rel.split(sep).some(sensitivePart)) return { unavailable: 'unsafe-resource-reference' };
  if (root.pluginRoot && !rel.split(sep).includes('skills')) return { unavailable: 'outside-approved-root' };

  const aliasParts = rel.split(sep);
  const name = label(skill.name) ?? label(basename(dirname(supplied)));
  const originRaw = label(skill.origin);
  const scopeRaw = label(skill.scope);
  const origin = origins.has(originRaw) ? originRaw : 'unknown';
  const scope = scopes.has(scopeRaw) ? scopeRaw : 'unknown';
  const providerRaw = typeof skill.provider === 'string' ? skill.provider : undefined;
  const provider = label(providerRaw) && !secretLike(providerRaw) ? providerRaw : undefined;
  const providerRef = providerRaw && !provider ? `opaque-${hash(providerRaw).slice(0, 24)}` : undefined;
  if (!name || secretLike(name)) return { unavailable: 'unsafe-resource-reference' };

  const prefix = root.logicalPrefix ?? [];
  const alias = [root.role, ...prefix, ...root.sub.split(sep), ...aliasParts.slice(0, -1)].join('/');
  if (!logical(alias)) return { unavailable: 'unsafe-resource-reference' };
  const resolved = await resolveWithin(root, rel, io);
  let canonical = alias;
  if (resolved.status === 'resolved') {
    const c = relative(root.root, resolved.path);
    if (c && !c.startsWith('..') && !isAbsolute(c)) {
      canonical = [root.role, ...prefix, ...root.sub.split(sep), ...c.split(sep).slice(0, -1)].join('/');
    }
  }
  if (!logical(canonical)) return { unavailable: 'unsafe-resource-reference' };
  const identity = {
    origin,
    ...(provider ? { provider } : {}),
    ...(providerRef ? { providerRef } : {}),
    location: canonical
  };
  return {
    root, rel, alias, identity, name, scope, providerForManifest: providerRaw,
    version: undefined,
    nativeSkillId: typeof skill.id === 'string' && /^[a-f0-9]{24}$/.test(skill.id) ? skill.id : undefined
  };
}

async function readDefinition(found, budget, io) {
  const resolved = await resolveWithin(found.root, found.rel, io);
  if (resolved.status !== 'resolved') return { status: resolved.status };
  const result = await readSafe(resolved.path, found.root.root, budget, io);
  if (result.status !== 'present') return { status: result.status };
  return {
    status: 'present',
    fingerprint: hash(result.data),
    scope: 'skill-definition-bytes',
    privatePath: resolved.path
  };
}

function manifestProjection(data) {
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out = {};
    for (const k of ['id', 'name']) {
      if (typeof parsed[k] === 'string' && parsed[k].length <= 128 && /^[A-Za-z0-9._+/-]+$/.test(parsed[k]) && !secretLike(parsed[k])) {
        out[k] = parsed[k];
      }
    }
    if (semver(parsed.version)) out.version = parsed.version;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
async function readManifest(found, definition, budget, io) {
  if (!definition.privatePath || !found.root.pluginRoot) return undefined;
  const parts = relative(found.root.root, definition.privatePath).split(sep);
  const skillsAt = parts.indexOf('skills');
  let packageParts;
  const provider = found.providerForManifest;
  if (parts[0] !== 'cache' || skillsAt < 2) return { status: 'missing', scope: 'plugin-manifest-allowlist' };
  if (skillsAt >= 3 && parts[2] && parts[1] && provider === `${parts[1]}/${parts[2]}` && (skillsAt === 3 || skillsAt === 4)) {
    packageParts = parts.slice(0, skillsAt);
  } else if (parts[1] && provider === parts[1] && (skillsAt === 2 || skillsAt === 3)) {
    packageParts = parts.slice(0, skillsAt);
  } else {
    return { status: 'missing', scope: 'plugin-manifest-allowlist' };
  }
  const packageRoot = join(found.root.root, ...packageParts);
  const alternatives = [
    join(packageRoot, '.codex-plugin', 'plugin.json'),
    join(packageRoot, 'plugin.json'),
    join(packageRoot, 'manifest.json')
  ];
  for (const file of alternatives) {
    const resolved = await resolveWithin(found.root, relative(found.root.root, file), io);
    if (resolved.status !== 'resolved') continue;
    const raw = await readSafe(resolved.path, found.root.root, budget, io);
    if (raw.status !== 'present') continue;
    const safe = manifestProjection(raw.data);
    if (!safe || (safe.id && safe.id !== provider)) continue;
    return {
      status: 'present',
      fingerprint: hash(JSON.stringify(safe)),
      scope: 'plugin-manifest-allowlist',
      ...(label(safe.version) ? { version: label(safe.version) } : {})
    };
  }
  return { status: 'missing', scope: 'plugin-manifest-allowlist' };
}

function validEndpoint(e) {
  return e && statusSet.has(e.status) &&
    (!e.fingerprint || (/^[a-f0-9]{64}$/.test(e.fingerprint) && e.status === 'present')) &&
    (!e.scope || ['skill-definition-bytes', 'plugin-manifest-allowlist'].includes(e.scope));
}
function validateBlock(v) {
  if (!v || v.schemaVersion !== 1 || !['complete', 'partial', 'unavailable'].includes(v.status) ||
      (v.reason !== undefined && !reasons.has(v.reason)) || !Array.isArray(v.resources) || !v.counts) return false;
  for (const k of ['observed', 'omitted', 'snapshots']) {
    if (!Number.isSafeInteger(v.counts[k]) || v.counts[k] < 0) return false;
  }
  if (v.counts.snapshots > MAX_SNAPSHOTS || v.resources.length > MAX_RESOURCES) return false;
  if (v.omissionReasons !== undefined && (!v.omissionReasons || typeof v.omissionReasons !== 'object' || Array.isArray(v.omissionReasons) ||
      Object.entries(v.omissionReasons).some(([k, n]) => !omissionKinds.has(k) || !Number.isSafeInteger(n) || n < 0))) return false;
  const reasonCount = Object.values(v.omissionReasons ?? {}).reduce((a, b) => a + b, 0);
  if (v.counts.observed < v.resources.length || v.counts.observed > v.resources.length + v.counts.omitted ||
      reasonCount > v.counts.omitted || (v.status === 'unavailable' && v.resources.length > 0)) return false;
  for (const r of v.resources) {
    if (!r || typeof r !== 'object' || !r.identity || typeof r.identity !== 'object' || !Array.isArray(r.snapshots)) return false;
    if (r.snapshots.length > MAX_SNAPSHOTS || r.snapshots.length > v.counts.snapshots) return false;
    if (!origins.has(r.identity.origin) || !scopes.has(r.scope) || !logical(r.identity.location)) return false;
    if (!r.snapshots.every(s => s && typeof s === 'object' && phases.has(s.phase) &&
        validEndpoint(s.definition) && (!s.manifest || validEndpoint(s.manifest)))) return false;
    if (r.catalogs !== undefined && (!Array.isArray(r.catalogs) || r.catalogs.length > MAX_RESOURCES ||
        !r.catalogs.every(c => c && typeof c === 'object' && phases.has(c.phase) && statusSet.has(c.status)))) return false;
  }
  return true;
}
function cleanEndpoint(e) {
  if (!validEndpoint(e)) return { status: 'unavailable' };
  return {
    status: e.status,
    ...(e.fingerprint ? { fingerprint: e.fingerprint } : {}),
    ...(e.scope ? { scope: e.scope } : {}),
    ...(label(e.version) ? { version: label(e.version) } : {})
  };
}
function list(a) {
  return Array.isArray(a) ? [...new Set(a.map(label).filter(Boolean))].slice(0, MAX_RESOURCES) : [];
}

export function projectResourceProvenance(value, { maxResources = MAX_RESOURCES, maxBytes = MAX_BLOCK } = {}) {
  if (value == null) return unavailable('not-recorded');
  if (!validateBlock(value)) return unavailable('invalid');
  const limit = Math.max(0, Math.min(MAX_RESOURCES, Number.isSafeInteger(maxResources) ? maxResources : MAX_RESOURCES));
  const resources = value.resources.slice(0, limit).map(r => {
    const plainProvider = label(r.identity.provider);
    const opaqueProvider = typeof r.identity.providerRef === 'string' && /^opaque-[a-f0-9]{24}$/.test(r.identity.providerRef)
      ? r.identity.providerRef
      : !plainProvider && typeof r.identity.provider === 'string' && r.identity.provider.length <= 256
        ? `opaque-${hash(r.identity.provider).slice(0, 24)}`
        : undefined;
    return {
      identity: {
        origin: r.identity.origin,
        ...(plainProvider ? { provider: plainProvider } : {}),
        ...(opaqueProvider ? { providerRef: opaqueProvider } : {}),
        location: logical(r.identity.location) ?? 'unknown'
      },
      nativeSkillIds: Array.isArray(r.nativeSkillIds)
        ? r.nativeSkillIds.filter(x => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x)).slice(0, MAX_RESOURCES)
        : [],
      agentIds: list(r.agentIds),
      catalogs: Array.isArray(r.catalogs)
        ? r.catalogs.filter(c => c && phases.has(c.phase) && statusSet.has(c.status))
          .map(c => ({ ...(label(c.agentId) ? { agentId: label(c.agentId) } : {}), phase: c.phase, status: c.status }))
          .slice(0, MAX_RESOURCES)
        : [],
      aliases: Array.isArray(r.aliases) ? r.aliases.map(logical).filter(Boolean).slice(0, 16) : [],
      ...(logical(r.canonicalRef) ? { canonicalRef: logical(r.canonicalRef) } : {}),
      ...(label(r.name) ? { name: label(r.name) } : {}),
      scope: r.scope,
      ...(semver(r.version) ? { version: semver(r.version) } : {}),
      snapshots: r.snapshots.map(s => ({
        phase: s.phase,
        ...(label(s.agentId) ? { agentId: label(s.agentId) } : {}),
        ...(typeof s.capturedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s.capturedAt) ? { capturedAt: s.capturedAt } : {}),
        status: statusSet.has(s.status) ? s.status : 'unavailable',
        definition: cleanEndpoint(s.definition),
        ...(s.manifest ? { manifest: cleanEndpoint(s.manifest) } : {})
      }))
    };
  });
  const retainedInputs = value.resources.slice(0, limit);
  const detailOmissions = retainedInputs.filter(r => {
    const validIds = Array.isArray(r.nativeSkillIds)
      ? r.nativeSkillIds.filter(x => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x))
      : [];
    const validAliases = Array.isArray(r.aliases) ? r.aliases.map(logical).filter(Boolean) : [];
    return validIds.length > MAX_RESOURCES || validAliases.length > 16;
  }).length;
  const omitted = value.counts.omitted + Math.max(0, value.resources.length - limit) + detailOmissions;
  const omissionReasons = {};
  for (const [k, n] of Object.entries(value.omissionReasons ?? {})) {
    if (omissionKinds.has(k) && Number.isSafeInteger(n) && n > 0) omissionReasons[k] = n;
  }
  const known = Object.values(omissionReasons).reduce((a, b) => a + b, 0);
  if (known < value.counts.omitted) omissionReasons.unspecified = (omissionReasons.unspecified ?? 0) + value.counts.omitted - known;
  const projectedAway = Math.max(0, value.resources.length - limit) + detailOmissions;
  if (projectedAway) omissionReasons['projection-limit'] = (omissionReasons['projection-limit'] ?? 0) + projectedAway;
  const incompleteResource = resources.some(r =>
    r.snapshots.some(s => s.phase === 'late-observation' || s.definition.status !== 'present' || !s.definition.fingerprint ||
      ((r.identity.provider || r.identity.providerRef) && (!s.manifest || s.manifest.status !== 'present' || !s.manifest.fingerprint || !semver(s.manifest.version)))) ||
    r.catalogs.some(c => c.phase === 'late-observation' || c.status === 'unavailable'));
  const out = {
    schemaVersion: 1,
    status: value.status,
    ...(reasons.has(value.reason) ? { reason: value.reason } : {}),
    counts: { observed: value.counts.observed, omitted, snapshots: value.counts.snapshots },
    omissionReasons,
    resources
  };
  if (incompleteResource && out.status === 'complete') out.status = 'partial';
  if (out.counts.omitted && out.status === 'complete') out.status = 'partial';
  const cap = Math.max(256, Math.min(MAX_BLOCK, Number.isSafeInteger(maxBytes) ? maxBytes : MAX_BLOCK));
  while (Buffer.byteLength(JSON.stringify(out), 'utf8') > cap && resources.length) {
    resources.pop();
    out.counts.omitted++;
    out.omissionReasons['projection-limit'] = (out.omissionReasons['projection-limit'] ?? 0) + 1;
    out.status = 'partial';
  }
  return Buffer.byteLength(JSON.stringify(out), 'utf8') <= cap ? out : unavailable('size-limit');
}

export function compareResourceProvenance(left, right, { sameBaseline = false } = {}) {
  const a = projectResourceProvenance(left);
  const b = projectResourceProvenance(right);
  const comparisonLocation = r => {
    if (r.identity.origin !== 'plugin' || !r.version || !semver(r.version)) return r.identity.location;
    const parts = r.identity.location.split('/');
    const cacheAt = parts.indexOf('cache');
    if (cacheAt < 0) return r.identity.location;

    let packageParts;
    let versionAt;
    if (parts[cacheAt + 1] && parts[cacheAt + 2] && parts[cacheAt + 3] && parts[cacheAt + 4] === 'skills') {
      packageParts = [parts[cacheAt + 1], parts[cacheAt + 2]];
      versionAt = cacheAt + 3;
    } else if (parts[cacheAt + 1] && parts[cacheAt + 2] && parts[cacheAt + 3] === 'skills') {
      packageParts = [parts[cacheAt + 1]];
      versionAt = cacheAt + 2;
    } else {
      return r.identity.location;
    }

    const provider = r.identity.provider;
    const providerRef = r.identity.providerRef;
    const packageIds = [packageParts.join('/'), packageParts.at(-1)];
    const providerMatches = packageIds.some(id => provider === id || providerRef === `opaque-${hash(id).slice(0, 24)}`);
    const manifestVersions = r.snapshots.map(s => s.manifest?.version);
    if (!providerMatches || parts[versionAt] !== r.version || !semver(parts[versionAt]) ||
        !manifestVersions.length || manifestVersions.some(version => version !== parts[versionAt])) {
      return r.identity.location;
    }
    return parts.filter((_, index) => index !== versionAt).join('/');
  };
  const key = r => JSON.stringify([
    r.identity.origin,
    r.identity.provider ?? r.identity.providerRef ?? '',
    comparisonLocation(r)
  ]);
  const index = p => {
    const m = new Map();
    for (const r of p.resources) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const am = index(a);
  const bm = index(b);
  const changes = [];
  for (const k of new Set([...am.keys(), ...bm.keys()])) {
    const x = am.get(k) ?? [];
    const y = bm.get(k) ?? [];
    const identity = (x[0] ?? y[0]).identity;
    const requiresBaseline = identity.origin === 'repository' || identity.origin === 'project' || identity.location.startsWith('workspace/');
    if (x.length !== 1 || y.length !== 1 || (requiresBaseline && !sameBaseline)) {
      changes.push({
        identity,
        status: 'unknown',
        reason: requiresBaseline && !sameBaseline ? 'repository-alignment-unknown' : 'ambiguous-or-missing'
      });
      continue;
    }
    const last = r => r.snapshots.at(-1);
    const xx = last(x[0]);
    const yy = last(y[0]);
    const stableWithin = r => {
      const vals = r.snapshots.map(s => s.definition.fingerprint);
      if (!r.snapshots.every(s => s.definition.status === 'present' && s.definition.fingerprint) || new Set(vals).size !== 1) {
        return false;
      }
      if (r.identity.provider || r.identity.providerRef) {
        const manifests = r.snapshots.map(s => s.manifest);
        return manifests.every(m => m?.status === 'present' && m.fingerprint && semver(m.version)) &&
          new Set(manifests.map(m => m.fingerprint)).size === 1 &&
          new Set(manifests.map(m => m.version)).size === 1;
      }
      return true;
    };
    if (!stableWithin(x[0]) || !stableWithin(y[0])) {
      changes.push({ identity, status: 'unknown', reason: 'endpoint-unavailable-or-changed-within-run' });
      continue;
    }
    const manifestA = xx?.manifest;
    const manifestB = yy?.manifest;
    if ((x[0].identity.provider || x[0].identity.providerRef || y[0].identity.provider || y[0].identity.providerRef) &&
        (!manifestA || !manifestB || manifestA.status !== 'present' || manifestB.status !== 'present' ||
          !manifestA.fingerprint || !manifestB.fingerprint || !x[0].version || !y[0].version)) {
      changes.push({ identity, status: 'unknown', reason: 'plugin-version-unavailable' });
      continue;
    }
    const state = xx.definition.fingerprint !== yy.definition.fingerprint ||
      manifestA?.fingerprint !== manifestB?.fingerprint || x[0].version !== y[0].version ? 'changed' : 'same';
    changes.push({ identity, status: state });
  }
  const incomplete = a.status !== 'complete' || b.status !== 'complete';
  return {
    schemaVersion: 1,
    status: incomplete || changes.some(c => c.status === 'unknown') ? 'partial' : 'complete',
    sameBaseline: !!sameBaseline,
    stabilityProven: false,
    changes
  };
}

export function createResourceProvenance({ workspace, profileHome, userHome, limits = {}, fs = {} } = {}) {
  const io = { lstat: fs.lstat ?? lstat, open: fs.open ?? open, readlink: fs.readlink ?? readlink };
  const cap = Math.max(0, Math.min(MAX_RESOURCES, Number.isSafeInteger(limits.maxResources) ? limits.maxResources : MAX_RESOURCES));
  const byteCap = Math.max(0, Math.min(MAX_TOTAL, Number.isSafeInteger(limits.maxBytes) ? limits.maxBytes : MAX_TOTAL));
  const resources = [];
  let finished = false;
  let omitted = 0;
  let bytesRead = 0;
  let observedCatalogs = 0;
  let partial = false;
  let queue = Promise.resolve();
  const omissionReasons = Object.create(null);

  const omit = reason => {
    omitted++;
    const kind = omissionKinds.has(reason) ? reason : 'invalid-catalog-entry';
    omissionReasons[kind] = (omissionReasons[kind] ?? 0) + 1;
  };
  async function approvedRoots(cwd) {
    return rootsFor({ workspace, profileHome, userHome, cwd }, io);
  }
  async function collect(skills, { agentId = 'unknown', phase = 'before-task', cwd } = {}) {
    if (finished || !phases.has(phase)) return;
    if (!Array.isArray(skills)) {
      omitted++;
      partial = true;
      return;
    }
    if (phase === 'late-observation') partial = true;
    observedCatalogs++;
    const roots = await approvedRoots(cwd);
    const budget = { used: bytesRead, limit: byteCap };
    for (const skill of skills) {
      const found = await identify(skill, roots, io);
      if (found?.unavailable) {
        omit(found.unavailable);
        continue;
      }
      const catalogStatus = skill.loaded === false ? 'not-loaded' : skill.enabled === false ? 'inactive' : 'present';
      const existing = resources.find(r => JSON.stringify(r.identity) === JSON.stringify(found.identity));
      const aid = label(agentId);
      if (existing?.snapshots.some(s => s.phase === phase)) {
        if (found.nativeSkillId && !existing.nativeSkillIds.includes(found.nativeSkillId)) existing.nativeSkillIds.push(found.nativeSkillId);
        if (aid && !existing.agentIds.includes(aid)) existing.agentIds.push(aid);
        if (!existing.aliases.includes(found.alias)) existing.aliases.push(found.alias);
        addCatalog(existing, aid, phase, catalogStatus);
        continue;
      }
      if (!existing && resources.length >= cap) {
        omit('resource-limit');
        continue;
      }
      // A shared resource gets its after-task sample only after native work stops.
      if (existing?.snapshots.some(s => s.phase === 'before-task') && phase !== 'before-task') {
        if (found.nativeSkillId && !existing.nativeSkillIds.includes(found.nativeSkillId)) existing.nativeSkillIds.push(found.nativeSkillId);
        if (aid && !existing.agentIds.includes(aid)) existing.agentIds.push(aid);
        if (!existing.aliases.includes(found.alias)) existing.aliases.push(found.alias);
        addCatalog(existing, aid, phase, catalogStatus);
        continue;
      }

      const definition = skill.loaded === false
        ? { status: 'not-loaded', scope: 'skill-definition-bytes' }
        : skill.enabled === false
          ? { status: 'inactive', scope: 'skill-definition-bytes' }
          : await readDefinition(found, budget, io);
      let manifest;
      if (!['present', 'inactive', 'not-loaded'].includes(definition.status)) partial = true;
      if (definition.status === 'present' && found.root.pluginRoot) {
        manifest = await readManifest(found, definition, budget, io);
        if (manifest.status !== 'present' || !manifest.version) partial = true;
      }
      const rec = existing ?? {
        identity: found.identity,
        nativeSkillIds: [],
        agentIds: [],
        catalogs: [],
        aliases: [],
        canonicalRef: found.identity.location,
        name: found.name,
        scope: found.scope,
        snapshots: [],
        private: { root: found.root, rel: found.rel, providerForManifest: found.providerForManifest }
      };
      if (!rec.canonicalRef || rec.canonicalRef === found.identity.location) {
        const canonicalPath = definition.privatePath ? relative(found.root.root, definition.privatePath) : undefined;
        if (canonicalPath && !canonicalPath.startsWith('..')) {
          rec.canonicalRef = [found.root.role, ...(found.root.logicalPrefix ?? []), ...found.root.sub.split(sep), ...canonicalPath.split(sep).slice(0, -1)].join('/');
        }
      }
      if (found.nativeSkillId && !rec.nativeSkillIds.includes(found.nativeSkillId)) rec.nativeSkillIds.push(found.nativeSkillId);
      if (aid && !rec.agentIds.includes(aid)) rec.agentIds.push(aid);
      addCatalog(rec, aid, phase, catalogStatus);
      if (!rec.aliases.includes(found.alias)) rec.aliases.push(found.alias);
      if (!rec.version && manifest?.version) rec.version = manifest.version;
      rec.snapshots.push({
        phase,
        ...(aid ? { agentId: aid } : {}),
        capturedAt: new Date().toISOString(),
        status: definition.status,
        definition,
        ...(manifest ? { manifest } : {})
      });
      if (!existing) resources.push(rec);
    }
    bytesRead = budget.used;
  }
  function addCatalog(resource, agentId, phase, status) {
    const old = resource.catalogs.find(c => c.agentId === agentId && c.phase === phase);
    if (old) {
      if (old.status !== status) {
        old.status = 'unavailable';
        partial = true;
      }
      return;
    }
    resource.catalogs.push({ ...(agentId ? { agentId } : {}), phase, status });
  }
  const project = () => {
    const hasEvidence = observedCatalogs > 0;
    const clean = {
      schemaVersion: 1,
      status: partial || omitted ? 'partial' : hasEvidence ? 'complete' : 'unavailable',
      ...(!hasEvidence ? { reason: 'not-recorded' } : {}),
      counts: {
        observed: resources.length,
        omitted,
        snapshots: Math.min(MAX_SNAPSHOTS, Math.max(0, ...resources.map(r => r.snapshots.length)))
      },
      omissionReasons: { ...omissionReasons },
      resources: resources.map(({ private: _private, ...r }) => r)
    };
    return projectResourceProvenance(clean);
  };
  return {
    observeCatalog(skills, options) {
      const next = queue.then(() => collect(skills, options));
      queue = next.catch(() => {});
      return next;
    },
    async finish() {
      await queue;
      if (!finished) {
        finished = true;
        const roots = await approvedRoots();
        const budget = { used: bytesRead, limit: byteCap };
        for (const r of resources) {
          if (!r.snapshots.some(s => s.phase === 'before-task') || r.snapshots.some(s => s.phase === 'after-task')) continue;
          const root = roots.find(x => x.aliasRoot === r.private.root.aliasRoot);
          const found = { ...r.private, root: root ?? r.private.root };
          const definition = await readDefinition(found, budget, io);
          if (definition.status !== 'present') partial = true;
          let manifest;
          if (definition.status === 'present' && found.root.pluginRoot) {
            manifest = await readManifest(found, definition, budget, io);
            if (manifest.status !== 'present' || !manifest.version) partial = true;
          }
          r.snapshots.push({
            phase: 'after-task',
            capturedAt: new Date().toISOString(),
            status: definition.status,
            definition,
            ...(manifest ? { manifest } : {})
          });
        }
        bytesRead = budget.used;
      }
      return project();
    },
    snapshot: project
  };
}
