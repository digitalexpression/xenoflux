import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { discoverAuditProfile, auditResourceAbsent } from './audit-discovery.js';
import { auditNativeSession } from './audit-session.js';
import { compareAuditRuns, auditExitCode } from './audit-report.js';
import { exportAuditReport, readAuditReport } from './audit-store.js';
import { auditExperimentCommand, isAuditRecordId, showAuditRecord } from './audit-experiment.js';
import { comparableAuditResource, compareAuditResourceDetails } from './audit-profile-diff.js';
import { auditSelectionOptions } from './audit-selection.js';

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
const comparable = comparableAuditResource;
export function sameCompleteLocalSkillPackage(left, right, includeSourceValues) {
  return includeSourceValues === true && [left, right].every(item => item?.category === 'skill'
    && item.fingerprintScope === 'local-skill-package' && typeof item.fingerprint === 'string'
    && item.detail?.coverage?.comparison === 'complete') && left.fingerprint === right.fingerprint;
}
function hasSupportedSkillDifference(diff, left, right) {
  const leftFiles = new Map((left.detail?.files ?? []).map(file => [file.path, file]));
  const rightFiles = new Map((right.detail?.files ?? []).map(file => [file.path, file]));
  const fullComparable = file => file?.comparison === 'available'
    && ((file.comparisonBasis === 'full-bytes' && typeof file.digest === 'string')
      || (file.comparisonBasis === 'public-safe-text' && typeof file.fingerprint === 'string'));
  return diff.hunks.some(hunk => {
    const l = leftFiles.get(hunk.path), r = rightFiles.get(hunk.path);
    if (hunk.kind === 'metadata-changed') return true;
    if (hunk.kind === 'changed') return fullComparable(l) && fullComparable(r);
    if (hunk.kind === 'content-changed') {
      if (l && r) return l.comparison === 'available' && r.comparison === 'available'
        && ((l.comparisonBasis === 'full-bytes' && r.comparisonBasis === 'full-bytes'
            && typeof l.digest === 'string' && typeof r.digest === 'string' && l.digest !== r.digest)
          || (l.comparisonBasis === 'public-safe-text' && r.comparisonBasis === 'public-safe-text'
            && typeof l.fingerprint === 'string' && typeof r.fingerprint === 'string' && l.fingerprint !== r.fingerprint));
      const coverage = l ? right.detail?.coverage?.comparison : left.detail?.coverage?.comparison;
      return coverage === 'complete' && fullComparable(l ?? r);
    }
    if (hunk.kind === 'added' || hunk.kind === 'removed') {
      const coverage = left.detail?.coverage?.comparison === 'complete' && right.detail?.coverage?.comparison === 'complete';
      return coverage && fullComparable(l ?? r);
    }
    return false;
  });
}
function pluginSkillAbsent(resource, snapshot) {
  if (resource?.category !== 'skill' || resource.scope !== 'plugin' || !resource.sourceRole?.startsWith('plugin:')) return false;
  const plugin = resource.sourceRole.slice('plugin:'.length);
  const pluginInventory = snapshot?.inventory?.find(item => item.category === 'plugin' && item.scope === 'plugin'
    && item.sourceRole === 'plugin-cache' && typeof item.logicalRoot === 'string' && item.logicalRoot.endsWith('/plugins/cache'));
  if (pluginInventory?.status !== 'complete') return false;
  const versions = pluginInventory.names.filter(name => name.startsWith(`${plugin}/`))
    .map(name => name.slice(plugin.length + 1));
  if (!versions.length) return true;
  const skillRoots = new Map((snapshot.inventory ?? []).filter(item => item.category === 'skill' && item.scope === 'plugin'
    && item.sourceRole === resource.sourceRole && typeof item.logicalRoot === 'string')
    .map(item => [item.logicalRoot, item]));
  const cacheBase = pluginInventory.logicalRoot.slice(0, -'plugins/cache'.length);
  return versions.every(version => {
    const inventory = skillRoots.get(`${cacheBase}plugins/${plugin}/${version}/skills`);
    return inventory?.status === 'complete' && !inventory.names.includes(resource.logicalPath);
  });
}

