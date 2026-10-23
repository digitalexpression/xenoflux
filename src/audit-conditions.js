import { createHash } from 'node:crypto';
import { auditQualityFingerprint } from './audit-quality.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = value => typeof value === 'string' && value.length <= 160
  && /^[\p{L}\p{N}][\p{L}\p{N} ._:+-]*$/u.test(value) ? value : null;
const safeLabels = values => Array.isArray(values) ? values.map(label).filter(Boolean).slice(0, 50) : [];
const boundedEnvironment = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['platform', 'architecture', 'nodeVersion', 'settings', 'cache', 'integrations', 'epoch'];
  return Object.fromEntries(allowed.filter(key => value[key] !== undefined).map(key => [key,
    typeof value[key] === 'string' && value[key].length <= 120 && /^[\w .:+-]+$/.test(value[key]) ? value[key] : null]));
};

/** Build a privacy-safe, versioned description from frozen experiment inputs. */
export function buildAuditComparisonConditions({ spec, baseline, profile, profileOrder, trialIndex, environment, recipe } = {}) {
  const taskContract = spec?.taskContract;
  return { schemaVersion: 1, taskFingerprint: digest(spec?.task ?? ''),
    ...(taskContract ? { taskId: taskContract.id, editableFiles: [...taskContract.editableFiles] } : {}),
    checkRecipes: (spec?.checks ?? []).map(check => ({ name: check.name, fingerprint: digest(check) })),
    qualityFingerprint: auditQualityFingerprint(spec?.quality, spec?.checks ?? []) ?? null,
    setupFingerprint: digest(profile?.nativeConfig === undefined ? spec?.setup ?? []
      : { setup: spec?.setup ?? [], nativeConfig: profile.nativeConfig }),
    selectedSkills: safeLabels(profile?.skills).length === (profile?.skills ?? []).length ? safeLabels(profile?.skills) : null,
    variables: safeLabels(spec?.variables).length === (spec?.variables ?? []).length ? safeLabels(spec?.variables) : null,
    profileOrder: Array.isArray(profileOrder) ? safeLabels(profileOrder) : [],
    trialIndex: Number.isSafeInteger(trialIndex) && trialIndex >= 0 && trialIndex <= 19 ? trialIndex : null,
    environment: boundedEnvironment(environment),
    baseline: { commit: label(baseline?.commit), tree: label(baseline?.tree) },
    ...(recipe?.fingerprint ? { recipeFingerprint: recipe.fingerprint } : {}) };
}
