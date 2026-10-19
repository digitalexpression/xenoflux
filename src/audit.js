import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { discoverAuditProfile } from './audit-discovery.js';
import { auditNativeSession } from './audit-session.js';
import { compareAuditRuns, auditExitCode } from './audit-report.js';
import { exportAuditReport, readAuditReport } from './audit-store.js';
import { auditExperimentCommand, isAuditRecordId, showAuditRecord } from './audit-experiment.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const plain = value => typeof value === 'string' && value.trim() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
function resourceKey(resource, profile) {
  let path = resource.path ?? '';
  const roots = resource.scope === 'user' ? [[profile.userHome, '$HOME'], [profile.home, '$CODEX_HOME']]
    : [[profile.home, '$CODEX_HOME'], [profile.userHome, '$HOME']];
  for (const [root, prefix] of roots) {
    if (!root) continue;
    const rel = relative(root, path);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))) { path = `${prefix}/${rel}`; break; }
  }
  return [resource.category, resource.scope, resource.sourceRole ?? '', resource.provider ?? '', path, resource.name].join('\0');
}
const comparable = resource => ({ status: resource.status, fingerprint: resource.fingerprint ?? null,
  value: resource.value ?? null, version: resource.version ?? null });

export async function compareAuditProfiles(store, left, right, options = {}) {
  const snapshots = await Promise.allSettled([discoverAuditProfile(store, left, options), discoverAuditProfile(store, right, options)]);
  const side = (result, name) => result.status === 'fulfilled' ? result.value
    : { schemaVersion: 1, kind: 'audit-profile', status: 'unavailable', profile: { profileName: name },
      resources: [], coverage: { discovery: 'unavailable' }, warnings: ['The selected profile discovery source is unavailable.'] };
  const a = side(snapshots[0], left), b = side(snapshots[1], right);
  const first = new Map(a.resources.map(item => [resourceKey(item, a.profile), item]));
  const second = new Map(b.resources.map(item => [resourceKey(item, b.profile), item]));
  const resources = { added: [], removed: [], changed: [], unchanged: [], unavailable: [] };
  for (const key of [...new Set([...first.keys(), ...second.keys()])].sort()) {
    const l = first.get(key), r = second.get(key);
    if (!l) resources.unavailable.push({ ...r, comparison: 'unverified-on-left',
      reason: 'Observed on the right; the left discovery source has no corroborating record.' });
    else if (!r) resources.unavailable.push({ ...l, comparison: 'unverified-on-right',
      reason: 'Observed on the left; the right discovery source has no corroborating record.' });
    else if ([l, r].some(item => !['present', 'missing'].includes(item.status))) resources.unavailable.push({ ...r, left: l, right: r });
    else if (l.status === 'missing' && r.status === 'present') resources.added.push(r);
    else if (l.status === 'present' && r.status === 'missing') resources.removed.push(l);
    else if (l.status === 'missing' && r.status === 'missing') resources.unchanged.push(r);
    else if (!isDeepStrictEqual(comparable(l), comparable(r))) resources.changed.push({ ...r, left: l, right: r });
    else if ([l, r].some(item => ['unknown', 'partial'].includes(item.comparison)
      || (!item.fingerprint && item.value === undefined && ['config', 'mcp', 'hook', 'plugin'].includes(item.category))))
      resources.unavailable.push({ ...r, left: l, right: r, comparison: 'unknown',
        reason: 'Public metadata matches; undisclosed values or runtime state remain unverified.' });
    else resources.unchanged.push(r);
  }
  return { schemaVersion: 1, kind: 'audit-profile-comparison', status: [a, b].some(v => v.status !== 'ready' && v.status !== 'present') ? 'partial' : 'ready',
    left: a, right: b, comparison: { resources },
    coverage: { discovery: [a, b].some(v => v.status === 'unavailable') ? 'unavailable' : 'partial' } };
}

function unavailable(profileName, id) {
  return { schemaVersion: 1, kind: 'audit-run', id: null, status: 'unavailable', reason: 'The selected profile source is unavailable.',
    profile: { profileName }, source: { kind: 'native-rollout', nativeSessionId: id },
    agents: [], turns: [], events: [], skills: [], usage: { totals: null }, metrics: {},
    outcome: { status: 'unverified' }, artifacts: [], coverage: { source: 'unavailable' }, warnings: [] };
}
async function selectedRun(store, profile, id, options) {
  if (!plain(profile) || !UUID.test(id ?? '')) throw new Error('Select a plain profile name and valid native session UUID');
  try { return await auditNativeSession(store, profile, id, options); }
  catch { return unavailable(profile, id); }
}