function aliasedSource(resource, snapshot) {
  const inventory = snapshot.inventory?.find(item => item.key === resource.inventoryKey && item.aliasOf);
  if (!inventory) return undefined;
  const matches = snapshot.resources.filter(item => item.inventoryKey === inventory.aliasOf
    && item.category === resource.category && item.logicalPath === resource.logicalPath);
  return matches.length === 1 ? matches[0] : undefined;
}

function completeLocalSource(resource) {
  if (resource.status === 'missing') return true;
  return resource.status === 'present' && !['partial', 'unknown'].includes(resource.comparison)
    && !['partial', 'omitted', 'redacted'].includes(resource.valueStatus)
    && (!resource.detail || resource.detail.status === 'available')
    && (resource.value !== undefined || typeof resource.fingerprint === 'string');
}

function supportedSourceDifference(left, right, diff) {
  if ([left, right].every(completeLocalSource)) return true;
  if (typeof left.fingerprint === 'string' && typeof right.fingerprint === 'string'
    && left.fingerprintScope === right.fingerprintScope && left.fingerprint !== right.fingerprint) return true;
  // Partial definitions can still establish a changed field that was actually
  // observed on both sides. Missing/omitted fields alone do not prove a change.
  return diff.hunks.some(hunk => hunk.kind === 'changed' && /^value(?:\.|$)/.test(hunk.path)
    && hunk.left !== undefined && hunk.right !== undefined
    && ![left, right].some(item => ['omitted', 'redacted'].includes(item.valueStatus)));
}

