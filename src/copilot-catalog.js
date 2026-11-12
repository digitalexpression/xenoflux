import { copilotId } from './copilot-profile.js';

const requiredId = value => {
  if (!copilotId(value)) throw new Error('Invalid Copilot catalog identifier.');
  return value;
};
const unique = rows => {
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate Copilot catalog identifier.');
  return rows;
};

export const COPILOT_PERMISSION_MODES = Object.freeze(['manual', 'assisted']);

export function decodeCopilotCatalog(raw) {
  if (!Array.isArray(raw?.models) || raw.models.length > 5000
    || raw.auto != null && (!Array.isArray(raw.auto.tiers) || raw.auto.tiers.length > 128))
    throw new Error('Invalid Copilot model catalog.');
  const models = unique(raw.models.filter(row => row?.id !== 'auto').map(row => {
    const effort = row?.supportedReasoningEfforts;
    if (effort != null && (!Array.isArray(effort) || effort.length > 128 || new Set(effort).size !== effort.length))
      throw new Error('Invalid Copilot effort options.');
    const state = row?.policy?.state ?? null;
    const choices = effort?.map(value => ({ reasoningEffort: requiredId(value), description: null })) ?? null;
    return {
      id: requiredId(row?.id), model: row.id, displayName: requiredId(row.name),
      hidden: row.hidden === true || row.pickerVisible === false,
      policy: state,
      selectable: [null, 'enabled'].includes(state) && row.hidden !== true && row.pickerVisible !== false,
      supportedReasoningEfforts: choices, defaultReasoningEffort: row.defaultReasoningEffort == null ? null : requiredId(row.defaultReasoningEffort),
      effortCapability: choices ? (choices.length ? 'supported' : 'unsupported') : 'unknown',
      isDefault: null,
    };
  }));
  const auto = raw.auto == null ? null : {
    defaultTier: requiredId(raw.auto.defaultTier),
    tiers: unique(raw.auto.tiers.map(row => ({
      id: requiredId(row?.id), displayName: copilotId(row.displayName) ? row.displayName : row.id, type: requiredId(row.type),
      enabled: row.status?.enabled === true, visible: row.status?.pickerVisible !== false,
      reason: copilotId(row.status?.reason) ? row.status.reason : null,
    }))),
  };
  if (!models.length && !auto) throw new Error('Copilot did not advertise any conversation model or Auto routing.');
  return { models, auto, permissionModes: [...COPILOT_PERMISSION_MODES] };
}

export function selectCopilotSettings(catalog, { model, reasoningEffort, route, permissionMode } = {}) {
  if (permissionMode != null && !COPILOT_PERMISSION_MODES.includes(permissionMode))
    throw new Error('Unsupported Copilot permission mode.');
  if (model === 'auto') {
    const tier = route ?? catalog?.auto?.defaultTier;
    if (reasoningEffort != null || !catalog?.auto?.tiers.some(row => row.id === tier && row.type === 'auto' && row.enabled && row.visible))
      throw new Error('Copilot did not advertise the requested Auto route.');
    return { model, route: tier, permissionMode };
  }
  const advertised = model == null ? null : catalog?.models.find(row => row.id === model && row.selectable);
  if (route != null || model != null && !advertised
    || reasoningEffort != null && !advertised?.supportedReasoningEfforts?.some(row => row.reasoningEffort === reasoningEffort))
    throw new Error('Copilot did not advertise the requested model and effort.');
  return { model, reasoningEffort, permissionMode };
}