export async function auditCommand(store, params, flags, context = {}) {
  const [operation, ...args] = params;
  if (['run', 'recover', 'clean', 'resume', 'evaluate'].includes(operation)) return auditExperimentCommand(store, params, flags, context);
  if (!['profiles', 'show', 'diff', 'export'].includes(operation)) throw new Error('Use audit profiles, show, diff, or export');
  const present = key => flags[`--${key}`] !== undefined;
  const native = ['profile', 'id'].some(present), paired = ['left-profile', 'left-id', 'right-profile', 'right-id'].some(present);
  const expectations = ['expect-model', 'expect-effort'].some(present);
  if (['spec', 'dry-run', 'apply'].some(present)) throw new Error('Experiment execution flags require audit run, recover, or clean');
  if (native && paired) throw new Error('Choose one native session or a left/right comparison');
  if (expectations && operation !== 'diff' && !(operation === 'export' && paired)) throw new Error('Control expectations require an audit diff selection');
  if (operation !== 'export' && (present('output') || present('format'))) throw new Error('--output and --format are supported by audit export only');
  if (operation === 'export' && !present('output')) throw new Error('audit export requires --output');
  if (present('format') && !['json', 'markdown'].includes(flags['--format'])) throw new Error('Choose export --format json or markdown');
  const profileMode = operation === 'profiles' || (operation === 'export' && args[0] === 'profiles');
  if (!profileMode && (present('repo') || present('client'))) throw new Error('--repo and --client are supported by audit profiles only');
  if (present('client') && !['cli', 'desktop'].includes(flags['--client'])) throw new Error('Choose --client cli or desktop');
  if (present('repo') && (!plain(flags['--repo']) || !isAbsolute(flags['--repo']) || resolve(flags['--repo']) !== flags['--repo']))
    throw new Error('Repository path must be absolute and normalized');
  const options = { ...context, ...(present('repo') ? { repo: flags['--repo'] } : {}), ...(present('client') ? { client: flags['--client'] } : {}) };
  let value;
  if (profileMode) {
    const names = operation === 'profiles' ? args : args.slice(1);
    if (names.length !== 2 || native || paired || expectations || names.some(name => !plain(name))) throw new Error('Use audit profiles LEFT RIGHT [--repo DIRECTORY --client cli|desktop]');
    value = await compareAuditProfiles(store, ...names, options);
  } else if (native) {
    if (!present('profile') || !present('id') || args.length || operation === 'diff') throw new Error('Use audit show --profile NAME --id UUID');
    value = await selectedRun(store, flags['--profile'], flags['--id'], options);
  } else if (paired) {
    if (!['left-profile', 'left-id', 'right-profile', 'right-id'].every(present) || args.length || operation === 'show') throw new Error('audit diff requires both explicit profile/session pairs');
    // Validate both identifiers before either source is read.
    for (const side of ['left', 'right']) if (!plain(flags[`--${side}-profile`]) || !UUID.test(flags[`--${side}-id`] ?? '')) throw new Error('Invalid native profile/session selection');
    const control = { expectModel: flags['--expect-model'], expectEffort: flags['--expect-effort'] };
    compareAuditRuns({ turns: [] }, { turns: [] }, control); // validate controls before any source reads
    const [left, right] = await Promise.all(['left', 'right'].map(side => selectedRun(store, flags[`--${side}-profile`], flags[`--${side}-id`], options)));
    value = compareAuditRuns(left, right, control);
  } else {
    const count = operation === 'diff' ? 2 : 1;
    if (args.length !== count) throw new Error('Select explicit native sessions or exported JSON report file(s)');
    const reports = await Promise.all(args.map(value => isAuditRecordId(value) ? showAuditRecord(store, value) : readAuditReport(value)));
    if (operation === 'diff') {
      if (reports.some(item => item.kind !== 'audit-run')) throw new Error('audit diff FILE FILE requires two frozen run reports');
      value = compareAuditRuns(...reports, { expectModel: flags['--expect-model'], expectEffort: flags['--expect-effort'] });
    } else value = reports[0];
  }
  const exitCode = auditExitCode(value);
  return { value: operation === 'export' ? await exportAuditReport(value, { output: flags['--output'], format: flags['--format'] ?? 'json' }) : value, exitCode };
}
