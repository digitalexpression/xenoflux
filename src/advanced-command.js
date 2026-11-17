import { homedir } from 'node:os';
import { createEnvironmentBinding } from './client-contracts.js';
import { inspectCopyProfile } from './copy-client.js';
import { managedNativeProfiles } from './managed-native-profile.js';
import { find } from './profiles.js';
import { pickAdvancedItems } from './advanced-picker.js';
import { planCopy, validateAdvancedSelection } from './native-copy.js';
import { confirmCopyAction } from './copy-picker.js';
import { inspectSetupGuidance } from './setup-guidance.js';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

export async function copyCommandOptions(store, source, target, { defaultUserHome = homedir(), terminalEnvironment } = {}) {
  const data = await store.read();
  const destination = target.toLowerCase() === 'default' ? null : find(data, target);
  if (!destination) throw new Error('Default is a source; copy into a named profile');
  const selectedSource = source.toLowerCase() === 'default' ? null : find(data, source);
  const clientId = destination.client ?? 'codex';
  if (selectedSource && (selectedSource.client ?? 'codex') !== clientId)
    throw new Error('Copy settings between profiles using the same client');
  if (clientId === 'codex') return { defaultUserHome };

  const native = managedNativeProfiles({ store, defaultUserHome, terminalEnvironment });
  async function binding(selected) {
    if (!selected) return;
    const profile = await native.resolveProfile(clientId, selected);
    return createEnvironmentBinding({ client: clientId, profileId: profile.profileId, surface: 'cli', executionLocation: 'local', rootMode: profile.rootMode,
      roots: { config: profile.home, reservation: profile.reservationRoot, user: profile.userHome, runtime: profile.home },
      workspace: null, executable: { path: profile.executable, identity: profile.executableIdentity, version: profile.version }, settingsIdentity: null });
  }
  return { defaultUserHome, clientId, sourceBinding: await binding(selectedSource), targetBinding: await binding(destination) };
}

/** Each conflicting item needs an explicit replacement choice; otherwise keep it. */
export async function reviewAdvancedConflicts(preview, selection, io = {}) {
  const output = io.output ?? process.stdout;
  const advancedResult = !Array.isArray(selection);
  const ids = advancedResult ? selection.selection : selection;
  const chosen = new Set(ids);
  const skipped = [...(advancedResult ? selection.skipped ?? [] : [])];
  for (const item of preview.items ?? []) {
    if (item.status !== 'conflict' || !chosen.has(item.id)) continue;
    if (io.signal?.aborted) return null;
    output.write(`\nConflict: ${clean(item.label)}\n`);
    output.write(`Origin: ${clean(item.origin ?? 'unknown')} | Scope: ${clean(item.scope ?? 'unknown')} | Source: ${clean(item.sourcePath ?? item.path ?? 'unknown')}\n`);
    const details = JSON.stringify(item.changes ?? [], null, 2);
    if (details.length > 1024 * 1024 || (item.changes?.length ?? 0) > 1900) {
      output.write('This change exceeds the safe review limit and will be kept at the destination.\n');
      chosen.delete(item.id);
      skipped.push({ ...item, status: 'skipped', reason: 'Kept at destination because its diff exceeded the review limit.' });
      continue;
    }
    output.write(`${details.replace(/[\x7f-\x9f]/g, ' ')}\n`);
    output.write('Type replace to apply this selected change, including listed package removals; anything else keeps the destination.\n');
    if (!await confirmCopyAction('replace', io)) {
      chosen.delete(item.id);
      skipped.push({ ...item, status: 'skipped', reason: 'Kept the destination item.' });
    }
    if (io.signal?.aborted) return null;
  }
  const result = ids.filter(id => chosen.has(id));
  return { ...(advancedResult ? selection : { setup: [], limitations: [] }), selection: result, skipped };
}

/** Read-only selection, shared by creation and copying. Never creates a profile. */
export async function selectAdvancedCopy(store, source, target, {
  input = process.stdin, output = process.stdout, signal, defaultUserHome = homedir(),
  clientId, sourceBinding, targetBinding,
} = {}) {
  const controller = signal ? null : new AbortController();
  signal ??= controller.signal;
  const abort = () => controller?.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
  if (controller) for (const name of signals) process.on(name, abort);
  const io = { input, output, signal };
  try {
    if (!input.isTTY || !output.isTTY) throw new Error('Advanced selection requires an interactive terminal; use profile inspect NAME --json for inventory');
    const options = { defaultUserHome, clientId, sourceBinding, targetBinding };
    const inventory = await inspectCopyProfile(store, source, { defaultUserHome, clientId, binding: sourceBinding, mainConversationsOnly: true });
    // Storage artifacts are not separate transferable conversations or settings.
    inventory.items = inventory.items.filter(item => item.scope !== 'project' && !['project', 'db', 'runtime', 'docs'].includes(item.category));
    if (clientId && clientId !== 'codex') {
      const candidates = inventory.items.filter(item => item.copyable && !item.setup);
      if (candidates.length) {
        const verified = await validateAdvancedSelection(store, source, candidates.map(item => item.id), { ...options, skipUnsafe: true });
        const verifiedIds = new Set(verified.selection);
        for (const item of candidates) {
          if (verifiedIds.has(item.id)) continue;
          item.copyable = false;
          item.reason = 'Excluded by the native copy safety checks.';
        }
      }
    }
    const guidance = !clientId || clientId === 'codex'
      ? await inspectSetupGuidance(store, source, target, { defaultUserHome }) : { items: [], limitations: [] };
    const setupIds = new Set([...inventory.items.filter(item => item.setup), ...guidance.items].map(item => item.id));
    inventory.items.push(...guidance.items);
    const review = ids => {
      const transferSelection = ids.filter(id => !setupIds.has(id));
      return target
        ? planCopy(store, source, target, { ...options, selection: transferSelection })
        : validateAdvancedSelection(store, source, transferSelection, options);
    };
    const picked = await pickAdvancedItems(inventory, { ...io, review });
    if (!picked || signal?.aborted) return null;
    const selection = picked.filter(id => !setupIds.has(id));
    const selectedSetup = inventory.items.filter(item => setupIds.has(item.id) && picked.includes(item.id));
    if (selection.length) await validateAdvancedSelection(store, source, selection, options);
    return { selection, setup: selectedSetup, limitations: [...new Set([...(inventory.limitations ?? []), ...guidance.limitations])], skipped: [] };
  } finally { if (controller) for (const name of signals) process.off(name, abort); }
}
