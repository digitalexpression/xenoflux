import { homedir } from 'node:os';
import { inspectProfile } from './profile-inventory.js';
import { pickAdvancedItems } from './advanced-picker.js';
import { planCopy, validateAdvancedSelection } from './native-copy.js';
import { confirmCopyAction } from './copy-picker.js';
import { inspectSetupGuidance } from './setup-guidance.js';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');

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
} = {}) {
  const controller = signal ? null : new AbortController();
  signal ??= controller.signal;
  const abort = () => controller?.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP'];
  if (controller) for (const name of signals) process.on(name, abort);
  const io = { input, output, signal };
  try {
    if (!input.isTTY || !output.isTTY) throw new Error('Advanced selection requires an interactive terminal; use profile inspect NAME --json for inventory');
    const inventory = await inspectProfile(store, source, { defaultUserHome, includeProjects: false, mainConversationsOnly: true, copyOnly: true });
    // Storage artifacts are not separate transferable conversations or settings.
    inventory.items = inventory.items.filter(item => item.scope !== 'project' && !['project', 'db', 'runtime', 'docs'].includes(item.category));
    const guidance = await inspectSetupGuidance(store, source, target, { defaultUserHome });
    const setupIds = new Set(guidance.items.map(item => item.id));
    inventory.items.push(...guidance.items);
    const review = ids => {
      const transferSelection = ids.filter(id => !setupIds.has(id));
      return target
        ? planCopy(store, source, target, { selection: transferSelection, defaultUserHome })
        : validateAdvancedSelection(store, source, transferSelection, { defaultUserHome });
    };
    const picked = await pickAdvancedItems(inventory, { ...io, review });
    if (!picked || signal?.aborted) return null;
    const selection = picked.filter(id => !setupIds.has(id));
    const selectedSetup = guidance.items.filter(item => picked.includes(item.id));
    if (selection.length) await validateAdvancedSelection(store, source, selection, { defaultUserHome });
    return { selection, setup: selectedSetup, limitations: [...new Set([...(inventory.limitations ?? []), ...guidance.limitations])], skipped: [] };
  } finally { if (controller) for (const name of signals) process.off(name, abort); }
}