export async function compareAuditProfiles(store, left, right, options = {}) {
  const leftOptions = { ...options, ...options.leftOptions }, rightOptions = { ...options, ...options.rightOptions };
  const snapshots = await Promise.allSettled([discoverAuditProfile(store, left, leftOptions), discoverAuditProfile(store, right, rightOptions)]);
  const side = (result, name) => result.status === 'fulfilled' ? result.value
    : { schemaVersion: 1, kind: 'audit-profile', status: 'unavailable', profile: { profileName: name },
      resources: [], coverage: { discovery: 'unavailable' }, warnings: ['The selected profile discovery source is unavailable.'] };
  const a = side(snapshots[0], left), b = side(snapshots[1], right);
  const leftClient = a.context?.clientId ?? leftOptions.clientId ?? leftOptions.binding?.client ?? 'codex';
  const rightClient = b.context?.clientId ?? rightOptions.clientId ?? rightOptions.binding?.client ?? 'codex';
  if (leftClient !== rightClient) return {
    schemaVersion: 1, kind: 'audit-profile-comparison', status: 'partial', left: a, right: b,
    comparison: { mode: 'separate', reason: 'Mixed-client setups are shown separately; categories and settings are not equivalent.',
      resources: { added: [], removed: [], changed: [], unchanged: [], unavailable: [] } },
    coverage: { discovery: [a, b].some(value => value.status === 'unavailable') ? 'unavailable' : 'partial', equivalence: 'unavailable' },
  };
  const first = new Map(a.resources.map(item => [resourceKey(item, a.profile), item]));
  const second = new Map(b.resources.map(item => [resourceKey(item, b.profile), item]));
  const staticCategories = new Set(['agent', 'config', 'feature', 'hook', 'instruction', 'mcp', 'memory-setting', 'plugin', 'rule', 'skill', 'tool']);
  const physicalKey = item => staticCategories.has(item.category)
    ? [item.category, item.provider ?? '', item.canonicalPath ?? item.path ?? '', item.name].join('\0') : null;
  const fallback = new Map();
  const leftPhysical = new Map(), rightPhysical = new Map();
  for (const pair of first) {
    if (second.has(pair[0])) continue;
    const id = physicalKey(pair[1]);
    if (!id) continue;
    const group = leftPhysical.get(id) ?? [];
    group.push(pair); leftPhysical.set(id, group);
  }
  for (const pair of second) {
    if (first.has(pair[0])) continue;
    const id = physicalKey(pair[1]);
    if (!id) continue;
    const group = rightPhysical.get(id) ?? [];
    group.push(pair); rightPhysical.set(id, group);
  }
  for (const [id, leftMatches] of leftPhysical) {
    const rightMatches = rightPhysical.get(id) ?? [];
    if (leftMatches.length !== 1 || rightMatches.length !== 1) continue;
    const [[leftKey, leftItem]] = leftMatches, [[rightKey, rightItem]] = rightMatches;
    if (leftKey !== rightKey) fallback.set(leftKey, rightKey);
  }
  // Plugin skill packages are cached below version-specific physical roots.
  // Their stable identity is the plugin source role and full directory name, but only
  // when each side has exactly one unmatched candidate.
  const logicalSkillKey = item => item.category === 'skill' && item.scope === 'plugin'
    ? [item.scope, item.provider ?? '', item.sourceRole ?? '', basename(item.path)].join('\0') : null;
  const leftSkills = new Map(), rightSkills = new Map();
  for (const pair of first) {
    if (second.has(pair[0]) || fallback.has(pair[0])) continue;
    const id = logicalSkillKey(pair[1]); if (!id) continue;
    const group = leftSkills.get(id) ?? []; group.push(pair); leftSkills.set(id, group);
  }
  for (const pair of second) {
    if (first.has(pair[0]) || [...fallback.values()].includes(pair[0])) continue;
    const id = logicalSkillKey(pair[1]); if (!id) continue;
    const group = rightSkills.get(id) ?? []; group.push(pair); rightSkills.set(id, group);
  }
  for (const [id, leftMatches] of leftSkills) {
    const rightMatches = rightSkills.get(id) ?? [];
    if (leftMatches.length !== 1 || rightMatches.length !== 1) continue;
    const [[leftKey], [rightKey]] = [leftMatches[0], rightMatches[0]];
    fallback.set(leftKey, rightKey);
  }
  const ambiguousPluginSkill = item => {
    const id = logicalSkillKey(item);
    if (!id) return false;
    const leftCount = leftSkills.get(id)?.length ?? 0, rightCount = rightSkills.get(id)?.length ?? 0;
    return leftCount > 0 && rightCount > 0 && (leftCount > 1 || rightCount > 1);
  };
  const resources = { added: [], removed: [], changed: [], unchanged: [], unavailable: [] };
  const handledRight = new Set();
  const handledLeft = new Set();
  const pairs = [...first.keys()].sort().map(key => {
    const rightKey = second.has(key) ? key : fallback.get(key);
    if (rightKey) { handledRight.add(rightKey); handledLeft.add(key); }
    return [first.get(key), rightKey ? second.get(rightKey) : undefined];
  });
  for (const [key, item] of [...second].sort(([x], [y]) => x.localeCompare(y)))
    if (!handledRight.has(key)) pairs.push([undefined, item]);
  for (const [leftSource, rightSource] of pairs) {
    const leftAlias = !leftSource && rightSource ? aliasedSource(rightSource, a) : undefined;
    const rightAlias = !rightSource && leftSource ? aliasedSource(leftSource, b) : undefined;
    const l = leftSource ?? leftAlias, r = rightSource ?? rightAlias;
    const aliasObservation = leftSource ?? rightSource;
    const sourceAlias = leftAlias || rightAlias ? { ...Object.fromEntries(['id', 'scope', 'sourceRole', 'origin', 'path', 'canonicalPath', 'inventoryKey', 'logicalPath']
      .filter(key => aliasObservation[key] !== undefined).map(key => [key, aliasObservation[key]])), sourceRelationship: 'shared-profile-user-root',
      reason: 'The profile user directory is the same directory as its Codex home; the observed source supplies both roles.' } : {};
    const corroboratingMatches = !l && r ? [...first].filter(([, item]) => physicalKey(item) && physicalKey(item) === physicalKey(r))
      : !r && l ? [...second].filter(([, item]) => physicalKey(item) && physicalKey(item) === physicalKey(l)) : [];
    const corroborating = corroboratingMatches.length === 1 ? corroboratingMatches[0] : undefined;
    const sourceContext = (item, alreadyPaired) => ({
      corroboratingSource: { path: item.path, scope: item.scope, sourceRole: item.sourceRole, origin: item.origin },
      reason: alreadyPaired
        ? 'The same physical source was read under ' + item.sourceRole + '; its comparison is already represented for that source role.'
        : 'The same physical source was read under ' + item.sourceRole + '; a unique source pairing could not be established.',
    });
    const sharedSkillCorroboration = (observed, counterpart, observedSide) => {
      if (observed?.category !== 'skill' || counterpart?.category !== 'skill') return false;
      const leftSource = observedSide === 'right' ? counterpart : observed;
      const rightSource = observedSide === 'right' ? observed : counterpart;
      const complete = options.includeSourceValues === true
        && [leftSource, rightSource].every(item => item.fingerprintScope === 'local-skill-package'
          && typeof item.fingerprint === 'string' && item.detail?.coverage?.comparison === 'complete');
      const same = sameCompleteLocalSkillPackage(leftSource, rightSource, options.includeSourceValues);
      const row = { ...observed, left: leftSource, right: rightSource, sourceRelationship: 'shared-physical-source',
        reason: same ? 'The complete local package fingerprints match for this shared physical source.'
          : complete ? 'The shared physical source has different complete package fingerprints.'
            : 'The shared physical source has incomplete local package comparison evidence.' };
      if (same) resources.unchanged.push(row);
      else resources.unavailable.push({ ...row, comparison: 'unknown' });
      return true;
    };
    const sharedLocalCorroboration = (observed, counterpart, observedSide) => {
      if (observed.category === 'skill' || options.includeSourceValues !== true) return false;
      const l = observedSide === 'right' ? counterpart : observed, r = observedSide === 'right' ? observed : counterpart;
      const complete = [l, r].every(completeLocalSource);
      const same = complete && isDeepStrictEqual(comparable(l), comparable(r));
      const row = { ...observed, left: l, right: r, sourceRelationship: 'shared-physical-source',
        reason: same ? 'Both observations of this shared physical source match; the profile-specific comparison is retained separately.'
          : complete ? 'The shared physical source changed between observations; a consistent comparison could not be established.'
            : 'The shared physical source has incomplete source comparison evidence.' };
      if (same) resources.unchanged.push(row);
      else resources.unavailable.push({ ...row, comparison: 'unknown' });
      return true;
    };
    if (!l && corroborating && sharedSkillCorroboration(r, corroborating[1], 'right')) {}
    else if (!r && corroborating && sharedSkillCorroboration(l, corroborating[1], 'left')) {}
    else if (!l && corroborating && sharedLocalCorroboration(r, corroborating[1], 'right')) {}
    else if (!r && corroborating && sharedLocalCorroboration(l, corroborating[1], 'left')) {}
    else if (!l && (auditResourceAbsent(r, a) || pluginSkillAbsent(r, a))) resources.added.push(r);
    else if (!r && (auditResourceAbsent(l, b) || pluginSkillAbsent(l, b))) resources.removed.push(l);
    else if (!l && corroborating) resources.unavailable.push({ ...r, comparison: 'unverified-on-left',
      ...sourceContext(corroborating[1], handledLeft.has(corroborating[0])) });
    else if (!r && corroborating) resources.unavailable.push({ ...l, comparison: 'unverified-on-right',
      ...sourceContext(corroborating[1], handledRight.has(corroborating[0])) });
    else if (!l) resources.unavailable.push({ ...r, comparison: 'unverified-on-left',
      reason: ambiguousPluginSkill(r) ? 'Multiple cached source versions expose this plugin skill, so a unique pairing cannot be established.'
        : 'Observed on the right; the left discovery source has no corroborating record.' });
    else if (!r) resources.unavailable.push({ ...l, comparison: 'unverified-on-right',
      reason: ambiguousPluginSkill(l) ? 'Multiple cached source versions expose this plugin skill, so a unique pairing cannot be established.'
        : 'Observed on the left; the right discovery source has no corroborating record.' });
    else if ([l, r].some(item => !['present', 'missing'].includes(item.status))) resources.unavailable.push({ ...r, left: l, right: r, ...sourceAlias });
    else if (l.status === 'missing' && r.status === 'present') resources.added.push(leftAlias || rightAlias ? { ...r, left: l, right: r, ...sourceAlias } : r);
    else if (l.status === 'present' && r.status === 'missing') resources.removed.push(leftAlias || rightAlias ? { ...r, left: l, right: r, ...sourceAlias } : l);
    else if (l.status === 'missing' && r.status === 'missing') resources.unchanged.push({ ...r, left: l, right: r, ...sourceAlias });
    else if (!isDeepStrictEqual(comparable(l), comparable(r))) {
      const detailDiff = compareAuditResourceDetails(l, r);
      if (l.category === 'skill' || r.category === 'skill') {
        const incomplete = [l, r].some(item => item.comparison !== 'available'
          || item.detail?.coverage?.comparison !== 'complete');
        const hasPositiveDifference = hasSupportedSkillDifference(detailDiff, l, r);
        if (incomplete && !hasPositiveDifference) resources.unavailable.push({ ...r, left: l, right: r,
          detailDiff, comparison: 'unknown', reason: 'Skill package comparison is incomplete; no verified difference could be established.' });
        else resources.changed.push({ ...r, left: l, right: r, detailDiff });
      } else if (supportedSourceDifference(l, r, detailDiff)) resources.changed.push({ ...r, left: l, right: r, detailDiff, ...sourceAlias });
      else resources.unavailable.push({ ...r, left: l, right: r, detailDiff, ...sourceAlias, comparison: 'unknown',
        reason: 'Source comparison is incomplete; omitted or unread portions do not establish a difference.' });
    }
    else if ([l, r].some(item => ['unknown', 'partial'].includes(item.comparison)
      || ['partial', 'omitted'].includes(item.valueStatus)
      || (!item.fingerprint && item.value === undefined && ['config', 'mcp', 'hook', 'plugin'].includes(item.category))))
      resources.unavailable.push({ ...r, left: l, right: r, comparison: 'unknown',
        reason: options.includeSourceValues
          ? [l, r].some(item => item.valueStatus === 'omitted')
            ? 'Source values exceed the comparison detail limit or could not be included in full.'
            : 'Source or package contents are incomplete; the unobserved portions cannot be compared.'
          : 'Public metadata matches; undisclosed values or runtime state remain unverified.' });
    else resources.unchanged.push({ ...r, left: l, right: r, ...sourceAlias });
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

/** Compare two explicitly selected native sessions; the CLI and the local app share this path. */
export async function compareAuditSessions(store, left, right, control = {}, options = {}) {
  // Validate both identifiers and the controls before either source is read.
  for (const side of [left, right]) if (!plain(side?.profile) || !UUID.test(side?.id ?? '')) throw new Error('Invalid native profile/session selection');
  compareAuditRuns({ turns: [] }, { turns: [] }, control);
  const [a, b] = await Promise.all([left, right].map(side => selectedRun(store, side.profile, side.id, options)));
  return compareAuditRuns(a, b, control);
}

export async function auditCommand(store, params, flags, context = {}) {
  const [operation, ...args] = params;
  if (['run', 'cohort', 'recover', 'clean', 'resume', 'evaluate'].includes(operation)) {
    if (flags['--include-replay-content'] !== undefined) throw new Error('--include-replay-content is supported by audit export only');
    if (flags['--same-task'] !== undefined || flags['--variables'] !== undefined)
      throw new Error('Task and variable declarations require an audit comparison; run declarations belong in the spec');
    return auditExperimentCommand(store, params, flags, context);
  }
  if (!['profiles', 'show', 'diff', 'export'].includes(operation)) throw new Error('Use audit profiles, show, diff, or export');
  const present = key => flags[`--${key}`] !== undefined;
  const native = ['profile', 'id'].some(present), paired = ['left-profile', 'left-id', 'right-profile', 'right-id'].some(present);
  const expectations = ['expect-model', 'expect-effort'].some(present);
  const declarations = ['same-task', 'variables'].some(present);
  if (['spec', 'dry-run', 'apply'].some(present)) throw new Error('Experiment execution flags require audit run, recover, or clean');
  if (native && paired) throw new Error('Choose one native session or a left/right comparison');
  if (expectations && operation !== 'diff' && !(operation === 'export' && (paired || args.length === 2 && args[0] !== 'profiles'))) throw new Error('Control expectations require an audit diff selection');
  if (declarations && !(operation === 'diff' || operation === 'export' && (paired || args.length === 2 && args[0] !== 'profiles')))
    throw new Error('Task and variable declarations require an audit comparison');
  const selection = auditSelectionOptions({
    ...(present('same-task') ? { taskAssociation: { status: 'user-declared', taskId: flags['--same-task'] } } : {}),
    ...(present('variables') ? { declaredVariables: typeof flags['--variables'] === 'string' ? flags['--variables'].split(',').map(value => value.trim()) : null } : {}),
  });
  if (operation !== 'export' && (present('output') || present('format'))) throw new Error('--output and --format are supported by audit export only');
  if (present('include-content') && operation !== 'export') throw new Error('--include-content is supported by profile setup export only');
  if (present('include-replay-content') && operation !== 'export') throw new Error('--include-replay-content is supported by audit export only');
  if (operation === 'export' && !present('output')) throw new Error('audit export requires --output');
  if (present('format') && !['json', 'markdown'].includes(flags['--format'])) throw new Error('Choose export --format json or markdown');
  const profileMode = operation === 'profiles' || (operation === 'export' && args[0] === 'profiles');
  if (profileMode && present('include-replay-content')) throw new Error('--include-replay-content requires a session report');
  if (!profileMode && (present('repo') || present('surface'))) throw new Error('--repo and --surface are supported by audit profiles only');
  if (present('surface') && !['cli', 'desktop'].includes(flags['--surface'])) throw new Error('Choose --surface cli or desktop');
  if (present('repo') && (!plain(flags['--repo']) || !isAbsolute(flags['--repo']) || resolve(flags['--repo']) !== flags['--repo']))
    throw new Error('Repository path must be absolute and normalized');
  const options = { ...context, includeReplay: !profileMode, ...(present('repo') ? { repo: flags['--repo'] } : {}), ...(present('surface') ? { client: flags['--surface'] } : {}) };
  let value;
  if (profileMode) {
    const names = operation === 'profiles' ? args : args.slice(1);
    if (names.length !== 2 || native || paired || expectations || names.some(name => !plain(name))) throw new Error('Use audit profiles LEFT RIGHT [--repo DIRECTORY --surface cli|desktop]');
    value = await compareAuditProfiles(store, ...names, options);
  } else if (native) {
    if (!present('profile') || !present('id') || args.length || operation === 'diff') throw new Error('Use audit show --profile NAME --id UUID');
    value = await selectedRun(store, flags['--profile'], flags['--id'], options);
  } else if (paired) {
    if (!['left-profile', 'left-id', 'right-profile', 'right-id'].every(present) || args.length || operation === 'show') throw new Error('audit diff requires both explicit profile/session pairs');
    const control = { expectModel: flags['--expect-model'], expectEffort: flags['--expect-effort'], ...selection };
    const [left, right] = ['left', 'right'].map(side => ({ profile: flags[`--${side}-profile`], id: flags[`--${side}-id`] }));
    value = await compareAuditSessions(store, left, right, control, options);
  } else {
    const compareFiles = operation === 'diff' || operation === 'export' && args.length === 2;
    const count = compareFiles ? 2 : 1;
    if (args.length !== count) throw new Error('Select explicit native sessions or exported JSON report file(s)');
    const reports = await Promise.all(args.map(value => isAuditRecordId(value) ? showAuditRecord(store, value, { includeReplay: true }) : readAuditReport(value)));
    if (compareFiles) {
      if (reports.some(item => item.kind !== 'audit-run')) throw new Error('audit diff FILE FILE requires two frozen run reports');
      value = compareAuditRuns(...reports, { expectModel: flags['--expect-model'], expectEffort: flags['--expect-effort'], ...selection });
    } else value = reports[0];
  }
  const exitCode = auditExitCode(value);
  return { value: operation === 'export' ? await exportAuditReport(value, { output: flags['--output'], format: flags['--format'] ?? 'json', includeContent: present('include-content'), includeReplayContent: present('include-replay-content') }) : value, exitCode };
}
